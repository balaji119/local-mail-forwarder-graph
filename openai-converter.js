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
4. KINDS EXTRACTION RULES (CRITICAL - EXTRACT ALL KINDS):
   You MUST extract ALL kinds from the email without exception. A kind is **any standalone token appearing 
   on its own line**, typically in a table or list format, between SIZE and FINISH/PRINT sections,
   that is not one of the known headers:
   RFQ, TITLE, PROD, SIZE, PRINT, STOCK, FINISH, PACKING, DELIVERY, Quantity.

   A "standalone token" means:
   - the entire line contains exactly one word/code (no spaces), OR
   - it appears as a product/SKU code in a table row
   - allowed characters: letters, digits, hyphens, underscores
   Examples of valid kinds:
     623869010C01
     463024038C01
     572406002C01
     561203002C01
     kind1
     KIND_ABC
     SKU-77
     A0HEADER
   
   IMPORTANT: If you see a table with multiple rows of codes/kinds, you MUST extract EVERY SINGLE ONE.
   Do NOT stop after a few - extract them ALL. The email may contain 10, 15, 17, or more kinds.
   Count how many kinds you extract and make sure you haven't missed any from the table.

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
    // Remove "(ADS)" from the end if it exists
    if (subjectContent.endsWith('(ADS)')) {
      subjectContent = subjectContent.slice(0, -5).trim();
    }
  }

  // Combine subject content with prod from body
  const parts = [];
  if (subjectContent) parts.push(subjectContent);
  if (ex.prod) parts.push(ex.prod);

  return parts.length ? parts.join(' / ') : null;
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

// Load job operations array from file
// If extractedPrint is provided, filter operations based on Rule field.
// rawEmailText (optional): when provided, rules are matched against both extractedPrint and raw email
// so rule-based operations still apply if the model abbreviates the print field.
function loadOperations(extractedPrint, rawEmailText) {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  // Try bundled config first so we get full rules (e.g. Coles Printing Note); then DATA_DIR for user override
  const pathsToTry = [
    path.join(__dirname, 'data', 'operations.json'),
    path.join(__dirname, 'config', 'operations.json'),
    path.join(DATA_DIR, 'operations.json')
  ];

  for (const operationsFile of pathsToTry) {
    try {
      if (!fs.existsSync(operationsFile)) continue;
      const content = fs.readFileSync(operationsFile, 'utf8');
      const operations = JSON.parse(content);
      if (!Array.isArray(operations) || operations.length === 0) continue;

      const printPart = extractedPrint ? String(extractedPrint).toLowerCase() : '';
      const rawPart = rawEmailText ? String(rawEmailText).toLowerCase() : '';
      const textToMatch = [printPart, rawPart].filter(Boolean).join(' ');

      logger.log(`loadOperations: loaded from ${operationsFile}, ${operations.length} ops, textToMatch has 'satin': ${textToMatch.includes('satin')}`);

      const filteredOperations = operations.filter(op => {
          // old format (string) - always include
          if (typeof op === 'string') return true;

          // new format (object) - if no Rule, include
          if (!op || typeof op !== 'object') return false;
          if (!op.Rule || typeof op.Rule !== 'string' || !op.Rule.trim()) return true;

          // if Rule is specified, include when rule appears in extracted print or raw email
          const ruleLower = op.Rule.trim().toLowerCase();
          return textToMatch.includes(ruleLower);
        });

      return filteredOperations.map(op => {
        if (typeof op === 'string') return { OperationName: op };
        const item = { OperationName: op.OperationName || '' };
        if (op.Group && typeof op.Group === 'string' && op.Group.trim()) {
          item.Group = op.Group.trim();
        }
        return item;
      }).filter(op => op.OperationName && String(op.OperationName).trim() !== '');
    } catch (err) {
      logger.warn(`Failed to load operations from ${operationsFile}:`, err.message);
    }
  }

  // Return default operations if no file found or parse failed
  return [
    { OperationName: "Preflight" },
    { OperationName: "* PROOF PDF" },
    { OperationName: "*FILE SETUP ADS" },
    { OperationName: "Auto to Press" }
  ];
}

