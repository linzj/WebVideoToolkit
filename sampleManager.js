/**
 * Manages video samples, providing functionalities for adding, finalizing,
 * and processing video data. It supports operations like time-based and
 * index-based sample selection, and provides chunks for decoding.
 */
export class SampleManager {
  /**
   * Calculates the timestamp of a sample in milliseconds.
   * @param {object} sample - The video sample.
   * @returns {number} - The sample's timestamp in milliseconds.
   */
  static sampleTimeMs(sample) {
    return (sample.cts * 1000) / sample.timescale;
  }

  /**
   * Creates an EncodedVideoChunk from a video sample.
   * @param {object} sample - The video sample.
   * @returns {EncodedVideoChunk} - The resulting video chunk.
   */
  static encodedVideoChunkFromSample(sample) {
    return new EncodedVideoChunk({
      type: sample.is_sync ? "key" : "delta",
      timestamp: (1e6 * sample.cts) / sample.timescale,
      duration: (1e6 * sample.duration) / sample.timescale,
      data: sample.data,
    });
  }

  /**
   * Initializes a new SampleManager instance.
   */
  constructor() {
    this.samples = [];
    this.originalSamples = null;
    this.currentIndex = 0;
    this.finalized = false;
    this.state = "receiving"; // Initial state
    this.readyPromise = new Promise((resolve) => {
      this.resolveReadyPromise = resolve;
    });
  }

  /**
   * Returns the total number of samples.
   * @returns {number} - The number of samples.
   */
  sampleCount() {
    return this.samples.length;
  }

  /**
   * Adds new samples to the manager.
   * @param {Array<object>} newSamples - An array of new samples to add.
   * @throws {Error} If called after the manager is finalized.
   */
  addSamples(newSamples) {
    if (this.finalized) {
      throw new Error("Cannot add samples to finalized SampleManager");
    }
    this.samples.push(...newSamples);
  }

  /**
   * Waits until the initial set of samples has been received and finalized.
   * @returns {Promise<void>}
   */
  async waitForReady() {
    if (this.state === "finalized") {
      return;
    }
    await this.readyPromise;
  }

  /**
   * Finalizes the initial sample loading, making the manager ready for processing.
   */
  finalize() {
    this.originalSamples = this.samples;
    this.resolveReadyPromise();
    this.resolveReadyPromise = null;
    this.state = "finalized";
  }

  /**
   * Finalizes the sample list to a specific time range.
   * @param {number} timeRangeStart - The start time in milliseconds.
   * @param {number} timeRangeEnd - The end time in milliseconds.
   * @returns {[number, number, number]} - The number of samples, and the actual start and end times.
   */
  finalizeTimeRange(timeRangeStart, timeRangeEnd) {
    this.samples = this.originalSamples;
    let startIndex = 0;
    let endIndex = this.samples.length;
    let preciousStartIndex = 0;
    let preciousEndIndex = this.samples.length - 1;

    if (timeRangeStart !== undefined) {
      startIndex = this.lowerBound(timeRangeStart);
      preciousStartIndex = startIndex;
      // Rewind to the previous keyframe
      while (startIndex > 0 && !this.samples[startIndex].is_sync) {
        startIndex--;
      }
    }

    if (timeRangeEnd !== undefined) {
      endIndex = this.upperBound(timeRangeEnd);
      preciousEndIndex = endIndex;
      // Fast-forward to the next keyframe if the next sample is not a keyframe
      while (
        endIndex < this.samples.length - 1 &&
        !this.samples[endIndex + 1].is_sync
      ) {
        endIndex++;
      }
      endIndex++;
    }

    if (preciousEndIndex >= this.samples.length) {
      preciousEndIndex = this.samples.length - 1;
    }

    if (preciousStartIndex >= this.samples.length) {
      throw new Error("Invalid sample range");
    }

    const outputTimeRangeStart = SampleManager.sampleTimeMs(
      this.samples[preciousStartIndex]
    );
    const outputTimeRangeEnd = SampleManager.sampleTimeMs(
      this.samples[preciousEndIndex]
    );

    this.samples = this.samples.slice(startIndex, endIndex);
    this.currentIndex = 0;
    this.finalized = true;
    return [this.samples.length, outputTimeRangeStart, outputTimeRangeEnd];
  }

