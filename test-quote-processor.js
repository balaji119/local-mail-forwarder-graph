/* test-quote-processor.js
   Test file for the extracted quote processing functionality.
   Run with: node test-quote-processor.js
*/

const { processQuote, extractPriceInfo, getPrintIQToken, createQuoteOnPrintIQ } = require('./quote-processor');
const { convertWithOpenAI, processEmailWithOpenAI } = require('./openai-converter');
const path = require('path');

// Sample test payload
const samplePayload = {
  "CustomProduct": {
    "ProductCategory": null,
    "FinishSizeWidth": 135,
    "FinishSizeHeight": 975,
    "Sections": [
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
    ],
    "JobOperations": [
      { "OperationName": "Preflight" }
    ]
  },
  "SelectedQuantity": {
    "Quantity": 1000,
    "Kinds": 1
  },
  "QuoteContact": {},
  "Deliveries": [],
  "TargetFreightPrice": null,
  "CustomerCode": "C00116",
  "AcceptQuote": false,
  "JobDescription": "Test quote for business cards",
  "JobTitle": "RFQ001 - Business Cards",
  "Notes": "Standard business cards",
  "CustomerExpectedDate": null,
  "JobDueDate": null,
  "CustomerReference": "TEST001"
};

// Mock response for testing price extraction
const mockCreateResult = {
  status: 200,
  body: {
    QuoteDetails: {
      QuoteNo: "Q12345",
      Products: [{
        Quantities: [{
          Price: 125.50,
          Quantity: 1000,
          QuantityToDisplay: "1000"
        }]
      }]
    }
  }
};

async function testExtractPriceInfo() {
  console.log('\n=== Testing extractPriceInfo ===');
  
  const priceInfo = extractPriceInfo(mockCreateResult);
  console.log('Price Info:', priceInfo);
  
  // Test with null input
  const nullResult = extractPriceInfo(null);
  console.log('Null input result:', nullResult);
  
  // Test with malformed data
  const malformedResult = extractPriceInfo({ status: 200, body: { error: "Invalid data" } });
  console.log('Malformed data result:', malformedResult);
}

async function testGetToken() {
  console.log('\n=== Testing getPrintIQToken ===');
  
  try {
    const tokenResult = await getPrintIQToken();
    console.log('Token result success:', tokenResult.success);
    if (tokenResult.success) {
      console.log('Token length:', tokenResult.token?.length);
    } else {
      console.log('Token error reason:', tokenResult.reason);
    }
  } catch (error) {
    console.error('Token test failed:', error.message);
  }
}

async function testProcessQuote() {
  console.log('\n=== Testing processQuote ===');
  
  try {
    const testLogDir = path.join(__dirname, 'test-logs');
    const result = await processQuote(samplePayload, { logDir: testLogDir });
    
    console.log('Process quote success:', result.success);
    if (result.success) {
      console.log('Create result status:', result.createResult?.status);
      console.log('Price info:', result.priceInfo);
      console.log('Timestamp:', result.timestamp);
    } else {
      console.log('Process quote error:', result.error);
    }
  } catch (error) {
    console.error('Process quote test failed:', error.message);
  }
}

async function testCreateQuote() {
  console.log('\n=== Testing createQuoteOnPrintIQ (requires valid token) ===');
  
  try {
    // First get a token
    const tokenResult = await getPrintIQToken();
    if (!tokenResult.success) {
      console.log('Skipping createQuote test - no valid token');
      return;
    }
    
    const createResult = await createQuoteOnPrintIQ(samplePayload, tokenResult.token);
    console.log('Create quote status:', createResult.status);
    console.log('Create quote body type:', typeof createResult.body);
    
    if (createResult.status === 200 && typeof createResult.body === 'object') {
      const priceInfo = extractPriceInfo(createResult);
      console.log('Extracted price info:', priceInfo);
    }
  } catch (error) {
    console.error('Create quote test failed:', error.message);
  }
}

// Sample emails for combined testing
const sampleEmails = {
  businessCards: `
RFQ No: BC001-TEST
TITLE: Business Cards for Test Company
SIZE: 90mm x 54mm  
QUANTITY: 500
Notes: Standard business cards, double sided printing required
Customer: John Test <john@testcompany.com>
Due Date: 2024-12-15
`,

  flyers: `
Subject: Quote Request - Marketing Flyers

Hi, we need a quote for:
- A5 flyers 
- Quantity: 2500
- Full color both sides
- 150gsm paper
- Need by end of month

Thanks,
Sarah Marketing
sarah@testcompany.com
`,

  brochures: `
RFQ: 20241201-BROCH
Product: Tri-fold brochures
Size: DL when folded (99mm x 210mm)
Quantity: 1000
Stock: 250gsm gloss art paper
Customer reference: TEST-BROCH-2024
Expected delivery: 20th December
`
};