// Load section operations array from file
// If extractedFinish is provided, filter operations based on Rule field
function loadSectionOperations(extractedFinish) {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const sectionOperationsFile = path.join(DATA_DIR, 'section-operations.json');
  
  logger.log(`loadSectionOperations: file path = ${sectionOperationsFile}, exists = ${fs.existsSync(sectionOperationsFile)}`);

  try {
    if (fs.existsSync(sectionOperationsFile)) {
      const content = fs.readFileSync(sectionOperationsFile, 'utf8');
      logger.log(`loadSectionOperations: file content = ${content.substring(0, 200)}`);
      const sectionOperations = JSON.parse(content);
      logger.log(`loadSectionOperations: parsed ${sectionOperations.length} operations`);
      if (Array.isArray(sectionOperations) && sectionOperations.length > 0) {
        // Filter operations based on Rule if extractedFinish is provided
        const finishLower = extractedFinish ? extractedFinish.toLowerCase() : '';
        
        const filteredOperations = sectionOperations.filter(op => {
          // Handle old format (string) - always include
          if (typeof op === 'string') {
            return true;
          }
          
          // If Rule is not specified or empty, include the operation (current behavior)
          if (!op.Rule || typeof op.Rule !== 'string' || !op.Rule.trim()) {
            return true;
          }
          
          // If Rule is specified, check if it's present in extracted.finish
          const ruleLower = op.Rule.trim().toLowerCase();
          return finishLower.includes(ruleLower);
        });
        
        logger.log(`loadSectionOperations: filtered ${filteredOperations.length} operations, result = ${JSON.stringify(filteredOperations)}`);
        
        // If no operations match after filtering, return default
        if (filteredOperations.length === 0) {
          logger.log(`loadSectionOperations: no operations matched rules, returning default`);
          return [
            { 
              OperationName: "CUT - Kongsberg Table Cutter",
              Group: "Die cut to shape"
            }
          ];
        }
        
        // Map to output format
        return filteredOperations.map(op => {
          // Handle old format (string) - backward compatibility
          if (typeof op === 'string') {
            return { OperationName: op };
          }
          // Handle new format (object with OperationName and optional Group)
          const result = { OperationName: op.OperationName || op };
          // Only include Group if it's specified and not empty
          if (op.Group && typeof op.Group === 'string' && op.Group.trim()) {
            result.Group = op.Group.trim();
          }
          return result;
        });
      }
    }
  } catch (err) {
    logger.warn(`Failed to load section operations from ${sectionOperationsFile}:`, err.message);
  }

  // Return default section operations if file doesn't exist or can't be parsed
  logger.log(`loadSectionOperations: returning default - file not found or parse error`);
  return [
    { 
      OperationName: "CUT - Kongsberg Table Cutter",
      Group: "Square Cut"
    }
  ];
}

