class VideoProcessor {
  constructor() {
    this.video = document.createElement("video");
    this.canvas = new OffscreenCanvas(0, 0);
    this.ctx = this.canvas.getContext("2d");
    this.encoder = null;
    this.chunks = [];
    this.startTime = performance.now();
    this.frameCount = 0;
    this.status = document.getElementById("status");
    this.frameDuration = 1000 / 30; // 33.33ms per frame at 30fps
  }

  async initEncoder(width, height) {
    const config = {
      codec: "avc1.64001e",
      width,
      height,
      bitrate: 5_000_000,
      framerate: 30,
    };

    this.encoder = new VideoEncoder({
      output: (chunk) => this.chunks.push(chunk),
      error: (e) => console.error("Encoding error:", e),
    });

    await this.encoder.configure(config);
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
      const handle = await file.getFile();
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
    this.video.src = URL.createObjectURL(file);
    await this.video.play();

    this.video.addEventListener("loadedmetadata", async () => {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
      this.initEncoder(this.video.videoWidth, this.video.videoHeight);

      const creationTime = await this.getCreationTime(file);

      // If creation time exists, calculate start time based on video duration
      if (creationTime) {
        const videoDuration = this.video.duration * 1000; // Convert to milliseconds
        this.startTime = creationTime.getTime() - videoDuration;
      } else {
        this.startTime = performance.now();
      }

      this.processFrame();
    });
  }

  processFrame() {
    if (this.video.paused || this.video.ended) {
      this.finalizeEncoding();
      return;
    }

    this.ctx.drawImage(this.video, 0, 0);
    this.addTimestamp();

    const frame = new VideoFrame(this.canvas, {
      timestamp: (this.frameCount * 1000) / 30,
    });
    this.encoder.encode(frame);
    frame.close();

    this.frameCount++;
    this.status.textContent = `Processing frame ${this.frameCount}`;

    requestAnimationFrame(() => this.processFrame());
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
    await this.encoder.flush();
    this.encoder.close();

    const blob = new Blob(this.chunks, {
      type: 'video/mp4; codecs="avc1.64001e"',
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "processed-video.mp4";
    a.click();

    this.status.textContent = "Processing complete! Video downloaded.";
    URL.revokeObjectURL(url);
  }
}

document.getElementById("videoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const processor = new VideoProcessor();
  processor.processFile(file);
});
