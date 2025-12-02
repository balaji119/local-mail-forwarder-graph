/* webhook-server.js
   Receives parsed email JSON, converts to PrintIQ JSON via OpenAI, creates PrintIQ quote,
   extracts price and replies using Microsoft Graph app-only sendMail.
*/
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const { sendMailOffice365 } = require('./ms-graph-mail');

const app = express();
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = path.join(DATA_DIR, 'webhook-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRINTIQ_USER = process.env.PRINTIQ_USER;
const PRINTIQ_PASSWORD = process.env.PRINTIQ_PASSWORD;
const PRINTIQ_APPNAME = process.env.PRINTIQ_APPNAME;
const PRINTIQ_APPKEY = process.env.PRINTIQ_APPKEY;
const PRINTIQ_BASE_URL = process.env.PRINTIQ_BASE_URL;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
if (!PRINTIQ_USER || !PRINTIQ_PASSWORD || !PRINTIQ_APPNAME || !PRINTIQ_APPKEY) {
  throw new Error("Missing printIQ credentials in .env");
}
if (!PRINTIQ_BASE_URL) throw new Error("Missing PRINTIQ_BASE_URL in .env");

// Updated convertWithOpenAI with hard-coded CustomerCode, Sections, and JobOperations
// Updated convertWithOpenAI with Deliveries always empty + hard-coded fields
async function convertWithOpenAI(rawText) {
  const prompt = `
You are an automation agent whose only job is to extract information from an RFQ email and output a single valid JSON object that exactly matches the schema specified below. 
***Important rules***
- Respond WITH ONLY the JSON object (no explanation, no markdown, no code fences, no extra characters).
- All numeric values must be numbers (not strings).
- If a field cannot be found, use null.
- DO NOT return any delivery details — Deliveries must always be an empty array.
- Dates: if present, convert to ISO 8601. If not, use null.

***INPUT EMAIL***
<<<
${rawText}
>>>

***SCHEMA (JSON output must match exactly)***
{
  "CustomProduct": {
    "ProductCategory": null,
    "FinishSizeWidth": null,
    "FinishSizeHeight": null,
    "Sections": [],
    "JobOperations": []
  },
  "SelectedQuantity": {
    "Quantity": null,
    "Kinds": null
  },
  "QuoteContact": {},
  "Deliveries": [],
  "TargetFreightPrice": null,
  "CustomerCode": "C00116",
  "AcceptQuote": false,
  "JobDescription": null,
  "JobTitle": null,
  "Notes": null,
  "CustomerExpectedDate": null,
  "JobDueDate": null,
  "CustomerReference": null
}

***MAPPING / extraction rules***
- JobTitle: From RFQ No + TITLE line.
- SelectedQuantity.Quantity: First numeric quantity found.
- SelectedQuantity.Kinds: If unknown → 1.
- FinishSizeWidth/Height: From SIZE line ("135 mm x 975 mm").
- Notes / JobDescription: From text like “Notes:” or “Online order”.
- CustomerCode: ALWAYS "C00116".
- Deliveries: ALWAYS [].

Output ONLY the JSON object.
`;

  const body = {
    model: "gpt-4o-mini",
    input: prompt,
    temperature: 0,
    max_output_tokens: 1200
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }

  const j = await resp.json();

  // extract text
  let text = "";
  if (Array.isArray(j.output)) {
    text = j.output.map(o =>
      typeof o === "string"
        ? o
        : o.content?.text ||
          (Array.isArray(o.content)
            ? o.content.map(c => c.text || c).join("")
            : JSON.stringify(o))
    ).join("\n");
  } else if (j.outputText) {
    text = j.outputText;
  } else if (j.choices?.[0]?.message?.content) {
    text = j.choices[0].message.content;
  } else {
    text = JSON.stringify(j);
  }

  // locate JSON braces
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("OpenAI did not return JSON. Raw: " + text.slice(0, 200));
  }

  const jsonText = text.substring(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("Invalid JSON from model: " + err.message);
  }

  // ------- HARD-CODE VALUES YOU REQUESTED --------

  // Always set CustomerCode
  parsed.CustomerCode = "C00116";

  // Always empty deliveries
  parsed.Deliveries = [];

  // Hard-code Sections
  parsed.CustomProduct.Sections = [
    {
      "SectionType": "Single-Section",
      "StockCode": "100gsm laser",
      "ProcessFront": "None",
      "ProcessReverse": "None",
      "SectionSizeWidth": 96,
      "SectionSizeHeight": 48,
      "FoldCatalog": "Flat Product",
      "Pages": 2,
      "SectionOperations": [],
      "SideOperations": []
    }
  ];

  // Hard-code JobOperations
  parsed.CustomProduct.JobOperations = [
    { "OperationName": "Preflight" }
  ];

  // Default kinds to 1 if missing
  if (!parsed.SelectedQuantity) parsed.SelectedQuantity = {};
  if (parsed.SelectedQuantity.Kinds == null)
    parsed.SelectedQuantity.Kinds = 1;

  return parsed;
}



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

