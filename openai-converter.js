/* openai-converter.js
   Handles OpenAI email-to-quote conversion functionality.
   Extracted for testability and separation of concerns.
*/
require('dotenv').config();

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

function buildJobTitleFromExtracted(ex) {
  // Build job title from available pieces similarly to earlier rules
  // Prefer: title - rfq_no - prod
  const parts = [];
  if (ex.title) parts.push(ex.title);
  if (ex.rfq_no) parts.push(ex.rfq_no);
  if (ex.prod) parts.push(ex.prod);
  return parts.length ? parts.join(" - ") : null;
}

// Build "final" JSON shape from the compact extracted model output
function buildFinalJsonFromExtracted(extracted, rawText) {
  // Ensure default structure and hard-coded fields as requested
  const final = {
    CustomProduct: {
      ProductCategory: null,
      FinishSizeWidth: null,
      FinishSizeHeight: null,
      Sections: [
        {
          SectionType: "Single-Section",
          StockCode: "100gsm laser",
          ProcessFront: "None",
          ProcessReverse: "None",
          SectionSizeWidth: 96,
          SectionSizeHeight: 48,
          FoldCatalog: "Flat Product",
          Pages: 2,
          SectionOperations: [],
          SideOperations: []
        }
      ],
      JobOperations: [
        { OperationName: "Preflight" }
      ]
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

  // Titles/notes
  final.JobTitle = buildJobTitleFromExtracted(extracted);
  final.JobDescription = extracted.title || null;
  final.Notes = extracted.title || null;


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
// 3) transforms to the final required JSON shape (with your hard-coded defaults)
async function convertWithOpenAI(rawText) {
  // 1) ask model for compact extractor JSON
  const modelText = await callOpenAIForExtractor(rawText);
  console.log("Open AI output: ", modelText)

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

  return final;
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
      console.log("Processing email text (first 200 chars):", (emailText || "").substring(0, 200));
    }
    
    const payload = await convertWithOpenAI(emailText);
    
    if (enableLogging) {
      console.log("Payload (final JSON):", JSON.stringify(payload, null, 2));
    }
    
    return {
      success: true,
      payload,
      timestamp: Date.now()
    };
    
  } catch (error) {
    console.error("OpenAI conversion error:", error);
    return {
      success: false,
      error: String(error),
      payload: null,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  convertWithOpenAI,
  processEmailWithOpenAI
};
