/* logger.js
   Centralized logging utility that writes to files instead of console.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Get log file path for today
function getLogFilePath() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `app-${today}.log`);
}

// Format log message with timestamp
function formatLogMessage(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');
  return `[${timestamp}] [${level}] ${message}\n`;
}

// Write to log file
function writeToLog(level, ...args) {
  const logFile = getLogFilePath();
  const message = formatLogMessage(level, ...args);
  
  try {
    fs.appendFileSync(logFile, message, 'utf8');
  } catch (err) {
    // Fallback to console if file write fails
    console.error(`Failed to write to log file: ${err.message}`);
    console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](...args);
  }
}

// Logger interface
const logger = {
  log: (...args) => {
    writeToLog('INFO', ...args);
  },
  
  error: (...args) => {
    writeToLog('ERROR', ...args);
  },
  
  warn: (...args) => {
    writeToLog('WARN', ...args);
  },
  
  info: (...args) => {
    writeToLog('INFO', ...args);
  }
};

module.exports = logger;
