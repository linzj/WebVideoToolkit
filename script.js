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
      bitrate: targetBitrate,
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
      output: async (chunk) => {
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

  encode(frame) {
    this.encoder.encode(frame);
  }

  async finalize() {
    await this.encoder.flush();
    this.encoder.close();
  }
}

class VideoDecoder {
  constructor(canvas, ctx, status) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.status = status;
    this.decoder = null;
    this.frameCount = 0;
    this.startTime = performance.now();
    this.frameDuration = 1000 / 30;
  }

  async init(videoTrack, fileBuffer, onFrameDecoded) {
    try {
      const codecString = videoTrack.codec.toLowerCase();
      if (!codecString.startsWith("avc1.") && !codecString.startsWith("h264")) {
        throw new Error(
          `Unsupported codec: ${videoTrack.codec}. Only H.264/AVC is supported.`
        );
      }

      const formattedCodec = codecString.startsWith("h264")
        ? `avc1.${codecString.slice(5)}`
        : codecString;

      // Get avcC box from video track
      let avcC = null;
      console.log("Looking for avcC box in video track:", videoTrack);

      if (videoTrack.avcC) {
        console.log("Found avcC in videoTrack.avcC:", videoTrack.avcC);
        avcC = videoTrack.avcC;
      } else if (videoTrack.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC) {
        console.log(
          "Found avcC in stsd entries:",
          videoTrack.mdia.minf.stbl.stsd.entries[0].avcC
        );
        avcC = videoTrack.mdia.minf.stbl.stsd.entries[0].avcC;
      }

      if (!avcC) {
        console.log("Attempting to extract avcC from samples...");
        // First get the file data
        const fileData = await this.getVideoData(videoTrack, fileBuffer);
        if (!fileData) {
          throw new Error("Could not get video data");
        }

        // Then extract the AVC configuration
        const configData = await this.extractAVCConfig(fileData);
        if (!configData.sps || !configData.pps) {
          throw new Error("Could not find SPS and PPS");
        }

        avcC = {
          configurationVersion: 1,
          AVCProfileIndication: configData.sps[1],
          profile_compatibility: configData.sps[2],
          AVCLevelIndication: configData.sps[3],
          lengthSizeMinusOne: 3,
          nb_SPS: 1,
          SPS: [configData.sps],
          nb_PPS: 1,
          PPS: [configData.pps],
        };
      }

      if (!avcC) {
        throw new Error("Could not find AVC configuration data");
      }

      console.log("Using avcC:", avcC);
      const avcCBuffer = this.avcCToBuffer(avcC);
      console.log("Created avcC buffer:", new Uint8Array(avcCBuffer));

      this.decoder = new window.VideoDecoder({
        output: (frame) => this.processDecodedFrame(frame, onFrameDecoded),
        error: (error) => {
          console.error("Decoder error:", error);
          this.status.textContent = `Decoder error: ${error.message}`;
        },
      });

      await this.decoder.configure({
        codec: formattedCodec,
        codedWidth: videoTrack.track_width,
        codedHeight: videoTrack.track_height,
        description: new Uint8Array(avcCBuffer),
      });
    } catch (error) {
      console.error("Error initializing decoder:", error);
      throw error;
    }
  }

  async getVideoData(videoTrack, fileBuffer) {
    return new Promise((resolve, reject) => {
      const demuxer = MP4Box.createFile();
      let foundSample = false;

      demuxer.onReady = (info) => {
        console.log("Demuxer ready with info:", info);
        const track = info.videoTracks[0];
        if (!track) {
          reject(new Error("No video track found"));
          return;
        }

        demuxer.setExtractionOptions(track.id, null, { nbSamples: 30 });
        demuxer.onSamples = (track_id, ref, samples) => {
          console.log(`Got ${samples.length} samples`);
          if (!foundSample && samples.length > 0) {
            foundSample = true;
            for (const sample of samples) {
              if (sample.is_sync) {
                console.log("Found sync sample:", {
                  size: sample.data.byteLength,
                  is_sync: sample.is_sync,
                });
                resolve(sample.data);
                return;
              }
            }
          }
        };

        // Start sample extraction
        console.log("Starting sample extraction");
        demuxer.start();
      };

      demuxer.onError = (error) => {
        console.error("Demuxer error:", error);
        reject(error);
      };

      // Use the original file buffer
      console.log("Setting up file data");
      fileBuffer.fileStart = 0;
      demuxer.appendBuffer(fileBuffer);
      demuxer.flush();
    });
  }

  async extractAVCConfig(data) {
    const sampleData = new Uint8Array(data);
    console.log(
      "Sample data first bytes:",
      Array.from(sampleData.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")
    );

    const nalUnits = this.parseNALUnits(sampleData);
    console.log(`Found ${nalUnits.length} NAL units`);

    let sps = null;
    let pps = null;

    for (const nal of nalUnits) {
      const nalType = nal[0] & 0x1f;
      console.log("NAL unit type:", nalType, "length:", nal.length);

      if (nalType === 7 && !sps) {
        console.log("Found SPS NAL unit");
        sps = nal;
      } else if (nalType === 8 && !pps) {
        console.log("Found PPS NAL unit");
        pps = nal;
      }

      if (sps && pps) {
        console.log("Found both SPS and PPS");
        break;
      }
    }

    return { sps, pps };
  }

  parseNALUnits(data) {
    const nalUnits = [];
    let offset = 0;

    // Try Annex B format first (00 00 00 01 or 00 00 01)
    while (offset < data.length - 3) {
      if (
        (data[offset] === 0 &&
          data[offset + 1] === 0 &&
          data[offset + 2] === 0 &&
          data[offset + 3] === 1) ||
        (data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1)
      ) {
        const prefixLen = data[offset + 2] === 1 ? 3 : 4;
        const start = offset + prefixLen;
        let end = data.length;

        // Find next start code
        for (let i = start; i < data.length - 3; i++) {
          if (
            (data[i] === 0 &&
              data[i + 1] === 0 &&
              data[i + 2] === 0 &&
              data[i + 3] === 1) ||
            (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1)
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

    // If no NAL units found, try length-prefixed format
    if (nalUnits.length === 0 && data.length >= 4) {
      offset = 0;
      while (offset + 4 <= data.length) {
        const length =
          (data[offset] << 24) |
          (data[offset + 1] << 16) |
          (data[offset + 2] << 8) |
          data[offset + 3];
        offset += 4;

        if (length > 0 && offset + length <= data.length) {
          nalUnits.push(data.slice(offset, offset + length));
          offset += length;
        } else {
          break;
        }
      }
    }

    return nalUnits;
  }

  avcCToBuffer(avcC) {
    // Calculate total size needed for the buffer
    const totalSize =
      6 + // Version(1) + Profile(1) + Compatibility(1) + Level(1) + Length size(1) + Reserved(1)
      2 + // SPS count(1) + total SPS length(2)
      avcC.SPS.reduce((acc, sps) => acc + 2 + sps.length, 0) + // Each SPS: length(2) + data
      1 + // PPS count(1)
      avcC.PPS.reduce((acc, pps) => acc + 2 + pps.length, 0); // Each PPS: length(2) + data

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Write header
    view.setUint8(offset++, avcC.configurationVersion);
    view.setUint8(offset++, avcC.AVCProfileIndication);
    view.setUint8(offset++, avcC.profile_compatibility);
    view.setUint8(offset++, avcC.AVCLevelIndication);
    view.setUint8(offset++, (avcC.lengthSizeMinusOne & 0x3) | 0xfc); // Reserved bits
    view.setUint8(offset++, (avcC.nb_SPS & 0x1f) | 0xe0); // Reserved bits

    // Write SPS
    for (const sps of avcC.SPS) {
      view.setUint16(offset, sps.length);
      offset += 2;
      new Uint8Array(buffer, offset, sps.length).set(sps);
      offset += sps.length;
    }

    // Write PPS
    view.setUint8(offset++, avcC.nb_PPS);
    for (const pps of avcC.PPS) {
      view.setUint16(offset, pps.length);
      offset += 2;
      new Uint8Array(buffer, offset, pps.length).set(pps);
      offset += pps.length;
    }

    return buffer;
  }

  decode(chunk) {
    this.decoder.decode(chunk);
  }

  processDecodedFrame(frame, onFrameDecoded) {
    try {
      if (
        this.canvas.width !== frame.codedWidth ||
        this.canvas.height !== frame.codedHeight
      ) {
        this.ctx.drawImage(
          frame,
          0,
          0,
          frame.codedWidth,
          frame.codedHeight,
          0,
          0,
          this.canvas.width,
          this.canvas.height
        );
      } else {
        this.ctx.drawImage(frame, 0, 0);
      }

      this.addTimestamp();

      const newFrame = new VideoFrame(this.canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration,
      });

      onFrameDecoded(newFrame);

      this.frameCount++;
      this.status.textContent = `Processing frame ${this.frameCount}`;

      frame.close();
    } catch (error) {
      console.error("Frame processing error:", error);
      this.status.textContent = "Error processing frame";
    }
  }

  addTimestamp() {
    const elapsedMs = Math.floor(this.frameCount * this.frameDuration);
    const totalTime = this.startTime + elapsedMs;

    const date = new Date(totalTime);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    const text = `Time: ${year}-${month}-${day} ${hours}-${minutes}-${seconds}`;

    this.ctx.fillStyle = "white";
    this.ctx.font = "20px Arial";
    this.ctx.textAlign = "right";
    this.ctx.textBaseline = "bottom";
    this.ctx.fillText(text, this.canvas.width - 10, this.canvas.height - 10);
  }

  async close() {
    if (this.decoder) {
      await this.decoder.flush();
      this.decoder.close();
    }
  }
}

class VideoProcessor {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.maxWidth = "100%";
    this.canvas.style.border = "1px solid #ccc";
    document.getElementById("canvasContainer").appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.status = document.getElementById("status");
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.totalFrames = 0;
    this.mp4File = null;
  }

  async processFile(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const demuxer = MP4Box.createFile();

      return new Promise((resolve, reject) => {
        demuxer.onReady = async (info) => {
          if (!info.videoTracks || info.videoTracks.length === 0) {
            reject(new Error("No video track found"));
            return;
          }

          const videoTrack = info.videoTracks[0];
          this.videoWidth = videoTrack.track_width;
          this.videoHeight = videoTrack.track_height;
          const durationInSeconds = videoTrack.duration / videoTrack.timescale;
          this.totalFrames = Math.floor(durationInSeconds * 30);

          this.canvas.width = this.videoWidth;
          this.canvas.height = this.videoHeight;

          console.log(
            `Video dimensions: ${this.videoWidth}x${this.videoHeight}`
          );

          this.mp4File = MP4Box.createFile({ ftyp: "isom" });
          const encoder = new VideoEncoder(this.canvas, this.mp4File);
          const decoder = new VideoDecoder(this.canvas, this.ctx, this.status);

          try {
            await encoder.init(this.videoWidth, this.videoHeight);
            await decoder.init(videoTrack, arrayBuffer, (frame) =>
              encoder.encode(frame)
            );

            demuxer.setExtractionOptions(videoTrack.id, null, {
              nbSamples: 1000000,
            });

            let processedSamples = 0;
            const totalSamples = videoTrack.nb_samples;
            let processingComplete = false;

            demuxer.onSamples = async (track_id, ref, samples) => {
              if (processingComplete) return;

              for (const sample of samples) {
                const chunk = new EncodedVideoChunk({
                  type: sample.is_sync ? "key" : "delta",
                  timestamp: (sample.cts * 1000000) / sample.timescale,
                  duration: (sample.duration * 1000000) / sample.timescale,
                  data: sample.data,
                });
                decoder.decode(chunk);
              }

              processedSamples += samples.length;

              if (processedSamples >= totalSamples && !processingComplete) {
                processingComplete = true;
                await this.finalizeProcessing(encoder, decoder);
                resolve();
              }
            };

            demuxer.start();
          } catch (error) {
            console.error("Error in processing:", error);
            reject(error);
          }
        };

        demuxer.onError = (error) => reject(error);
        arrayBuffer.fileStart = 0;
        demuxer.appendBuffer(arrayBuffer);
        demuxer.flush();
      });
    } catch (error) {
      console.error("Error processing file:", error);
      throw error;
    }
  }

  async finalizeProcessing(encoder, decoder) {
    try {
      await decoder.close();
      await encoder.finalize();

      await new Promise((resolve, reject) => {
        const outputBuffer = new ArrayBuffer(1024 * 1024 * 100);
        const outputView = new Uint8Array(outputBuffer);
        let offset = 0;

        this.mp4File.onReady = () => {
          this.mp4File.start();
        };

        this.mp4File.onSegment = (id, user, buffer) => {
          outputView.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        };

        this.mp4File.onFlush = () => {
          const finalBuffer = outputBuffer.slice(0, offset);
          const blob = new Blob([finalBuffer], { type: "video/mp4" });
          const url = URL.createObjectURL(blob);

          const a = document.createElement("a");
          a.style.display = "none";
          a.href = url;
          a.download = "processed-video.mp4";
          document.body.appendChild(a);
          a.click();

          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          this.status.textContent = "Processing complete! Video downloaded.";
          resolve();
        };

        this.mp4File.save("processed-video.mp4");
      });
    } catch (error) {
      console.error("Error finalizing:", error);
      this.status.textContent = "Processing failed";
      throw error;
    } finally {
      await this.cleanupResources();
    }
  }

  async cleanupResources() {
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.ctx = null;
    this.canvas = null;

    if (typeof gc === "function") {
      gc();
    }
  }
}

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
