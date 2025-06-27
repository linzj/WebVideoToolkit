/**
 * Provides functionality to get and validate a time range from user input fields.
 */
export class TimeRangeProvider {
  /**
   * Initializes the provider with the start and end time input elements.
   * @param {object} config - The configuration object.
   * @param {HTMLInputElement} config.startTimeInput - The input element for the start time.
   * @param {HTMLInputElement} config.endTimeInput - The input element for the end time.
   */
  constructor({ startTimeInput, endTimeInput }) {
    this.startTimeInput = startTimeInput;
    this.endTimeInput = endTimeInput;
  }

  /**
   * Converts a time string in "MM:SS" format to milliseconds.
   * @param {string} timeStr - The time string to convert.
   * @returns {number} - The time in milliseconds.
   */
  convertTimeToMs(timeStr) {
    const [minutes, seconds] = timeStr.split(":").map(Number);
    return (minutes * 60 + seconds) * 1000;
  }

  /**
   * Validates the format of a time input field, resetting it if invalid.
   * @param {HTMLInputElement} input - The input element to validate.
   */
  validateTimeInput(input) {
    const regex = /^[0-5][0-9]:[0-5][0-9]$/;
    if (!regex.test(input.value)) {
      input.value = "00:00";
    }
  }

  /**
   * Gets the selected time range in milliseconds.
   * @returns {{startMs: number|undefined, endMs: number|undefined}} - The start and end times.
   */
  getTimeRange() {
    this.validateTimeInput(this.startTimeInput);
    this.validateTimeInput(this.endTimeInput);

    const startMs = this.convertTimeToMs(this.startTimeInput.value);
    const endMs = this.convertTimeToMs(this.endTimeInput.value);

    let timeRangeStart = startMs > 0 ? startMs : undefined;
    let timeRangeEnd = endMs > 0 ? endMs : undefined;

    if (
      timeRangeEnd !== undefined &&
      timeRangeStart !== undefined &&
      timeRangeEnd <= timeRangeStart
    ) {
      timeRangeEnd = undefined;
      this.endTimeInput.value = "00:00";
    }

    return { startMs: timeRangeStart, endMs: timeRangeEnd };
  }
}
