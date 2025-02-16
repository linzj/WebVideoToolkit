import { verboseLog, performanceLog, kDecodeQueueSize } from "./logging.js";
import { SampleManager } from "./sampleManager.js";
import { VideoEncoder } from "./videoEncoder.js";
import { TimeStampRenderer } from "./timeStampRenderer.js";
import { VideoFrameRenderer } from "./videoFrameRenderer.js";
import { VideoDecoder, MP4Demuxer } from "./videoDecoder.js";
import { PreviewManager } from "./previewManager.js";

/**
 * VideoProcessor handles video processing operations including decoding, frame manipulation,
 * encoding, and preview generation. It manages the lifecycle of video processing from
 * initialization to finalization.
 */
export class VideoProcessor {
  /**
   * Creates a new VideoProcessor instance
   * @param {Object} config - Configuration object
   * @param {HTMLCanvasElement} config.canvas - Canvas element for frame rendering
   * @param {HTMLElement} config.statusElement - Element to display processing status
   * @param {HTMLElement} config.frameCountDisplay - Element to display frame count
   * @param {Object} config.timestampProvider - Provider for timestamp operations
   */
  constructor({ canvas, statusElement, frameCountDisplay, timestampProvider }) {
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    this.status = statusElement;
    this.encoder = null;
    this.frameCountDisplay = frameCountDisplay;
    this.nb_samples = 0;
    this.frame_count = 0;
    this.state = "idle";
    this.previousPromise = null;
    this.timeRangeStart = undefined;
    this.timeRangeEnd = undefined;
    this.outputTaskPromises = [];
    this.startProcessVideoTime = undefined;
    this.sampleManager = new SampleManager();
    this.timestampRenderer = null;
    this.timestampProvider = timestampProvider;
    this.isChromeBased = false;
    this.processingPromise = null;
    this.processingResolve = null;
    this.mp4StartTime = undefined;
    this.frameRenderer = new VideoFrameRenderer(this.ctx);
    this.decoder = null;
    // Preview-related properties
    this.previewManager = null; // Will hold PreviewManager instance
    this.lastPreviewPercentage = 0.0;
    this.scale = 1.0; // Add scale property
    this.fps = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.matrix = undefined;
  }

  // Add update method for scale
  async updateScale(scale) {
    this.scale = scale;

    const { width, height } = this.getEncoderDimensions();
    this.setupCanvas(width, height);
    // Update frame renderer
    this.frameRenderer.setup(
      this.videoWidth,
      this.videoHeight,
      this.matrix,
      scale
    );

    // If in preview mode, update the preview
    if (this.state === "initialized") {
      await this.renderSampleInPercentage(this.lastPreviewPercentage);
    }
  }

  /**
   * Updates the status message displayed to the user
   * @param {string} phase - Current processing phase
   * @param {string} message - Status message to display
   */
  setStatus(phase, message) {
    this.status.textContent = `${phase}: ${message}`;
  }

  /**
   * Finalizes the video processing, closing encoder and calculating performance metrics
   * @returns {Promise<void>}
   */
  async finalize() {
    if (this.outputTaskPromises.length > 0) {
      await Promise.all(this.outputTaskPromises);
      this.outputTaskPromises = [];
    }
    if (this.state !== "finalized") {
      this.state = "finalized";
      await this.encoder.finalize();
      const endProcessVideoTime = performance.now();
      performanceLog(
        `Total processing time: ${
          endProcessVideoTime - this.startProcessVideoTime
        } ms, FPS: ${
          this.frame_count /
          ((endProcessVideoTime - this.startProcessVideoTime) / 1000)
        }`
      );
      this.processingResolve();
    }
  }

  /**
   * Initializes processing for a given file
   * @param {File} file - Video file to process
   * @returns {Promise<void>}
   */
  async initFile(file) {
    if (this.state !== "idle") {
      throw new Error("Processor is not idle");
    }
    this.state = "initializing";
    try {
      const videoURL = URL.createObjectURL(file);
      await this.processVideo(videoURL);
      URL.revokeObjectURL(videoURL);
    } catch (error) {
      console.error("Error processing video:", error);
      this.setStatus("error", error.message);
    }
  }

