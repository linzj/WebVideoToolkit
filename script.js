class VideoProcessor {
  constructor() {
    this.video = document.createElement("video");
    // Replace OffscreenCanvas with regular canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.border = '1px solid #ccc';
    document.getElementById('canvasContainer').appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.encoder = null;
    this.mp4File = null;
    this.trackId = null;
    this.startTime = performance.now();
    this.frameCount = 0;
    this.status = document.getElementById("status");
    this.frameDuration = 1000 / 30; // 33.33ms per frame at 30fps
    this.avcSequenceHeader = null;
    this.pendingFrames = [];
  }

  async initEncoder(width, height) {
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
      
      // Update canvas dimensions
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
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
      avc: { format: "annexb" }
    };

    this.chunks = [];
    this.maxQueueSize = 30; // Maximum number of chunks to keep in memory
    this.processingChunk = false;
    this.avcSequenceHeader = null;

    // Ensure dimensions match between encoder and canvas
    if (width !== this.canvas.width || height !== this.canvas.height) {
      console.warn("Dimension mismatch:", {
        encoder: `${width}x${height}`,
        canvas: `${this.canvas.width}x${this.canvas.height}`,
      });
      // Update canvas dimensions to match encoder if needed
      this.canvas.width = width;
      this.canvas.height = height;
    }

    // Check if MP4Box is available
    if (typeof MP4Box === "undefined") {
      throw new Error(
        "MP4Box is not loaded. Please check your internet connection."
      );
    }

    // Initialize MP4Box with explicit file type
    this.mp4File = MP4Box.createFile({ ftyp: "isom" });

    // More complete track configuration
    const trackConfig = {
      type: "avc1",
      codecs: "avc1.640033", // Match encoder codec
      width: targetWidth,
      height: targetHeight,
      timescale: 30000,
      framerate: {
        fixed: true,
        fps: 30,
      },
    };

    try {
      console.log("Adding track with config:", trackConfig);

      // Ensure MP4Box is ready
      await new Promise((resolve) => setTimeout(resolve, 0));

      this.trackId = this.mp4File.addTrack(trackConfig);
      console.log("Track ID returned:", this.trackId);

      if (!this.trackId || this.trackId < 0) {
        throw new Error(`Invalid track ID returned: ${this.trackId}`);
      }

      // Initialize basic sample description
      const track = this.mp4File.getTrackById(this.trackId);
      if (!track) {
        throw new Error("Could not get track after creation");
      }

      console.log("Successfully created track with ID:", this.trackId);
    } catch (error) {
      console.error("Track creation error:", error);
      throw new Error(`Failed to add track to MP4 file: ${error.message}`);
    }

    this.firstKeyFrame = true;
    this.spsData = null;
    this.ppsData = null;

    this.encoder = new VideoEncoder({
      output: async (chunk) => {
        try {
          const buffer = new ArrayBuffer(chunk.byteLength);
          const initialView = new Uint8Array(buffer);
          chunk.copyTo(initialView);

          let frameData = initialView; // Use a mutable variable for frame data

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

            // Only add avcC box when we have both SPS and PPS
            if (this.spsData && this.ppsData && this.firstKeyFrame) {
              this.firstKeyFrame = false;
              const avcC = {
                configurationVersion: 1,
                AVCProfileIndication: this.spsData[1],
                profile_compatibility: this.spsData[2],
                AVCLevelIndication: this.spsData[3],
                lengthSizeMinusOne: 3,
                nb_SPS: 1,
                SPS: [this.spsData],
                nb_PPS: 1,
                PPS: [this.ppsData]
              };

              // Update track configuration
              const track = this.mp4File.getTrackById(this.trackId);
              if (track && track.trak && track.trak.mdia && track.trak.mdia.minf && 
                  track.trak.mdia.minf.stbl && track.trak.mdia.minf.stbl.stsd) {
                const stsd = track.trak.mdia.minf.stbl.stsd;
                if (!stsd.entries) stsd.entries = [];
                if (!stsd.entries[0]) {
                  stsd.entries[0] = {
                    type: 'avc1',
                    width: track.width,
                    height: track.height,
                    avcC: avcC
                  };
                }
                stsd.entries[0].avcC = avcC;
                console.log("Added avcC box:", avcC);
              }
            }

            // For key frames, ensure SPS and PPS are included before the frame data
            if (this.spsData && this.ppsData) {
              const fullFrame = new Uint8Array(
                4 + this.spsData.length + 
                4 + this.ppsData.length + 
                initialView.length
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
              
              frameData = fullFrame;
            }
          }

          const sample = {
            data: frameData,
            duration: Math.round((chunk.duration * 30000) / 1000000),
            dts: Math.round((chunk.timestamp * 30000) / 1000000),
            cts: Math.round((chunk.timestamp * 30000) / 1000000),
            is_sync: chunk.type === "key"
          };

          this.mp4File.addSample(this.trackId, sample.data, sample);
        } catch (error) {
          console.error("Error processing video chunk:", error);
          this.status.textContent = "Error processing video chunk";
        }
      },
      error: (e) => console.error("Encoding error:", e)
    });

    await this.encoder.configure(config);
  }

  parseNALUnits(data) {
    const nalUnits = [];
    let offset = 0;
    
    while (offset < data.length - 4) {
      // Look for start code
      if (data[offset] === 0 && data[offset + 1] === 0 &&
          data[offset + 2] === 0 && data[offset + 3] === 1) {
        const start = offset + 4;
        let end = data.length;
        
        // Find next start code
        for (let i = start; i < data.length - 4; i++) {
          if (data[i] === 0 && data[i + 1] === 0 &&
              data[i + 2] === 0 && data[i + 3] === 1) {
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

  async processSample(data, chunk) {
    const sample = {
      data: data,
      duration: Math.round(chunk.duration * 30000 / 1000000),
      dts: Math.round(chunk.timestamp * 30000 / 1000000),
      cts: Math.round(chunk.timestamp * 30000 / 1000000),
      is_sync: chunk.type === 'key'
    };
    
    this.mp4File.addSample(this.trackId, sample.data, sample);
  }

  createAVCCBox(avcData) {
    // Basic avcC box creation - you may need to adjust this based on your exact needs
    const sps = this.findNALUnit(avcData, 7);
    const pps = this.findNALUnit(avcData, 8);
    
    if (!sps || !pps) {
      throw new Error("Could not find SPS or PPS");
    }

    return {
      configurationVersion: 1,
      AVCProfileIndication: sps[1],
      profile_compatibility: sps[2],
      AVCLevelIndication: sps[3],
      lengthSizeMinusOne: 3,
      nb_SPS: 1,
      SPS: [sps],
      nb_PPS: 1,
      PPS: [pps]
    };
  }

  findNALUnit(data, nalType) {
    let offset = 0;
    while (offset < data.length - 4) {
      if (data[offset] === 0 && data[offset + 1] === 0 &&
          data[offset + 2] === 0 && data[offset + 3] === 1) {
        const currentNalType = data[offset + 4] & 0x1F;
        if (currentNalType === nalType) {
          // Find the end of this NAL unit
          let end = offset + 5;
          while (end < data.length - 4) {
            if (data[end] === 0 && data[end + 1] === 0 &&
                data[end + 2] === 0 && data[end + 3] === 1) {
              break;
            }
            end++;
          }
          return data.slice(offset + 4, end);
        }
      }
      offset++;
    }
    return null;
  }

  async getCreationTimeFromMP4Metadata(file) {
    try {
      const buffer = await file.arrayBuffer();
      const dataView = new DataView(buffer);

      // MP4 files start with 'ftyp' atom
      const ftyp = String.fromCharCode(
        dataView.getUint8(4),
        dataView.getUint8(5),
        dataView.getUint8(6),
        dataView.getUint8(7)
      );

      if (ftyp !== "ftyp") return null;

      // File is MP4, try to parse metadata
      let offset = 0;
      while (offset + 8 < dataView.byteLength) {
        const size = dataView.getUint32(offset);
        const type = String.fromCharCode(
          dataView.getUint8(offset + 4),
          dataView.getUint8(offset + 5),
          dataView.getUint8(offset + 6),
          dataView.getUint8(offset + 7)
        );

        if (type === "mvhd") {
          // Found movie header atom
          const version = dataView.getUint8(offset + 8);
          if (version === 0) {
            // Version 0: 32-bit timestamps
            const secondsSince1904 = dataView.getUint32(offset + 12);
            return new Date((secondsSince1904 - 2082844800) * 1000);
          } else if (version === 1) {
            // Version 1: 64-bit timestamps
            const secondsSince1904 = Number(dataView.getBigUint64(offset + 12));
            return new Date((secondsSince1904 - 2082844800n) * 1000n);
          }
          break;
        }

        offset += size;
        if (size === 0) break; // Prevent infinite loop
      }
    } catch (e) {
      console.log("Could not parse video metadata:", e);
    }
    return null;
  }

  async getCreationTimeFromFilesystem(file) {
    try {
      const handle = file;
      if (handle.lastModified) {
        return new Date(handle.lastModified);
      }
    } catch (e) {
      console.log("Could not access file metadata:", e);
    }
    return null;
  }

  async getCreationTime(file) {
    // First try MP4 metadata
    const mp4Time = await this.getCreationTimeFromMP4Metadata(file);
    if (mp4Time) return mp4Time;

    // Fall back to filesystem time
    return await this.getCreationTimeFromFilesystem(file);
  }

  async processFile(file) {
    return new Promise((resolve, reject) => {
      let loadTimeout;
      let isResolved = false;

      const cleanup = () => {
        clearTimeout(loadTimeout);
        this.video.removeEventListener("canplay", onCanPlay);
        this.video.removeEventListener("error", onError);
        this.video.removeEventListener("loadstart", onLoadStart);
        this.video.removeEventListener("progress", onProgress);
      };

      const onLoadStart = () => {
        console.log("Video load started");
      };

      const onProgress = () => {
        console.log("Video loading progress");
      };

      const onCanPlay = async () => {
        if (isResolved) return;
        console.log("Video can play");

        // Double check dimensions are available
        if (!this.video.videoWidth || !this.video.videoHeight) {
          console.log("Waiting for dimensions...");
          return;
        }

        isResolved = true;
        cleanup();

        try {
          const videoWidth = this.video.videoWidth;
          const videoHeight = this.video.videoHeight;

          console.log(`Video dimensions: ${videoWidth}x${videoHeight}`);

          if (!videoWidth || !videoHeight) {
            throw new Error(
              "Invalid video dimensions. Width and height must be greater than 0"
            );
          }

          // Set canvas dimensions before initializing encoder
          this.canvas.width = videoWidth;
          this.canvas.height = videoHeight;

          console.log(
            `Canvas dimensions set to: ${this.canvas.width}x${this.canvas.height}`
          );

          await this.initEncoder(videoWidth, videoHeight);

          const creationTime = await this.getCreationTime(file);
          if (creationTime) {
            const videoDuration = this.video.duration * 1000;
            this.startTime = creationTime.getTime() - videoDuration;
          } else {
            this.startTime = performance.now();
          }

          resolve();
        } catch (error) {
          console.error("Setup error:", error);
          reject(error);
        }
      };

      const onError = (error) => {
        if (isResolved) return;
        isResolved = true;
        cleanup();
        console.error("Video loading error:", error);
        reject(new Error(`Video loading failed: ${error}`));
      };

      // Configure video element
      console.log("Configuring video element");
      this.video = document.createElement("video"); // Create fresh element
      this.video.preload = "auto"; // Changed to auto
      this.video.crossOrigin = "anonymous";
      this.video.muted = true;
      this.video.playsInline = true;

      // Add timeout to prevent hanging
      loadTimeout = setTimeout(() => {
        if (!isResolved) {
          cleanup();
          console.error("Video loading timed out");
          reject(new Error("Video loading timed out"));
        }
      }, 30000);

      // Set up event listeners before source
      this.video.addEventListener("loadstart", onLoadStart);
      this.video.addEventListener("progress", onProgress);
      this.video.addEventListener("canplay", onCanPlay);
      this.video.addEventListener("error", onError);

      // Set source and load
      console.log("Setting video source");
      const objectUrl = URL.createObjectURL(file);
      this.video.src = objectUrl;
      this.video.load();
    });
  }

  processFrame(now, metadata) {
    try {
      // Check if encoder is available
      if (!this.encoder) {
        console.error("Encoder not initialized");
        this.status.textContent = "Error: Encoder not initialized";
        return;
      }

      // Process current frame with potential scaling
      if (this.canvas.width !== this.video.videoWidth || 
          this.canvas.height !== this.video.videoHeight) {
        // Draw with scaling if dimensions differ
        this.ctx.drawImage(this.video, 
          0, 0, this.video.videoWidth, this.video.videoHeight,
          0, 0, this.canvas.width, this.canvas.height
        );
      } else {
        this.ctx.drawImage(this.video, 0, 0);
      }
      
      this.addTimestamp();

      const frame = new VideoFrame(this.canvas, {
        timestamp: metadata.mediaTime * 1000000, // Convert to microseconds
      });

      try {
        this.encoder.encode(frame);
      } catch (encodeError) {
        console.error("Frame encoding error:", encodeError);
      } finally {
        frame.close();
      }

      this.frameCount++;
      this.status.textContent = `Processing frame ${this.frameCount} (${(
        (this.video.currentTime / this.video.duration) *
        100
      ).toFixed(1)}%)`;

      // Request next frame if video is still playing and encoder exists
      if (!this.video.ended && this.encoder) {
        this.video.requestVideoFrameCallback(this.processFrame.bind(this));
      }
    } catch (error) {
      console.error("Frame processing error:", error);
      this.status.textContent = "Error processing frame";
    }
  }

  setupVideoEvents() {
    // Add ended event listener
    const onEnded = () => {
      this.finalizeEncoding();
      this.video.removeEventListener("ended", onEnded);
    };

    this.video.addEventListener("ended", onEnded);
  }

  addTimestamp() {
    const elapsedMs = Math.floor(this.frameCount * this.frameDuration);
    const totalTime = this.startTime + elapsedMs;

    // Convert milliseconds to hh:mm:ss
    const date = new Date(totalTime);
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    const text = `Time: ${hours}:${minutes}:${seconds}`;

    this.ctx.fillStyle = "white";
    this.ctx.font = "20px Arial";
    this.ctx.textAlign = "right";
    this.ctx.textBaseline = "bottom";
    this.ctx.fillText(text, this.canvas.width - 10, this.canvas.height - 10);
  }

  async cleanupResources() {
    // Add canvas cleanup
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    // Close any open VideoFrames
    if (this.currentFrame) {
      this.currentFrame.close();
      this.currentFrame = null;
    }

    // Release canvas resources
    this.ctx = null;
    this.canvas = null;

    // Release video resources
    this.video.src = "";
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.video.src);

    // Force garbage collection (where supported)
    if (typeof gc === "function") {
      gc();
    }
  }

  async finalizeEncoding() {
    try {
      await this.encoder.flush();
      this.encoder.close();
      this.encoder = null;

      await new Promise((resolve, reject) => {
        // Set up file writing
        const outputBuffer = new ArrayBuffer(1024 * 1024 * 100); // 100MB initial buffer
        const outputView = new Uint8Array(outputBuffer);
        let offset = 0;

        this.mp4File.onReady = (info) => {
          this.mp4File.start();
        };

        this.mp4File.onSegment = (id, user, buffer, sampleNum, is_last) => {
          outputView.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        };

        this.mp4File.onFlush = () => {
          // Create download link
          const finalBuffer = outputBuffer.slice(0, offset);
          const blob = new Blob([finalBuffer], { type: "video/mp4" });
          const url = URL.createObjectURL(blob);

          // Create and trigger download
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = url;
          a.download = "processed-video.mp4";
          document.body.appendChild(a);
          a.click();

          // Clean up
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          this.status.textContent = "Processing complete! Video downloaded.";
          resolve();
        };

        // Start MP4 file writing process
        this.mp4File.save("processed-video.mp4");
      });
    } catch (error) {
      console.error("Encoding error:", error);
      this.status.textContent = "Encoding failed";
      throw error;
    } finally {
      await this.cleanupResources();
    }
  }

  setAvccBox(trackId, avcC) {
    const track = this.mp4File.getTrackById(trackId);
    if (track && track.trak && track.trak.mdia && track.trak.mdia.minf && 
        track.trak.mdia.minf.stbl && track.trak.mdia.minf.stbl.stsd) {
      const stsd = track.trak.mdia.minf.stbl.stsd;
      if (!stsd.entries) stsd.entries = [];
      if (!stsd.entries[0]) {
        stsd.entries[0] = {
          type: 'avc1',
          width: track.width,
          height: track.height,
          avcC: avcC
        };
      } else {
        stsd.entries[0].avcC = avcC;
      }
    }
  }
}

document.getElementById("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const processor = new VideoProcessor();

  try {
    await processor.processFile(file);

    // Set up video events before starting playback
    processor.setupVideoEvents();

    // Start frame processing using requestVideoFrameCallback
    processor.video.requestVideoFrameCallback(
      processor.processFrame.bind(processor)
    );
    processor.video.play();
  } catch (error) {
    console.error("Error processing video:", error);
    processor.status.textContent = "Error processing video";
  }
});
