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
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STOCK_MAPPING_FILE = path.join(DATA_DIR, 'stock-mapping.json');

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// Initialize stock-mapping.json if it doesn't exist
if (!fs.existsSync(STOCK_MAPPING_FILE)) {
  fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify({}, null, 2), 'utf8');
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
