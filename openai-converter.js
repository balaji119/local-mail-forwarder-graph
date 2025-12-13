/* openai-converter.js
   Handles OpenAI email-to-quote conversion functionality.
   Extracted for testability and separation of concerns.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in .env");
}

// Model config
const MODEL = "gpt-4o-mini";
const PROMPT_TEMPLATE = (rawText) => `
You are an extractor. Given the raw email below, return exactly one valid JSON object 
(no explanation, no markdown) that matches the schema and rules below.

Schema:
{
  "rfq_no": "",
  "title": "",
  "prod": "",
  "width": null,
  "height": null,
  "kinds": [
    { "kind": "", "count": 0 }
  ],
  "print": "",
  "stock": "",
  "finish": "",
  "packing": "",
  "delivery": "",
  "quantity": 0
}

IMPORTANT RULES:
1. Output must contain EXACTLY this JSON structure. Use double quotes only.
2. All numeric values must be real numbers (not strings).
3. If a field cannot be found, return:
   - "" for text fields
   - null for width / height
   - [] for kinds
   - 0 for quantity
4. KINDS EXTRACTION RULES (VERY IMPORTANT):
   A kind is **any standalone token appearing on its own line**, between SIZE and FINISH/PRINT sections,
   that is not one of the known headers:
   RFQ, TITLE, PROD, SIZE, PRINT, STOCK, FINISH, PACKING, DELIVERY, Quantity.

   A “standalone token” means:
   - the entire line contains exactly one word (no spaces)
   - allowed characters: letters, digits, hyphens, underscores
   Examples of valid kinds:
     572406002C01
     561203002C01
     kind1
     KIND_ABC
     SKU-77
     A0HEADER

5. COUNT EXTRACTION RULES:
   - If the kind line includes a count like “CODE x390” or “CODE ×390”, extract that number.
   - If a kind line has **no count**, set "count": 0.
   - If there is exactly one kind AND the email contains a total Quantity (like "870"), 
     you may set that kind’s count equal to the total Quantity.

6. The output must be valid JSON with no additional fields, no comments, and no extra text.

INPUT EMAIL:
<<<
${rawText}
>>>
`.trim();

// ---------- Helpers ----------
function safeNumFromString(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[,\u00A0\s]+/g, '');
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseModelTextToJson(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("No JSON found in model response.");
  }
  const jsonText = text.substring(first, last + 1);
  try {
    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (err) {
    throw new Error("Invalid JSON from model: " + err.message + "\nSnippet: " + jsonText.slice(0, 500));
  }
}

function extractKindsArrayFromExtracted(extracted) {
  // normalized kinds array of strings from objects with kind and count properties
  if (!Array.isArray(extracted.kinds)) return [];
  return extracted.kinds
    .map(k => {
      if (typeof k === 'object' && k !== null && k.kind) {
        return String(k.kind).trim();
      }
      return typeof k === 'string' ? k.trim() : String(k);
    })
    .filter(Boolean);
}

function buildJobTitleFromExtracted(ex, rawText) {
  // Extract content after # from email subject (first line)
  const lines = rawText.split('\n').map(line => line.trim());
  const subjectLine = lines[0] || '';
  let subjectContent = '';

  const hashIndex = subjectLine.indexOf('#');
  if (hashIndex !== -1) {
    subjectContent = subjectLine.substring(hashIndex + 1).trim();
  }

  // Combine subject content with title from body
  const parts = [];
  if (subjectContent) parts.push(subjectContent);
  if (ex.title) parts.push(ex.title);

  return parts.length ? parts.join(' - ') : null;
}

// Load stock mapping from external JSON file
function loadStockMapping() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const mappingFile = path.join(DATA_DIR, 'stock-mapping.json');
  
  try {
    if (fs.existsSync(mappingFile)) {
      const content = fs.readFileSync(mappingFile, 'utf8');
      const mapping = JSON.parse(content);
      return mapping;
    }
  } catch (err) {
    logger.warn(`Failed to load stock mapping from ${mappingFile}:`, err.message);
  }
  
  // Return empty object if file doesn't exist or can't be parsed
  return {};
}

// Load operations array from file
function loadOperations() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const operationsFile = path.join(DATA_DIR, 'operations.json');

  try {
    if (fs.existsSync(operationsFile)) {
      const content = fs.readFileSync(operationsFile, 'utf8');
      const operations = JSON.parse(content);
      if (Array.isArray(operations) && operations.length > 0) {
        return operations.map(op => ({ OperationName: op }));
      }
    }
  } catch (err) {
    logger.warn(`Failed to load operations from ${operationsFile}:`, err.message);
  }

  // Return default operations if file doesn't exist or can't be parsed
  return [
    { OperationName: "Preflight" },
    { OperationName: "* PROOF PDF" },
    { OperationName: "*FILE SETUP ADS" },
    { OperationName: "Auto to Press" }
  ];
}

// Load default settings from file
function loadDefaultSettings() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const settingsFile = path.join(DATA_DIR, 'default-settings.json');

  try {
    if (fs.existsSync(settingsFile)) {
      const content = fs.readFileSync(settingsFile, 'utf8');
      const settings = JSON.parse(content);
      return {
        defaultStockCode: settings.defaultStockCode || "100gsm laser",
        defaultProcessFront: settings.defaultProcessFront || "Standard/Heavy CMYK (160sqm/hr)",
        defaultProcessReverse: settings.defaultProcessReverse || "Standard/Heavy CMYK (160sqm/hr)"
      };
    }
  } catch (err) {
    logger.warn(`Failed to load default settings from ${settingsFile}:`, err.message);
  }

  // Return default settings if file doesn't exist or can't be parsed
  return {
    defaultStockCode: "100gsm laser",
    defaultProcessFront: "Standard/Heavy CMYK (160sqm/hr)",
    defaultProcessReverse: "Standard/Heavy CMYK (160sqm/hr)"
  };
}

function getStockCodeFromMapping(stockValue) {
  if (!stockValue || typeof stockValue !== 'string') {
    return null;
  }
  
  const mapping = loadStockMapping();
  if (!mapping || Object.keys(mapping).length === 0) {
    return null;
  }
  
  // Try exact match first (case-sensitive)
  if (mapping[stockValue]) {
    const mappingData = mapping[stockValue];
    // Support both old format (string) and new format (object)
    if (typeof mappingData === 'string') {
      return { value: mappingData, processFront: 'Standard/Heavy CMYK (160sqm/hr)', processReverse: 'Standard/Heavy CMYK (160sqm/hr)' };
    }
    return {
      value: mappingData.value || mappingData,
      processFront: mappingData.processFront || 'Standard/Heavy CMYK (160sqm/hr)',
      processReverse: mappingData.processReverse || 'Standard/Heavy CMYK (160sqm/hr)'
    };
  }
  
  // Try case-insensitive match
  const stockLower = stockValue.toLowerCase().trim();
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase().trim() === stockLower) {
      // Support both old format (string) and new format (object)
      if (typeof value === 'string') {
        return { value: value, processFront: 'Standard/Heavy CMYK (160sqm/hr)', processReverse: 'Standard/Heavy CMYK (160sqm/hr)' };
      }
      return {
        value: value.value || value,
        processFront: value.processFront || 'Standard/Heavy CMYK (160sqm/hr)',
        processReverse: value.processReverse || 'Standard/Heavy CMYK (160sqm/hr)'
      };
    }
  }
  
  return null;
}

// Build "final" JSON shape from the compact extracted model output
function buildFinalJsonFromExtracted(extracted, rawText) {
  // Load default settings
  const defaultSettings = loadDefaultSettings();

  // Ensure default structure and configurable default fields
  const final = {
    CustomProduct: {
      ProductCategory: null,
      FinishSizeWidth: null,
      FinishSizeHeight: null,
      Sections: [
        {
          SectionType: "Single-Section",
          StockCode: defaultSettings.defaultStockCode,
          ProcessFront: defaultSettings.defaultProcessFront,
          ProcessReverse: defaultSettings.defaultProcessReverse,
          SectionSizeWidth: 96,
          SectionSizeHeight: 48,
          FoldCatalog: "Flat Product",
          Pages: 2,
          SectionOperations: [],
          SideOperations: []
        }
      ],
      JobOperations: loadOperations()
    },
    SelectedQuantity: {
      Quantity: 0,
      Kinds: 0
    },
    QuoteContact: {},
    Deliveries: [], // ALWAYS empty
    TargetFreightPrice: "10.00",
    CustomerCode: "C00116",
    AcceptQuote: false,
    JobDescription: null,
    JobTitle: null,
    Notes: null,
    CustomerExpectedDate: null,
    JobDueDate: null,
    CustomerReference: null
  };

  // Normalize extracted fields and types
  const width = safeNumFromString(extracted.width) ?? null;
  const height = safeNumFromString(extracted.height) ?? null;
  const quantity = safeNumFromString(extracted.quantity) ?? 0;
  const kindsArray = extractKindsArrayFromExtracted(extracted); // array of stock codes

  final.CustomProduct.FinishSizeWidth = width;
  final.CustomProduct.FinishSizeHeight = height;

  // Update StockCode and Process types based on STOCK value from email using mapping file
  if (extracted.stock) {
    const mappedData = getStockCodeFromMapping(extracted.stock);
    if (mappedData) {
      final.CustomProduct.Sections[0].StockCode = mappedData.value;
      final.CustomProduct.Sections[0].ProcessFront = mappedData.processFront;
      
      // Check if STOCK value indicates single-sided printing
      const printLower = extracted.print.toLowerCase();
      const singleSidedKeywords = ['single side', '1s', '1 side', 'one side', 'ss'];
      const isSingleSided = singleSidedKeywords.some(keyword => printLower.includes(keyword));
      
      // If single-sided, set ProcessReverse to None; otherwise use mapping value
      final.CustomProduct.Sections[0].ProcessReverse = isSingleSided ? 'None' : mappedData.processReverse;
    }
  }

  // Titles/notes
  final.JobTitle = buildJobTitleFromExtracted(extracted, rawText);
  final.JobDescription = extracted.title || null;

  // Build notes with finished size, substrate, and mode
  const notesParts = [];
  if (width !== null && height !== null) {
    notesParts.push(`Finished Size: ${width} x ${height}`);
  }
  if (extracted.stock) {
    notesParts.push(`Substrate: ${extracted.stock}`);
  }
  if (final.CustomProduct.Sections[0].ProcessFront) {
    notesParts.push(`Mode: ${final.CustomProduct.Sections[0].ProcessFront}`);
  }
  final.Notes = notesParts.length > 0 ? notesParts.join('\n') : null;


  // Customer reference fallback to rfq_no
  final.CustomerReference = extracted.rfq_no || null;

  // Default target freight (string per your sample)
  final.TargetFreightPrice = "10.00";

  // Base selected quantity values
  final.SelectedQuantity.Quantity = Number(quantity);
  final.SelectedQuantity.Kinds = kindsArray.length > 1 ? 0: 1;

  // If multiple kinds -> build AdvancedKinds structure using individual kind counts
  if (kindsArray.length > 1) {    
    const advKinds =  extracted.kinds.map((kindObj, index) => {
          return {
            Name: kindsArray[index] || `Kind-${index + 1}`,
            Quantity: Number(kindObj.count),
            Sections: [{ SectionNumber: 1 }]
          };
        });

    final.SelectedQuantity.TargetRetailPrice = extracted.TargetRetailPrice != null ? Number(extracted.TargetRetailPrice) : 0;
    final.SelectedQuantity.TargetWholesalePrice = extracted.TargetWholesalePrice != null ? Number(extracted.TargetWholesalePrice) : 0;
    final.SelectedQuantity.AdvancedKinds = {
      KindsArePacks: false,
      Kinds: advKinds
    };

    // Update total quantity to sum of individual kind quantities
    const sumAdv = advKinds.reduce((s, k) => s + (Number(k.Quantity) || 0), 0);
    if (sumAdv > 0) {
      final.SelectedQuantity.Quantity = sumAdv;
    }
  }

  // Ensure numeric typing
  if (final.SelectedQuantity.Quantity != null) final.SelectedQuantity.Quantity = Number(final.SelectedQuantity.Quantity);
  if (final.SelectedQuantity.Kinds != null) final.SelectedQuantity.Kinds = Number(final.SelectedQuantity.Kinds);

  return final;
}

// ---------- OpenAI call ----------
async function callOpenAIForExtractor(rawText) {
  const prompt = PROMPT_TEMPLATE(rawText);

  const body = {
    model: MODEL,
    input: prompt,
    temperature: 0,
    max_output_tokens: 800
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

  return text;
}

// ---------- Public function: convertWithOpenAI ----------
// This function now:
// 1) calls the model to get a small extractor JSON
// 2) parses that JSON
// 3) transforms to the final required JSON shape (with configurable defaults)
async function convertWithOpenAI(rawText) {
  // 1) ask model for compact extractor JSON
  const modelText = await callOpenAIForExtractor(rawText);
  logger.log("Open AI output: ", modelText)

  // 2) parse model JSON
  let extracted;
  try {
    extracted = parseModelTextToJson(modelText);
  } catch (err) {
    // If model failed to return valid JSON, throw to caller so they can decide fallback behavior.
    throw new Error("Failed to parse extractor JSON from model: " + err.message + "\nModel raw output: " + modelText.slice(0, 1000));
  }

  // Ensure fields exist
  if (!extracted.kinds) extracted.kinds = [];

  // 3) deterministic JS post-processing -> build final JSON
  const final = buildFinalJsonFromExtracted(extracted, rawText);

  // Enforce the always-required hard-coded fields (again) to be safe
  final.CustomerCode = "C00116";
  final.Deliveries = [];

  return { final, extracted };
}

/**
 * Process email text through OpenAI with logging and error handling
 * @param {string} emailText - The email text to process
 * @param {Object} options - Options including enableLogging
 * @returns {Object} Result containing payload and metadata
 */
async function processEmailWithOpenAI(emailText, options = {}) {
  const { enableLogging = false } = options;

  try {
    if (enableLogging) {
      logger.log("Processing email text (first 200 chars):", (emailText || "").substring(0, 200));
    }

    const result = await convertWithOpenAI(emailText);
    const { final: payload, extracted } = result;

    if (enableLogging) {
      logger.log("Extracted data:", JSON.stringify(extracted, null, 2));
      logger.log("Payload (final JSON):", JSON.stringify(payload, null, 2));
    }

    return {
      success: true,
      payload,
      extracted,
      timestamp: Date.now()
    };

  } catch (error) {
    logger.error("OpenAI conversion error:", error);
    return {
      success: false,
      error: String(error),
      payload: null,
      extracted: null,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  convertWithOpenAI,
  processEmailWithOpenAI
};
