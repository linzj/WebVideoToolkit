/**
 * Centralized error handling for the video processing application.
 * Provides consistent error handling, logging, and user feedback.
 */
export class ErrorHandler {
  constructor(uiManager) {
    this.uiManager = uiManager;
    this.errorCount = 0;
    this.maxRetries = 3;
  }

  /**
   * Handles errors with appropriate logging and user feedback.
   * @param {Error} error - The error object
   * @param {string} context - The context where the error occurred
   * @param {Object} options - Additional options for error handling
   * @param {boolean} options.showToUser - Whether to show error to user
   * @param {boolean} options.retry - Whether to retry the operation
   * @param {Function} options.retryFunction - Function to retry
   */
  async handleError(error, context, options = {}) {
    const {
      showToUser = true,
      retry = false,
      retryFunction = null,
      critical = false,
    } = options;

    // Log the error
    this.logError(error, context);

    // Show user-friendly message if requested
    if (showToUser) {
      this.showUserError(error, context, critical);
    }

    // Handle retry logic
    if (retry && retryFunction && this.errorCount < this.maxRetries) {
      this.errorCount++;
      console.log(
        `Retrying operation (attempt ${this.errorCount}/${this.maxRetries})`
      );

      try {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * this.errorCount)
        ); // Exponential backoff
        return await retryFunction();
      } catch (retryError) {
        return this.handleError(retryError, context, options);
      }
    }

    // Reset error count on success or max retries reached
    if (!retry || this.errorCount >= this.maxRetries) {
      this.errorCount = 0;
    }

    // Re-throw critical errors
    if (critical) {
      throw error;
    }

    return null;
  }

  /**
   * Logs error details for debugging.
   * @param {Error} error - The error object
   * @param {string} context - The context where the error occurred
   */
  logError(error, context) {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      context: context,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };

    console.error("Video Processing Error:", errorInfo);

    // In a production environment, you might want to send this to a logging service
    if (typeof window !== "undefined" && window.gtag) {
      window.gtag("event", "exception", {
        description: `${context}: ${error.message}`,
        fatal: false,
      });
    }
  }

  /**
   * Shows user-friendly error messages.
   * @param {Error} error - The error object
   * @param {string} context - The context where the error occurred
   * @param {boolean} critical - Whether this is a critical error
   */
  showUserError(error, context, critical = false) {
    const userMessage = this.getUserFriendlyMessage(error, context);

    if (this.uiManager) {
      this.uiManager.setStatus("error", userMessage);
    } else {
      // Fallback to alert if no UI manager
      alert(`Error: ${userMessage}`);
    }

    // For critical errors, show additional notification
    if (critical) {
      console.error("Critical error occurred:", error);
    }
  }

  /**
   * Converts technical error messages to user-friendly messages.
   * @param {Error} error - The error object
   * @param {string} context - The context where the error occurred
   * @returns {string} - User-friendly error message
   */
  getUserFriendlyMessage(error, context) {
    const errorMessage = error.message.toLowerCase();

    // Common error patterns and their user-friendly messages
    if (
      errorMessage.includes("not supported") ||
      errorMessage.includes("unsupported")
    ) {
      return "This video format is not supported. Please try a different video file.";
    }

    if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      return "Network error occurred. Please check your internet connection and try again.";
    }

    if (
      errorMessage.includes("memory") ||
      errorMessage.includes("out of memory")
    ) {
      return "The video file is too large to process. Please try a smaller video file.";
    }

    if (
      errorMessage.includes("permission") ||
      errorMessage.includes("access")
    ) {
      return "Permission denied. Please check your browser settings and try again.";
    }

    if (errorMessage.includes("timeout")) {
      return "Operation timed out. Please try again with a shorter video segment.";
    }

    if (errorMessage.includes("codec") || errorMessage.includes("encoding")) {
      return "Video encoding error. Please try a different video format.";
    }

    // Default message based on context
    const contextMessages = {
      "file loading":
        "Failed to load video file. Please check the file and try again.",
      decoding:
        "Failed to decode video. The file may be corrupted or unsupported.",
      encoding: "Failed to encode video. Please try different settings.",
      processing: "Video processing failed. Please try again.",
      preview: "Failed to generate preview. Please try again.",
      initialization:
        "Failed to initialize video processor. Please refresh the page and try again.",
    };

    return (
      contextMessages[context] ||
      "An unexpected error occurred. Please try again."
    );
  }

  /**
   * Validates video file before processing.
   * @param {File} file - The video file to validate
   * @returns {Object} - Validation result with isValid and error properties
   */
  validateVideoFile(file) {
    if (!file) {
      return { isValid: false, error: "No file selected" };
    }

    if (!file.type.startsWith("video/")) {
      return { isValid: false, error: "Selected file is not a video" };
    }

    const maxSize = 500 * 1024 * 1024; // 500MB
    if (file.size > maxSize) {
      return { isValid: false, error: "Video file is too large (max 500MB)" };
    }

    const supportedTypes = [
      "video/mp4",
      "video/webm",
      "video/ogg",
      "video/quicktime",
      "video/x-msvideo",
    ];

    if (!supportedTypes.includes(file.type)) {
      return { isValid: false, error: "Video format not supported" };
    }

    return { isValid: true, error: null };
  }

  /**
   * Checks if the browser supports required features.
   * @returns {Object} - Support check result with supported and missingFeatures properties
   */
  checkBrowserSupport() {
    const missingFeatures = [];

    if (!window.VideoDecoder) {
      missingFeatures.push("VideoDecoder API");
    }

    if (!window.VideoEncoder) {
      missingFeatures.push("VideoEncoder API");
    }

    if (!window.VideoFrame) {
      missingFeatures.push("VideoFrame API");
    }

    if (!window.EncodedVideoChunk) {
      missingFeatures.push("EncodedVideoChunk API");
    }

    const supported = missingFeatures.length === 0;

    if (!supported) {
      console.error("Missing browser features:", missingFeatures);
    }

    return { supported, missingFeatures };
  }
}
