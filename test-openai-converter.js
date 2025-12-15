/* test-openai-converter.js
   Test file for the extracted OpenAI email conversion functionality.
   Run with: node test-openai-converter.js
*/

const { convertWithOpenAI, processEmailWithOpenAI } = require('./openai-converter');

// Sample email texts for testing
const sampleEmails = {
  businessCards: `
RFQ No: BC001
TITLE: Business Cards for ABC Corp
SIZE: 90mm x 54mm  
QUANTITY: 1000
Notes: Standard business cards, double sided printing required
Customer: John Smith <john@abccorp.com>
Due Date: 2024-01-15
`,

  flyers: `
Subject: Quote Request - Marketing Flyers

Hi, we need a quote for:
- A5 flyers 
- Quantity: 5000
- Full color both sides
- 150gsm paper
- Need by end of month

Thanks,
Sarah Marketing
sarah@company.com
`,

  brochures: `
RFQ: 20241201-001
Product: Tri-fold brochures
Size: DL when folded (99mm x 210mm)
Open size: 297mm x 210mm  
Quantity: 2500
Stock: 250gsm gloss art paper
Finishing: Folded
Customer reference: PROMO2024-Q4
Expected delivery: 15th December
`,

  minimal: `
Subject: Quick quote needed
100 business cards
Standard size
Thanks
`,

  complex: `
RFQ#: 2024-120-XYZ
TITLE: Corporate Annual Report
SIZE: A4 (210mm x 297mm)
PAGES: 24 pages
QUANTITY: 500 copies
STOCK: Cover - 300gsm, Inner - 150gsm
BINDING: Perfect bound
FINISHING: Matt lamination on cover
Customer: Big Corporation Ltd
Contact: Jane Doe <jane.doe@bigcorp.com>
Reference: AR-2024-001
Due date: 2024-12-20
Delivery: Head office, 123 Business St, Sydney
Notes: Annual report with financial statements. Require PDF proof before printing.
`
};

async function testBasicConversion() {
  console.log('\n=== Testing Basic Email Conversion ===');
  
  try {
    const result = await convertWithOpenAI(sampleEmails.businessCards);
    console.log('Business Cards Result:', JSON.stringify(result, null, 2));
    
    // Verify required fields
    console.log('✓ CustomerCode:', result.CustomerCode);
    console.log('✓ Deliveries empty:', Array.isArray(result.Deliveries) && result.Deliveries.length === 0);
    console.log('✓ Sections populated:', result.CustomProduct?.Sections?.length > 0);
    console.log('✓ JobOperations populated:', result.CustomProduct?.JobOperations?.length > 0);
    
  } catch (error) {
    console.error('Basic conversion failed:', error.message);
  }
}

async function testProcessEmailWithLogging() {
  console.log('\n=== Testing processEmailWithOpenAI with Logging ===');
  
  try {
    const result = await processEmailWithOpenAI(sampleEmails.flyers, { enableLogging: true });
    console.log('Process result success:', result.success);
    console.log('Timestamp:', result.timestamp);
    
    if (result.success) {
      console.log('Quantity extracted:', result.payload?.SelectedQuantity?.Quantity);
      console.log('Job Title:', result.payload?.JobTitle);
    } else {
      console.log('Error:', result.error);
    }
    
  } catch (error) {
    console.error('Process email test failed:', error.message);
  }
}

async function testMultipleEmailFormats() {
  console.log('\n=== Testing Multiple Email Formats ===');
  
  for (const [type, emailText] of Object.entries(sampleEmails)) {
    console.log(`\n--- Testing ${type} ---`);
    try {
      const result = await processEmailWithOpenAI(emailText, { enableLogging: false });
      
      if (result.success) {
        const payload = result.payload;
        console.log(`✓ ${type}:`);
        console.log(`  - Quantity: ${payload?.SelectedQuantity?.Quantity}`);
        console.log(`  - Size: ${payload?.CustomProduct?.FinishSizeWidth}x${payload?.CustomProduct?.FinishSizeHeight}`);
        console.log(`  - Job Title: ${payload?.JobTitle || 'N/A'}`);
        console.log(`  - Customer Reference: ${payload?.CustomerReference || 'N/A'}`);
      } else {
        console.log(`✗ ${type}: Failed - ${result.error}`);
      }
    } catch (error) {
      console.log(`✗ ${type}: Exception - ${error.message}`);
    }
  }
}

async function testErrorHandling() {
  console.log('\n=== Testing Error Handling ===');
  
  // Test with empty input
  try {
    const emptyResult = await processEmailWithOpenAI('');
    console.log('Empty input result:', emptyResult.success ? 'Success' : emptyResult.error);
  } catch (error) {
    console.log('Empty input error:', error.message);
  }
  
  // Test with malformed input
  try {
    const malformedResult = await processEmailWithOpenAI('Lorem ipsum dolor sit amet...');
    console.log('Malformed input success:', malformedResult.success);
    if (malformedResult.success) {
      console.log('  Quantity extracted:', malformedResult.payload?.SelectedQuantity?.Quantity);
    }
  } catch (error) {
    console.log('Malformed input error:', error.message);
  }
}

async function testHardCodedValues() {
  console.log('\n=== Testing Hard-coded Values ===');
  
  try {
    const result = await convertWithOpenAI(sampleEmails.minimal);
    
    // Test hard-coded values
    console.log('CustomerCode check:', result.CustomerCode === "C00014" ? '✓' : '✗');
    console.log('Deliveries empty check:', Array.isArray(result.Deliveries) && result.Deliveries.length === 0 ? '✓' : '✗');
    console.log('Sections check:', result.CustomProduct?.Sections?.length === 1 ? '✓' : '✗');
    console.log('JobOperations check:', result.CustomProduct?.JobOperations?.length === 1 ? '✓' : '✗');
    console.log('Kinds defaulted check:', result.SelectedQuantity?.Kinds === 1 ? '✓' : '✗');
    
    // Display the hard-coded values
    console.log('\nHard-coded Sections:', JSON.stringify(result.CustomProduct.Sections, null, 2));
    console.log('\nHard-coded JobOperations:', JSON.stringify(result.CustomProduct.JobOperations, null, 2));
    
  } catch (error) {
    console.error('Hard-coded values test failed:', error.message);
  }
}

async function runAllTests() {
  console.log('Starting OpenAI Converter Tests...');
  console.log('Note: These tests require a valid OPENAI_API_KEY in your .env file');
  
  await testBasicConversion();
  await testProcessEmailWithLogging();
  await testMultipleEmailFormats();
  await testErrorHandling();
  await testHardCodedValues();
  
  console.log('\n=== All OpenAI converter tests completed ===');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testBasicConversion,
  testProcessEmailWithLogging,
  testMultipleEmailFormats,
  testErrorHandling,
  testHardCodedValues,
  sampleEmails
};