import { verboseLog, kEncodeQueueSize } from "./logging.js";
import { Muxer, StreamTarget } from "mp4-muxer";

/**
 * Handles video encoding using the WebCodecs API and muxing with mp4-muxer.
 * It can write the output to the File System Access API or in-memory.
 */
export class VideoEncoder {
  /**
   * Initializes the VideoEncoder, setting up initial state values.
   * This includes properties for the encoder, muxer, file handling,
   * and managing backpressure during encoding.
   */
  constructor() {
    this.encoder = null; // Holds the VideoEncoder instance.
    this.blockingPromise = null; // A promise used to pause encoding when the queue is full.
    this.blockingPromiseResolve = null; // The resolve function for the blocking promise.
    this.muxer = null; // Holds the mp4-muxer instance.
    this.chunks = []; // Stores video chunks if not using the file system.
    this.fileHandle = null; // Handle for the output file.
    this.fileStream = null; // Writable stream for the output file.
    this.root = null; // Root directory for file system access.
    this.tempFileName = `temp-manji.mp4`; // Temporary file name for the encoded video.
  }

  /**
   * Initializes the encoder and muxer with the specified parameters.
   * This method configures the video encoding settings, including resolution,
   * frame rate, and bitrate. It also sets up the output target, which can be
   * either an in-memory buffer or the file system.
   *
   * @param {number} width - The width of the video.
   * @param {number} height - The height of the video.
   * @param {number} fps - The frames per second of the video.
   * @param {boolean} useCalculatedBitrate - Whether to use a calculated bitrate.
   * @param {boolean} [useFileSystem=false] - Whether to use the File System Access API for output.
   */
  async init(width, height, fps, useCalculatedBitrate, useFileSystem = false) {
    verboseLog("Initializing encoder with dimensions:", { width, height });

    // Define maximum dimensions for H.264 Level 5.1 (e.g., 4K resolution).
    const maxWidth = 4096;
    const maxHeight = 2304;
    let targetWidth = width;
    let targetHeight = height;

    // If the video dimensions exceed the maximum, scale it down while maintaining the aspect ratio.
    // This feature is currently disabled.
    if ((width > maxWidth || height > maxHeight) && false) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      targetWidth = Math.floor(width * ratio);
      targetHeight = Math.floor(height * ratio);
      console.log("Scaling video to:", { targetWidth, targetHeight });
    }

    // Calculate an appropriate bitrate for the video. A common heuristic is 0.2 bits per pixel.
    // The bitrate is capped at 30 Mbps, a reasonable limit for H.264 Level 5.1.
    const pixelCount = targetWidth * targetHeight;
    const bitsPerPixel = 0.2;
    const targetBitrate = Math.min(
      Math.floor(pixelCount * bitsPerPixel * 30),
      30_000_000 // Cap at 30Mbps for Level 5.1
    );

    // If using the file system, set up a web worker to handle file I/O.
    // This prevents blocking the main thread.
    if (useFileSystem) {
      this.fileWorker = new Worker("fileWorker.js");
      this.fileWorker.postMessage({
        type: "init",
        data: { fileName: this.tempFileName },
      });

      // Configure the muxer to write data to the file worker.
      this.muxer = new Muxer({
        target: new StreamTarget({
          chunked: true,
          onData: (data, position) => {
            this.fileWorker.postMessage({
              type: "write",
              data: {
                chunk: new Uint8Array(data),
                position,
              },
            });
          },
        }),
        fastStart: false,
        video: {
          codec: "avc",
          width: targetWidth,
          height: targetHeight,
        },
        firstTimestampBehavior: "offset",
      });
    } else {
      // If not using the file system, store the video chunks in an in-memory array.
      this.muxer = new Muxer({
        target: new StreamTarget({
          chunked: true,
          onData: (data, position) => {
            this.chunks.push({ data: new Uint8Array(data), position });
          },
        }),
        fastStart: "in-memory",
        video: {
          codec: "avc",
          width: targetWidth,
          height: targetHeight,
        },
        firstTimestampBehavior: "offset",
      });
    }

    // Initialize the VideoEncoder with a callback to handle encoded chunks.
    // The output of the encoder is fed directly to the muxer.
    this.encoder = new window.VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error("Encoding error:", e),
    });

    // Set up a callback to handle the 'dequeue' event. This is used to manage
    // backpressure from the encoder's internal queue.
    this.encoder.ondequeue = () => {
      if (
        this.blockingPromise &&
        this.encoder.encodeQueueSize < kEncodeQueueSize
      ) {
        this.blockingPromiseResolve();
        this.blockingPromise = null;
        this.blockingPromiseResolve = null;
      }
    };

    // Configure the encoder with the specified video parameters.
    const config = {
      codec: "avc1.640033", // H.264 High Profile Level 5.1
      width: targetWidth,
      height: targetHeight,
      framerate: fps,
    };
    if (useCalculatedBitrate) {
      config.bitrate = targetBitrate;
    }

    await this.encoder.configure(config);
  }

  /**
   * Encodes a single video frame. This method handles backpressure by checking
   * the encoder's queue size. If the queue is too large, it pauses encoding
   * until the queue has drained.
   *
   * @param {VideoFrame} frame - The video frame to encode.
   */
  async encode(frame) {
    while (this.encoder.encodeQueueSize > kEncodeQueueSize) {
      // If a blocking promise already exists, it means another encode call
      // is already waiting for the queue to drain. We should wait on that
      // same promise.
      if (this.blockingPromise) {
        await this.blockingPromise;
        // After waiting, we continue the loop to re-check the queue size.
        continue;
      }
      // Create a promise that will be resolved when the queue has drained.
      this.blockingPromise = new Promise((resolve) => {
        this.blockingPromiseResolve = resolve;
      });
      await this.blockingPromise;
    }
    // Encode the frame and then close it to free up resources.
    this.encoder.encode(frame);
    frame.close();
  }

  /**
   * Finalizes the encoding process. This method flushes any remaining frames
   * from the encoder and muxer, and then prepares the final video file for
   * download. The method of providing the file depends on whether the file
   * system or in-memory storage was used.
   */
  async finalize() {
    // Flush any buffered frames from the encoder and close it.
    await this.encoder.flush();
    this.encoder.close();
    this.muxer.finalize();

    // If using the file system, finalize the file and provide a download link.
    if (this.fileWorker) {
      this.fileWorker.postMessage({ type: "close" });
      // Wait for the file worker to confirm that the file has been closed.
      await new Promise((resolve) => {
        this.fileWorker.onmessage = (e) => {
          if (e.data.type === "closed") {
            this.fileWorker.terminate();
            resolve();
          }
        };
      });

      // Get a handle to the temporary file and create a URL for it.
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(this.tempFileName, {
        create: false,
      });
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);

      // Create a link to download the file.
      const a = document.createElement("a");
      a.href = url;
      a.download = "processed-video.mp4";
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // If using in-memory storage, assemble the video from the stored chunks.
      const sortedChunks = this.chunks.sort((a, b) => a.position - b.position);
      const lastChunk = sortedChunks[sortedChunks.length - 1];
      const totalSize = lastChunk.position + lastChunk.data.length;
      const result = new Uint8Array(totalSize);
      for (const chunk of sortedChunks) {
        result.set(chunk.data, chunk.position);
      }

      // Create a Blob from the video data and provide a download link.
      const blob = new Blob([result], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "processed-video.mp4";
      a.click();
      URL.revokeObjectURL(url);
    }
  }
}
