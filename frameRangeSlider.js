/**
 * Manages a dual-thumb slider for selecting a frame range from a video.
 * It handles user input, updates the slider's visual representation,
 * and provides the selected frame range.
 */
export class FrameRangeSlider {
  /**
   * Initializes the slider by querying DOM elements and setting up initial state.
   */
  constructor() {
    this.timeSelectionRadios = document.getElementsByName("timeSelection");
    this.sliderContainer = document.querySelector(".slider-container");
    this.timeInputs = document.querySelector(".time-inputs");
    this.thumbStart = document.getElementById("thumbStart");
    this.thumbEnd = document.getElementById("thumbEnd");
    this.sliderTrack = document.querySelector(".slider-track");
    this.sliderRange = document.querySelector(".slider-range");
    this.startFrameDisplay = document.getElementById("startFrame");
    this.endFrameDisplay = document.getElementById("endFrame");
    this.totalFramesDisplay = document.getElementById("totalFrames");

    this.isDragging = null;
    this.startPercent = 0;
    this.endPercent = 100;
    this.totalFrames = 0;

    this.initializeEventListeners();
  }

  /**
   * Sets up event listeners for the time selection radio buttons and slider thumbs.
   */
  initializeEventListeners() {
    this.timeSelectionRadios.forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const useSlider = e.target.value === "slider";
        this.sliderContainer.classList.toggle("visible", useSlider);
        this.timeInputs.classList.toggle("visible", !useSlider);
      });
    });

    // Add mouse and touch events to both thumbs
    [this.thumbStart, this.thumbEnd].forEach((thumb) => {
      thumb.addEventListener("mousedown", this.handleStart.bind(this));
      thumb.addEventListener("touchstart", this.handleStart.bind(this));
    });
  }

  /**
   * Handles the start of a drag operation on a slider thumb.
   * @param {MouseEvent|TouchEvent} e - The event object.
   */
  handleStart(e) {
    e.preventDefault();
    const thumb = e.target;
    this.isDragging = thumb.id;

    const handleMove = (e) => this.handleMove(e);
    const handleEnd = (e) => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleEnd);
      document.removeEventListener("touchmove", handleMove);
      document.removeEventListener("touchend", handleEnd);
      this.isDragging = null;
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleEnd);
    document.addEventListener("touchmove", handleMove);
    document.addEventListener("touchend", handleEnd);
  }

  /**
   * Handles the movement of a slider thumb during a drag operation.
   * @param {MouseEvent|TouchEvent} e - The event object.
   */
  handleMove(e) {
    if (!this.isDragging) return;

    const rect = this.sliderTrack.getBoundingClientRect();
    const clientX = e.type.includes("touch") ? e.touches[0].clientX : e.clientX;

    let percent = ((clientX - rect.left) / rect.width) * 100;
    percent = Math.max(0, Math.min(100, percent));

    if (this.isDragging === "thumbStart") {
      this.startPercent = Math.min(percent, this.endPercent - 1);
      this.onUpdatePercentage(this.startPercent);
    } else {
      this.endPercent = Math.max(percent, this.startPercent + 1);
      this.onUpdatePercentage(this.endPercent);
    }

    this.updateSliderDisplay();
  }

  /**
   * Initializes the slider with the total number of frames.
   * @param {number} totalFrames - The total number of frames in the video.
   */
  initialize(totalFrames) {
    this.totalFramesDisplay.textContent = totalFrames;
    this.totalFrames = totalFrames;
    this.updateSliderDisplay();
  }

  /**
   * Updates the visual display of the slider, including thumb positions and frame numbers.
   */
  updateSliderDisplay() {
    this.thumbStart.style.left = `${this.startPercent}%`;
    this.thumbEnd.style.left = `${this.endPercent}%`;
    this.sliderRange.style.left = `${this.startPercent}%`;
    this.sliderRange.style.width = `${this.endPercent - this.startPercent}%`;

    const totalFrames = parseInt(this.totalFramesDisplay.textContent) || 0;
    const startFrame = Math.floor((this.startPercent / 100) * totalFrames);
    const endFrame = Math.floor((this.endPercent / 100) * totalFrames);

    this.startFrameDisplay.textContent = startFrame;
    this.endFrameDisplay.textContent = endFrame;
  }

  /**
   * Checks if the slider mode is currently active.
   * @returns {boolean} - True if the slider is visible, false otherwise.
   */
  isSliderModeActive() {
    return this.sliderContainer.classList.contains("visible");
  }

  /**
   * Gets the selected frame range.
   * @returns {{startFrame: number, endFrame: number}} - The start and end frames.
   */
  getFrameRange() {
    const totalFrames = this.totalFrames;
    return {
      startFrame: Math.floor((this.startPercent / 100) * totalFrames),
      endFrame: Math.floor((this.endPercent / 100) * totalFrames),
    };
  }

  /**
   * Callback function that is called when the percentage of the slider changes.
   * @param {number} percentage - The new percentage value.
   */
  onUpdatePercentage(percentage) {
    if (this.onupdatepercentage) {
      this.onupdatepercentage(percentage);
    }
  }
}