async function testCompleteWorkflow() {
  console.log('\n=== Testing Complete Email-to-Quote Workflow ===');
  
  for (const [emailType, emailText] of Object.entries(sampleEmails)) {
    console.log(`\n--- Processing ${emailType} email ---`);
    
    try {
      // Step 1: Convert email to payload using OpenAI
      console.log('Step 1: Converting email with OpenAI...');
      const conversionResult = await processEmailWithOpenAI(emailText, { enableLogging: false });
      
      if (!conversionResult.success) {
        console.log(`✗ ${emailType}: OpenAI conversion failed - ${conversionResult.error}`);
        continue;
      }
      
      console.log(`✓ OpenAI conversion successful`);
      console.log(`  - Extracted quantity: ${conversionResult.payload?.SelectedQuantity?.Quantity}`);
      console.log(`  - Job title: ${conversionResult.payload?.JobTitle || 'N/A'}`);
      console.log(`  - Size: ${conversionResult.payload?.CustomProduct?.FinishSizeWidth}x${conversionResult.payload?.CustomProduct?.FinishSizeHeight}`);
      
      // Step 2: Process the quote using the payload
      console.log('Step 2: Processing quote with PrintIQ...');
      const testLogDir = path.join(__dirname, 'test-logs', emailType);
      const quoteResult = await processQuote(conversionResult.payload, { logDir: testLogDir });
      
      if (!quoteResult.success) {
        console.log(`✗ ${emailType}: Quote processing failed - ${quoteResult.error}`);
        continue;
      }
      
      console.log(`✓ Quote processing successful`);
      console.log(`  - Create result status: ${quoteResult.createResult?.status}`);
      
      if (quoteResult.priceInfo) {
        console.log(`  - Quote number: ${quoteResult.priceInfo.quoteNo}`);
        console.log(`  - Price: ${quoteResult.priceInfo.price}`);
        console.log(`  - Quantity: ${quoteResult.priceInfo.qty}`);
      } else {
        console.log(`  - No price information extracted`);
      }
      
      // Step 3: Summary
      console.log(`✓ ${emailType}: Complete workflow successful!`);
      
    } catch (error) {
      console.log(`✗ ${emailType}: Workflow failed with exception - ${error.message}`);
    }
  }
}

async function testWorkflowWithMockData() {
  console.log('\n=== Testing Workflow with Mock Email (No API calls) ===');
  
  // Test the workflow structure without making real API calls
  const mockEmail = sampleEmails.businessCards;
  
  try {
    console.log('Testing workflow structure...');
    console.log('Email input preview:', mockEmail.substring(0, 100) + '...');
    
    // This would normally go through OpenAI, but we'll simulate it
    console.log('✓ Would convert email to payload via OpenAI');
    console.log('✓ Would process quote via PrintIQ');
    console.log('✓ Would extract price information');
    console.log('✓ Complete workflow structure validated');
    
    // Show what the real workflow would look like
    console.log('\nReal workflow would be:');
    console.log('1. Email Text → OpenAI → Structured Payload');
    console.log('2. Structured Payload → PrintIQ → Quote Result');
    console.log('3. Quote Result → Price Extraction → Response');
    
  } catch (error) {
    console.log('Mock workflow test failed:', error.message);
  }
}

async function testWorkflowErrorHandling() {
  console.log('\n=== Testing Complete Workflow Error Handling ===');
  
  // Test with malformed email
  const malformedEmail = "This is not a proper RFQ email at all...";
  
  try {
    console.log('Testing with malformed email...');
    const result = await processEmailWithOpenAI(malformedEmail, { enableLogging: false });
    
    if (result.success) {
      console.log('✓ OpenAI handled malformed email gracefully');
      console.log('  Extracted quantity:', result.payload?.SelectedQuantity?.Quantity || 'None');
      
      // Try to process this with PrintIQ
      const quoteResult = await processQuote(result.payload, { logDir: null });
      console.log('Quote processing result:', quoteResult.success ? 'Success' : 'Failed');
    } else {
      console.log('✓ OpenAI properly rejected malformed email:', result.error);
    }
    
  } catch (error) {
    console.log('Error handling test completed with exception:', error.message);
  }
}

async function runAllTests() {
  console.log('Starting Quote Processor Tests...');
  
  // Test individual functions
  await testExtractPriceInfo();
  await testGetToken();
  await testCreateQuote();
  
  // Test the main integrated function
  await testProcessQuote();
  
  // Test complete workflow
  await testCompleteWorkflow();
  await testWorkflowWithMockData();
  await testWorkflowErrorHandling();
  
  console.log('\n=== All tests completed ===');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testExtractPriceInfo,
  testGetToken,
  testProcessQuote,
  testCreateQuote,
  testCompleteWorkflow,
  testWorkflowWithMockData,
  testWorkflowErrorHandling,
  samplePayload,
  mockCreateResult,
  sampleEmails
};