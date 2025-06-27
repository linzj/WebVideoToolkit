import { TimeStampProvider } from "./timeStampProvider.js";
import { TimeRangeProvider } from "./timeRangeProvider.js";
import { VideoProcessor } from "./videoProcessor.js";
import { FrameRangeSlider } from "./frameRangeSlider.js";

// Initialize the slider, time range, and timestamp providers.
const frameRangeSlider = new FrameRangeSlider();
const timeRangeProvider = new TimeRangeProvider({
  startTimeInput: document.getElementById("startTime"),
  endTimeInput: document.getElementById("endTime"),
});
const timestampProvider = new TimeStampProvider({
  timestampStartInput: document.getElementById("timestampStart"),
  enableTimestampCheckbox: document.getElementById("enableTimestamp"),
  timestampInputs: document.getElementById("timestampInputs"),
});

let processor = null;

/**
 * Event listener for the video input file selection.
 * Initializes the VideoProcessor with the selected file and sets up callbacks.
 */
document.getElementById("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) {
    document.getElementById("processButton").disabled = true;
    return;
  }

  if (file) {
    // Reset processor if it exists
    if (processor != null) {
      if (processor.isProcessing) {
        await processor.waitForProcessing();
      }
    }
    // Initialize the video processor
    processor = new VideoProcessor({
      canvas: document.getElementById("processorCanvas"),
      statusElement: document.getElementById("status"),
      frameCountDisplay: document.getElementById("frameCount"),
      timestampProvider: timestampProvider,
      frameRangeSlider: frameRangeSlider,
    });

    // Set up a callback for when the processor is initialized
    processor.onInitialized = (nb_samples) => {
      frameRangeSlider.initialize(nb_samples);
      document.getElementById("processButton").disabled = false;

      // Set up a callback for slider updates
      frameRangeSlider.onupdatepercentage = (percentage) => {
        processor.renderSampleInPercentage(percentage);
      };
    };
    processor.initFile(file);
  }
});

/**
 * Event listener for the process button.
 * Starts video processing based on the selected mode (slider or time range).
 */
document.getElementById("processButton").addEventListener("click", async () => {
  const file = document.getElementById("videoInput").files[0];
  if (!file) return;

  try {
    document.getElementById("processButton").disabled = true;
    if (frameRangeSlider.isSliderModeActive()) {
      const { startFrame, endFrame } = frameRangeSlider.getFrameRange();
      await processor.processFileByFrame(startFrame, endFrame);
    } else {
      const { startMs, endMs } = timeRangeProvider.getTimeRange();
      await processor.processFileByTime(startMs, endMs);
    }
  } catch (error) {
    console.error("Error processing video:", error);
    processor.status.textContent = "Error processing video";
  } finally {
    document.getElementById("processButton").disabled = false;
  }
});

/**
 * Event listener for the scale slider.
 * Updates the video scale in the processor.
 */
document.getElementById("scaleSlider").addEventListener("input", async (e) => {
  const scale = e.target.value / 100;
  document.getElementById("scaleValue").textContent = `${e.target.value}%`;

  if (processor && processor.state === "initialized") {
    await processor.updateScale(scale);
  }
});

/**
 * Event listener for the clockwise rotation button.
 */
document.getElementById("rotateCW").addEventListener("click", async () => {
  if (processor) {
    await processor.updateRotation((processor.rotation + 90) % 360);
  }
});

/**
 * Event listener for the counter-clockwise rotation button.
 */
document.getElementById("rotateCCW").addEventListener("click", async () => {
  if (processor) {
    await processor.updateRotation((processor.rotation - 90 + 360) % 360);
  }
});
