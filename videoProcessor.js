import { verboseLog, performanceLog, kDecodeQueueSize } from "./logging.js";
import { SampleManager } from "./sampleManager.js";
import { VideoEncoder } from "./videoEncoder.js";
import { TimeStampRenderer } from "./timeStampRenderer.js";
import { VideoFrameRenderer } from "./videoFrameRenderer.js";
import { VideoDecoder, MP4Demuxer } from "./videoDecoder.js";
import { PreviewManager } from "./previewManager.js";

export class VideoProcessor {
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
  }

  setStatus(phase, message) {
    this.status.textContent = `${phase}: ${message}`;
  }

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

  async processFile() {
    if (this.state !== "initialized") {
      throw new Error("Processor is not initializing");
    }
    while (this.hasPreviousPromise) {
      await this.waitForPreviousPromise();
    }

    let startTime =
      this.timestampProvider.getUserStartTime() ||
      this.mp4StartTime ||
      new Date();
    // Only create timestampRenderer if timestamp is enabled
    this.timestampRenderer = this.timestampProvider.isEnabled()
      ? new TimeStampRenderer(startTime)
      : null;
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

  async processFileByTime(startMs, endMs) {
    this.startProcessVideoTime = performance.now();

    [this.nb_samples, this.timeRangeStart, this.timeRangeEnd] =
      this.sampleManager.finalizeTimeRange(startMs, endMs);
    await this.processFile();
  }

  async processFileByFrame(startIndex, endIndex) {
    this.startProcessVideoTime = performance.now();
    [this.nb_samples, this.timeRangeStart, this.timeRangeEnd] =
      this.sampleManager.finalizeSampleInIndex(startIndex, endIndex);
    await this.processFile();
  }

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

  async processVideo(uri) {
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setup(config),
      setStatus: (phase, message) => this.setStatus(phase, message),
      sampleManager: this.sampleManager,
    });
  }

  async setup(config) {
    // If browser is chrome based.
    if (navigator.userAgent.toLowerCase().includes("chrome")) {
      this.isChromeBased = true;
    }
    await this.setupDecoder(config);
    this.setupCanvas(config.codedWidth, config.codedHeight);
    await this.setupEncoder(config.codedWidth, config.codedHeight, config.fps);
    this.frameRenderer.setup(
      config.codedWidth,
      config.codedHeight,
      config.matrix
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

  async setupEncoder(width, height, fps) {
    this.encoder = new VideoEncoder();
    await this.encoder.init(width, height, fps, !this.isChromeBased, true);
  }

  drawFrame(frame) {
    this.frameRenderer.drawFrame(frame);
  }

  get hasPreviousPromise() {
    return this.previousPromise !== null;
  }

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
    this.previewManager.drawPreview(frame, (frame) =>
      this.drawFrame(frame)
    );
    frame.close();
  }

  /**
   * Handles preview rendering at specified percentage of video
   * @param {number} percentage - Position in video (0-100)
   */
  async renderSampleInPercentage(percentage) {
    if (this.state !== "initialized") {
      throw new Error("Processor should be in the initialized state");
    }

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

  isProcessing() {
    return this.state === "processing";
  }

  async waitForProcessing() {
    if (this.state === "processing") {
      return;
    }
    if (this.processingPromise) {
      await this.processingPromise;
    }
  }
}
