import { kDecodeQueueSize } from "./logging.js";
import { DataStream, createFile } from "mp4box";

/**
 * Wraps the WebCodecs VideoDecoder API to provide a consistent interface for decoding video frames.
 */
export class VideoDecoder {
  /**
   * Initializes the VideoDecoder.
   * @param {object} config - The configuration object.
   * @param {function} config.onFrame - Callback for when a frame is decoded.
   * @param {function} config.onDequeue - Callback to request more data.
   * @param {function} config.onError - Callback for decoding errors.
   * @param {boolean} config.isChromeBased - Flag indicating if the browser is Chrome-based.
   */
  constructor({ onFrame, onDequeue, onError, isChromeBased }) {
    this.decoder = null;
    this.onFrame = onFrame;
    this.onDequeue = onDequeue;
    this.onError = onError;
    this.isChromeBased = isChromeBased;
  }

  /**
   * Configures and sets up the underlying VideoDecoder.
   * @param {object} config - The video decoder configuration.
   */
  async setup(config) {
    // Initialize the decoder
    this.decoder = new window.VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => this.onError(e),
    });
    // If browser is chrome based.
    if (this.isChromeBased) {
      this.decoder.ondequeue = () => {
        // Number of chunks to request
        const n = kDecodeQueueSize - this.decoder.decodeQueueSize;
        if (n > 0) {
          this.onDequeue(n);
        }
      };
    }

    await this.decoder.configure(config);
  }

  /**
   * Starts a timer-based dispatch mechanism for non-Chrome browsers.
   * @param {function} onDispatch - The function to call to dispatch more data.
   */
  startTimerDispatch(onDispatch) {
    setTimeout(() => {
      const n = kDecodeQueueSize - this.decodeQueueSize;
      onDispatch(n);
    }, 1000);
  }

  /**
   * Gets the current size of the decoder's queue.
   * @returns {number} The decode queue size.
   */
  get decodeQueueSize() {
    return this.decoder?.decodeQueueSize || 0;
  }

  /**
   * Sets the state of the decoder.
   * @param {string} state - The new state.
   */
  setState(state) {
    this.state = state;
  }

  /**
   * Decodes a video chunk.
   * @param {EncodedVideoChunk} chunk - The chunk to decode.
   */
  decode(chunk) {
    this.decoder?.decode(chunk);
  }

  /**
   * Flushes any pending frames from the decoder.
   */
  async flush() {
    await this.decoder?.flush();
  }
}

/**
 * Demuxes an MP4 file to extract video samples and configuration.
 */
export class MP4Demuxer {
  /**
   * Initializes the MP4Demuxer.
   * @param {string} uri - The URI of the MP4 file.
   * @param {object} config - The configuration object.
   * @param {function} config.onConfig - Callback with the video configuration.
   * @param {function} config.setStatus - Callback to update the status.
   * @param {SampleManager} config.sampleManager - The sample manager to handle extracted samples.
   */
  constructor(uri, { onConfig, setStatus, sampleManager }) {
    this.onConfig = onConfig;
    this.setStatus = setStatus;
    this.file = createFile();

    this.file.onError = (error) => setStatus("demux", error);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.nb_samples = 0;
    this.passed_samples = 0;
    this.stopProcessingSamples = false;
    this.sampleManager = sampleManager;
    this.setupFile(uri);
  }

  /**
   * Fetches the MP4 file and pipes it to the demuxer.
   * @param {string} uri - The URI of the MP4 file.
   */
  async setupFile(uri) {
    const fileSink = new MP4FileSink(this.file, this.setStatus);
    const response = await fetch(uri);
    await response.body.pipeTo(
      new WritableStream(fileSink, { highWaterMark: 2 })
    );
  }

  /**
   * Extracts the decoder-specific description from the video track.
   * @param {object} track - The video track information.
   * @returns {Uint8Array} The decoder-specific description.
   */
  getDescription(track) {
    const trak = this.file.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8); // Remove the box header.
      }
    }
    throw new Error("avcC, hvcC, vpcC, or av1C box not found");
  }

  /**
   * Calculates the frames per second (FPS) of the video track.
   * @param {object} track - The video track information.
   * @returns {number} The calculated FPS.
   */
  calculateFPS(track) {
    // Convert duration to seconds using timescale
    const durationInSeconds = track.duration / track.timescale;

    // Calculate FPS using number of samples (frames) divided by duration
    const fps = track.nb_samples / durationInSeconds;

    // Round to 2 decimal places for cleaner display
    return Math.round(fps * 100) / 100;
  }

  /**
   * Called when the demuxer is ready and has parsed the file's metadata.
   * @param {object} info - The file information.
   */
  onReady(info) {
    this.setStatus("demux", "Ready");
    const track = info.videoTracks[0];

    // Calculate duration in milliseconds
    const durationMs = (track.duration * 1000) / track.timescale;

    // Create a Date object for startTime
    const startTime = track.created
      ? new Date(track.created.getTime() - durationMs)
      : new Date();

    this.onConfig({
      codec: track.codec,
      codedHeight: track.video.height,
      codedWidth: track.video.width,
      description: this.getDescription(track),
      nb_samples: track.nb_samples,
      matrix: track.matrix,
      startTime: startTime,
      fps: this.calculateFPS(track),
    });
    this.nb_samples = track.nb_samples;

    this.file.setExtractionOptions(track.id);
    this.file.start();
  }

  /**
   * Called when video samples are extracted from the file.
   * @param {number} track_id - The ID of the track.
   * @param {object} ref - Reference object.
   * @param {Array<object>} samples - The extracted samples.
   */
  onSamples(track_id, ref, samples) {
    if (this.stopProcessingSamples) return;
    this.passed_samples += samples.length;
    this.sampleManager.addSamples(samples);
    if (this.passed_samples >= this.nb_samples) {
      this.stopProcessingSamples = true;
      this.sampleManager.finalize();
    }
  }
}

/**
 * A WritableStream sink for piping data to the MP4 demuxer.
 */
export class MP4FileSink {
  /**
   * Initializes the MP4FileSink.
   * @param {object} file - The mp4box.js file object.
   * @param {function} setStatus - Callback to update the status.
   */
  constructor(file, setStatus) {
    this.file = file;
    this.setStatus = setStatus;
    this.offset = 0;
  }

  /**
   * Writes a chunk of data to the file.
   * @param {Uint8Array} chunk - The data chunk.
   */
  write(chunk) {
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    buffer.fileStart = this.offset;
    this.offset += buffer.byteLength;

    this.setStatus("fetch", `${(this.offset / 1024 / 1024).toFixed(1)} MB`);
    this.file.appendBuffer(buffer);
  }

  /**
   * Closes the file sink and flushes any pending data.
   */
  close() {
    this.setStatus("fetch", "Complete");
    this.file.flush();
  }
}
("");