  /**
   * Processes the initialized file with current configuration
   * @returns {Promise<void>}
   * @throws {Error} If processor is not in initialized state
   */
  async processFile() {
    if (this.state !== "initialized") {
      throw new Error("Processor is not initializing");
    }
    while (this.hasPreviousPromise) {
      await this.waitForPreviousPromise();
    }

    await this.setupEncoder();

    let userStartTime = this.timestampProvider.getUserStartTime();

    let startTime = userStartTime || this.mp4StartTime || new Date();
    // Only create timestampRenderer if timestamp is enabled
    this.timestampRenderer = this.timestampProvider.isEnabled()
      ? new TimeStampRenderer(startTime)
      : null;

    // Synchronize timestamp rendering with user-specified start time
    // by applying negative timeRangeStart offset. This adjusts the base time
    // to account for video trimming while maintaining accurate absolute timestamps.
    if (userStartTime) {
      this.timestampRenderer.updateExtraTimeOffsetMS(-this.timeRangeStart);
    }
    this.state = "processing";
    this.processingPromise = new Promise((resolve) => {
      this.processingResolve = resolve;
    });

    try {
      this.timerDispatch();
      this.dispatch(kDecodeQueueSize);
    } catch (error) {
      console.error("Error processing video:", error);
      this.setStatus("error", error.message);
    }
  }

  /**
   * Processes file within specified time range
   * @param {number} startMs - Start time in milliseconds
   * @param {number} endMs - End time in milliseconds
   * @returns {Promise<void>}
   */
  async processFileByTime(startMs, endMs) {
    this.startProcessVideoTime = performance.now();

    [this.nb_samples, this.timeRangeStart, this.timeRangeEnd] =
      this.sampleManager.finalizeTimeRange(startMs, endMs);
    await this.processFile();
  }

  /**
   * Processes file for specified frame range
   * @param {number} startIndex - Starting frame index
   * @param {number} endIndex - Ending frame index
   * @returns {Promise<void>}
   */
  async processFileByFrame(startIndex, endIndex) {
    this.startProcessVideoTime = performance.now();
    [this.nb_samples, this.timeRangeStart, this.timeRangeEnd] =
      this.sampleManager.finalizeSampleInIndex(startIndex, endIndex);
    await this.processFile();
  }

