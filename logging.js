export const kEncodeQueueSize = 23;
export const kDecodeQueueSize = kEncodeQueueSize;

// Logging configuration
export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  VERBOSE: 4,
};

export const LogConfig = {
  level: LogLevel.INFO,
  enablePerformanceLogging: true,
  enableConsoleOutput: true,
  enableFileOutput: false,
  maxLogEntries: 1000,
};

class Logger {
  constructor() {
    this.logEntries = [];
    this.performanceMetrics = new Map();
  }

  /**
   * Logs a message with the specified level.
   * @param {number} level - The log level
   * @param {string} context - The context where the log was generated
   * @param {string} message - The log message
   * @param {Object} data - Additional data to log
   */
  log(level, context, message, data = null) {
    if (level > LogConfig.level) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: this.getLevelName(level),
      context,
      message,
      data,
      performance: performance.now(),
    };

    this.logEntries.push(logEntry);

    // Keep only the last maxLogEntries
    if (this.logEntries.length > LogConfig.maxLogEntries) {
      this.logEntries.shift();
    }

    // Console output
    if (LogConfig.enableConsoleOutput) {
      this.outputToConsole(logEntry);
    }

    // File output (if enabled)
    if (LogConfig.enableFileOutput) {
      this.outputToFile(logEntry);
    }
  }

  /**
   * Gets the name of a log level.
   * @param {number} level - The log level
   * @returns {string} - The level name
   */
  getLevelName(level) {
    const names = ["ERROR", "WARN", "INFO", "DEBUG", "VERBOSE"];
    return names[level] || "UNKNOWN";
  }

  /**
   * Outputs a log entry to the console.
   * @param {Object} logEntry - The log entry
   */
  outputToConsole(logEntry) {
    const { level, context, message, data } = logEntry;
    const prefix = `[${level}] [${context}]`;

    switch (level) {
      case "ERROR":
        console.error(prefix, message, data || "");
        break;
      case "WARN":
        console.warn(prefix, message, data || "");
        break;
      case "INFO":
        console.info(prefix, message, data || "");
        break;
      case "DEBUG":
      case "VERBOSE":
        console.log(prefix, message, data || "");
        break;
    }
  }

  /**
   * Outputs a log entry to a file (placeholder for future implementation).
   * @param {Object} logEntry - The log entry
   */
  outputToFile(logEntry) {
    // TODO: Implement file logging
    // This could write to IndexedDB or send to a logging service
  }

  /**
   * Records a performance metric.
   * @param {string} name - The metric name
   * @param {number} value - The metric value
   * @param {string} unit - The unit of measurement
   */
  recordPerformance(name, value, unit = "ms") {
    if (!LogConfig.enablePerformanceLogging) {
      return;
    }

    if (!this.performanceMetrics.has(name)) {
      this.performanceMetrics.set(name, []);
    }

    this.performanceMetrics.get(name).push({
      value,
      unit,
      timestamp: Date.now(),
    });

    // Keep only the last 100 measurements per metric
    const metrics = this.performanceMetrics.get(name);
    if (metrics.length > 100) {
      metrics.shift();
    }
  }

  /**
   * Gets performance statistics for a metric.
   * @param {string} name - The metric name
   * @returns {Object} - Performance statistics
   */
  getPerformanceStats(name) {
    const metrics = this.performanceMetrics.get(name);
    if (!metrics || metrics.length === 0) {
      return null;
    }

    const values = metrics.map((m) => m.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    return {
      name,
      count: values.length,
      average: avg,
      min,
      max,
      total: sum,
    };
  }

  /**
   * Gets all log entries.
   * @returns {Array} - All log entries
   */
  getLogEntries() {
    return [...this.logEntries];
  }

  /**
   * Clears all log entries.
   */
  clearLogs() {
    this.logEntries = [];
  }

  /**
   * Exports logs as JSON.
   * @returns {string} - JSON string of logs
   */
  exportLogs() {
    return JSON.stringify(
      {
        logs: this.logEntries,
        performance: Object.fromEntries(this.performanceMetrics),
        config: LogConfig,
      },
      null,
      2
    );
  }
}

// Create singleton logger instance
const logger = new Logger();

// Export convenience functions
export function errorLog(context, message, data = null) {
  logger.log(LogLevel.ERROR, context, message, data);
}

export function warnLog(context, message, data = null) {
  logger.log(LogLevel.WARN, context, message, data);
}

export function infoLog(context, message, data = null) {
  logger.log(LogLevel.INFO, context, message, data);
}

export function debugLog(context, message, data = null) {
  logger.log(LogLevel.DEBUG, context, message, data);
}

export function verboseLog(context, message, data = null) {
  logger.log(LogLevel.VERBOSE, context, message, data);
}

export function performanceLog(context, message, duration = null) {
  if (duration !== null) {
    logger.recordPerformance(context, duration);
  }

  if (LogConfig.enablePerformanceLogging) {
    const stats = logger.getPerformanceStats(context);
    if (stats) {
      message += ` (avg: ${stats.average.toFixed(2)}ms, min: ${
        stats.min
      }ms, max: ${stats.max}ms)`;
    }
    logger.log(LogLevel.INFO, "PERFORMANCE", message);
  }
}

// Export logger instance for advanced usage
export { logger };
