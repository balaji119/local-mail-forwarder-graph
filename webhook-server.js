/* webhook-server.js
   Receives parsed email JSON, converts to PrintIQ JSON via OpenAI, creates PrintIQ quote,
   extracts price and replies using Microsoft Graph app-only sendMail.
*/
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { sendMailOffice365 } = require('./ms-graph-mail');
const { processQuote } = require('./quote-processor');
const { convertWithOpenAI } = require('./openai-converter');
const logger = require('./logger');

const app = express();
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = path.join(DATA_DIR, 'webhook-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;

app.post('/webhook/email', async (req, res) => {
  try {
    const { from, subject, text, html, attachments, raw } = req.body;
    const emailText = `${subject || ''}\n\n${text || ''}\n\n${raw || ''}`;

    logger.log("Incoming email from:", from);
    logger.log("Subject:", subject);

    const payload = await convertWithOpenAI(emailText);
    logger.log("Payload:", JSON.stringify(payload, null, 2));

    // Process the quote using the extracted module
    const quoteResult = await processQuote(payload, { logDir: LOG_DIR });
    
    if (!quoteResult.success) {
      logger.error("Failed to process quote:", quoteResult.error);
      return res.status(500).json({ ok: false, error: quoteResult.error, debug: quoteResult.debug });
    }

    const { createResult, priceInfo } = quoteResult;
    let replyResult = { ok: false, reason: 'no-price-found' };
    let shouldMarkAsRead = false;

    if (priceInfo && typeof priceInfo.price !== 'undefined' && priceInfo.price !== null) {
      const priceStr = Number(priceInfo.price).toFixed(2);
      const qtyText = priceInfo.qty || '';
      const quoteNo = priceInfo.quoteNo || '';
      const replyTo = process.env.REPLY_TO_EMAIL || (payload.DeliveryContact && payload.DeliveryContact.Email) || from || '';

      const replySubject = `Re: ${subject || 'Your RFQ'} — Quote ${quoteNo}`;
      const replyHtml = `<p>Thanks — we created quote <strong>${quoteNo}</strong>.</p>
<p><strong>Estimated unit price:</strong> ${priceStr} (ex GST)<br/><strong>Quantity:</strong> ${qtyText}</p>
<p>If you'd like to proceed reply to this email.</p>`;

      try {
        replyResult = await sendMailOffice365({ to: replyTo, subject: replySubject, htmlBody: replyHtml });
        // Only mark as read if reply was successfully sent
        if (replyResult.ok) {
          shouldMarkAsRead = true;
        }
      } catch (err) {
        replyResult = { ok: false, error: String(err) };
        logger.error("Error sending reply via Graph:", err);
      }
    } else {
      logger.warn("No price found in createResult, not sending reply.");
    }

    res.json({ ok: true, createResult, priceInfo, replyResult, shouldMarkAsRead });
  } catch (err) {
    logger.error("Webhook error:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on http://0.0.0.0:${PORT}/webhook/email`));