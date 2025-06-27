/**
 * Manages the timestamp functionality, including UI interactions and
 * validation for the user-provided start time.
 */
export class TimeStampProvider {
  /**
   * Initializes the provider with necessary DOM elements.
   * @param {object} config - The configuration object.
   * @param {HTMLInputElement} config.timestampStartInput - Input for the start timestamp.
   * @param {HTMLInputElement} config.enableTimestampCheckbox - Checkbox to enable/disable timestamps.
   * @param {HTMLElement} config.timestampInputs - The container for timestamp inputs.
   */
  constructor({
    timestampStartInput,
    enableTimestampCheckbox,
    timestampInputs,
  }) {
    this.timestampStartInput = timestampStartInput;
    this.enableTimestampCheckbox = enableTimestampCheckbox;
    this.timestampInputs = timestampInputs;
    this.userStartTime = null;

    // Set up timestamp checkbox handler
    this.enableTimestampCheckbox.addEventListener("change", () => {
      this.timestampInputs.classList.toggle(
        "visible",
        this.enableTimestampCheckbox.checked
      );
    });
  }

  /**
   * Checks if the timestamp functionality is enabled by the user.
   * @returns {boolean} - True if enabled, false otherwise.
   */
  isEnabled() {
    return this.enableTimestampCheckbox.checked;
  }

  /**
   * Validates the format of the user-provided timestamp.
   * @returns {boolean} - True if the format is valid, false otherwise.
   */
  validateTimestampInput() {
    const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (
      this.timestampStartInput.value &&
      !regex.test(this.timestampStartInput.value)
    ) {
      alert("Invalid timestamp format. Please use YYYY-MM-DD HH:MM:SS");
      this.timestampStartInput.value = "";
      return false;
    }
    return true;
  }

  /**
   * Gets the user-defined start time as a Date object.
   * @returns {Date|null} - The start time or null if not provided or invalid.
   */
  getUserStartTime() {
    if (!this.timestampStartInput.value) {
      return null;
    }

    if (!this.validateTimestampInput()) {
      return null;
    }

    const startTime = new Date(this.timestampStartInput.value);
    if (isNaN(startTime.getTime())) {
      alert("Invalid date. Please check your input.");
      return null;
    }
    return startTime;
  }
}
