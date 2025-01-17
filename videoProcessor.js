import { verboseLog, performanceLog, kDecodeQueueSize } from "./logging.js";
import { SampleManager } from "./sampleManager.js";
import { VideoEncoder } from "./videoEncoder.js";
import { TimeStampRenderer } from "./timeStampRenderer.js";
import { VideoFrameRenderer } from "./videoFrameRenderer.js";

export class VideoProcessor {
  constructor({ canvas, statusElement, frameCountDisplay, timestampProvider }) {
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    this.status = statusElement;
    this.mp4File = null;
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
    this.previewFrameTimeStamp = 0;
    this.processingPromise = null;
    this.processingResolve = null;
    this.mp4StartTime = undefined;
    this.frameRenderer = new VideoFrameRenderer(this.ctx);
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
    while (this.previousPromise) {
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
    setTimeout(() => {
      const n = kDecodeQueueSize - this.decoder.decodeQueueSize; // Number of chunks to request
      if (n > 0) {
        this.dispatch(n);
      }
      this.timerDispatch(); // Call the timerDispatch function again after 0ms  (next tick) to keep the process running
    }, 1000);
  }

  async processVideo(uri) {
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setupDecoder(config),
      setStatus: (phase, message) => this.setStatus(phase, message),
      sampleManager: this.sampleManager,
    });
  }

  async setupDecoder(config) {
    // Initialize the decoder
    this.decoder = new VideoDecoder({
      output: (frame) => this.handleDecoderOutput(frame),
      error: (e) => console.error(e),
    });

    // If browser is chrome based.
    if (navigator.userAgent.toLowerCase().includes("chrome")) {
      this.decoder.ondequeue = () => {
        if (this.state !== "processing") {
          return;
        }
        const n = kDecodeQueueSize - this.decoder.decodeQueueSize; // Number of chunks to request
        if (n > 0) {
          this.dispatch(n);
        }
      };
      this.isChromeBased = true;
    }

    await this.decoder.configure(config);
    this.setStatus("decode", "Decoder configured");
    await this.sampleManager.waitForReady();

    // Set up canvas dimensions - now using matrix[0] and matrix[1] to detect rotation
    let canvasWidth = undefined;
    let canvasHeight = undefined;
    if (config.matrix[0] === 0) {
      // 90 or 270 degree rotation
      canvasWidth = config.codedHeight;
      canvasHeight = config.codedWidth;
    } else {
      canvasWidth = config.codedWidth;
      canvasHeight = config.codedHeight;
    }
    this.canvas.width = canvasWidth;
    this.canvas.height = canvasHeight;
    this.encoder = new VideoEncoder();
    await this.encoder.init(
      canvasWidth,
      canvasHeight,
      config.fps,
      !this.isChromeBased,
      this.isChromeBased
    );
    this.frame_count = 0;
    this.frameCountDisplay.textContent = `Processed frames: 0 / ${this.nb_samples}`;
    this.state = "initialized";
    if (this.onInitialized) {
      this.onInitialized(this.sampleManager.sampleCount());
    }
    this.frameRenderer.setup(canvasWidth, canvasHeight, config.matrix);
    this.mp4StartTime = config.startTime;
  }

  drawFrame(frame) {
    // Replace logic with a call to frameRenderer
    this.frameRenderer.drawFrame(frame);
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

    // let tempPromise = this.previousPromise;
    // while (tempPromise) {
    //   await tempPromise;
    //   if (tempPromise === this.previousPromise) {
    //     break;
    //   }
    //   tempPromise = this.previousPromise;
    // }
    while (this.previousPromise) {
      await this.waitForPreviousPromise();
    }

    try {
      this.drawFrame(frame);
      // Replace the timestamp drawing code with TimeStampRenderer
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
    if (
      Math.floor(this.previewFrameTimeStamp) !==
      Math.floor(frame.timestamp / 1000.0)
    ) {
      frame.close();
      return;
    }
    this.drawFrame(frame);
    frame.close();
    this.previewFrameTimeStamp = 0;
  }

  async renderSampleInPercentage(percentage) {
    if (this.state !== "initialized") {
      throw new Error("Processor should be in the initialized state");
    }

    const samples = this.sampleManager.findSamplesAtPercentage(percentage);
    this.previewFrameTimeStamp = SampleManager.sampleTimeMs(
      samples[samples.length - 1]
    );
    const currentPreviewFrameTs = this.previewFrameTimeStamp;
    while (this.previousPromise) {
      await this.waitForPreviousPromise();
    }

    if (currentPreviewFrameTs !== this.previewFrameTimeStamp) {
      return;
    }

    for (const sample of samples) {
      const encodedVideoChunk =
        SampleManager.encodedVideoChunkFromSample(sample);
      this.decoder.decode(encodedVideoChunk);
    }
    this.previousPromise = this.decoder.flush();
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

// MP4 demuxer class implementation
class MP4Demuxer {
  constructor(uri, { onConfig, setStatus, sampleManager }) {
    this.onConfig = onConfig;
    this.setStatus = setStatus;
    this.file = MP4Box.createFile();

    this.file.onError = (error) => setStatus("demux", error);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.nb_samples = 0;
    this.passed_samples = 0;
    this.stopProcessingSamples = false;
    this.sampleManager = sampleManager;
    this.setupFile(uri);
  }

  async setupFile(uri) {
    const fileSink = new MP4FileSink(this.file, this.setStatus);
    const response = await fetch(uri);
    await response.body.pipeTo(
      new WritableStream(fileSink, { highWaterMark: 2 })
    );
  }

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

  calculateFPS(track) {
    // Convert duration to seconds using timescale
    const durationInSeconds = track.duration / track.timescale;

    // Calculate FPS using number of samples (frames) divided by duration
    const fps = track.nb_samples / durationInSeconds;

    // Round to 2 decimal places for cleaner display
    return Math.round(fps * 100) / 100;
  }

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
      matrix: track.matrix, // Pass matrix directly instead of rotation
      startTime: startTime,
      fps: this.calculateFPS(track),
    });
    this.nb_samples = track.nb_samples;

    this.file.setExtractionOptions(track.id);
    this.file.start();
  }

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

// MP4 file sink implementation
class MP4FileSink {
  constructor(file, setStatus) {
    this.file = file;
    this.setStatus = setStatus;
    this.offset = 0;
  }

  write(chunk) {
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    buffer.fileStart = this.offset;
    this.offset += buffer.byteLength;

    this.setStatus("fetch", `${(this.offset / 1024 / 1024).toFixed(1)} MB`);
    this.file.appendBuffer(buffer);
  }

  close() {
    this.setStatus("fetch", "Complete");
    this.file.flush();
  }
}
