import { VideoFrameRenderer } from "./videoFrameRenderer.js";
import { TimeStampRenderer } from "./timeStampRenderer.js";

/**
 * UIManager handles all interactions with the DOM, including canvas rendering and status updates.
 */
export class UIManager {
  /**
   * Creates a new UIManager instance.
   * @param {Object} config - Configuration object.
   * @param {HTMLCanvasElement} config.canvas - Canvas element for frame rendering.
   * @param {HTMLElement} config.statusElement - Element to display processing status.
   * @param {HTMLElement} config.frameCountDisplay - Element to display frame count.
   * @param {Object} config.timestampProvider - Provider for timestamp operations.
   */
  constructor({ canvas, statusElement, frameCountDisplay, timestampProvider }) {
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    this.statusElement = statusElement;
    this.frameCountDisplay = frameCountDisplay;
    this.timestampProvider = timestampProvider;

    this.frameRenderer = new VideoFrameRenderer(this.ctx);
    this.timestampRenderer = null;

    this.videoWidth = 0;
    this.videoHeight = 0;
    this.zoom = 1.0;
    this.rotation = 0;
    this.matrix = null;
  }

  /**
   * Sets the status message displayed to the user.
   * @param {string} phase - Current processing phase.
   * @param {string} message - Status message to display.
   */
  setStatus(phase, message) {
    this.statusElement.textContent = `${phase}: ${message}`;
  }

  /**
   * Updates the frame count display.
   * @param {number} processed - Number of frames processed.
   * @param {number} total - Total number of frames to process.
   */
  updateFrameCount(processed, total) {
    this.frameCountDisplay.textContent = `Processed frames: ${processed} / ${total}`;
  }

  /**
   * Configures the UI manager with video metadata.
   * @param {number} videoWidth - The coded width of the video.
   * @param {number} videoHeight - The coded height of the video.
   * @param {number[]} matrix - The video's transformation matrix.
   * @param {number} zoom - The initial zoom level.
   * @param {number} rotation - The initial rotation.
   */
  setup(videoWidth, videoHeight, matrix, zoom, rotation) {
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.zoom = zoom;
    this.rotation = rotation;
    this.matrix = matrix;
    this.frameRenderer.setup(videoWidth, videoHeight, matrix, zoom);
    this.updateRotation(rotation); // This will also setup canvas
  }

  /**
   * Updates the rotation of the video display.
   * @param {number} rotation - The new rotation in degrees.
   */
  updateRotation(rotation) {
    this.rotation = rotation;
    this.frameRenderer.updateRotation(this.rotation);
    const { width, height } = this.getCanvasDimensions();
    this.setupCanvas(width, height);
  }

  /**
   * Updates the zoom of the video display.
   * @param {number} zoom - The new zoom value.
   */
  updateZoom(zoom) {
    this.zoom = zoom;
    this.frameRenderer.setup(
      this.videoWidth,
      this.videoHeight,
      this.matrix,
      zoom
    );
    const { width, height } = this.getCanvasDimensions();
    this.setupCanvas(width, height);
  }

  /**
   * Sets the canvas dimensions.
   * @param {number} width - The new width.
   * @param {number} height - The new height.
   */
  setupCanvas(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * Calculates canvas dimensions based on video dimensions, rotation, and zoom.
   * @returns {{width: number, height: number}} The calculated dimensions.
   */
  getCanvasDimensions() {
    const isSideways = this.rotation % 180 !== 0;
    const width = isSideways
      ? this.videoHeight * this.zoom
      : this.videoWidth * this.zoom;
    const height = isSideways
      ? this.videoWidth * this.zoom
      : this.videoHeight * this.zoom;
    return { width, height };
  }

  /**
   * Renders a frame to the canvas.
   * @param {VideoFrame} frame - Frame to render.
   */
  drawFrame(frame) {
    this.frameRenderer.drawFrame(frame);
  }

  /**
   * Draws the timestamp overlay on the canvas if enabled.
   * @param {number} frameTimeMs - The timestamp of the current frame in milliseconds.
   */
  drawTimestamp(frameTimeMs) {
    if (this.timestampRenderer) {
      this.timestampRenderer.draw(this.ctx, frameTimeMs);
    }
  }

  /**
   * Creates and configures the timestamp renderer.
   * @param {Date | null} userStartTime - The user-defined start time.
   * @param {Date} mp4StartTime - The start time from the video metadata.
   * @param {number} timeRangeStart - The start of the processing time range in ms.
   */
  createTimestampRenderer(userStartTime, mp4StartTime, timeRangeStart) {
    if (!this.timestampProvider.isEnabled()) {
      this.timestampRenderer = null;
      return;
    }

    let startTime = userStartTime || mp4StartTime || new Date();
    this.timestampRenderer = new TimeStampRenderer(startTime);

    if (userStartTime) {
      this.timestampRenderer.updateExtraTimeOffsetMS(-timeRangeStart);
    }
  }
}