app.post('/webhook/email', async (req, res) => {
  try {
    const { from, subject, text, html, attachments, raw } = req.body;
    const emailText = `${subject || ''}\n\n${text || ''}\n\n${raw || ''}`;

    console.log("Incoming email from:", from);
    console.log("Subject:", subject);

    const payload = await convertWithOpenAI(emailText);
    console.log("Payload:", JSON.stringify(payload, null, 2));

    payload.CustomerCode = "C00116";
    payload.ProductCode = "100mm (w) x 75mm (h)";

    const stamp = Date.now();
    fs.writeFileSync(path.join(LOG_DIR, `payload-${stamp}.json`), JSON.stringify(payload, null, 2));

    const tokenResult = await getPrintIQToken();
    if (!tokenResult.success) {
      console.error("Failed to obtain token:", tokenResult.raw || tokenResult.reason);
      return res.status(500).json({ ok: false, error: 'failed to obtain printiq token', debug: tokenResult });
    }

    const createResult = await createQuoteOnPrintIQ(payload, tokenResult.token);
    fs.writeFileSync(path.join(LOG_DIR, `create-${stamp}.json`), JSON.stringify({ createResult }, null, 2));
    console.log("Create result status:", createResult.status);
    console.log("Create result body:", createResult.body);

    const priceInfo = extractPriceInfo(createResult);
    let replyResult = { ok: false, reason: 'no-price-found' };

    if (priceInfo && typeof priceInfo.price !== 'undefined' && priceInfo.price !== null) {
      const priceStr = Number(priceInfo.price).toFixed(2);
      const qtyText = priceInfo.qty || '';
      const quoteNo = priceInfo.quoteNo || '';
      //const replyTo = (payload.DeliveryContact && payload.DeliveryContact.Email) || from || '';
      const replyTo = 'balajik@live.com';

      const replySubject = `Re: ${subject || 'Your RFQ'} — Quote ${quoteNo}`;
      const replyHtml = `<p>Thanks — we created quote <strong>${quoteNo}</strong>.</p>
<p><strong>Estimated unit price:</strong> ${priceStr} (ex GST)<br/><strong>Quantity:</strong> ${qtyText}</p>
<p>If you'd like to proceed reply to this email.</p>`;

      try {
        replyResult = await sendMailOffice365({ to: replyTo, subject: replySubject, htmlBody: replyHtml });
      } catch (err) {
        replyResult = { ok: false, error: String(err) };
        console.error("Error sending reply via Graph:", err);
      }
    } else {
      console.warn("No price found in createResult, not sending reply.");
    }

    res.json({ ok: true, createResult, priceInfo, replyResult });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on http://0.0.0.0:${PORT}/webhook/email`));
