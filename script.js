class VideoEncoder {
  constructor(canvas, mp4File) {
    this.canvas = canvas;
    this.mp4File = mp4File;
    this.encoder = null;
    this.trackId = null;
    this.firstKeyFrame = true;
    this.spsData = null;
    this.ppsData = null;
  }

  async init(width, height) {
    console.log("Initializing encoder with dimensions:", { width, height });

    // Calculate maximum dimensions for Level 5.1 (4096x2304)
    const maxWidth = 4096;
    const maxHeight = 2304;
    let targetWidth = width;
    let targetHeight = height;

    // Scale down if needed while maintaining aspect ratio
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      targetWidth = Math.floor(width * ratio);
      targetHeight = Math.floor(height * ratio);
      console.log("Scaling video to:", { targetWidth, targetHeight });
    }

    // Calculate appropriate bitrate (0.2 bits per pixel per frame)
    const pixelCount = targetWidth * targetHeight;
    const bitsPerPixel = 0.2;
    const targetBitrate = Math.min(
      Math.floor(pixelCount * bitsPerPixel * 30),
      50_000_000 // Cap at 50Mbps for Level 5.1
    );

    const config = {
      codec: "avc1.640033", // Level 5.1 supports up to 4096x2304
      width: targetWidth,
      height: targetHeight,
      // bitrate: targetBitrate,
      framerate: 30,
      avc: { format: "annexb" },
    };

    // Initialize MP4Box with explicit file type
    this.trackId = this.mp4File.addTrack({
      type: "avc1",
      codecs: "avc1.640033",
      width: targetWidth,
      height: targetHeight,
      timescale: 30000,
      framerate: {
        fixed: true,
        fps: 30,
      },
    });

    console.log("Track ID returned:", this.trackId);

    if (!this.trackId || this.trackId < 0) {
      throw new Error(`Invalid track ID returned: ${this.trackId}`);
    }

    this.encoder = new window.VideoEncoder({
      output: async (chunk, cfg) => {
        try {
          const buffer = new ArrayBuffer(chunk.byteLength);
          const initialView = new Uint8Array(buffer);
          chunk.copyTo(initialView);

          let frameData = initialView;

          if (chunk.type === "key") {
            const nalUnits = this.parseNALUnits(initialView);
            for (const nal of nalUnits) {
              const nalType = nal[0] & 0x1f;
              if (nalType === 7 && !this.spsData) {
                this.spsData = nal;
                console.log("Found SPS:", this.spsData);
              } else if (nalType === 8 && !this.ppsData) {
                this.ppsData = nal;
                console.log("Found PPS:", this.ppsData);
              }
            }

            if (this.spsData && this.ppsData && this.firstKeyFrame) {
              this.firstKeyFrame = false;
              const avcC = this.createAVCCBox();
              this.setAvccBox(this.trackId, avcC);
            }

            if (this.spsData && this.ppsData) {
              frameData = this.createFullFrame(initialView);
            }
          }

          const sample = {
            data: frameData,
            duration: Math.round((chunk.duration * 30000) / 1000000),
            dts: Math.round((chunk.timestamp * 30000) / 1000000),
            cts: Math.round((chunk.timestamp * 30000) / 1000000),
            is_sync: chunk.type === "key",
          };

          this.mp4File.addSample(this.trackId, sample.data, sample);
        } catch (error) {
          console.error("Error processing video chunk:", error);
        }
      },
      error: (e) => console.error("Encoding error:", e),
    });

    await this.encoder.configure(config);
  }

  parseNALUnits(data) {
    const nalUnits = [];
    let offset = 0;

    while (offset < data.length - 4) {
      if (
        data[offset] === 0 &&
        data[offset + 1] === 0 &&
        data[offset + 2] === 0 &&
        data[offset + 3] === 1
      ) {
        const start = offset + 4;
        let end = data.length;

        for (let i = start; i < data.length - 4; i++) {
          if (
            data[i] === 0 &&
            data[i + 1] === 0 &&
            data[i + 2] === 0 &&
            data[i + 3] === 1
          ) {
            end = i;
            break;
          }
        }

        nalUnits.push(data.slice(start, end));
        offset = end;
      } else {
        offset++;
      }
    }

    return nalUnits;
  }

  createAVCCBox() {
    return {
      configurationVersion: 1,
      AVCProfileIndication: this.spsData[1],
      profile_compatibility: this.spsData[2],
      AVCLevelIndication: this.spsData[3],
      lengthSizeMinusOne: 3,
      nb_SPS: 1,
      SPS: [this.spsData],
      nb_PPS: 1,
      PPS: [this.ppsData],
    };
  }

  createFullFrame(initialView) {
    const fullFrame = new Uint8Array(
      4 + this.spsData.length + 4 + this.ppsData.length + initialView.length
    );

    let offset = 0;
    // Add SPS
    fullFrame.set([0, 0, 0, 1], offset);
    offset += 4;
    fullFrame.set(this.spsData, offset);
    offset += this.spsData.length;

    // Add PPS
    fullFrame.set([0, 0, 0, 1], offset);
    offset += 4;
    fullFrame.set(this.ppsData, offset);
    offset += this.ppsData.length;

    // Add frame data
    fullFrame.set(initialView, offset);

    return fullFrame;
  }

  setAvccBox(trackId, avcC) {
    const track = this.mp4File.getTrackById(trackId);
    if (
      track &&
      track.trak &&
      track.trak.mdia &&
      track.trak.mdia.minf &&
      track.trak.mdia.minf.stbl &&
      track.trak.mdia.minf.stbl.stsd
    ) {
      const stsd = track.trak.mdia.minf.stbl.stsd;
      if (!stsd.entries) stsd.entries = [];
      if (!stsd.entries[0]) {
        stsd.entries[0] = {
          type: "avc1",
          width: track.width,
          height: track.height,
          avcC: avcC,
        };
      } else {
        stsd.entries[0].avcC = avcC;
      }
    }
  }

  async encode(frame) {
    this.encoder.encode(frame);
    frame.close();
    if (this.encoder.encodeQueueSize > 80) {
      await this.encoder.flush();
    }
  }

  async finalize() {
    await this.encoder.flush();
    this.encoder.close();
    this.mp4File.save("processed-video.mp4");
  }
}

