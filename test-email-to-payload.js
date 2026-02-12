#!/usr/bin/env node
/**
 * test-email-to-payload.js
 *
 * Tests steps #2 and #3 only, using the same application code as production:
 *   #2 = OpenAI parses the email (openai-converter.js: callOpenAIForExtractor + parseModelTextToJson)
 *   #3 = Build PrintIQ JSON payload (openai-converter.js: buildFinalJsonFromExtracted)
 * No Outlook (#1), no PrintIQ API (#4).
 *
 * Usage:
 *   node test-email-to-payload.js                    # use data/sample-emails/coles-rfq-q14242.txt
 *   node test-email-to-payload.js path/to/email.txt  # use email from file
 *
 * Output: writes payload + extracted JSON to data/test-payloads/<timestamp>.json
 *         and prints summary to console.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
// Same module as webhook-server.js; processEmailWithOpenAI wraps convertWithOpenAI (steps #2 + #3)
const { processEmailWithOpenAI } = require('./openai-converter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TEST_PAYLOADS_DIR = path.join(DATA_DIR, 'test-payloads');
const DEFAULT_SAMPLE_FILE = path.join(__dirname, 'data', 'sample-emails', 'coles-rfq-q14242.txt');

function getEmailText() {
  const fileArg = process.argv[2];
  const filePath = fileArg
    ? (path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg))
    : DEFAULT_SAMPLE_FILE;
  if (!fs.existsSync(filePath)) {
    if (fileArg) {
      console.error('File not found:', filePath);
      process.exit(1);
    }
    console.error('Default sample file not found:', DEFAULT_SAMPLE_FILE);
    console.error('Create it or run: node test-email-to-payload.js path/to/email.txt');
    process.exit(1);
  }
  return fs.readFileSync(filePath, 'utf8');
}

async function main() {
  const emailText = getEmailText();
  const source = process.argv[2] ? `file: ${process.argv[2]}` : `file: data/sample-emails/coles-rfq-q14242.txt`;

  console.log('--- Test: Email → Payload (no Outlook, no PrintIQ) ---');
  console.log('Source:', source);
  console.log('Email preview (first 300 chars):');
  console.log(emailText.substring(0, 300).replace(/\n/g, '\n  '));
  console.log('---');

  const result = await processEmailWithOpenAI(emailText, { enableLogging: true });

  if (!result.success) {
    console.error('Conversion failed:', result.error);
    process.exit(1);
  }

  const { payload, extracted, stockMappingUsed } = result;
  const timestamp = Date.now();
  const outDir = TEST_PAYLOADS_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const output = {
    timestamp,
    source,
    stockMappingUsed,
    extracted,
    payload
  };
  const outPath = path.join(outDir, `payload-${timestamp}.json`);
  const payloadOnlyPath = path.join(outDir, `payload-${timestamp}-printiq.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  fs.writeFileSync(payloadOnlyPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n--- Result ---');
  console.log('Stock mapping used:', stockMappingUsed);
  console.log('Extracted (rfq_no, title, prod, quantity, kinds count):', {
    rfq_no: extracted?.rfq_no,
    title: extracted?.title,
    prod: extracted?.prod,
    quantity: extracted?.quantity,
    kindsCount: extracted?.kinds?.length
  });
  console.log('Full result (extracted + payload) written to:', outPath);
  console.log('JSON payload only (PrintIQ-ready) written to:', payloadOnlyPath);
  console.log('\nJobOperations:', JSON.stringify(payload?.CustomProduct?.JobOperations, null, 2));
  console.log('\nSectionOperations:', JSON.stringify(payload?.CustomProduct?.Sections?.[0]?.SectionOperations, null, 2));
  console.log('\nFull payload (JobTitle, SelectedQuantity, CustomProduct sizes):');
  console.log(JSON.stringify({
    JobTitle: payload?.JobTitle,
    CustomerReference: payload?.CustomerReference,
    SelectedQuantity: payload?.SelectedQuantity,
    FinishSize: payload?.CustomProduct
      ? { width: payload.CustomProduct.FinishSizeWidth, height: payload.CustomProduct.FinishSizeHeight }
      : null
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
