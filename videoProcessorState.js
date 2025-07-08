/**
 * Manages the state transitions for the VideoProcessor.
 * Provides a centralized way to handle state changes and validation.
 */
export class VideoProcessorState {
  constructor() {
    this.currentState = "idle";
    this.processingPromise = null;
    this.processingResolve = null;
    this.previousPromise = null;

    // Define valid state transitions
    this.transitions = {
      idle: ["initializing", "error"],
      initializing: ["initialized", "error"],
      initialized: ["processing", "finalized", "error"],
      processing: ["finalized", "error"],
      finalized: ["initialized", "idle"],
      error: ["idle", "initializing"],
    };
  }

  /**
   * Attempts to transition to a new state.
   * @param {string} newState - The target state
   * @returns {boolean} - True if transition is valid, false otherwise
   */
  transitionTo(newState) {
    const validTransitions = this.transitions[this.currentState];
    if (!validTransitions.includes(newState)) {
      console.error(
        `Invalid state transition from ${this.currentState} to ${newState}`
      );
      return false;
    }

    console.log(`State transition: ${this.currentState} -> ${newState}`);
    this.currentState = newState;
    return true;
  }

  /**
   * Gets the current state.
   * @returns {string} - The current state
   */
  getCurrentState() {
    return this.currentState;
  }

  /**
   * Checks if the processor is in a specific state.
   * @param {string} state - The state to check
   * @returns {boolean} - True if in the specified state
   */
  isInState(state) {
    return this.currentState === state;
  }

  /**
   * Checks if the processor is processing.
   * @returns {boolean} - True if processing
   */
  isProcessing() {
    return this.currentState === "processing";
  }

  /**
   * Checks if the processor is initialized.
   * @returns {boolean} - True if initialized
   */
  isInitialized() {
    return this.currentState === "initialized";
  }

  /**
   * Sets the processing promise and resolve function.
   * @param {Promise} promise - The processing promise
   * @param {Function} resolve - The resolve function
   */
  setProcessingPromise(promise, resolve) {
    this.processingPromise = promise;
    this.processingResolve = resolve;
  }

  /**
   * Gets the processing promise.
   * @returns {Promise|null} - The processing promise
   */
  getProcessingPromise() {
    return this.processingPromise;
  }

  /**
   * Resolves the processing promise.
   */
  resolveProcessing() {
    if (this.processingResolve) {
      this.processingResolve();
      this.processingResolve = null;
      this.processingPromise = null;
    }
  }

  /**
   * Sets the previous promise for preview operations.
   * @param {Promise} promise - The previous promise
   */
  setPreviousPromise(promise) {
    this.previousPromise = promise;
  }

  /**
   * Gets the previous promise.
   * @returns {Promise|null} - The previous promise
   */
  getPreviousPromise() {
    return this.previousPromise;
  }

  /**
   * Clears the previous promise.
   */
  clearPreviousPromise() {
    this.previousPromise = null;
  }

  /**
   * Checks if there is a previous promise.
   * @returns {boolean} - True if there is a previous promise
   */
  hasPreviousPromise() {
    return this.previousPromise !== null;
  }

  /**
   * Resets the state to idle.
   */
  reset() {
    this.currentState = "idle";
    this.processingPromise = null;
    this.processingResolve = null;
    this.previousPromise = null;
  }
}