class VideoProcessor {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.status = document.getElementById("status");
    document.getElementById("canvasContainer").appendChild(this.canvas);
    this.mp4File = null;
    this.encoder = null;
    this.frameCountDisplay = document.getElementById("frameCount");
    this.nb_samples = 0;
    this.frame_count = 0;
    this.isFinalized = false;
    this.previousPromise = null;
    this.rotation = 0;
    this.startTime = 0;
  }

  setStatus(phase, message) {
    this.status.textContent = `${phase}: ${message}`;
  }

  setRotation(rotation) {
    this.rotation = rotation;
  }

  async processFile(file) {
    try {
      const videoURL = URL.createObjectURL(file);
      await this.processVideo(videoURL);
      URL.revokeObjectURL(videoURL);
    } catch (error) {
      console.error("Error processing video:", error);
      this.setStatus("error", error.message);
    }
  }

  async processVideo(uri) {
    const demuxer = new MP4Demuxer(uri, {
      onConfig: (config) => this.setupDecoder(config),
      onChunk: (chunk) => this.decoder.decode(chunk),
      setStatus: (phase, message) => this.setStatus(phase, message),
      onChunkEnd: () => {
        this.decoder.flush();
      },
    });
  }

  async setupDecoder(config) {
    // Initialize the decoder
    this.decoder = new VideoDecoder({
      output: (frame) => this.processFrame(frame),
      error: (e) => console.error(e),
    });

    await this.decoder.configure(config);
    this.setStatus("decode", "Decoder configured");

    // Set up canvas dimensions
    if (config.rotation === 90 || config.rotation === 270) {
      this.canvas.width = config.codedHeight;
      this.canvas.height = config.codedWidth;
    } else {
      this.canvas.width = config.codedWidth;
      this.canvas.height = config.codedHeight;
    }
    this.mp4File = MP4Box.createFile({ ftyp: "isom" });
    this.encoder = new VideoEncoder(this.canvas, this.mp4File);
    this.encoder.init(config.codedWidth, config.codedHeight);
    this.nb_samples = config.nb_samples;
    this.frame_count = 0;
    this.frameCountDisplay.textContent = `Processed frames: 0 / ${this.nb_samples}`;
    this.setRotation(config.rotation);
    this.startTime = config.startTime || Date.now();
  }

  async processFrame(frame) {
    if (this.previousPromise) {
      await this.previousPromise;
    }
    try {
      this.ctx.save();

      // Apply rotation if needed
      if (this.rotation === 180) {
        this.ctx.scale(1, -1);
        this.ctx.translate(0, -this.canvas.height);
      } else if (this.rotation === 90) {
        this.ctx.translate(this.canvas.width, 0);
        this.ctx.rotate((90 * Math.PI) / 180);
      }

      // Draw the frame
      this.ctx.drawImage(frame, 0, 0);

      this.ctx.restore();

      // Convert frame.timestamp (microseconds) to milliseconds and add to startTime
      const frameTime = new Date(
        this.startTime.getTime() + Math.floor(frame.timestamp / 1000)
      );
      const timestamp = frameTime
        .toLocaleString("sv", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        .replace(" ", " "); // Ensure proper spacing

      this.ctx.fillStyle = "white";
      this.ctx.font = "20px Arial";
      this.ctx.textAlign = "right";
      this.ctx.fillText(
        timestamp,
        this.canvas.width - 10,
        this.canvas.height - 10
      );

      const newFrame = new VideoFrame(this.canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration,
      });

      frame.close();
      this.frame_count++;
      this.frameCountDisplay.textContent = `Processed frames: ${this.frame_count} / ${this.nb_samples}`;
      this.previousPromise = this.encoder.encode(newFrame);
      await this.previousPromise;
      if (this.frame_count === this.nb_samples) {
        this.encoder.finalize();
      }
    } catch (error) {
      console.error("Error processing frame:", error);
    }
  }
}

