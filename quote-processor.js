/* quote-processor.js
   Handles PrintIQ quote creation and price extraction functionality.
   Extracted for testability and separation of concerns.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const PRINTIQ_USER = process.env.PRINTIQ_USER;
const PRINTIQ_PASSWORD = process.env.PRINTIQ_PASSWORD;
const PRINTIQ_APPNAME = process.env.PRINTIQ_APPNAME;
const PRINTIQ_APPKEY = process.env.PRINTIQ_APPKEY;
const PRINTIQ_BASE_URL = process.env.PRINTIQ_BASE_URL;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = path.join(DATA_DIR, 'webhook-logs');

function tryParseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (err) { return { ok: false, error: err }; }
}

async function getPrintIQToken() {
  const user = PRINTIQ_USER;
  const pass = PRINTIQ_PASSWORD;
  const app = PRINTIQ_APPNAME;
  const key = PRINTIQ_APPKEY;

  const baseUrl = new URL(PRINTIQ_BASE_URL);
  const hostname = baseUrl.hostname;
  const path = `${baseUrl.pathname}/api/QuoteProcess/GetApplicationLogInToken?UserName=${user}&Password=${pass}&ApplicationName=${app}&ApplicationKey=${key}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: hostname,
      path,
      headers: { 'Accept': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString().trim();
        const parsed = tryParseJson(raw);
        let token = null;
        if (parsed.ok) {
          const body = parsed.value;
          if (typeof body === 'string') token = body;
          else if (body && typeof body === 'object') {
            token = body.Token || body.LoginToken || body.ApplicationToken;
            if (!token) {
              const candidate = Object.values(body).find(v => typeof v === 'string' && v.length > 16);
              if (candidate) token = candidate;
            }
          }
        } else {
          token = raw;
        }
        if (!token) return resolve({ success: false, reason: 'no-token', raw });
        if (typeof token === 'string') {
          token = token.trim();
          if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
        }
        resolve({ success: true, token });
      });
      res.on('error', err => reject(err));
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function createQuoteOnPrintIQ(payload, tokenRaw) {
  const token = encodeURIComponent(String(tokenRaw || '').trim());
  const baseUrl = new URL(PRINTIQ_BASE_URL);
  const hostname = baseUrl.hostname;
  const path = `${baseUrl.pathname}/api/QuoteProcess/GetPrice?LoginToken=${token}`;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: hostname,
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
      res.on('error', reject);
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => { req.destroy(new Error('timeout')); });

    req.write(body);
    req.end();
  });
}

function extractPriceInfo(createResult) {
  try {
    const body = createResult && createResult.body;
    if (!body || !body.QuoteDetails) return null;
    const q = body.QuoteDetails;
    const quoteNo = q.QuoteNo || '';
    const price = q.Products?.[0]?.Quantities?.[0]?.Price;
    const qty = q.Products?.[0]?.Quantities?.[0]?.Quantity || q.Products?.[0]?.Quantities?.[0]?.QuantityToDisplay || '';
    return { price, qty, quoteNo };
  } catch (err) {
    return null;
  }
}

/**
 * Main function that processes a quote request
 * @param {Object} payload - The quote payload
 * @param {Object} options - Options including logDir for file logging
 * @returns {Object} Result containing createResult, priceInfo, and success status
 */
async function processQuote(payload, options = {}) {
  const { logDir = LOG_DIR } = options;
  
  // Ensure payload has required fields
  payload.CustomerCode = payload.CustomerCode || "C00116";

  const stamp = Date.now();
  
  try {
    // Save payload for debugging
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `payload-${stamp}.json`), JSON.stringify(payload, null, 2));
    }

    // Get authentication token
    const tokenResult = await getPrintIQToken();
    if (!tokenResult.success) {
      console.error("Failed to obtain token:", tokenResult.raw || tokenResult.reason);
      return {
        success: false,
        error: 'failed to obtain printiq token',
        debug: tokenResult,
        createResult: null,
        priceInfo: null
      };
    }

    // Create quote
    const createResult = await createQuoteOnPrintIQ(payload, tokenResult.token);
    
    // Save result for debugging
    if (logDir) {
      fs.writeFileSync(path.join(logDir, `create-${stamp}.json`), JSON.stringify({ createResult }, null, 2));
    }

    console.log("Create result status:", createResult.status);
    console.log("Create result body:", createResult.body);

    // Extract price information
    const priceInfo = extractPriceInfo(createResult);

    return {
      success: true,
      createResult,
      priceInfo,
      timestamp: stamp
    };

  } catch (error) {
    console.error("Quote processing error:", error);
    return {
      success: false,
      error: String(error),
      createResult: null,
      priceInfo: null,
      timestamp: stamp
    };
  }
}

module.exports = {
  getPrintIQToken,
  createQuoteOnPrintIQ,
  extractPriceInfo,
  processQuote
};