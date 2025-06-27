/**
 * Handles the rendering of video frames to a canvas, including transformations
 * like scaling and rotation.
 */
export class VideoFrameRenderer {
  /**
   * Initializes the renderer with a 2D canvas context.
   * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.matrix = null;
    this.width = 0;
    this.height = 0;
    this.scale = 1.0;
    this.rotation = 0; // Video rotation in degrees
  }

  /**
   * Sets up the renderer with video dimensions, matrix, and initial scale.
   * @param {number} width - The width of the video.
   * @param {number} height - The height of the video.
   * @param {Array<number>} matrix - The transformation matrix of the video.
   * @param {number} [scale=1.0] - The initial scaling factor.
   */
  setup(width, height, matrix, scale = 1.0) {
    this.width = width;
    this.height = height;
    this.matrix = matrix;
    this.scale = scale;
  }

  /**
   * Updates the rotation of the video frame.
   * @param {number} rotation - The new rotation in degrees.
   */
  updateRotation(rotation) {
    this.rotation = rotation;
  }

  /**
   * Draws a video frame to the canvas, applying scaling and rotation.
   * @param {VideoFrame} frame - The video frame to draw.
   */
  drawFrame(frame) {
    this.ctx.save();

    const canvasWidth = this.ctx.canvas.width;
    const canvasHeight = this.ctx.canvas.height;

    // Translate to the center of the canvas to rotate around the center
    this.ctx.translate(canvasWidth / 2, canvasHeight / 2);
    this.ctx.rotate((this.rotation * Math.PI) / 180);

    // Calculate the crop dimensions based on the scale
    const cropWidth = this.width * this.scale;
    const cropHeight = this.height * this.scale;
    const cropX = (this.width - cropWidth) / 2;
    const cropY = (this.height - cropHeight) / 2;

    // Draw the frame, cropped and scaled, centered on the canvas
    this.ctx.drawImage(
      frame,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      -cropWidth / 2, // Draw at the center of the rotated canvas
      -cropHeight / 2, // Draw at the center of the rotated canvas
      cropWidth,
      cropHeight
    );
    this.ctx.restore();
  }
}