// Load quote contact from environment variables
function loadQuoteContact() {
  return {
    Title: process.env.QUOTE_CONTACT_TITLE,
    FirstName: process.env.QUOTE_CONTACT_FIRST_NAME,
    Surname: process.env.QUOTE_CONTACT_SURNAME,
    Email: process.env.QUOTE_CONTACT_EMAIL,
  };
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
      return { value: mappingData, processFront: null, processReverse: null };
    }
    return {
      value: mappingData.value || mappingData,
      processFront: (mappingData.processFront && mappingData.processFront !== 'None') ? mappingData.processFront : null,
      processReverse: (mappingData.processReverse && mappingData.processReverse !== 'None') ? mappingData.processReverse : null
    };
  }
  
  // Try case-insensitive match
  const stockLower = stockValue.toLowerCase().trim();
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase().trim() === stockLower) {
      // Support both old format (string) and new format (object)
      if (typeof value === 'string') {
        return { value: value, processFront: null, processReverse: null };
      }
      return {
        value: value.value || value,
        processFront: (value.processFront && value.processFront !== 'None') ? value.processFront : null,
        processReverse: (value.processReverse && value.processReverse !== 'None') ? value.processReverse : null
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
          SectionSizeWidth: 0,
          SectionSizeHeight: 0,
          FoldCatalog: "Flat Product",
          Pages: 2,
          SectionOperations: loadSectionOperations(extracted.finish),
          SideOperations: []
        }
      ],
      JobOperations: loadOperations(extracted.print, rawText)
    },
    SelectedQuantity: {
      Quantity: 0,
      Kinds: 0
    },
    QuoteContact: loadQuoteContact(),
    Deliveries: [], // ALWAYS empty
    TargetFreightPrice: "",
    CustomerCode: "C00014",
    AcceptQuote: false,
    JobDescription: null,
    JobTitle: null,
    Notes: null,
    CustomerExpectedDate: null,
    JobDueDate: null,
    CustomerReference: null
  };

  // Track if stock mapping was used
  let stockMappingUsed = false;

  // Normalize extracted fields and types
  const width = safeNumFromString(extracted.width) ?? null;
  const height = safeNumFromString(extracted.height) ?? null;
  const quantity = safeNumFromString(extracted.quantity) ?? 0;
  const kindsArray = extractKindsArrayFromExtracted(extracted); // array of stock codes

  final.CustomProduct.FinishSizeWidth = width;
  final.CustomProduct.FinishSizeHeight = height;
  final.CustomProduct.Sections[0].SectionSizeWidth = width;
  final.CustomProduct.Sections[0].SectionSizeHeight = height;

  // Check if PRINT value indicates single-sided printing (always check, regardless of stock mapping)
  let isSingleSided = false;
  if (extracted.print) {
    const printLower = extracted.print.toLowerCase();
    const singleSidedKeywords = ['single side', '1s', '1 side', 'one side', ' ss '];
    isSingleSided = singleSidedKeywords.some(keyword => printLower.includes(keyword));
  }

  // Update StockCode and Process types based on STOCK value from email using mapping file
  if (extracted.stock) {
    const mappedData = getStockCodeFromMapping(extracted.stock);
    logger.log("DEBUG: Stock value:", extracted.stock);
    logger.log("DEBUG: Mapped data:", JSON.stringify(mappedData));
    if (mappedData) {
      final.CustomProduct.Sections[0].StockCode = mappedData.value;
      
      logger.log("DEBUG: ProcessFront from mapping:", mappedData.processFront);
      logger.log("DEBUG: ProcessReverse from mapping:", mappedData.processReverse);
      logger.log("DEBUG: Default ProcessFront before override:", final.CustomProduct.Sections[0].ProcessFront);
      
      // Use mapping values if provided (not null and not "None"), otherwise keep defaults
      if (mappedData.processFront && mappedData.processFront !== 'None') {
        final.CustomProduct.Sections[0].ProcessFront = mappedData.processFront;
        logger.log("DEBUG: Set ProcessFront from mapping to:", mappedData.processFront);
      } else {
        logger.log("DEBUG: Keeping default ProcessFront:", final.CustomProduct.Sections[0].ProcessFront);
      }
      // else: keep the default ProcessFront that was already set

      // If single-sided, set ProcessReverse to None; otherwise use mapping value (or default if mapping is null/None)
      if (isSingleSided) {
        final.CustomProduct.Sections[0].ProcessReverse = 'None';
        logger.log("DEBUG: Set ProcessReverse to None (single-sided)");
      } else if (mappedData.processReverse && mappedData.processReverse !== 'None') {
        final.CustomProduct.Sections[0].ProcessReverse = mappedData.processReverse;
        logger.log("DEBUG: Set ProcessReverse from mapping to:", mappedData.processReverse);
      } else {
        logger.log("DEBUG: Keeping default ProcessReverse:", final.CustomProduct.Sections[0].ProcessReverse);
      }
      // else: keep the default ProcessReverse that was already set
      
      stockMappingUsed = true;
    }
  }

  // Titles/notes
  final.JobTitle = buildJobTitleFromExtracted(extracted, rawText);

  // Build notes with finished size, substrate, and mode
  const descParts = [];
  if (width !== null && height !== null) {
    descParts.push(`Finished Size: ${width} x ${height}`);
  }
  if (extracted.stock) {
    descParts.push(`Substrate: ${extracted.stock}`);
  }
  if (final.CustomProduct.Sections[0].ProcessFront) {
    descParts.push(`Mode: ${final.CustomProduct.Sections[0].ProcessFront}`);
  }
  descParts.push('Includes: Bulk packed and Wrapped')
  final.JobDescription = descParts.length > 0 ? descParts.join('\n') : null;


  // Customer reference fallback to rfq_no
  final.CustomerReference = extracted.rfq_no || null;

  // Target freight should be empty (not $10)
  final.TargetFreightPrice = "";

  // Base selected quantity values
  final.SelectedQuantity.Quantity = Number(quantity);
  
  // Handle kinds: use AdvancedKinds whenever we have at least one kind (single or multiple)
  logger.log(`DEBUG: kindsArray.length=${kindsArray.length}, extracted.kinds=${JSON.stringify(extracted.kinds)}`);
  if (kindsArray.length >= 1) {
    // One or more kinds - always use AdvancedKinds structure
    final.SelectedQuantity.Kinds = 0;

    const advKinds = extracted.kinds.map((kindObj, index) => {
      const kindName = (kindObj && typeof kindObj === 'object' && kindObj.kind)
        ? String(kindObj.kind).trim()
        : (kindsArray[index] || `Kind-${index + 1}`);
      
      // Special case: if there's exactly ONE kind and count is 0 or missing, use total quantity
      let qty;
      if (extracted.kinds.length === 1 && (!kindObj.count || kindObj.count === 0)) {
        qty = Number(quantity ?? 0);
      } else {
        qty = Number(kindObj.count ?? 0);
      }
      
      logger.log(`DEBUG: Kind ${index}: name=${kindName}, qty=${qty}`);
      return {
        Name: kindName,
        Quantity: qty,
        Sections: [{ SectionNumber: 1 }]
      };
    });
    logger.log(`DEBUG: advKinds total count=${advKinds.length}`);

    final.SelectedQuantity.TargetRetailPrice = extracted.TargetRetailPrice != null ? Number(extracted.TargetRetailPrice) : 0;
    final.SelectedQuantity.TargetWholesalePrice = extracted.TargetWholesalePrice != null ? Number(extracted.TargetWholesalePrice) : 0;
    final.SelectedQuantity.AdvancedKinds = {
      KindsArePacks: false,
      Kinds: advKinds
    };

    const sumAdv = advKinds.reduce((s, k) => s + (Number(k.Quantity) || 0), 0);
    if (sumAdv > 0) {
      final.SelectedQuantity.Quantity = sumAdv;
    } else {
      final.SelectedQuantity.Quantity = Number(quantity);
    }
  } else {
    // No kinds - set Kinds to 1, use total quantity
    final.SelectedQuantity.Kinds = 1;
  }

  // Ensure numeric typing
  if (final.SelectedQuantity.Quantity != null) final.SelectedQuantity.Quantity = Number(final.SelectedQuantity.Quantity);
  if (final.SelectedQuantity.Kinds != null) final.SelectedQuantity.Kinds = Number(final.SelectedQuantity.Kinds);

  return { final, stockMappingUsed };
}

