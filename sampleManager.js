export class SampleManager {
  static sampleTimeMs(sample) {
    return (sample.cts * 1000) / sample.timescale;
  }

  constructor() {
    this.samples = [];
    this.currentIndex = 0;
    this.finalized = false;
  }

  sampleCount() {
    return this.samples.length;
  }

  addSamples(newSamples) {
    if (this.finalized) {
      throw new Error("Cannot add samples to finalized SampleManager");
    }
    this.samples.push(...newSamples);
  }

  finalizeTimeRange(timeRangeStart, timeRangeEnd) {
    let startIndex = 0;
    let endIndex = this.samples.length;
    let preciousStartIndex = 0;
    let preciousEndIndex = this.samples.length;

    if (timeRangeStart !== undefined) {
      startIndex = this.lowerBound(timeRangeStart);
      preciousStartIndex = startIndex;
      while (startIndex > 0 && !this.samples[startIndex].is_sync) {
        startIndex--;
      }
    }

    if (timeRangeEnd !== undefined) {
      endIndex = this.upperBound(timeRangeEnd);
      preciousEndIndex = endIndex;
      while (
        endIndex < this.samples.length - 1 &&
        !this.samples[endIndex + 1].is_sync
      ) {
        endIndex++;
      }
      endIndex++;
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

  finalizeSampleInIndex(startIndex, endIndex) {
    let preciousStartIndex = startIndex;
    while (startIndex > 0 && !this.samples[startIndex].is_sync) {
      startIndex--;
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

  requestChunks(count, onChunk, onExhausted) {
    let processed = 0;

    while (processed < count && this.currentIndex < this.samples.length) {
      const sample = this.samples[this.currentIndex];
      onChunk(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (1e6 * sample.cts) / sample.timescale,
          duration: (1e6 * sample.duration) / sample.timescale,
          data: sample.data,
        })
      );
      this.currentIndex++;
      processed++;
    }

    if (this.currentIndex >= this.samples.length) {
      onExhausted();
    }

    return processed;
  }

  reset() {
    this.currentIndex = 0;
    this.samples = [];
    this.currentIndex = 0;
    this.finalized = false;
  }
}
