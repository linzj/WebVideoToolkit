class VideoProcessor {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.maxWidth = "100%";
    this.canvas.style.border = "1px solid #ccc";
    document.getElementById("canvasContainer").appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.encoder = null;
    this.decoder = null;
    this.mp4File = null;
    this.trackId = null;
    this.startTime = performance.now();
    this.frameCount = 0;
    this.status = document.getElementById("status");
    this.frameDuration = 1000 / 30; // 33.33ms per frame at 30fps
    this.avcSequenceHeader = null;
    this.pendingFrames = [];
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.totalFrames = 0;
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
      avc: { format: "annexb" },
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
                PPS: [this.ppsData],
              };

              // Update track configuration
              const track = this.mp4File.getTrackById(this.trackId);
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
                }
                stsd.entries[0].avcC = avcC;
                console.log("Added avcC box:", avcC);
              }
            }

            // For key frames, ensure SPS and PPS are included before the frame data
            if (this.spsData && this.ppsData) {
              const fullFrame = new Uint8Array(
                4 +
                  this.spsData.length +
                  4 +
                  this.ppsData.length +
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
            is_sync: chunk.type === "key",
          };

          this.mp4File.addSample(this.trackId, sample.data, sample);
        } catch (error) {
          console.error("Error processing video chunk:", error);
          this.status.textContent = "Error processing video chunk";
        }
      },
      error: (e) => console.error("Encoding error:", e),
    });

    await this.encoder.configure(config);
  }

  parseAVCNALUnits(data) {
    const nalUnits = [];
    let offset = 0;
    const dataView = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength
    );

    // Try to parse as length-prefixed NAL units
    try {
      while (offset + 4 <= data.length) {
        const length = dataView.getUint32(offset);
        offset += 4;

        if (length === 0 || offset + length > data.length) {
          console.log("Invalid NAL unit length:", length);
          break;
        }

        nalUnits.push(data.slice(offset, offset + length));
        offset += length;
      }
    } catch (error) {
      console.log("Error parsing AVC NAL units:", error);
      return [];
    }

    return nalUnits;
  }

  parseNALUnits(data) {
    const nalUnits = [];
    let offset = 0;

    // Try to parse as start code prefixed NAL units
    while (offset < data.length - 4) {
      // Look for start code
      if (
        data[offset] === 0 &&
        data[offset + 1] === 0 &&
        data[offset + 2] === 0 &&
        data[offset + 3] === 1
      ) {
        const start = offset + 4;
        let end = data.length;

        // Find next start code
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

  async processSample(data, chunk) {
    const sample = {
      data: data,
      duration: Math.round((chunk.duration * 30000) / 1000000),
      dts: Math.round((chunk.timestamp * 30000) / 1000000),
      cts: Math.round((chunk.timestamp * 30000) / 1000000),
      is_sync: chunk.type === "key",
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
      PPS: [pps],
    };
  }

  findNALUnit(data, nalType) {
    let offset = 0;
    while (offset < data.length - 4) {
      if (
        data[offset] === 0 &&
        data[offset + 1] === 0 &&
        data[offset + 2] === 0 &&
        data[offset + 3] === 1
      ) {
        const currentNalType = data[offset + 4] & 0x1f;
        if (currentNalType === nalType) {
          // Find the end of this NAL unit
          let end = offset + 5;
          while (end < data.length - 4) {
            if (
              data[end] === 0 &&
              data[end + 1] === 0 &&
              data[end + 2] === 0 &&
              data[end + 3] === 1
            ) {
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
          this.totalFrames = Math.floor(durationInSeconds * 30); // Assuming 30fps
          console.log("Video info:", {
            duration: durationInSeconds,
            timescale: videoTrack.timescale,
            calculatedFrames: durationInSeconds * 30,
            roundedFrames: this.totalFrames,
          });

          // Set canvas dimensions
          this.canvas.width = this.videoWidth;
          this.canvas.height = this.videoHeight;

          console.log(
            `Video dimensions: ${this.videoWidth}x${this.videoHeight}`
          );

          // Initialize decoder with codec validation
          const codecString = videoTrack.codec.toLowerCase();
          if (
            !codecString.startsWith("avc1.") &&
            !codecString.startsWith("h264")
          ) {
            reject(
              new Error(
                `Unsupported codec: ${videoTrack.codec}. Only H.264/AVC is supported.`
              )
            );
            return;
          }

          // Ensure codec string is properly formatted
          const formattedCodec = codecString.startsWith("h264")
            ? `avc1.${codecString.slice(5)}`
            : codecString;

          this.decoder = new VideoDecoder({
            output: this.processDecodedFrame.bind(this),
            error: (error) => {
              console.error("Decoder error:", error);
              this.status.textContent = `Decoder error: ${error.message}`;
            },
          });

          // Get avcC box from video track with enhanced error handling and logging
          let avcC = null;
          console.log("Video track codec:", videoTrack.codec);
          console.log("Video track info:", {
            width: videoTrack.track_width,
            height: videoTrack.track_height,
            timescale: videoTrack.timescale,
            duration: videoTrack.duration,
          });

          // Try different paths to find avcC box
          if (videoTrack.avcC) {
            console.log("Found avcC in videoTrack.avcC:", videoTrack.avcC);
            avcC = videoTrack.avcC;
          } else if (videoTrack.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC) {
            console.log(
              "Found avcC in stsd entries:",
              videoTrack.mdia.minf.stbl.stsd.entries[0].avcC
            );
            avcC = videoTrack.mdia.minf.stbl.stsd.entries[0].avcC;
          } else {
            console.log(
              "No direct avcC box found, checking track structure:",
              videoTrack
            );
          }

          // If no avcC box found, try to extract it from the first few samples
          if (!avcC) {
            console.log(
              "No avcC box found in metadata, attempting to extract from samples..."
            );

            // Set up temporary sample processing
            return new Promise((resolveConfig, rejectConfig) => {
              let sps = null;
              let pps = null;

              const tempOnSamples = (track_id, ref, samples) => {
                if (sps && pps) return; // Already found what we need

                for (const sample of samples) {
                  if (!sample.is_sync) continue; // Only look at keyframes

                  console.log("Processing keyframe sample:", {
                    size: sample.data.byteLength,
                    is_sync: sample.is_sync,
                  });

                  // Try different NAL unit formats
                  let nalUnits = [];
                  const sampleData = new Uint8Array(sample.data);

                  // First try standard format (0x00000001)
                  nalUnits = this.parseNALUnits(sampleData);

                  // If no NAL units found, try alternative format (length prefixed)
                  if (nalUnits.length === 0) {
                    nalUnits = this.parseAVCNALUnits(sampleData);
                  }

                  console.log(`Found ${nalUnits.length} NAL units in sample`);
                  for (const nal of nalUnits) {
                    const nalType = nal[0] & 0x1f;
                    console.log(
                      "NAL unit type:",
                      nalType,
                      "length:",
                      nal.length
                    );

                    // Log first few bytes to help debug
                    const nalHeader = Array.from(
                      nal.slice(0, Math.min(10, nal.length))
                    )
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join(" ");
                    console.log("NAL header bytes:", nalHeader);

                    if (nalType === 7 && !sps) {
                      console.log("Found SPS NAL unit");
                      sps = nal;
                    } else if (nalType === 8 && !pps) {
                      console.log("Found PPS NAL unit");
                      pps = nal;
                    }

                    if (sps && pps) {
                      // Construct avcC box
                      avcC = {
                        configurationVersion: 1,
                        AVCProfileIndication: sps[1],
                        profile_compatibility: sps[2],
                        AVCLevelIndication: sps[3],
                        lengthSizeMinusOne: 3,
                        nb_SPS: 1,
                        SPS: [sps],
                        nb_PPS: 1,
                        PPS: [pps],
                      };

                      console.log("Successfully constructed avcC box");

                      const avcCBuffer = this.avcCToBuffer(avcC);
                      console.log(
                        "Constructed avcC buffer:",
                        new Uint8Array(avcCBuffer)
                      );

                      try {
                        // Configure decoder with the constructed avcC and formatted codec
                        this.decoder.configure({
                          codec: formattedCodec,
                          codedWidth: this.videoWidth,
                          codedHeight: this.videoHeight,
                          description: new Uint8Array(avcCBuffer),
                        });
                        console.log("Decoder configured successfully");

                        // Initialize encoder and continue processing
                        this.initEncoder(this.videoWidth, this.videoHeight)
                          .then(() => {
                            // Restore original onSamples handler
                            demuxer.onSamples = originalOnSamples;

                            // Set up sample processing for all remaining samples
                            demuxer.setExtractionOptions(videoTrack.id, null, {
                              nbSamples: 1000000,
                            });

                            // Get total sample count and set up tracking
                            const totalSamples = videoTrack.nb_samples;
                            let processedSamples = 0;
                            let decoderClosed = false;
                            console.log(
                              `Total samples to process: ${totalSamples}`
                            );

                            // Set up frame processing handler with sample counting
                            demuxer.onSamples = async (
                              track_id,
                              ref,
                              samples
                            ) => {
                              if (decoderClosed) return;

                              console.log(
                                `Processing ${samples.length} samples (${
                                  processedSamples + samples.length
                                }/${totalSamples})`
                              );

                              // Process all samples in this batch
                              for (const sample of samples) {
                                const chunk = new EncodedVideoChunk({
                                  type: sample.is_sync ? "key" : "delta",
                                  timestamp:
                                    (sample.cts * 1000000) / sample.timescale,
                                  duration:
                                    (sample.duration * 1000000) /
                                    sample.timescale,
                                  data: sample.data,
                                });
                                this.decoder.decode(chunk);
                              }
                              processedSamples += samples.length;

                              // Check if we've processed all samples
                              if (
                                processedSamples >= totalSamples &&
                                !decoderClosed
                              ) {
                                decoderClosed = true;
                                console.log(
                                  "All samples processed, flushing decoder"
                                );
                                try {
                                  await this.decoder.flush();
                                  console.log("Decoder flushed, closing");
                                  this.decoder.close();
                                } catch (error) {
                                  console.error(
                                    "Error closing decoder:",
                                    error
                                  );
                                }
                                console.log(
                                  "Decoder finished, finalizing encoding"
                                );
                                this.finalizeEncoding();
                              }
                            };

                            // Start processing
                            console.log("Starting sample processing");
                            demuxer.start();
                            resolveConfig();
                          })
                          .catch(rejectConfig);
                      } catch (error) {
                        console.error("Failed to configure decoder:", error);
                        rejectConfig(error);
                      }

                      return;
                    }
                  }
                }
              };

              // Temporarily override onSamples
              const originalOnSamples = demuxer.onSamples;
              demuxer.onSamples = tempOnSamples;

              // Process more samples to ensure we find a keyframe
              demuxer.setExtractionOptions(videoTrack.id, null, {
                nbSamples: 30, // Increased from 5 to 30
              });
              demuxer.start();

              // Set timeout for fallback
              setTimeout(() => {
                if (demuxer.onSamples === tempOnSamples) {
                  // Only reject if we haven't already found SPS/PPS
                  demuxer.onSamples = originalOnSamples;
                  rejectConfig(new Error("Could not find SPS/PPS in samples"));
                }
              }, 5000);
            });
          } else {
            try {
              // Use existing avcC box with formatted codec
              this.decoder.configure({
                codec: formattedCodec,
                codedWidth: this.videoWidth,
                codedHeight: this.videoHeight,
                description: new Uint8Array(avcC.buffer),
              });
              console.log("Decoder configured successfully with existing avcC");
            } catch (error) {
              console.error(
                "Failed to configure decoder with existing avcC:",
                error
              );
              throw error;
            }
          }

          try {
            // Initialize encoder and set up processing
            await this.initEncoder(this.videoWidth, this.videoHeight);
            console.log("Encoder initialized, setting up sample processing");

            // Set up sample processing for all samples
            demuxer.setExtractionOptions(videoTrack.id, null, {
              nbSamples: 1000000,
            });

            // Set up frame processing handler
            demuxer.onSamples = (track_id, ref, samples) => {
              console.log(`Processing ${samples.length} samples`);
              for (const sample of samples) {
                const chunk = new EncodedVideoChunk({
                  type: sample.is_sync ? "key" : "delta",
                  timestamp: (sample.cts * 1000000) / sample.timescale,
                  duration: (sample.duration * 1000000) / sample.timescale,
                  data: sample.data,
                });
                this.decoder.decode(chunk);
              }
            };

            const creationTime = await this.getCreationTime(file);
            if (creationTime) {
              const videoDuration = (info.duration / info.timescale) * 1000;
              this.startTime = creationTime.getTime() - videoDuration;
            } else {
              this.startTime = performance.now();
            }

            // Get total sample count and set up tracking
            const totalSamples = videoTrack.nb_samples;
            let processedSamples = 0;
            let decoderClosed = false;
            console.log(`Total samples to process: ${totalSamples}`);

            // Set up frame processing handler with sample counting
            demuxer.onSamples = async (track_id, ref, samples) => {
              if (decoderClosed) return;

              console.log(
                `Processing ${samples.length} samples (${
                  processedSamples + samples.length
                }/${totalSamples})`
              );

              // Process all samples in this batch
              for (const sample of samples) {
                const chunk = new EncodedVideoChunk({
                  type: sample.is_sync ? "key" : "delta",
                  timestamp: (sample.cts * 1000000) / sample.timescale,
                  duration: (sample.duration * 1000000) / sample.timescale,
                  data: sample.data,
                });
                this.decoder.decode(chunk);
              }
              processedSamples += samples.length;

              // Check if we've processed all samples
              if (processedSamples >= totalSamples && !decoderClosed) {
                decoderClosed = true;
                console.log("All samples processed, flushing decoder");
                try {
                  await this.decoder.flush();
                  console.log("Decoder flushed, closing");
                  this.decoder.close();
                } catch (error) {
                  console.error("Error closing decoder:", error);
                }
                console.log("Decoder finished, finalizing encoding");
                this.finalizeEncoding();
              }
            };

            // Start processing
            console.log("Starting sample processing");
            demuxer.start();
            resolve();
          } catch (error) {
            console.error("Error setting up processing:", error);
            reject(error);
          }
        };

        demuxer.onError = (error) => reject(error);

        // Create a buffer object that matches MP4Box's expectations
        arrayBuffer.fileStart = 0;

        demuxer.appendBuffer(arrayBuffer);
        demuxer.flush();
      });
    } catch (error) {
      console.error("Error processing file:", error);
      throw error;
    }
  }

  processDecodedFrame(frame) {
    try {
      // Draw frame to canvas with potential scaling
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

      // Create new frame from canvas for encoding
      const newFrame = new VideoFrame(this.canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration,
      });

      try {
        this.encoder.encode(newFrame);
      } catch (encodeError) {
        console.error("Frame encoding error:", encodeError);
      } finally {
        newFrame.close();
      }

      this.frameCount++;
      this.status.textContent = `Processing frame ${this.frameCount}`;

      // Close the original decoded frame
      frame.close();
    } catch (error) {
      console.error("Frame processing error:", error);
      this.status.textContent = "Error processing frame";
    }
  }

  async cleanupResources() {
    if (this.decoder) {
      await this.decoder.flush();
      this.decoder.close();
      this.decoder = null;
    }

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.ctx = null;
    this.canvas = null;

    if (typeof gc === "function") {
      gc();
    }
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
