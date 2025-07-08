import {
  errorLog,
  warnLog,
  infoLog,
  debugLog,
  verboseLog,
  performanceLog,
  kDecodeQueueSize,
} from "./logging.js";
import { SampleManager } from "./sampleManager.js";
import { VideoDecoder, MP4Demuxer } from "./videoDecoder.js";
import { PreviewManager } from "./previewManager.js";
import { UIManager } from "./uiManager.js";
import { ProcessingPipeline } from "./processingPipeline.js";
import { VideoProcessorState } from "./videoProcessorState.js";
import { ErrorHandler } from "./errorHandler.js";
import { ResourceManager } from "./resourceManager.js";

/**
 * VideoProcessor orchestrates the entire video processing workflow, including UI management,
 * previewing, and coordinating the processing pipeline.
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
    this.uiManager = new UIManager({
      canvas,
      statusElement,
      frameCountDisplay,
      timestampProvider,
    });

    // Initialize new systems
    this.stateManager = new VideoProcessorState();
    this.errorHandler = new ErrorHandler(this.uiManager);
    this.resourceManager = new ResourceManager();

    this.sampleManager = new SampleManager();
    this.timestampProvider = timestampProvider;
    this.isChromeBased = navigator.userAgent.toLowerCase().includes("chrome");

    this.startProcessVideoTime = undefined;
    this.mp4StartTime = undefined;
    this.decoder = null; // For previewing only
    this.previewManager = null;
    this.lastPreviewPercentage = 0.0;

    // Configuration and state properties
    this.zoom = 1.0;
    this.rotation = 0;
    this.fps = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.matrix = undefined;
    this.videoConfig = null;
    this.nb_samples = 0;
    this.frame_count = 0;
    this.timeRangeStart = undefined;
    this.timeRangeEnd = undefined;
    this.pipeline = null;

    // Start periodic cleanup
    this.resourceManager.startPeriodicCleanup();

    infoLog("VideoProcessor", "VideoProcessor initialized");
  }

  /**
   * Sets the initial rotation of the video based on the video's matrix.
   * @param {number[]} matrix - The video's transformation matrix.
   */
  setInitialRotation(matrix) {
    if (!matrix) return;

    const scale = 1 / 65536;
    const [a, b, , c, d] = matrix.map((val) => val * scale);

    let rotation = 0;
    if (a === 0 && b === 1 && c === -1 && d === 0) {
      rotation = 90;
    } else if (a === 0 && b === -1 && c === 1 && d === 0) {
      rotation = -90;
    } else if (a === -1 && d === -1) {
      rotation = 180;
    }
    this.updateRotation(rotation);
  }

  /**
   * Gets the current state of the processor.
   * @returns {string} The current state.
   */
  get state() {
    return this.stateManager.getCurrentState();
  }

  /**
   * Updates the rotation of the video.
   * @param {number} rotation - The new rotation in degrees.
   */
  async updateRotation(rotation) {
    this.rotation = rotation;
    this.uiManager.updateRotation(rotation);

    if (this.state === "initialized") {
      await this.renderSampleInPercentage(this.lastPreviewPercentage);
    }
  }

  /**
   * Updates the zoom of the video.
   * @param {number} zoom - The new zoom value.
   */
  async updateZoom(zoom) {
    this.zoom = zoom;
    this.uiManager.updateZoom(zoom);

    if (this.state === "initialized") {
      await this.renderSampleInPercentage(this.lastPreviewPercentage);
    }
  }

  /**
   * Finalizes the video processing, calculating performance metrics.
   * The pipeline finalizes itself separately.
   * @returns {Promise<void>}
   */
  async finalize() {
    if (!this.stateManager.isInState("finalized")) {
      const endProcessVideoTime = performance.now();
      const totalTime = endProcessVideoTime - this.startProcessVideoTime;
      const fps = this.frame_count / (totalTime / 1000);

      performanceLog(
        "VideoProcessing",
        `Total processing time: ${totalTime}ms, FPS: ${fps.toFixed(2)}`,
        totalTime
      );

      this.stateManager.transitionTo("finalized");
      this.stateManager.resolveProcessing();

      infoLog("VideoProcessor", "Video processing finalized", {
        totalTime,
        fps: fps.toFixed(2),
        frameCount: this.frame_count,
      });
    }
  }

  /**
   * Initializes processing for a given file
   * @param {File} file - Video file to process
   * @returns {Promise<void>}
   */
  async initFile(file) {
    // Validate file
    const validation = this.errorHandler.validateVideoFile(file);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }

    // Check browser support
    const browserSupport = this.errorHandler.checkBrowserSupport();
    if (!browserSupport.supported) {
      throw new Error(
        `Browser not supported. Missing features: ${browserSupport.missingFeatures.join(
          ", "
        )}`
      );
    }

    if (!this.stateManager.isInState("idle")) {
      throw new Error("Processor is not idle");
    }

    this.stateManager.transitionTo("initializing");
    infoLog("VideoProcessor", "Starting file initialization", {
      fileName: file.name,
      fileSize: file.size,
    });

    try {
      const videoURL = URL.createObjectURL(file);
      await this.setupDemuxer(videoURL);
      URL.revokeObjectURL(videoURL);
    } catch (error) {
      this.stateManager.transitionTo("error");
      await this.errorHandler.handleError(error, "file loading", {
        showToUser: true,
        critical: false,
      });
      throw error;
    }
  }

  /**
   * Resets the processor state to 'initialized' if it has been finalized.
   * This allows for reprocessing of the video with different settings.
   */
  resetForReprocessing() {
    if (this.stateManager.isInState("finalized")) {
      this.stateManager.transitionTo("initialized");
      this.sampleManager.resetForReprocessing();
      debugLog("VideoProcessor", "Reset for reprocessing");
    }
  }

  /**
   * Processes the initialized file with current configuration
   * @returns {Promise<void>}
   * @throws {Error} If processor is not in initialized state
   */
  async processFile() {
    this.resetForReprocessing();
    if (!this.stateManager.isInState("initialized")) {
      throw new Error("Processor is not initialized");
    }

    await this.waitForPreviousPromise(); // For preview

    this.frame_count = 0;
    this.uiManager.updateFrameCount(this.frame_count, this.nb_samples);
    this.uiManager.createTimestampRenderer(
      this.timestampProvider.getUserStartTime(),
      this.mp4StartTime,
      this.timeRangeStart
    );

    this.pipeline = new ProcessingPipeline({
      onFrameProcessed: () => {
        this.frame_count++;
        this.uiManager.updateFrameCount(this.frame_count, this.nb_samples);
      },
      onFinalized: () => this.finalize(),
      sampleManager: this.sampleManager,
      uiManager: this.uiManager,
      isChromeBased: this.isChromeBased,
      fps: this.fps,
    });

    try {
      await this.pipeline.setup(this.videoConfig);
    } catch (error) {
      await this.errorHandler.handleError(error, "pipeline setup", {
        showToUser: true,
        critical: true,
      });
      throw error;
    }

    this.stateManager.transitionTo("processing");
    let processingResolve;
    const processingPromise = new Promise((resolve) => {
      processingResolve = resolve;
    });
    this.stateManager.setProcessingPromise(
      processingPromise,
      processingResolve
    );

    try {
      await this.pipeline.start(this.timeRangeStart, this.timeRangeEnd);
    } catch (error) {
      this.stateManager.transitionTo("error");
      await this.errorHandler.handleError(error, "processing", {
        showToUser: true,
        critical: false,
      });
      throw error;
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
    this.uiManager.updateFrameCount(0, this.nb_samples);
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
    this.uiManager.updateFrameCount(0, this.nb_samples);
    await this.processFile();
  }

  /**
   * Sets up video processing from URI
   * @param {string} uri - Video URI to process
   * @returns {Promise<void>}
   */
  async setupDemuxer(uri) {
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setup(config),
      setStatus: (phase, message) => this.uiManager.setStatus(phase, message),
      sampleManager: this.sampleManager,
    });
  }

  /**
   * Configures processor with video metadata for initialization and previewing.
   * @param {Object} config - Video configuration object
   * @returns {Promise<void>}
   */
  async setup(config) {
    try {
      this.videoConfig = config;
      this.videoWidth = config.codedWidth;
      this.videoHeight = config.codedHeight;
      this.matrix = config.matrix;
      this.fps = config.fps;
      this.mp4StartTime = config.startTime;

      infoLog("VideoProcessor", "Video configuration received", {
        width: this.videoWidth,
        height: this.videoHeight,
        fps: this.fps,
        codec: config.codec,
      });

      // Setup decoder for previewing
      await this.setupPreviewDecoder(config);

      this.uiManager.setup(
        this.videoWidth,
        this.videoHeight,
        this.matrix,
        this.zoom,
        this.rotation
      );
      this.setInitialRotation(this.matrix);

      this.frame_count = 0;
      this.uiManager.updateFrameCount(0, 0); // Initially 0 samples

      this.stateManager.transitionTo("initialized");
      this.previewManager = new PreviewManager(
        this.decoder,
        this.sampleManager
      );

      if (this.onInitialized) {
        this.onInitialized(this.sampleManager.sampleCount());
      }

      infoLog("VideoProcessor", "Video processor setup complete");
    } catch (error) {
      this.stateManager.transitionTo("error");
      await this.errorHandler.handleError(error, "initialization", {
        showToUser: true,
        critical: true,
      });
      throw error;
    }
  }

  async setupPreviewDecoder(config) {
    try {
      // This decoder is only for previews. The pipeline will create its own.
      this.decoder = new VideoDecoder({
        onFrame: (frame) => this.handlePreviewDecoderOutput(frame),
        onError: (e) => {
          errorLog("PreviewDecoder", "Decoder error", e);
        },
        // No onDequeue for preview decoder, it's driven on demand.
        isChromeBased: this.isChromeBased,
      });

      await this.decoder.setup(config);
      this.uiManager.setStatus("decode", "Preview Decoder configured");
      await this.sampleManager.waitForReady();

      infoLog("VideoProcessor", "Preview decoder setup complete");
    } catch (error) {
      await this.errorHandler.handleError(error, "preview decoder setup", {
        showToUser: true,
        critical: false,
      });
      throw error;
    }
  }

  /**
   * Handles decoded frames from the preview decoder.
   * @param {VideoFrame} frame - Decoded video frame
   * @returns {Promise<void>}
   */
  async handlePreviewDecoderOutput(frame) {
    if (!this.stateManager.isInState("initialized")) {
      this.resourceManager.closeFrame({
        frame,
        context: "preview",
        closed: false,
      });
      throw new Error(
        "Processor should be in the initialized state for previewing"
      );
    }

    try {
      await this.resourceManager.processFrame(
        frame,
        (f) => {
          this.previewManager.drawPreview(f, (drawFrame) =>
            this.uiManager.drawFrame(drawFrame)
          );
        },
        "preview"
      );
    } catch (error) {
      errorLog("VideoProcessor", "Error handling preview frame", error);
      throw error;
    }
  }

  /**
   * Renders a preview at specified position in video
   * @param {number} percentage - Position in video (0-100)
   * @returns {Promise<void>}
   * @throws {Error} If processor is not in initialized state
   */
  async renderSampleInPercentage(percentage) {
    this.resetForReprocessing();
    if (!this.stateManager.isInState("initialized")) {
      throw new Error("Processor should be in the initialized state");
    }

    this.lastPreviewPercentage = percentage;
    debugLog("VideoProcessor", `Rendering preview at ${percentage}%`);

    try {
      // Phase 1: Prepare preview and get handle
      const previewHandle = this.previewManager.preparePreview(percentage);
      await this.waitForPreviousPromise();

      // Phase 2: start preview decoding
      const previewPromise = this.previewManager.executePreview(previewHandle);
      if (previewPromise) {
        this.stateManager.setPreviousPromise(previewPromise);
      }
    } catch (error) {
      await this.errorHandler.handleError(error, "preview", {
        showToUser: false,
        critical: false,
      });
      throw error;
    }
  }

  /**
   * Checks if video is currently being processed
   * @returns {boolean} True if processing, false otherwise
   */
  isProcessing() {
    return this.stateManager.isProcessing();
  }

  /**
   * Waits for current processing operation to complete
   * @returns {Promise<void>}
   */
  async waitForProcessing() {
    if (!this.stateManager.isProcessing()) {
      return;
    }
    const processingPromise = this.stateManager.getProcessingPromise();
    if (processingPromise) {
      await processingPromise;
    }
  }

  /**
   * Checks if there is a pending promise from previous operations
   * @returns {boolean} True if there is a pending promise
   */
  get hasPreviousPromise() {
    return this.stateManager.hasPreviousPromise();
  }

  /**
   * Waits for any previous promise to complete before proceeding
   * @returns {Promise<boolean>} Resolves to true when previous promise is completed
   */
  async waitForPreviousPromise() {
    let tempPromise = this.stateManager.getPreviousPromise();
    while (tempPromise) {
      await tempPromise;
      if (tempPromise === this.stateManager.getPreviousPromise()) {
        break;
      }
      tempPromise = this.stateManager.getPreviousPromise();
    }
    this.stateManager.clearPreviousPromise();
    return true;
  }

  /**
   * Shuts down the processor and cleans up resources
   */
  shutdown() {
    infoLog("VideoProcessor", "Shutting down video processor");
    this.resourceManager.shutdown();
    this.stateManager.reset();
  }
}
