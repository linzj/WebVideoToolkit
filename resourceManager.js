/**
 * Manages video resources to prevent memory leaks and ensure proper cleanup.
 * Handles VideoFrame objects, canvas contexts, and other video-related resources.
 */
export class ResourceManager {
  constructor() {
    this.activeFrames = new Set();
    this.framePool = [];
    this.maxPoolSize = 10;
    this.cleanupCallbacks = [];
    this.isShuttingDown = false;
    this.cleanupPaused = false;
  }

  /**
   * Registers a VideoFrame for tracking and automatic cleanup.
   * @param {VideoFrame} frame - The VideoFrame to track
   * @param {string} context - Context where the frame was created
   */
  registerFrame(frame, context = "unknown") {
    if (!frame || this.isShuttingDown) {
      return;
    }

    const frameInfo = {
      frame,
      context,
      timestamp: Date.now(),
      closed: false,
    };

    this.activeFrames.add(frameInfo);

    // Add a weak reference cleanup
    const cleanup = () => {
      this.closeFrame(frameInfo);
    };

    // Store cleanup callback
    this.cleanupCallbacks.push(cleanup);

    // Log frame registration in development
    if (process.env.NODE_ENV === "development") {
      console.log(
        `Frame registered: ${context} (active: ${this.activeFrames.size})`
      );
    }
  }

  /**
   * Closes a VideoFrame and removes it from tracking.
   * @param {Object} frameInfo - The frame info object
   */
  closeFrame(frameInfo) {
    if (!frameInfo || frameInfo.closed) {
      return;
    }

    try {
      if (frameInfo.frame && typeof frameInfo.frame.close === "function") {
        frameInfo.frame.close();
      }
      frameInfo.closed = true;
      this.activeFrames.delete(frameInfo);
    } catch (error) {
      console.error("Error closing frame:", error);
    }

    // Log frame closure in development
    if (process.env.NODE_ENV === "development") {
      console.log(
        `Frame closed: ${frameInfo.context} (active: ${this.activeFrames.size})`
      );
    }
  }

  /**
   * Closes all active frames.
   */
  closeAllFrames() {
    const framesToClose = Array.from(this.activeFrames);

    framesToClose.forEach((frameInfo) => {
      this.closeFrame(frameInfo);
    });

    console.log(`Closed ${framesToClose.length} active frames`);
  }

  /**
   * Gets a frame from the pool or creates a new one.
   * @param {Function} createFrame - Function to create a new frame
   * @returns {VideoFrame} - The frame
   */
  getFrameFromPool(createFrame) {
    if (this.framePool.length > 0) {
      const frame = this.framePool.pop();
      this.registerFrame(frame, "pool");
      return frame;
    }

    const newFrame = createFrame();
    this.registerFrame(newFrame, "new");
    return newFrame;
  }

  /**
   * Returns a frame to the pool for reuse.
   * @param {VideoFrame} frame - The frame to return to pool
   */
  returnFrameToPool(frame) {
    if (!frame || this.framePool.length >= this.maxPoolSize) {
      this.closeFrame({ frame, context: "pool-return", closed: false });
      return;
    }

    // Reset frame state if needed
    if (frame.codedWidth && frame.codedHeight) {
      this.framePool.push(frame);
    } else {
      this.closeFrame({ frame, context: "pool-return", closed: false });
    }
  }

  /**
   * Cleans up old frames that have been active for too long.
   * @param {number} maxAgeMs - Maximum age in milliseconds (default: 30 seconds)
   */
  cleanupOldFrames(maxAgeMs = 30000) {
    const now = Date.now();
    const framesToClose = [];

    this.activeFrames.forEach((frameInfo) => {
      if (now - frameInfo.timestamp > maxAgeMs) {
        framesToClose.push(frameInfo);
      }
    });

    framesToClose.forEach((frameInfo) => {
      this.closeFrame(frameInfo);
    });

    if (framesToClose.length > 0) {
      console.log(`Cleaned up ${framesToClose.length} old frames`);
    }
  }

  /**
   * Gets statistics about resource usage.
   * @returns {Object} - Resource statistics
   */
  getStats() {
    return {
      activeFrames: this.activeFrames.size,
      poolSize: this.framePool.length,
      maxPoolSize: this.maxPoolSize,
      isShuttingDown: this.isShuttingDown,
    };
  }

  /**
   * Sets up periodic cleanup to prevent memory leaks.
   * @param {number} intervalMs - Cleanup interval in milliseconds (default: 10 seconds)
   */
  startPeriodicCleanup(intervalMs = 10000) {
    this.cleanupInterval = setInterval(() => {
      if (!this.cleanupPaused) {
        this.cleanupOldFrames();
      }
    }, intervalMs);
  }

  /**
   * Pauses automatic cleanup during critical operations (e.g., video processing).
   */
  pauseCleanup() {
    this.cleanupPaused = true;
  }

  /**
   * Resumes automatic cleanup after critical operations complete.
   */
  resumeCleanup() {
    this.cleanupPaused = false;
  }

  /**
   * Stops periodic cleanup.
   */
  stopPeriodicCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Shuts down the resource manager and cleans up all resources.
   */
  shutdown() {
    this.isShuttingDown = true;
    this.stopPeriodicCleanup();
    this.closeAllFrames();

    // Clear the pool
    this.framePool.forEach((frame) => {
      try {
        if (frame && typeof frame.close === "function") {
          frame.close();
        }
      } catch (error) {
        console.error("Error closing pooled frame:", error);
      }
    });
    this.framePool = [];

    // Execute cleanup callbacks
    this.cleanupCallbacks.forEach((callback) => {
      try {
        callback();
      } catch (error) {
        console.error("Error in cleanup callback:", error);
      }
    });
    this.cleanupCallbacks = [];

    console.log("Resource manager shutdown complete");
  }

  /**
   * Creates a safe wrapper for frame operations that ensures cleanup.
   * @param {Function} operation - The operation to perform with the frame
   * @param {string} context - Context for the operation
   * @returns {Promise} - Promise that resolves when operation is complete
   */
  async withFrame(operation, context = "operation") {
    let frame = null;
    try {
      frame = await operation();
      if (frame) {
        this.registerFrame(frame, context);
      }
      return frame;
    } catch (error) {
      if (frame) {
        this.closeFrame({ frame, context, closed: false });
      }
      throw error;
    }
  }

  /**
   * Safely processes a frame and ensures it's closed afterward.
   * @param {VideoFrame} frame - The frame to process
   * @param {Function} processor - The processing function
   * @param {string} context - Context for the processing
   * @returns {Promise} - Promise that resolves with the processing result
   */
  async processFrame(frame, processor, context = "processing") {
    if (!frame) {
      throw new Error("No frame provided for processing");
    }

    this.registerFrame(frame, context);

    try {
      const result = await processor(frame);
      return result;
    } finally {
      this.closeFrame({ frame, context, closed: false });
    }
  }
}
