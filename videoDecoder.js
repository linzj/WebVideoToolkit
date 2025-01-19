import { kDecodeQueueSize } from "./logging.js";
import { DataStream, createFile } from "mp4box";

export class VideoDecoder {
  constructor({ onFrame, onDequeue, onError, isChromeBased }) {
    this.decoder = null;
    this.onFrame = onFrame;
    this.onDequeue = onDequeue;
    this.onError = onError;
    this.isChromeBased = isChromeBased;
  }

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

  startTimerDispatch(onDispatch) {
    setTimeout(() => {
      const n = kDecodeQueueSize - this.decodeQueueSize;
      onDispatch(n);
    }, 1000);
  }

  get decodeQueueSize() {
    return this.decoder?.decodeQueueSize || 0;
  }

  setState(state) {
    this.state = state;
  }

  decode(chunk) {
    this.decoder?.decode(chunk);
  }

  async flush() {
    await this.decoder?.flush();
  }
}

// MP4 demuxer class implementation
export class MP4Demuxer {
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
      matrix: track.matrix,
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
export class MP4FileSink {
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