// ---------- OpenAI call ----------
async function callOpenAIForExtractor(rawText) {
  const prompt = PROMPT_TEMPLATE(rawText);

  const body = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0,
    max_tokens: 2000
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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

  // Log finish_reason to detect truncation
  logger.log(`OpenAI finish_reason: ${j.choices?.[0]?.finish_reason}, usage: ${JSON.stringify(j.usage)}`);

  // extract text from chat completion response
  let text = "";
  if (j.choices?.[0]?.message?.content) {
    text = j.choices[0].message.content;
    logger.log(`OpenAI response length: ${text.length} chars`);
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
  const result = buildFinalJsonFromExtracted(extracted, rawText);
  const final = result.final;
  const stockMappingUsed = result.stockMappingUsed;

  // Enforce the always-required hard-coded fields (again) to be safe
  final.CustomerCode = "C00014";
  final.Deliveries = [];

  return { final, extracted, stockMappingUsed };
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
    const { final: payload, extracted, stockMappingUsed } = result;

    if (enableLogging) {
      logger.log("Extracted data:", JSON.stringify(extracted, null, 2));
      logger.log("Payload (final JSON):", JSON.stringify(payload, null, 2));
      logger.log("Stock mapping used:", stockMappingUsed);
    }

    return {
      success: true,
      payload,
      extracted,
      stockMappingUsed,
      timestamp: Date.now()
    };

  } catch (error) {
    logger.error("OpenAI conversion error:", error);
    return {
      success: false,
      error: String(error),
      payload: null,
      extracted: null,
      stockMappingUsed: false,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  convertWithOpenAI,
  processEmailWithOpenAI
};
