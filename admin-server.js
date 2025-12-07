/* admin-server.js
   Web interface for managing stock-mapping.json and viewing logs
*/
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Use DATA_DIR from env, or default to 'data' directory
// In Docker, DATA_DIR is typically set to '/data'
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Use LOG_DIR from env, or default to DATA_DIR/logs
// In Docker, LOG_DIR should be set to '/usr/src/app/logs' to match logger.js
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
const STOCK_MAPPING_FILE = path.join(DATA_DIR, 'stock-mapping.json');
const OPERATIONS_FILE = path.join(DATA_DIR, 'operations.json');

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// Initialize stock-mapping.json if it doesn't exist
if (!fs.existsSync(STOCK_MAPPING_FILE)) {
  fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify({}, null, 2), 'utf8');
}

// Initialize operations.json if it doesn't exist (with default values)
if (!fs.existsSync(OPERATIONS_FILE)) {
  const defaultOperations = [
    "Preflight",
    "* PROOF PDF",
    "*FILE SETUP ADS",
    "Auto to Press"
  ];
  fs.writeFileSync(OPERATIONS_FILE, JSON.stringify(defaultOperations, null, 2), 'utf8');
}

// Get stock mapping
app.get('/api/stock-mapping', (req, res) => {
  try {
    if (!fs.existsSync(STOCK_MAPPING_FILE)) {
      return res.json({});
    }
    const content = fs.readFileSync(STOCK_MAPPING_FILE, 'utf8');
    const mapping = JSON.parse(content);
    res.json(mapping);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update stock mapping (replace entire file)
app.post('/api/stock-mapping', (req, res) => {
  try {
    const mapping = req.body;
    if (typeof mapping !== 'object') {
      return res.status(400).json({ error: 'Invalid mapping data' });
    }
    fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
    res.json({ success: true, message: 'Stock mapping updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add or update a single key-value pair
app.put('/api/stock-mapping/:key', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const value = req.body.value || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    
    if (!key || !value) {
      return res.status(400).json({ error: 'Key and value are required' });
    }
    
    if (!fs.existsSync(STOCK_MAPPING_FILE)) {
      fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify({}, null, 2), 'utf8');
    }
    
    const content = fs.readFileSync(STOCK_MAPPING_FILE, 'utf8');
    const mapping = JSON.parse(content);
    mapping[key] = value;
    
    fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
    res.json({ success: true, message: 'Key-value pair added/updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a key-value pair
app.delete('/api/stock-mapping/:key', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    if (!fs.existsSync(STOCK_MAPPING_FILE)) {
      return res.status(404).json({ error: 'Stock mapping file not found' });
    }
    
    const content = fs.readFileSync(STOCK_MAPPING_FILE, 'utf8');
    const mapping = JSON.parse(content);
    
    if (!(key in mapping)) {
      return res.status(404).json({ error: 'Key not found' });
    }
    
    delete mapping[key];
    fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
    res.json({ success: true, message: 'Key-value pair deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get operations array
app.get('/api/operations', (req, res) => {
  try {
    if (!fs.existsSync(OPERATIONS_FILE)) {
      return res.json([]);
    }
    const content = fs.readFileSync(OPERATIONS_FILE, 'utf8');
    const operations = JSON.parse(content);
    res.json(Array.isArray(operations) ? operations : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new operation
app.post('/api/operations', (req, res) => {
  try {
    const { operation } = req.body;
    
    if (!operation || typeof operation !== 'string' || !operation.trim()) {
      return res.status(400).json({ error: 'Operation name is required and must be a non-empty string' });
    }
    
    if (!fs.existsSync(OPERATIONS_FILE)) {
      fs.writeFileSync(OPERATIONS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
    
    const content = fs.readFileSync(OPERATIONS_FILE, 'utf8');
    const operations = JSON.parse(content);
    
    if (!Array.isArray(operations)) {
      return res.status(500).json({ error: 'Operations file is corrupted' });
    }
    
    // Check for duplicates
    if (operations.includes(operation.trim())) {
      return res.status(400).json({ error: 'Operation already exists' });
    }
    
    operations.push(operation.trim());
    fs.writeFileSync(OPERATIONS_FILE, JSON.stringify(operations, null, 2), 'utf8');
    res.json({ success: true, message: 'Operation added successfully', operations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an operation by index
app.put('/api/operations/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { operation } = req.body;
    
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }
    
    if (!operation || typeof operation !== 'string' || !operation.trim()) {
      return res.status(400).json({ error: 'Operation name is required and must be a non-empty string' });
    }
    
    if (!fs.existsSync(OPERATIONS_FILE)) {
      return res.status(404).json({ error: 'Operations file not found' });
    }
    
    const content = fs.readFileSync(OPERATIONS_FILE, 'utf8');
    const operations = JSON.parse(content);
    
    if (!Array.isArray(operations)) {
      return res.status(500).json({ error: 'Operations file is corrupted' });
    }
    
    if (index >= operations.length) {
      return res.status(404).json({ error: 'Index out of range' });
    }
    
    // Check for duplicates (excluding current index)
    const trimmedOperation = operation.trim();
    if (operations.some((op, i) => i !== index && op === trimmedOperation)) {
      return res.status(400).json({ error: 'Operation already exists' });
    }
    
    operations[index] = trimmedOperation;
    fs.writeFileSync(OPERATIONS_FILE, JSON.stringify(operations, null, 2), 'utf8');
    res.json({ success: true, message: 'Operation updated successfully', operations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an operation by index
app.delete('/api/operations/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }
    
    if (!fs.existsSync(OPERATIONS_FILE)) {
      return res.status(404).json({ error: 'Operations file not found' });
    }
    
    const content = fs.readFileSync(OPERATIONS_FILE, 'utf8');
    const operations = JSON.parse(content);
    
    if (!Array.isArray(operations)) {
      return res.status(500).json({ error: 'Operations file is corrupted' });
    }
    
    if (index >= operations.length) {
      return res.status(404).json({ error: 'Index out of range' });
    }
    
    operations.splice(index, 1);
    fs.writeFileSync(OPERATIONS_FILE, JSON.stringify(operations, null, 2), 'utf8');
    res.json({ success: true, message: 'Operation deleted successfully', operations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get list of log files
app.get('/api/logs/files', (req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      return res.json([]);
    }
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(LOG_DIR, f),
        size: fs.statSync(path.join(LOG_DIR, f)).size,
        modified: fs.statSync(path.join(LOG_DIR, f)).mtime
      }))
      .sort((a, b) => b.modified - a.modified);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get log file content
app.get('/api/logs/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    // Security: only allow .log files
    if (!filename.endsWith('.log') || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    const filePath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    res.json({ filename, lines, totalLines: lines.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest log entries (last N lines from most recent log file)
app.get('/api/logs/latest/:lines?', (req, res) => {
  try {
    const lines = parseInt(req.params.lines) || 100;
    
    if (!fs.existsSync(LOG_DIR)) {
      return res.json({ lines: [], totalLines: 0 });
    }
    
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(LOG_DIR, f),
        modified: fs.statSync(path.join(LOG_DIR, f)).mtime
      }))
      .sort((a, b) => b.modified - a.modified);
    
    if (files.length === 0) {
      return res.json({ lines: [], totalLines: 0 });
    }
    
    const latestFile = files[0];
    const content = fs.readFileSync(latestFile.path, 'utf8');
    const allLines = content.split('\n').filter(line => line.trim());
    const latestLines = allLines.slice(-lines);
    
    res.json({ 
      filename: latestFile.name,
      lines: latestLines,
      totalLines: allLines.length,
      showing: latestLines.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.ADMIN_PORT || 3001;

app.listen(PORT, () => {
  console.log(`Admin interface listening on http://0.0.0.0:${PORT}`);
});
