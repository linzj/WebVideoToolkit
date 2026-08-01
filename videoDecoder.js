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
        if (n > 0 && this.onDequeue) {
          this.onDequeue(n);
        }
      };
    }

    await this.decoder.configure(config);
  }

  /**
   * Resets the decoder and reconfigures it. Used before each preview seek so
   * that chunks from a previous, unrelated position are not fed to the decoder.
   * @param {object} config - The video decoder configuration.
   */
  async resetAndConfigure(config) {
    if (!this.decoder) return;
    this.decoder.reset();
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
 * Demuxes an MP4 file lazily: only the moov box is parsed up front to build a
 * lightweight sample index; sample data is read from the source File on demand
 * via byte-range slices.
 */
export class MP4Demuxer {
  /**
   * Initializes the MP4Demuxer.
   * @param {File} file - The source MP4 File object.
   * @param {object} config - The configuration object.
   * @param {function} config.onConfig - Callback with the video configuration.
   * @param {function} config.setStatus - Callback to update the status.
   * @param {SampleManager} config.sampleManager - The sample manager to handle the sample index and data.
   */
  constructor(file, { onConfig, setStatus, sampleManager }) {
    this.onConfig = onConfig;
    this.setStatus = setStatus;
    this.sourceFile = file;
    this.file = createFile();

    this.file.onError = (error) => setStatus("demux", error);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.nb_samples = 0;
    this.moovReady = false;
    this.pendingExtraction = null;
    this.sampleManager = sampleManager;
    this.setupFile(file);
  }

  /**
   * Appends a byte range of the source file to the mp4box parser.
   * @param {number} start - Start offset (inclusive).
   * @param {number} end - End offset (exclusive).
   */
  async appendRange(start, end) {
    const buffer = await this.sourceFile.slice(start, end).arrayBuffer();
    buffer.fileStart = start;
    this.setStatus("fetch", `${(end / 1024 / 1024).toFixed(1)} MB`);
    this.file.appendBuffer(buffer);
  }

  /**
   * Reads just enough of the file to locate and parse the moov box:
   * first the head, then the tail (moov at end of file), and as a last
   * resort the whole file sequentially.
   * @param {File} file - The source MP4 File object.
   */
  async setupFile(file) {
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const headSize = Math.min(file.size, CHUNK_SIZE);

    // 1. Read the head of the file.
    await this.appendRange(0, headSize);
    if (this.moovReady) return;

    // 2. moov not in the head: try the tail (faststart not applied).
    if (file.size > headSize) {
      const tailSize = Math.min(file.size - headSize, CHUNK_SIZE);
      await this.appendRange(file.size - tailSize, file.size);
      if (this.moovReady) return;
    }

    // 3. Fallback: read the whole file sequentially.
    for (let pos = headSize; pos < file.size && !this.moovReady; pos += CHUNK_SIZE) {
      await this.appendRange(pos, Math.min(pos + CHUNK_SIZE, file.size));
    }
    if (!this.moovReady) {
      throw new Error("Failed to locate the moov box in the file");
    }
  }

  /**
   * Reads the bytes covering the given sample range and extracts the samples.
   * Resolves once expectedCount samples have been delivered via onSamples.
   * @param {number} byteStart - Start offset of the byte range (inclusive).
   * @param {number} byteEnd - End offset of the byte range (exclusive).
   * @param {number} firstSampleNumber - Number of the first sample in the range.
   * @param {number} expectedCount - Number of samples expected in the range.
   * @returns {Promise<void>}
   */
  async extractRange(byteStart, byteEnd, firstSampleNumber, expectedCount) {
    if (this.pendingExtraction) {
      throw new Error("An extraction is already in progress");
    }
    const buffer = await this.sourceFile.slice(byteStart, byteEnd).arrayBuffer();
    buffer.fileStart = byteStart;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.file.stop();
        this.pendingExtraction = null;
        reject(new Error("Sample extraction timed out"));
      }, 30000);
      this.pendingExtraction = { resolve, reject, timeout, received: 0, expectedCount };
      this.file.appendBuffer(buffer);
      this.trak.nextSample = firstSampleNumber;
      this.extractTrak.samples = [];
      this.file.start();
    });
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
   * Called when the demuxer has parsed the moov box. Builds the lightweight
   * sample index and configures on-demand extraction (without starting it).
   * @param {object} info - The file information.
   */
  onReady(info) {
    this.setStatus("demux", "Ready");
    this.moovReady = true;
    const track = info.videoTracks[0];

    // Build the lightweight sample index (no sample data).
    const samplesInfo = this.file.getTrackSamplesInfo(track.id);
    const index = samplesInfo.map((sample) => ({
      number: sample.number,
      cts: sample.cts,
      dts: sample.dts,
      duration: sample.duration,
      timescale: sample.timescale,
      is_sync: sample.is_sync,
      offset: sample.offset,
      size: sample.size,
    }));
    this.sampleManager.setIndex(index);
    this.sampleManager.finalize();

    // Configure on-demand extraction; it is started per byte range in extractRange.
    this.file.setExtractionOptions(track.id, null, { nbSamples: 1 });
    this.trak = this.file.getTrackById(track.id);
    this.extractTrak =
      this.file.extractedTracks[this.file.extractedTracks.length - 1];
    this.sampleManager.setDataLoader((byteStart, byteEnd, firstSampleNumber, expectedCount) =>
      this.extractRange(byteStart, byteEnd, firstSampleNumber, expectedCount)
    );

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

    // Release the head/tail parse buffers where fully consumed.
    this.file.stream.cleanBuffers?.();
  }

  /**
   * Called when samples are extracted on demand. Back-fills the sample data
   * into the index and resolves the pending extraction once complete.
   * @param {number} track_id - The ID of the track.
   * @param {object} ref - Reference object.
   * @param {Array<object>} samples - The extracted samples.
   */
  onSamples(track_id, ref, samples) {
    const pending = this.pendingExtraction;
    if (!pending) return;
    this.sampleManager.backFillData(samples);
    pending.received += samples.length;
    if (pending.received >= pending.expectedCount) {
      clearTimeout(pending.timeout);
      this.file.stop();
      this.pendingExtraction = null;
      this.file.stream.cleanBuffers?.();
      pending.resolve();
    }
  }

  /**
   * Stops any ongoing extraction and releases demuxer resources.
   */
  shutdown() {
    if (this.pendingExtraction) {
      clearTimeout(this.pendingExtraction.timeout);
      this.pendingExtraction.reject(new Error("Demuxer shut down"));
      this.pendingExtraction = null;
    }
    this.file.stop();
    this.file.flush();
  }
}
