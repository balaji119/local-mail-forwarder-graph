/* admin-server.js
   Web interface for managing stock-mapping.json and viewing logs
*/
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('./logger');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html'
}));

// Explicit route for root path to ensure index.html is served
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Use DATA_DIR from env, or default to 'data' directory
// In Docker, DATA_DIR is typically set to '/data'
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Use LOG_DIR from env, or default to DATA_DIR/logs
// In Docker, LOG_DIR should be set to '/usr/src/app/logs' to match logger.js
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
const STOCK_MAPPING_FILE = path.join(DATA_DIR, 'stock-mapping.json');
const OPERATIONS_FILE = path.join(DATA_DIR, 'operations.json');
const SECTION_OPERATIONS_FILE = path.join(DATA_DIR, 'section-operations.json');
const FOLDER_CONFIG_FILE = path.join(DATA_DIR, 'folder-config.json');
const STOCK_CODES_FILE = path.join(DATA_DIR, 'stock-codes.json');
const PROCESS_TYPES_FILE = path.join(DATA_DIR, 'process-types.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'default-settings.json');

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

// Initialize section-operations.json if it doesn't exist (with default values)
if (!fs.existsSync(SECTION_OPERATIONS_FILE)) {
  const defaultSectionOperations = [
    { OperationName: "Square Cut" }
  ];
  fs.writeFileSync(SECTION_OPERATIONS_FILE, JSON.stringify(defaultSectionOperations, null, 2), 'utf8');
}

// Initialize folder-config.json if it doesn't exist
if (!fs.existsSync(FOLDER_CONFIG_FILE)) {
  const defaultFolderConfig = {
    selectedFolderId: 'Inbox',
    selectedFolderName: 'Inbox'
  };
  fs.writeFileSync(FOLDER_CONFIG_FILE, JSON.stringify(defaultFolderConfig, null, 2), 'utf8');
}

// Initialize default-settings.json if it doesn't exist
if (!fs.existsSync(SETTINGS_FILE)) {
  const defaultSettings = {
    defaultStockCode: "100gsm laser",
    defaultProcessFront: "Standard/Heavy CMYK (160sqm/hr)",
    defaultProcessReverse: "Standard/Heavy CMYK (160sqm/hr)"
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2), 'utf8');
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

// Get cached PrintIQ process types
app.get('/api/printiq-process-types', (req, res) => {
  try {
    if (!fs.existsSync(PROCESS_TYPES_FILE)) {
      return res.json([]);
    }
    const content = fs.readFileSync(PROCESS_TYPES_FILE, 'utf8');
    const processTypes = JSON.parse(content);
    res.json(Array.isArray(processTypes) ? processTypes : []);
  } catch (err) {
    console.error('Error reading cached process types:', err);
    res.status(500).json({ error: err.message });
  }
});

// Refresh PrintIQ process types from API
app.post('/api/printiq-process-types/refresh', async (req, res) => {
  try {
    const accessToken = process.env.PRINTIQ_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'PRINTIQ_ACCESS_TOKEN environment variable not set' });
    }

    const baseUrl = 'https://adsaust.printiq.com/api/v1/odata/Processes';

    console.log('Fetching PrintIQ process types...');

    const response = await fetch(baseUrl, {
      headers: {
        'PrintIQ-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`PrintIQ API returned status ${response.status}:`, errorText);
      return res.status(response.status).json({ error: `PrintIQ API error: ${errorText}` });
    }

    // Check if response is actually HTML (common when auth fails or endpoint is wrong)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
      const htmlContent = await response.text();
      console.error('PrintIQ API returned HTML instead of JSON. This usually indicates an authentication error or incorrect endpoint.');
      console.error('Response content (first 500 chars):', htmlContent.substring(0, 500));
      return res.status(500).json({
        error: 'PrintIQ API returned HTML instead of JSON. This usually indicates an authentication error or incorrect endpoint. Check your PRINTIQ_ACCESS_TOKEN.'
      });
    }

    const data = await response.json();
    const processes = data.value || [];

    // Extract only Description field
    const processDescriptions = processes.map(process => process.Description).filter(desc => desc && desc.trim());

    // Save to cache file
    fs.writeFileSync(PROCESS_TYPES_FILE, JSON.stringify(processDescriptions, null, 2), 'utf8');

    console.log(`Fetched and cached ${processDescriptions.length} process types from PrintIQ`);
    res.json({
      success: true,
      count: processDescriptions.length,
      message: `Successfully refreshed ${processDescriptions.length} process types`
    });
  } catch (err) {
    console.error('Error refreshing PrintIQ process types:', err);
    res.status(500).json({ error: err.message });
  }
});