  /**
   * Finalizes the sample list to a specific index range.
   * @param {number} startIndex - The starting sample index.
   * @param {number} endIndex - The ending sample index.
   * @returns {[number, number, number]} - The number of samples, and the actual start and end times.
   */
  finalizeSampleInIndex(startIndex, endIndex) {
    this.samples = this.originalSamples;
    let preciousStartIndex = startIndex;
    // Rewind to the previous keyframe
    while (startIndex > 0 && !this.samples[startIndex].is_sync) {
      startIndex--;
    }
    if (endIndex >= this.samples.length) {
      endIndex = this.samples.length - 1;
    }
    // Ensure the last sample has a valid timestamp
    while (endIndex > 0 && !this.samples[endIndex].cts) {
      endIndex--;
    }

    if (startIndex >= endIndex) {
      throw new Error("Invalid sample range");
    }

    const outputTimeRangeStart = SampleManager.sampleTimeMs(
      this.samples[preciousStartIndex]
    );
    const outputTimeRangeEnd = SampleManager.sampleTimeMs(
      this.samples[endIndex]
    );
    this.samples = this.samples.slice(startIndex, endIndex + 1);
    this.currentIndex = 0;
    this.finalized = true;
    return [this.samples.length, outputTimeRangeStart, outputTimeRangeEnd];
  }

  /**
   * Finds the first sample index at or after a given time.
   * @param {number} targetTime - The time in milliseconds.
   * @returns {number} - The sample index.
   */
  lowerBound(targetTime) {
    let left = 0;
    let right = this.samples.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const sampleTimeMs = SampleManager.sampleTimeMs(this.samples[mid]);

      if (sampleTimeMs < targetTime) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return left;
  }

  /**
   * Finds the last sample index at or before a given time.
   * @param {number} targetTime - The time in milliseconds.
   * @returns {number} - The sample index.
   */
  upperBound(targetTime) {
    let left = 0;
    let right = this.samples.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const sampleTimeMs = SampleManager.sampleTimeMs(this.samples[mid]);

      if (sampleTimeMs <= targetTime) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return right;
  }

  /**
   * Requests a number of chunks and provides them via a callback.
   * @param {number} count - The number of chunks to request.
   * @param {function} onChunk - Callback to handle each chunk.
   * @param {function} onExhausted - Callback when all samples are processed.
   * @returns {number} - The number of chunks processed.
   */
  requestChunks(count, onChunk, onExhausted) {
    let processed = 0;

    while (processed < count && this.currentIndex < this.samples.length) {
      const sample = this.samples[this.currentIndex];
      onChunk(SampleManager.encodedVideoChunkFromSample(sample));
      this.currentIndex++;
      processed++;
    }

    if (this.currentIndex >= this.samples.length) {
      onExhausted();
    }

    return processed;
  }

  /**
   * Finds a set of samples around a given percentage of the video for preview.
   * @param {number} percentage - The percentage (0-100) into the video.
   * @returns {Array<object>} - An array of samples for the preview.
   * @throws {Error} If called after the manager is finalized.
   */
  findSamplesAtPercentage(percentage) {
    if (this.finalized) {
      throw new Error("Cannot find sample in finalized SampleManager");
    }
    const sampleIndex = Math.floor(
      (percentage / 100) * (this.samples.length - 1)
    );

    // Rewind to the previous keyframe to ensure decodability
    let keyFrameIndex = sampleIndex;
    while (keyFrameIndex > 0 && !this.samples[keyFrameIndex].is_sync) {
      keyFrameIndex--;
    }
    return this.samples.slice(keyFrameIndex, sampleIndex + 1);
  }

  /**
   * Resets the manager to its initial state.
   */
  reset() {
    this.currentIndex = 0;
    this.samples = [];
    this.originalSamples = null;
    this.currentIndex = 0;
    this.finalized = false;
  }

  /**
   * Resets the manager for reprocessing, keeping the original samples.
   */
  resetForReprocessing() {
    this.currentIndex = 0;
    this.finalized = false;
    this.samples = this.originalSamples;
  }
}
