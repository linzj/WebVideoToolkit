export class VideoFrameRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.matrix = null;
    this.width = 0;
    this.height = 0;
    this.scale = 1.0;
  }

  setup(width, height, matrix, scale = 1.0) {
    this.width = width;
    this.height = height;
    this.matrix = matrix;
    this.scale = scale;
  }

  drawFrame(frame) {
    this.ctx.save();

    // Calculate scaled dimensions (round up to 64)
    const scaledWidth = Math.ceil(this.width * this.scale / 64) * 64;
    const scaledHeight = Math.ceil(this.height * this.scale / 64) * 64;

    // Calculate offsets to center the frame
    const offsetX = (this.width - scaledWidth) / 2;
    const offsetY = (this.height - scaledHeight) / 2;

    if (this.matrix) {
      const scale = 1 / 65536;
      const [a, b, u, c, d, v, x, y, w] = this.matrix.map((val) => val * scale);

      if (a === -1 && d === -1) {
        this.ctx.translate(scaledWidth, scaledHeight);
        this.ctx.rotate(Math.PI);
      } else if (a === 0 && b === 1 && c === -1 && d === 0) {
        this.ctx.translate(scaledWidth, 0);
        this.ctx.rotate(Math.PI / 2);
      } else if (a === 0 && b === -1 && c === 1 && d === 0) {
        this.ctx.translate(0, scaledHeight);
        this.ctx.rotate(-Math.PI / 2);
      }
    }

    // Draw the frame with scaling and centering
    this.ctx.drawImage(frame, -offsetX, -offsetY, this.width, this.height);
    this.ctx.restore();
  }
}
