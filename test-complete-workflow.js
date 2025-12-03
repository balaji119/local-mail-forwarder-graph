/* test-complete-workflow.js
   Test file for the complete email-to-quote workflow combining OpenAI conversion and quote processing.
   Run with: node test-complete-workflow.js
*/

const { convertWithOpenAI, processEmailWithOpenAI } = require('./openai-converter');
const { processQuote } = require('./quote-processor');
const path = require('path');

// Sample emails representing different types of quote requests
const testEmails = {
//   singleKind: {
//     name: "Single Kind",
//     email: `
// Please Supply Price and Lead Time for the following items:
 
// RFQ No.: Q12574:1.0
// TITLE: Gift Card Gondola Header Side 135x1085 RC
// PROD: 10368V1-Gift Card Gondola Header Side 135x1085 RC
// SIZE: 135.0 mm x 1085.0 mm
// 572406002C01
// PRINT: 4 Colour Process one side
// STOCK: 400gsm Pearl Artboard
// FINISH: Trim to Size
// PACKING: Bulk Pack
// DELIVERY: One delivery Melbourne . Tic Group Att: Wendy Pham 03 8378 9263 Door 3 207 Sunshine Road (Enter via Quarry Road) Tottenham VIC 3012 
// Quantity	Unit Price	Total Price (ex gst)	Lead Times
// 870			
// `.trim()
//   },

  multipleKinds: {
    name: "Multiple Kinds", 
    email: `
Please Supply Price and Lead Time for the following items:
 
RFQ No.: Q12686:1.0
TITLE: A0 P SS RC
PROD: 1102V01-A0 P SS RC
SIZE: 1189.0 mm x 841.0 mm
561203002C01 x390
561203003C01 x10
561203004C01 x5
3 kinds
PRINT: 4 Colour Process + Gloss Varnish one side
STOCK: 300gsm Hi-Bulk Art Board
FINISH: Trim to size
PACKING: Bulk pack by kind and label for delivery to TIC
DELIVERY: One delivery Melbourne . Tic Group Att: Wendy Pham 03 8378 9263 Door 3 207 Sunshine Road (Enter via Quarry Road) Tottenham VIC 3012 
Quantity	Unit Price	Total Price (ex gst)	Lead Times
405			
`.trim()
  }
};

/**
 * Test the complete workflow from email text to quote result
 * @param {string} emailType - Type of email being tested
 * @param {string} emailText - The email content
 * @returns {Object} Test result with success status and details
 */
async function testCompleteWorkflow(emailType, emailText) {
  console.log(`\n🔄 Testing complete workflow for: ${emailType}`);
  console.log('=' .repeat(50));
  
  const result = {
    emailType,
    success: false,
    steps: {
      openaiConversion: { success: false, duration: 0 },
      quoteProcessing: { success: false, duration: 0 }
    },
    payload: null,
    quoteResult: null,
    error: null
  };

  try {
    // Step 1: OpenAI Email Conversion
    console.log('📧 Step 1: Converting email with OpenAI...');
    const conversionStart = Date.now();
    
    const conversionResult = await processEmailWithOpenAI(emailText, { enableLogging: true });
    result.steps.openaiConversion.duration = Date.now() - conversionStart;
    
    if (!conversionResult.success) {
      result.error = `OpenAI conversion failed: ${conversionResult.error}`;
      console.log(`❌ OpenAI conversion failed: ${conversionResult.error}`);
      return result;
    }
    
    result.steps.openaiConversion.success = true;
    result.payload = conversionResult.payload;
    
    console.log(`✅ OpenAI conversion successful (${result.steps.openaiConversion.duration}ms)`);
    console.log(`   📊 Extracted details:`);
    console.log(`   - Quantity: ${result.payload.SelectedQuantity?.Quantity || 'N/A'}`);
    console.log(`   - Size: ${result.payload.CustomProduct?.FinishSizeWidth || 'N/A'}x${result.payload.CustomProduct?.FinishSizeHeight || 'N/A'}`);
    console.log(`   - Job Title: ${result.payload.JobTitle || 'N/A'}`);
    console.log(`   - Customer Code: ${result.payload.CustomerCode}`);
    
    // Step 2: Quote Processing
    console.log('\n🏭 Step 2: Processing quote with PrintIQ...');
    const quoteStart = Date.now();
    
    const testLogDir = path.join(__dirname, 'test-logs', 'workflow', emailType);
    const quoteResult = await processQuote(result.payload, { logDir: testLogDir });
    result.steps.quoteProcessing.duration = Date.now() - quoteStart;
    
    if (!quoteResult.success) {
      result.error = `Quote processing failed: ${quoteResult.error}`;
      console.log(`❌ Quote processing failed: ${quoteResult.error}`);
      return result;
    }
    
    result.steps.quoteProcessing.success = true;
    result.quoteResult = quoteResult;
    result.success = true;
    
    console.log(`✅ Quote processing successful (${result.steps.quoteProcessing.duration}ms)`);
    console.log(`   📈 Quote details:`);
    console.log(`   - Status: ${quoteResult.createResult?.status || 'N/A'}`);
    
    if (quoteResult.priceInfo) {
      console.log(`   - Quote No: ${quoteResult.priceInfo.quoteNo || 'N/A'}`);
      console.log(`   - Price: $${quoteResult.priceInfo.price || 'N/A'}`);
      console.log(`   - Quantity: ${quoteResult.priceInfo.qty || 'N/A'}`);
    } else {
      console.log(`   - No price information available`);
    }
    
    // Success Summary
    const totalDuration = result.steps.openaiConversion.duration + result.steps.quoteProcessing.duration;
    console.log(`\n🎉 Complete workflow successful! Total time: ${totalDuration}ms`);
    
    return result;
    
  } catch (error) {
    result.error = `Workflow exception: ${error.message}`;
    console.log(`💥 Workflow failed with exception: ${error.message}`);
    return result;
  }
}

