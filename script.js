import { TimeStampProvider } from "./timeStampProvider.js";
import { TimeRangeProvider } from "./timeRangeProvider.js";
import { VideoProcessor } from "./videoProcessor.js";

// Event listener for file input
document.getElementById("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) {
    document.getElementById("processButton").disabled = true;
    return;
  }

  // Enable the process button when a file is selected
  document.getElementById("processButton").disabled = false;
});

// Add process button click handler
document.getElementById("processButton").addEventListener("click", async () => {
  const file = document.getElementById("videoInput").files[0];
  if (!file) return;

  const timeRangeProvider = new TimeRangeProvider({
    startTimeInput: document.getElementById("startTime"),
    endTimeInput: document.getElementById("endTime"),
  });

  const timestampProvider = new TimeStampProvider({
    timestampStartInput: document.getElementById("timestampStart"),
    enableTimestampCheckbox: document.getElementById("enableTimestamp"),
    timestampInputs: document.getElementById("timestampInputs"),
  });

  const processor = new VideoProcessor({
    canvas: document.getElementById("processorCanvas"),
    statusElement: document.getElementById("status"),
    frameCountDisplay: document.getElementById("frameCount"),
    timestampProvider: timestampProvider,
  });

  try {
    document.getElementById("processButton").disabled = true;
    const { startMs, endMs } = timeRangeProvider.getTimeRange();
    await processor.processFile(file, startMs, endMs);
  } catch (error) {
    console.error("Error processing video:", error);
    processor.status.textContent = "Error processing video";
  } finally {
    document.getElementById("processButton").disabled = false;
  }
});