// MP4 demuxer class implementation
class MP4Demuxer {
  constructor(uri, { onConfig, onChunk, setStatus, onChunkEnd }) {
    this.onConfig = onConfig;
    this.onChunk = onChunk;
    this.setStatus = setStatus;
    this.onChunkEnd = onChunkEnd;
    this.file = MP4Box.createFile();

    this.file.onError = (error) => setStatus("demux", error);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.nb_samples = 0;
    this.processed_samples = 0;
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

  getRotationFromMatrix(transformationMatrix) {
    // Matrix format: [a, b, u, c, d, v, x, y, w]
    // For 180° rotation: [-1, 0, 0, 0, -1, 0, 0, 0, 1] (scaled by 65536)
    const [a, b] = transformationMatrix;

    if (a === -65536 && b === 0) {
      return 180;
    }
    if (a == 0 && b == 65536) {
      return 90;
    }
    return 0;
  }

  onReady(info) {
    this.transformationMatrix = info.matrix;
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
      rotation: this.getRotationFromMatrix(track.matrix),
      startTime: startTime,
    });
    this.nb_samples = track.nb_samples;

    this.file.setExtractionOptions(track.id);
    this.file.start();
  }

  onSamples(track_id, ref, samples) {
    for (const sample of samples) {
      this.onChunk(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (1e6 * sample.cts) / sample.timescale,
          duration: (1e6 * sample.duration) / sample.timescale,
          data: sample.data,
        })
      );
    }
    this.processed_samples += samples.length;
    if (this.processed_samples === this.nb_samples) this.onChunkEnd();
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

// Event listener for file input
document.getElementById("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const processor = new VideoProcessor();

  try {
    await processor.processFile(file);
  } catch (error) {
    console.error("Error processing video:", error);
    processor.status.textContent = "Error processing video";
  }
});