/**
 * Run workflow tests on all sample emails
 */
async function runAllWorkflowTests() {
  console.log('🚀 Starting Complete Workflow Tests');
  console.log('This will test the full email → OpenAI → PrintIQ → Quote flow');
  console.log('Note: Requires valid OPENAI_API_KEY and PrintIQ credentials\n');
  
  const results = [];
  
  for (const [emailKey, emailData] of Object.entries(testEmails)) {
    const result = await testCompleteWorkflow(emailData.name, emailData.email);
    results.push(result);
    
    // Add delay between tests to be respectful to APIs
    if (Object.keys(testEmails).indexOf(emailKey) < Object.keys(testEmails).length - 1) {
      console.log('\n⏱️  Waiting 2 seconds before next test...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Summary Report
  console.log('\n📊 WORKFLOW TEST SUMMARY');
  console.log('=' .repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful: ${successful.length}/${results.length}`);
  console.log(`❌ Failed: ${failed.length}/${results.length}`);
  
  if (successful.length > 0) {
    console.log('\n🏆 Successful Tests:');
    successful.forEach(result => {
      const totalTime = result.steps.openaiConversion.duration + result.steps.quoteProcessing.duration;
      console.log(`  - ${result.emailType}: ${totalTime}ms total`);
    });
  }
  
  if (failed.length > 0) {
    console.log('\n💔 Failed Tests:');
    failed.forEach(result => {
      console.log(`  - ${result.emailType}: ${result.error}`);
    });
  }
  
  // Performance Analysis
  if (successful.length > 0) {
    const avgOpenAITime = successful.reduce((sum, r) => sum + r.steps.openaiConversion.duration, 0) / successful.length;
    const avgQuoteTime = successful.reduce((sum, r) => sum + r.steps.quoteProcessing.duration, 0) / successful.length;
    
    console.log('\n⚡ Performance Averages:');
    console.log(`  - OpenAI Conversion: ${Math.round(avgOpenAITime)}ms`);
    console.log(`  - Quote Processing: ${Math.round(avgQuoteTime)}ms`);
    console.log(`  - Total Workflow: ${Math.round(avgOpenAITime + avgQuoteTime)}ms`);
  }
  
  console.log('\n🏁 All workflow tests completed!');
  return results;
}

/**
 * Test workflow with error scenarios
 */
async function testErrorScenarios() {
  console.log('\n🧪 Testing Error Scenarios');
  console.log('=' .repeat(40));
  
  const errorTests = {
    'Empty Email': '',
    'Gibberish': 'Lorem ipsum dolor sit amet consectetur adipiscing elit',
    'No Quantity': 'Subject: Quote Request\nPlease provide quote for business cards\nThanks!',
    'Invalid Format': '{"this": "is not an email"}'
  };
  
  for (const [testName, emailText] of Object.entries(errorTests)) {
    console.log(`\n🔍 Testing: ${testName}`);
    try {
      const result = await testCompleteWorkflow(testName, emailText);
      if (result.success) {
        console.log(`✅ Handled gracefully - extracted quantity: ${result.payload?.SelectedQuantity?.Quantity}`);
      } else {
        console.log(`✅ Failed as expected: ${result.error}`);
      }
    } catch (error) {
      console.log(`✅ Exception handled: ${error.message}`);
    }
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  async function main() {
    try {
      const results = await runAllWorkflowTests();
      //await testErrorScenarios();
      
      // Exit with appropriate code
      const hasFailures = results.some(r => !r.success);
      process.exit(hasFailures ? 1 : 0);
    } catch (error) {
      console.error('Test runner failed:', error);
      process.exit(1);
    }
  }
  
  main();
}

module.exports = {
  testCompleteWorkflow,
  runAllWorkflowTests,
  testErrorScenarios,
  testEmails
};