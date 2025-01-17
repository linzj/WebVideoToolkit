export class VideoFrameRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.matrix = null;
    this.width = 0;
    this.height = 0;
  }

  setup(width, height, matrix) {
    this.width = width;
    this.height = height;
    this.matrix = matrix;
  }

  drawFrame(frame) {
    this.ctx.save();

    if (this.matrix) {
      const scale = 1 / 65536;
      const [a, b, u, c, d, v, x, y, w] = this.matrix.map((val) => val * scale);

      if (a === -1 && d === -1) {
        this.ctx.translate(this.width, this.height);
        this.ctx.rotate(Math.PI);
      } else if (a === 0 && b === 1 && c === -1 && d === 0) {
        this.ctx.translate(this.width, 0);
        this.ctx.rotate(Math.PI / 2);
      } else if (a === 0 && b === -1 && c === 1 && d === 0) {
        this.ctx.translate(0, this.height);
        this.ctx.rotate(-Math.PI / 2);
      }
    }

    this.ctx.drawImage(frame, 0, 0);
    this.ctx.restore();
  }
}
