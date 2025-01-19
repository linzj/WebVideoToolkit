import { SampleManager } from "./sampleManager.js";

/**
 * Manages video preview functionality by coordinating sample selection,
 * frame decoding, and preview rendering.
 */
export class PreviewManager {
  /**
   * Creates a new PreviewManager instance
   * @param {VideoDecoder} decoder - The video decoder instance
   * @param {SampleManager} sampleManager - The sample manager instance
   */
  constructor(decoder, sampleManager) {
    this.decoder = decoder;
    this.sampleManager = sampleManager;
    // Handle used to track the current preview request
    this.previewFrameTimeStamp = 0;
  }

  /**
   * Phase 1: Prepares samples for preview at given percentage position
   * @param {number} percentage - Position in video (0-100)
   * @returns {number} Timestamp to be used as handle for this preview request
   */
  preparePreview(percentage) {
    const samples = this.sampleManager.findSamplesAtPercentage(percentage);
    const timeStamp = SampleManager.sampleTimeMs(samples[samples.length - 1]);
    this.samples = samples;
    this.previewFrameTimeStamp = timeStamp;
    return timeStamp;
  }

  /**
   * Phase 2: Validates the preview handle and initiates decoding if valid
   * @param {number} handle - Preview handle from phase 1
   * @returns {Promise|null} Decoder flush promise if valid, null if invalid
   */
  executePreview(handle) {
    // Skip if handle doesn't match current preview request
    if (handle !== this.previewFrameTimeStamp) {
      return null;
    }

    // Decode all samples for this preview
    for (const sample of this.samples) {
      const encodedVideoChunk =
        SampleManager.encodedVideoChunkFromSample(sample);
      this.decoder.decode(encodedVideoChunk);
    }
    return this.decoder.flush();
  }

  /**
   * Final phase: Handles the actual drawing of the preview frame
   * @param {number} handle - Preview handle to validate
   * @param {VideoFrame} frame - The decoded video frame
   * @param {Function} drawFrameCallback - Callback to render the frame
   */
  drawPreview(frame, drawFrameCallback) {
    // Compare the stored preview frame timestamp (in seconds)
    // with the incoming frame timestamp (converting from milliseconds to seconds)
    // Skip processing if timestamps don't match when rounded down
    if (
      Math.floor(this.previewFrameTimeStamp) !==
      Math.floor(frame.timestamp / 1000.0)
    ) {
      return;
    }
    // Draw the frame and clean up
    drawFrameCallback(frame);
    // Reset handle after successful preview
    this.previewFrameTimeStamp = 0;
  }
}
