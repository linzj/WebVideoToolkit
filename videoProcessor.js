import { verboseLog, performanceLog, kDecodeQueueSize } from "./logging.js";
import { SampleManager } from "./sampleManager.js";
import { VideoEncoder } from "./videoEncoder.js";
import { TimeStampRenderer } from "./timeStampRenderer.js";

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
    this.matrix = null; // replace this.rotation with this.matrix
    this.startTime = 0;
    this.timeRangeStart = undefined;
    this.timeRangeEnd = undefined;
    this.userStartTime = null;
    this.outputTaskPromises = [];
    this.startProcessVideoTime = undefined;
    this.sampleManager = new SampleManager();
    this.timestampRenderer = null;
    this.timestampProvider = timestampProvider;
  }

  setStatus(phase, message) {
    this.status.textContent = `${phase}: ${message}`;
  }

  setMatrix(matrix) {
    this.matrix = matrix;
  }

  validateTimestampInput(input) {
    const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (input.value && !regex.test(input.value)) {
      alert("Invalid timestamp format. Please use YYYY-MM-DD HH:MM:SS");
      input.value = "";
      return false;
    }
    return true;
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
    }
  }

  async processFile(file, startMs, endMs) {
    this.timeRangeStart = startMs;
    this.timeRangeEnd = endMs;

    if (!this.timestampProvider.validateTimestampInput()) {
      return;
    }

    this.userStartTime = this.timestampProvider.getUserStartTime();
    if (!this.timestampProvider.hasValidStartTime()) {
      return;
    }

    try {
      const videoURL = URL.createObjectURL(file);
      await this.processVideo(videoURL);
      URL.revokeObjectURL(videoURL);
    } catch (error) {
      console.error("Error processing video:", error);
      this.setStatus("error", error.message);
    }
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
    setTimeout(() => {
      const n = kDecodeQueueSize - this.decoder.decodeQueueSize; // Number of chunks to request
      if (n > 0) {
        this.dispatch(n);
      }
      this.timerDispatch(); // Call the timerDispatch function again after 0ms  (next tick) to keep the process running
    }, 1000);
  }

  async processVideo(uri) {
    this.startProcessVideoTime = performance.now();
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setupDecoder(config),
      setStatus: (phase, message) => this.setStatus(phase, message),
      sampleManager: this.sampleManager,
    });
  }

  async setupDecoder(config) {
    // Initialize the decoder
    this.decoder = new VideoDecoder({
      output: (frame) => this.outputTaskPromises.push(this.processFrame(frame)),
      error: (e) => console.error(e),
    });

    let isChromeBased = false;
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
      isChromeBased = true;
    }

    await this.decoder.configure(config);
    this.setStatus("decode", "Decoder configured");

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
    await this.encoder.init(canvasWidth, canvasHeight, config.fps);
    this.frame_count = 0;
    this.frameCountDisplay.textContent = `Processed frames: 0 / ${this.nb_samples}`;
    this.setMatrix(config.matrix);
    this.startTime = this.userStartTime || config.startTime || new Date();
    // Only create timestampRenderer if timestamp is enabled
    this.timestampRenderer = this.timestampProvider.isEnabled()
      ? new TimeStampRenderer(this.startTime)
      : null;
    this.nb_samples = this.sampleManager.finalizeTimeRange(
      this.timeRangeStart,
      this.timeRangeEnd
    );
    this.state = "processing";
    // Kick off the processing.
    this.dispatch(kDecodeQueueSize);
    if (!isChromeBased) {
      this.timerDispatch();
    }
  }

  async processFrame(frame) {
    const frameTimeMs = Math.floor(frame.timestamp / 1000);

    // Skip frames before start time
    if (
      this.timeRangeStart !== undefined &&
      frameTimeMs < this.timeRangeStart
    ) {
      frame.close();
      return;
    }

    // Stop processing after end time
    if (this.timeRangeEnd !== undefined && frameTimeMs > this.timeRangeEnd) {
      frame.close();
      return;
    }

    let tempPromise = this.previousPromise;
    while (tempPromise) {
      await tempPromise;
      if (tempPromise === this.previousPromise) {
        break;
      }
      tempPromise = this.previousPromise;
    }

    try {
      this.ctx.save();

      // Apply transformation matrix
      if (this.matrix) {
        // Scale the matrix values back from fixed-point to floating-point
        const scale = 1 / 65536;
        const [a, b, u, c, d, v, x, y, w] = this.matrix.map(
          (val) => val * scale
        );

        if (a === -1 && d === -1) {
          // 180 degree rotation
          this.ctx.translate(this.canvas.width, this.canvas.height);
          this.ctx.rotate(Math.PI);
        } else if (a === 0 && b === 1 && c === -1 && d === 0) {
          // 90 degree rotation
          this.ctx.translate(this.canvas.width, 0);
          this.ctx.rotate(Math.PI / 2);
        } else if (a === 0 && b === -1 && c === 1 && d === 0) {
          // 270 degree rotation
          this.ctx.translate(0, this.canvas.height);
          this.ctx.rotate(-Math.PI / 2);
        }
        // For identity matrix (a=1, d=1) or other transforms, no transformation needed
      }

      // Draw the frame
      this.ctx.drawImage(frame, 0, 0);

      this.ctx.restore();

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
    this.sampleManager.addSamples(samples);
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
