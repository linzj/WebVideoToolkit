/**
 * Renders timestamp overlay on video frames with dynamic positioning and formatting
 *
 * Usage:
 * 1. Initialize with reference start time (usually video start or user-specified time)
 * 2. Call draw() for each frame with rendering context and frame time offset
 * 3. Use updateExtraTimeOffsetMS() to synchronize with external time adjustments
 */
export class TimeStampRenderer {
  /**
   * @param {Date} startTime - Base reference time for timestamp calculations
   */
  constructor(startTime) {
    this.startTime = startTime; // Reference starting point for all time calculations
    this.extraTimeOffsetMS = 0; // Accumulated offset for time synchronization
  }

  /**
   * Renders formatted timestamp onto canvas context
   * @param {CanvasRenderingContext2D} ctx - Canvas 2D rendering context
   * @param {number} frameTimeMs - Milliseconds offset from start time
   */
  draw(ctx, frameTimeMs) {
    // Calculate absolute time for current frame: base + offset + frame-specific
    const frameTime = new Date(
      this.startTime.getTime() + this.extraTimeOffsetMS + frameTimeMs
    );
    // Format timestamp using Swedish locale for ISO-like format (YYYY-MM-DD HH:mm:ss)
    const timestamp = frameTime
      .toLocaleString("sv", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(" ", " "); // Normalize space separator between date and time

    // Dynamic font sizing: 3% of smallest canvas dimension
    const fontSize = Math.min(ctx.canvas.width, ctx.canvas.height) * 0.03;

    // Configure text rendering context
    ctx.fillStyle = "white"; // White text for contrast
    ctx.font = `${fontSize}px Arial`; // Simple sans-serif font
    ctx.textAlign = "right"; // Right-aligned in lower-right corner

    // Draw text with 10px padding from canvas edge
    ctx.fillText(timestamp, ctx.canvas.width - 10, ctx.canvas.height - 10);
  }

  /**
   * Updates time offset to synchronize with external time sources
   * @param {number} extraTimeOffsetMS - Millisecond offset to apply to base time
   */
  updateExtraTimeOffsetMS(extraTimeOffsetMS) {
    this.extraTimeOffsetMS = extraTimeOffsetMS; // Store cumulative offset
  }
}
