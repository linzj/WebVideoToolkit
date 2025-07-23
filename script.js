import { TimeStampProvider } from "./timeStampProvider.js";
import { TimeRangeProvider } from "./timeRangeProvider.js";
import { VideoProcessor } from "./videoProcessor.js";
import { FrameRangeSlider } from "./frameRangeSlider.js";
import { ErrorHandler } from "./errorHandler.js";
import { infoLog, errorLog } from "./logging.js";

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
let errorHandler = null;

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

  try {
    // Initialize error handler if not already done
    if (!errorHandler) {
      errorHandler = new ErrorHandler({
        setStatus: (phase, message) => {
          document.getElementById(
            "status"
          ).textContent = `${phase}: ${message}`;
        },
      });
    }

    // Reset processor if it exists
    if (processor != null) {
      if (processor.isProcessing()) {
        await processor.waitForProcessing();
      }
      processor.shutdown();
    }

    infoLog("Main", "Initializing video processor", { fileName: file.name });

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

      // Show initial preview at first frame when file is loaded and samples are ready
      processor.renderSampleInPercentage(0);

      infoLog("Main", "Video processor initialized", {
        sampleCount: nb_samples,
      });
    };

    await processor.initFile(file);
  } catch (error) {
    errorLog("Main", "Failed to initialize video processor", error);
    document.getElementById("processButton").disabled = true;
    document.getElementById("status").textContent = `Error: ${error.message}`;
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
    infoLog("Main", "Starting video processing");

    if (frameRangeSlider.isSliderModeActive()) {
      const { startFrame, endFrame } = frameRangeSlider.getFrameRange();
      infoLog("Main", "Processing by frame range", { startFrame, endFrame });
      await processor.processFileByFrame(startFrame, endFrame);
    } else {
      const { startMs, endMs } = timeRangeProvider.getTimeRange();
      infoLog("Main", "Processing by time range", { startMs, endMs });
      await processor.processFileByTime(startMs, endMs);
    }

    infoLog("Main", "Video processing completed successfully");
  } catch (error) {
    errorLog("Main", "Error processing video", error);
    if (errorHandler) {
      await errorHandler.handleError(error, "processing", {
        showToUser: true,
        critical: false,
      });
    } else {
      document.getElementById("status").textContent = "Error processing video";
    }
  } finally {
    document.getElementById("processButton").disabled = false;
  }
});

/**
 * Event listener for the zoom slider.
 * Updates the video zoom in the processor.
 */
document.getElementById("zoomSlider").addEventListener("input", async (e) => {
  const zoom = e.target.value / 100;
  document.getElementById("zoomValue").textContent = `${e.target.value}%`;

  if (processor && processor.state === "initialized") {
    await processor.updateZoom(zoom);
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
