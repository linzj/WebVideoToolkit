import {
  errorLog,
  warnLog,
  infoLog,
  debugLog,
  verboseLog,
  kDecodeQueueSize,
} from "./logging.js";
import { VideoEncoder } from "./videoEncoder.js";
import { VideoDecoder } from "./videoDecoder.js";
import { ResourceManager } from "./resourceManager.js";

/**
 * ProcessingPipeline manages the core video processing flow from decoding through encoding.
 */
export class ProcessingPipeline {
  /**
   * Creates a new ProcessingPipeline instance.
   * @param {Object} options - The options for the pipeline.
   * @param {Function} options.onFrameProcessed - Callback executed for each processed frame.
   * @param {Function} options.onFinalized - Callback executed when processing is complete.
   * @param {SampleManager} options.sampleManager - The manager for video samples.
   * @param {UIManager} options.uiManager - The manager for UI updates.
   * @param {boolean} options.isChromeBased - Flag for browser type.
   * @param {number} options.fps - The frames per second of the video.
   */
  constructor({
    onFrameProcessed,
    onFinalized,
    sampleManager,
    uiManager,
    isChromeBased,
    fps,
  }) {
    this.onFrameProcessed = onFrameProcessed;
    this.onFinalized = onFinalized;
    this.sampleManager = sampleManager;
    this.uiManager = uiManager;
    this.isChromeBased = isChromeBased;
    this.fps = fps;

    this.decoder = null;
    this.encoder = null;
    this.state = "idle"; // 'idle', 'ready', 'processing', 'exhausted', 'finalized'
    this.processingResolve = null;
    this.processingPromise = null;
    this.outputTaskPromises = [];
    this.previousPromise = Promise.resolve();
    this.timeRangeStart = 0;
    this.timeRangeEnd = 0;

    // Initialize resource manager
    this.resourceManager = new ResourceManager();

    infoLog("ProcessingPipeline", "Processing pipeline initialized");
  }

  /**
   * Sets up the decoder and encoder for the pipeline.
   * @param {Object} config - The video configuration object from the demuxer.
   */
  async setup(config) {
    await this.setupDecoder(config);
    await this.setupEncoder();
    this.state = "ready";
  }

  /**
   * Sets up the video decoder.
   * @param {Object} config - The video configuration object from the demuxer.
   * @private
   */
  async setupDecoder(config) {
    try {
      this.decoder = new VideoDecoder({
        onFrame: (frame) => this.handleDecoderOutput(frame),
        onError: (e) => {
          errorLog("ProcessingPipeline", "Decoder error", e);
        },
        onDequeue: (n) => this.dispatch(n),
        isChromeBased: this.isChromeBased,
      });

      await this.decoder.setup(config);
      this.uiManager.setStatus("decode", "Decoder configured");
      infoLog("ProcessingPipeline", "Decoder setup complete");
    } catch (error) {
      errorLog("ProcessingPipeline", "Failed to setup decoder", error);
      throw error;
    }
  }

  /**
   * Sets up the video encoder.
   * @private
   */
  async setupEncoder() {
    this.encoder = new VideoEncoder();
    const { width, height } = this.getEncoderDimensions();
    await this.encoder.init(width, height, this.fps, !this.isChromeBased, true);
  }

  /**
   * Calculates the output dimensions for the encoder, accounting for rotation, zoom,
   * and ensuring dimensions are a multiple of 64.
   * @returns {{width: number, height: number}}
   */
  getEncoderDimensions() {
    const { rotation, videoWidth, videoHeight, zoom } = this.uiManager;
    const isSideways = rotation % 180 !== 0;
    const width =
      Math.ceil(((isSideways ? videoHeight : videoWidth) * zoom) / 64) * 64;
    const height =
      Math.ceil(((isSideways ? videoWidth : videoHeight) * zoom) / 64) * 64;
    return { width, height };
  }