// Refresh stock definitions from PrintIQ API
app.post('/api/printiq-stock-definitions/refresh', async (req, res) => {
  try {
    const accessToken = process.env.PRINTIQ_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'PRINTIQ_ACCESS_TOKEN environment variable not set' });
    }

    const baseUrl = 'https://adsaust.printiq.com/api/v1/odata/StockDefinitions';
    let allStockDefinitions = [];
    let skip = 0;
    const pageSize = 50;

    console.log('Starting refresh of PrintIQ stock definitions...');

    while (true) {
      const url = `${baseUrl}?$skip=${skip}`;
      console.log(`Fetching PrintIQ stock definitions, skip=${skip}, url=${url}`);

      const response = await fetch(url, {
        headers: {
          'PrintIQ-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`PrintIQ API returned status ${response.status}:`, errorText);
        return res.status(response.status).json({ error: `PrintIQ API error: ${errorText}` });
      }

      // Check if response is actually HTML (common when auth fails or endpoint is wrong)
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        const htmlContent = await response.text();
        console.error('PrintIQ API returned HTML instead of JSON. This usually indicates an authentication error or incorrect endpoint.');
        console.error('Response content (first 500 chars):', htmlContent.substring(0, 500));
        return res.status(500).json({
          error: 'PrintIQ API returned HTML instead of JSON. This usually indicates an authentication error or incorrect endpoint. Check your PRINTIQ_ACCESS_TOKEN.'
        });
      }

      const data = await response.json();
      const stocks = data.value || [];

      console.log(`API returned ${stocks.length} raw stock items`);

      // Extract only Code and Description
      const processedStocks = stocks.map(stock => ({
        code: stock.Code,
        description: stock.Description
      }));

      allStockDefinitions = allStockDefinitions.concat(processedStocks);

      console.log(`Processed ${processedStocks.length} stock definitions, total so far: ${allStockDefinitions.length}`);
      console.log(`Sample processed stock:`, processedStocks[0]);

      // Check if there are more pages
      if (data['@odata.nextLink']) {
        skip += pageSize;
      } else {
        break;
      }
    }

    // Save to file
    fs.writeFileSync(STOCK_CODES_FILE, JSON.stringify(allStockDefinitions, null, 2), 'utf8');

    console.log(`Fetched and saved ${allStockDefinitions.length} stock definitions from PrintIQ`);
    res.json({
      success: true,
      count: allStockDefinitions.length,
      message: `Successfully refreshed ${allStockDefinitions.length} stock definitions`
    });
  } catch (err) {
    console.error('Error refreshing PrintIQ stock definitions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get cached stock definitions for search
app.get('/api/printiq-stock-definitions', (req, res) => {
  try {
    if (!fs.existsSync(STOCK_CODES_FILE)) {
      return res.json([]);
    }
    const content = fs.readFileSync(STOCK_CODES_FILE, 'utf8');
    const stockDefinitions = JSON.parse(content);
    res.json(stockDefinitions);
  } catch (err) {
    console.error('Error reading stock definitions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Search cached stock definitions by description
app.get('/api/printiq-stock-definitions/search', (req, res) => {
  try {
    const searchTerm = req.query.q?.toLowerCase() || '';
    if (!searchTerm || searchTerm.length < 2) {
      return res.json([]);
    }

    if (!fs.existsSync(STOCK_CODES_FILE)) {
      return res.json([]);
    }

    const content = fs.readFileSync(STOCK_CODES_FILE, 'utf8');
    const allStockDefinitions = JSON.parse(content);

    // Filter by search term in description
    const filteredResults = allStockDefinitions
      .filter(stock => stock.description.toLowerCase().includes(searchTerm))
      .slice(0, 20); // Limit to 20 results for performance

    console.log(`Search "${searchTerm}" returned ${filteredResults.length} results`);
    res.json(filteredResults);
  } catch (err) {
    console.error('Error searching stock definitions:', err);
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
    
    // Support both old format (string value) and new format (object with value, processFront, processReverse)
    let mappingValue;
    if (typeof req.body === 'string') {
      // Old format: just a string value
      mappingValue = req.body;
    } else if (req.body.value) {
      // New format: object with value, processFront, processReverse
      mappingValue = {
        value: req.body.value,
        processFront: req.body.processFront || 'Standard/Heavy CMYK (160sqm/hr)',
        processReverse: req.body.processReverse || 'Standard/Heavy CMYK (160sqm/hr)'
      };
    } else {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }
    
    if (!fs.existsSync(STOCK_MAPPING_FILE)) {
      fs.writeFileSync(STOCK_MAPPING_FILE, JSON.stringify({}, null, 2), 'utf8');
    }
    
    const content = fs.readFileSync(STOCK_MAPPING_FILE, 'utf8');
    const mapping = JSON.parse(content);
    mapping[key] = mappingValue;
    
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
    let operations = JSON.parse(content);

    // Normalize old format (strings) to new format (objects)
    if (Array.isArray(operations)) {
      operations = operations.map(op => {
        if (typeof op === 'string') return { OperationName: op };
        return op;
      });
    } else {
      operations = [];
    }

    res.json(operations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new operation
app.post('/api/operations', (req, res) => {
  try {
    // Backward compatible with old UI: { operation: "Preflight" }
    // New format: { operationName: "Preflight", group?: "...", rule?: "..." }
    const operationName = (req.body && (req.body.operationName ?? req.body.operation)) || '';
    const group = (req.body && req.body.group) || '';
    const rule = (req.body && req.body.rule) || '';

    if (!operationName || typeof operationName !== 'string' || !operationName.trim()) {
      return res.status(400).json({ error: 'Operation name is required and must be a non-empty string' });
    }
    
    if (!fs.existsSync(OPERATIONS_FILE)) {
      fs.writeFileSync(OPERATIONS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
    
    const content = fs.readFileSync(OPERATIONS_FILE, 'utf8');
    let operations = JSON.parse(content);
    
    if (!Array.isArray(operations)) {
      return res.status(500).json({ error: 'Operations file is corrupted' });
    }

    const trimmedName = operationName.trim();

    // Check for duplicates (by OperationName)
    const exists = operations.some(op => {
      if (typeof op === 'string') return op === trimmedName;
      return op && typeof op === 'object' && String(op.OperationName || '').trim() === trimmedName;
    });
    if (exists) return res.status(400).json({ error: 'Operation already exists' });

    // If group/rule provided, store object; otherwise store string for backward compatibility
    const hasGroup = typeof group === 'string' && group.trim();
    const hasRule = typeof rule === 'string' && rule.trim();
    if (hasGroup || hasRule) {
      const entry = { OperationName: trimmedName };
      if (hasGroup) entry.Group = group.trim();
      if (hasRule) entry.Rule = rule.trim();
      operations.push(entry);
    } else {
      operations.push(trimmedName);
    }

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
    const operationName = (req.body && (req.body.operationName ?? req.body.operation)) || '';
    const group = (req.body && req.body.group) || '';
    const rule = (req.body && req.body.rule) || '';
    
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }
    
    if (!operationName || typeof operationName !== 'string' || !operationName.trim()) {
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
    const trimmedOperation = operationName.trim();
    const dup = operations.some((op, i) => {
      if (i === index) return false;
      if (typeof op === 'string') return op === trimmedOperation;
      return op && typeof op === 'object' && String(op.OperationName || '').trim() === trimmedOperation;
    });
    if (dup) {
      return res.status(400).json({ error: 'Operation already exists' });
    }

    const hasGroup = typeof group === 'string' && group.trim();
    const hasRule = typeof rule === 'string' && rule.trim();
    if (hasGroup || hasRule) {
      const entry = { OperationName: trimmedOperation };
      if (hasGroup) entry.Group = group.trim();
      if (hasRule) entry.Rule = rule.trim();
      operations[index] = entry;
    } else {
      operations[index] = trimmedOperation;
    }

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

// Get section operations array
app.get('/api/section-operations', (req, res) => {
  try {
    if (!fs.existsSync(SECTION_OPERATIONS_FILE)) {
      return res.json([]);
    }
    const content = fs.readFileSync(SECTION_OPERATIONS_FILE, 'utf8');
    let sectionOperations = JSON.parse(content);
    
    // Normalize old format (strings) to new format (objects)
    if (Array.isArray(sectionOperations)) {
      sectionOperations = sectionOperations.map(op => {
        if (typeof op === 'string') {
          return { OperationName: op };
        }
        return op;
      });
    } else {
      sectionOperations = [];
    }
    
    res.json(sectionOperations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new section operation
app.post('/api/section-operations', (req, res) => {
  try {
    const { operationName, group, rule } = req.body;

    if (!operationName || typeof operationName !== 'string' || !operationName.trim()) {
      return res.status(400).json({ error: 'Operation name is required and must be a non-empty string' });
    }

    if (!fs.existsSync(SECTION_OPERATIONS_FILE)) {
      fs.writeFileSync(SECTION_OPERATIONS_FILE, JSON.stringify([], null, 2), 'utf8');
    }

    const content = fs.readFileSync(SECTION_OPERATIONS_FILE, 'utf8');
    let sectionOperations = JSON.parse(content);

    if (!Array.isArray(sectionOperations)) {
      return res.status(500).json({ error: 'Section operations file is corrupted' });
    }

    // Normalize old format to new format
    sectionOperations = sectionOperations.map(op => {
      if (typeof op === 'string') {
        return { OperationName: op };
      }
      return op;
    });

    // Check for duplicates (by OperationName)
    const trimmedOperationName = operationName.trim();
    if (sectionOperations.some(op => {
      const opName = typeof op === 'string' ? op : op.OperationName;
      return opName === trimmedOperationName;
    })) {
      return res.status(400).json({ error: 'Operation already exists' });
    }

    // Create new operation object
    const newOperation = { OperationName: trimmedOperationName };
    if (group && typeof group === 'string' && group.trim()) {
      newOperation.Group = group.trim();
    }
    if (rule && typeof rule === 'string' && rule.trim()) {
      newOperation.Rule = rule.trim();
    }

    sectionOperations.push(newOperation);
    fs.writeFileSync(SECTION_OPERATIONS_FILE, JSON.stringify(sectionOperations, null, 2), 'utf8');
    res.json({ success: true, message: 'Section operation added successfully', sectionOperations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a section operation by index
app.put('/api/section-operations/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { operationName, group, rule } = req.body;

    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    if (!operationName || typeof operationName !== 'string' || !operationName.trim()) {
      return res.status(400).json({ error: 'Operation name is required and must be a non-empty string' });
    }

    if (!fs.existsSync(SECTION_OPERATIONS_FILE)) {
      return res.status(404).json({ error: 'Section operations file not found' });
    }

    const content = fs.readFileSync(SECTION_OPERATIONS_FILE, 'utf8');
    let sectionOperations = JSON.parse(content);

    if (!Array.isArray(sectionOperations)) {
      return res.status(500).json({ error: 'Section operations file is corrupted' });
    }

    // Normalize old format to new format
    sectionOperations = sectionOperations.map(op => {
      if (typeof op === 'string') {
        return { OperationName: op };
      }
      return op;
    });

    if (index >= sectionOperations.length) {
      return res.status(404).json({ error: 'Index out of range' });
    }

    // Check for duplicates (excluding current index)
    const trimmedOperationName = operationName.trim();
    if (sectionOperations.some((op, i) => {
      if (i === index) return false;
      const opName = typeof op === 'string' ? op : op.OperationName;
      return opName === trimmedOperationName;
    })) {
      return res.status(400).json({ error: 'Operation already exists' });
    }

    // Update operation object
    const updatedOperation = { OperationName: trimmedOperationName };
    if (group && typeof group === 'string' && group.trim()) {
      updatedOperation.Group = group.trim();
    }
    if (rule && typeof rule === 'string' && rule.trim()) {
      updatedOperation.Rule = rule.trim();
    }

    sectionOperations[index] = updatedOperation;
    fs.writeFileSync(SECTION_OPERATIONS_FILE, JSON.stringify(sectionOperations, null, 2), 'utf8');
    res.json({ success: true, message: 'Section operation updated successfully', sectionOperations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a section operation by index
app.delete('/api/section-operations/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);

    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    if (!fs.existsSync(SECTION_OPERATIONS_FILE)) {
      return res.status(404).json({ error: 'Section operations file not found' });
    }

    const content = fs.readFileSync(SECTION_OPERATIONS_FILE, 'utf8');
    const sectionOperations = JSON.parse(content);

    if (!Array.isArray(sectionOperations)) {
      return res.status(500).json({ error: 'Section operations file is corrupted' });
    }

    if (index >= sectionOperations.length) {
      return res.status(404).json({ error: 'Index out of range' });
    }

    sectionOperations.splice(index, 1);
    fs.writeFileSync(SECTION_OPERATIONS_FILE, JSON.stringify(sectionOperations, null, 2), 'utf8');
    res.json({ success: true, message: 'Section operation deleted successfully', sectionOperations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get mail folders from Microsoft Graph
app.get('/api/folders', async (req, res) => {
  try {
    const { getGraphAccessToken, fetchMailFolders } = require('./ms-graph-mail');
    const mailbox = process.env.EMAIL_FROM;
    
    if (!mailbox) {
      return res.status(500).json({ error: 'EMAIL_FROM environment variable not set' });
    }
    
    const token = await getGraphAccessToken();
    const folders = await fetchMailFolders(token, mailbox);
    
    // Format folders for display
    const formattedFolders = folders.map(folder => ({
      id: folder.id,
      name: folder.displayName || folder.name || 'Unknown',
      unreadItemCount: folder.unreadItemCount || 0,
      totalItemCount: folder.totalItemCount || 0
    }));
    
    res.json(formattedFolders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get selected folder configuration
app.get('/api/folder-config', (req, res) => {
  try {
    if (!fs.existsSync(FOLDER_CONFIG_FILE)) {
      return res.json({ selectedFolderId: 'Inbox', selectedFolderName: 'Inbox' });
    }
    const content = fs.readFileSync(FOLDER_CONFIG_FILE, 'utf8');
    const config = JSON.parse(content);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update selected folder configuration
app.post('/api/folder-config', (req, res) => {
  try {
    const { selectedFolderId, selectedFolderName } = req.body;

    if (!selectedFolderId) {
      return res.status(400).json({ error: 'selectedFolderId is required' });
    }

    const config = {
      selectedFolderId,
      selectedFolderName: selectedFolderName || selectedFolderId
    };

    fs.writeFileSync(FOLDER_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    // Restart the worker service programmatically
    //exec('docker restart local_worker', { cwd: process.cwd() }, (error, stdout, stderr) => {
    //  if (error) {
    //    logger.warn(`Failed to restart worker service: ${error.message}`);
    //    // Still return success for folder update, but log the restart failure
    //  } else {
    //    logger.log('Worker service restarted successfully after folder selection');
    //  }
    //});

    res.json({
      success: true,
      message: 'Folder configuration updated successfully. Restart the worker service manually.',
      config
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get default settings
app.get('/api/settings', (req, res) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return res.json({
        defaultStockCode: "100gsm laser",
        defaultProcessFront: "Standard/Heavy CMYK (160sqm/hr)",
        defaultProcessReverse: "Standard/Heavy CMYK (160sqm/hr)"
      });
    }
    const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(content);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update default settings
app.post('/api/settings', (req, res) => {
  try {
    const { defaultStockCode, defaultProcessFront, defaultProcessReverse } = req.body;

    if (!defaultStockCode || !defaultProcessFront || !defaultProcessReverse) {
      return res.status(400).json({ error: 'defaultStockCode, defaultProcessFront, and defaultProcessReverse are required' });
    }

    const settings = {
      defaultStockCode,
      defaultProcessFront,
      defaultProcessReverse
    };

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');

    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings
    });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin interface listening on http://0.0.0.0:${PORT}`);
  console.log(`Static files served from: ${path.join(__dirname, 'public')}`);
  console.log(`Index.html exists: ${fs.existsSync(path.join(__dirname, 'public', 'index.html'))}`);
});