  /**
   * Dispatches decode requests to process video chunks
   * @param {number} n - Number of chunks to dispatch
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
   * Initiates timer-based dispatch for non-Chrome browsers
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
   * Sets up video processing from URI
   * @param {string} uri - Video URI to process
   * @returns {Promise<void>}
   */
  async processVideo(uri) {
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setup(config),
      setStatus: (phase, message) => this.setStatus(phase, message),
      sampleManager: this.sampleManager,
    });
  }

  /**
   * Configures processor components with video metadata
   * @param {Object} config - Video configuration object
   * @returns {Promise<void>}
   */
  async setup(config) {
    // If browser is chrome based.
    if (navigator.userAgent.toLowerCase().includes("chrome")) {
      this.isChromeBased = true;
    }
    await this.setupDecoder(config);
    this.setupCanvas(config.codedWidth, config.codedHeight);
    this.videoWidth = config.codedWidth;
    this.videoHeight = config.codedHeight;
    this.fps = config.fps;
    this.matrix = config.matrix;
    this.frameRenderer.setup(
      config.codedWidth,
      config.codedHeight,
      config.matrix,
      this.scale
    );
    this.mp4StartTime = config.startTime;
    this.frame_count = 0;
    this.frameCountDisplay.textContent = `Processed frames: 0 / ${this.nb_samples}`;
    this.state = "initialized";
    // Initialize preview manager.
    this.previewManager = new PreviewManager(this.decoder, this.sampleManager);
    if (this.onInitialized) {
      this.onInitialized(this.sampleManager.sampleCount());
    }
  }

  async setupDecoder(config) {
    this.decoder = new VideoDecoder({
      onFrame: (frame) => this.handleDecoderOutput(frame),
      onError: (e) => console.error(e),
      onDequeue: (n) => this.dispatch(n),
      isChromeBased: this.isChromeBased,
    });

    await this.decoder.setup(config);
    this.setStatus("decode", "Decoder configured");
    await this.sampleManager.waitForReady();
  }

  setupCanvas(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  getEncoderDimensions() {
    // Round up dimensions to multiples of 64
    const width = Math.ceil((this.videoWidth * this.scale) / 64) * 64;
    const height = Math.ceil((this.videoHeight * this.scale) / 64) * 64;
    return { width, height };
  }

  async setupEncoder() {
    this.encoder = new VideoEncoder();
    const { width, height } = this.getEncoderDimensions();
    const fps = this.fps;
    await this.encoder.init(width, height, fps, !this.isChromeBased, true);
  }

  /**
   * Renders a frame to the canvas
   * @param {VideoFrame} frame - Frame to render
   */
  drawFrame(frame) {
    this.frameRenderer.drawFrame(frame);
  }

  /**
   * Processes a single video frame
   * @param {VideoFrame} frame - Frame to process
   * @returns {Promise<void>}
   */
  async processFrame(frame) {
    const frameTimeMs = Math.floor(frame.timestamp / 1000);
    if (this.timeRangeStart === undefined || this.timeRangeEnd === undefined) {
      throw new Error("Time range not set");
    }

    // Skip frames before start time
    if (frameTimeMs < this.timeRangeStart) {
      frame.close();
      return;
    }

    // Stop processing after end time
    if (frameTimeMs > this.timeRangeEnd) {
      frame.close();
      return;
    }

    while (this.hasPreviousPromise) {
      await this.waitForPreviousPromise();
    }

    try {
      this.drawFrame(frame);
      if (this.timestampRenderer) {
        this.timestampRenderer.draw(this.ctx, frameTimeMs);
      }

      const videoFrameOptions = {
        timestamp: frame.timestamp,
        duration: frame.duration,
      };
      frame.close();
      verboseLog(`videoFrameOptions: ${JSON.stringify(videoFrameOptions)}`);
      const newFrame = new VideoFrame(this.canvas, videoFrameOptions);

      this.frame_count++;
      this.frameCountDisplay.textContent = `Processed frames: ${this.frame_count} / ${this.nb_samples}`;
      this.previousPromise = this.encoder.encode(newFrame);
      await this.previousPromise;
    } catch (error) {
      console.error("Error processing frame:", error);
    }
  }

  /**
   * Handles decoded frames from the decoder
   * @param {VideoFrame} frame - Decoded video frame
   * @returns {Promise<void>}
   */
  async handleDecoderOutput(frame) {
    if (this.state === "processing" || this.state === "exhausted") {
      this.outputTaskPromises.push(this.processFrame(frame));
      return;
    }
    if (this.state !== "initialized") {
      frame.close();
      throw new Error("Processor should be in the initialized state");
    }

    // Final phase: Handle preview frame drawing
    this.previewManager.drawPreview(frame, (frame) => this.drawFrame(frame));
    frame.close();
  }

  /**
   * Renders a preview at specified position in video
   * @param {number} percentage - Position in video (0-100)
   * @returns {Promise<void>}
   * @throws {Error} If processor is not in initialized state
   */
  async renderSampleInPercentage(percentage) {
    if (this.state !== "initialized") {
      throw new Error("Processor should be in the initialized state");
    }

    this.lastPreviewPercentage = percentage;

    // Phase 1: Prepare preview and get handle
    const previewHandle = this.previewManager.preparePreview(percentage);

    // Wait for any ongoing operations to complete
    while (this.hasPreviousPromise) {
      await this.waitForPreviousPromise();
    }

    // Phase 2: start preview decoding
    const previewPromise = this.previewManager.executePreview(previewHandle);
    if (previewPromise) {
      this.previousPromise = previewPromise;
    }
  }

  /**
   * Checks if video is currently being processed
   * @returns {boolean} True if processing, false otherwise
   */
  isProcessing() {
    return this.state === "processing";
  }

  /**
   * Waits for current processing operation to complete
   * @returns {Promise<void>}
   */
  async waitForProcessing() {
    if (this.state === "processing") {
      return;
    }
    if (this.processingPromise) {
      await this.processingPromise;
    }
  }

  /**
   * Checks if there is a pending promise from previous operations
   * @returns {boolean} True if there is a pending promise
   */
  get hasPreviousPromise() {
    return this.previousPromise !== null;
  }

  /**
   * Waits for any previous promise to complete before proceeding
   * @returns {Promise<boolean>} Resolves to true when previous promise is completed
   */
  async waitForPreviousPromise() {
    let tempPromise = this.previousPromise;
    while (tempPromise) {
      await tempPromise;
      if (tempPromise === this.previousPromise) {
        break;
      }
      tempPromise = this.previousPromise;
    }
    this.previousPromise = null;
    return true;
  }
}