  /**
   * Starts the video processing.
   * @param {number} timeRangeStart - The start of the processing time range in ms.
   * @param {number} timeRangeEnd - The end of the processing time range in ms.
   */
  async start(timeRangeStart, timeRangeEnd) {
    if (this.state !== "ready") {
      throw new Error("Pipeline is not ready to start processing.");
    }
    this.timeRangeStart = timeRangeStart;
    this.timeRangeEnd = timeRangeEnd;
    this.state = "processing";
    this.timerDispatch();
    this.dispatch(kDecodeQueueSize);

    this.processingPromise = new Promise((resolve) => {
      this.processingResolve = resolve;
    });

    return this.processingPromise;
  }

  /**
   * Requests and decodes a specified number of video chunks.
   * This method is called to feed the decoder with data from the SampleManager.
   * When all samples are exhausted, it flushes the decoder and finalizes the pipeline.
   * @param {number} n - The number of chunks to dispatch.
   * @private
   */
  dispatch(n) {
    if (this.state !== "processing") {
      return;
    }
    verboseLog(`Dispatching ${n} chunks`);
    this.sampleManager.requestChunks(
      n,
      (chunk) => {
        this.decoder.decode(chunk);
      },
      async () => {
        this.state = "exhausted";
        await this.decoder.flush();
        if (this.decoder.decodeQueueSize == 0) {
          this.finalize();
        }
      }
    );
  }

  /**
   * A timer-based dispatch mechanism for non-Chrome browsers that do not
   * support the `ondequeue` event on the VideoDecoder.
   * @private
   */
  timerDispatch() {
    if (this.state !== "processing") {
      return;
    }
    if (this.isChromeBased) {
      return;
    }
    this.decoder.startTimerDispatch((n) => {
      if (n > 0) {
        this.dispatch(n);
      }
      this.timerDispatch();
    });
  }

  /**
   * Handles decoded frames from the video decoder.
   * It ensures that frames are processed sequentially and adds them to a processing queue.
   * @param {VideoFrame} frame - The decoded video frame.
   * @private
   */
  async handleDecoderOutput(frame) {
    if (this.state === "processing" || this.state === "exhausted") {
      const p = this.previousPromise.then(() => this.processFrame(frame));
      this.previousPromise = p;
      this.outputTaskPromises.push(p);
      return;
    }
    // In any other state, we just close the frame.
    // Preview frames are handled by the VideoProcessor, not this pipeline.
    this.resourceManager.closeFrame({
      frame,
      context: "pipeline",
      closed: false,
    });
  }

  /**
   * Processes a single video frame. This includes:
   * - Checking if the frame is within the selected time range.
   * - Drawing the frame to the canvas (with transformations).
   * - Drawing a timestamp overlay.
   * - Creating a new frame from the canvas.
   * - Encoding the new frame.
   * @param {VideoFrame} frame - The video frame to process.
   * @private
   */
  async processFrame(frame) {
    const frameTimeMs = Math.floor(frame.timestamp / 1000);

    if (frameTimeMs < this.timeRangeStart || frameTimeMs > this.timeRangeEnd) {
      this.resourceManager.closeFrame({
        frame,
        context: "pipeline-out-of-range",
        closed: false,
      });
      return;
    }

    try {
      this.uiManager.drawFrame(frame);
      this.uiManager.drawTimestamp(frameTimeMs);

      const videoFrameOptions = {
        timestamp: frame.timestamp,
        duration: frame.duration,
      };
      frame.close();
      verboseLog(`videoFrameOptions: ${JSON.stringify(videoFrameOptions)}`);
      const newFrame = new VideoFrame(this.uiManager.canvas, videoFrameOptions);

      this.onFrameProcessed();
      return this.encoder.encode(newFrame);
    } catch (error) {
      console.error("Error processing frame:", error);
      throw error;
    }
  }

  /**
   * Finalizes the processing pipeline.
   * It waits for all pending frame processing tasks to complete,
   * finalizes the encoder, and calls the onFinalized callback.
   */
  async finalize() {
    if (this.state === "finalized") return;

    if (this.outputTaskPromises.length > 0) {
      await Promise.all(this.outputTaskPromises);
      this.outputTaskPromises = [];
    }

    this.state = "finalized";
    await this.encoder.finalize();
    this.onFinalized();

    if (this.processingResolve) {
      this.processingResolve();
    }
  }
}
