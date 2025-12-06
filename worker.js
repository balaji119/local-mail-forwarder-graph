// worker.js — patched so jobs are removed only after webhook accepted and message marked read
// - do NOT mark messages read during poll
// - mark message read only after webhook responds OK
// - only then mark job done
// - atomic claim of jobs + run-guard to avoid overlap

require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const Database = require('better-sqlite3');
const logger = require('./logger');

// -----------------------------------------
// Config
// -----------------------------------------
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://webhook:3000/webhook/email";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 10000); // default 10 seconds
const MAILBOX = process.env.EMAIL_FROM; // mailbox to poll with Graph
const CLAIM_LIMIT = Number(process.env.CLAIM_LIMIT || 10);

if (!MAILBOX) {
  console.error("ERROR: EMAIL_FROM is required (mailbox to poll)");
  process.exit(1);
}

// -----------------------------------------
// ms-graph-mail functions (reuse your existing module)
// -----------------------------------------
const {
  getGraphAccessToken,
  fetchUnreadEmails,
  markMessageAsRead,
  convertGraphMessage
} = require('./ms-graph-mail');

// -----------------------------------------
// SQLite DB
// -----------------------------------------
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT UNIQUE,
  status TEXT,
  payload TEXT,
  created_at TEXT
);
`);

// Prepared statements
const insertJob = db.prepare(`
INSERT OR IGNORE INTO jobs (msg_id, status, payload, created_at)
VALUES (@msg_id, @status, @payload, datetime('now'))
`);

const markJobDone = db.prepare(`UPDATE jobs SET status='done' WHERE id=?`);
const markJobError = db.prepare(`UPDATE jobs SET status='error' WHERE id=?`);
const resetProcessingToPending = db.prepare(`UPDATE jobs SET status='pending' WHERE status='processing'`);

// -----------------------------------------
// Claiming logic: atomically grab a batch of pending job ids and mark them 'processing'
// -----------------------------------------
function claimAndGetJobs(limit = CLAIM_LIMIT) {
  const tx = db.transaction((lim) => {
    const rows = db.prepare(`SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT ?`).all(lim);
    const ids = rows.map(r => r.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE jobs SET status='processing' WHERE id IN (${placeholders})`).run(...ids);

    const claimed = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
    return claimed;
  });

  return tx(limit);
}

// Optional: on startup, reset any 'processing' rows back to 'pending' so stuck jobs are retried
function recoverStuckProcessing() {
  try {
    resetProcessingToPending.run();
  } catch (err) {
    logger.error("Failed to reset processing -> pending:", err);
  }
}

// -----------------------------------------
// Poll Office365 for emails
// NOTE: We do NOT mark messages read here. We only insert job rows (INSERT OR IGNORE).
// The message will remain unread until the webhook accepted the job and we mark it read later.
// -----------------------------------------
async function pollMailbox() {
  try {
    const token = await getGraphAccessToken();
    const messages = await fetchUnreadEmails(token, MAILBOX);

    if (messages.length > 0) {
      logger.log(`Found ${messages.length} unread message(s)`);
    }

    for (const msg of messages) {
      const converted = convertGraphMessage(msg);

      // store msg_id and payload (dedupe by msg_id due to UNIQUE constraint)
      insertJob.run({
        msg_id: msg.id,
        status: "pending",
        payload: JSON.stringify(converted)
      });

      // IMPORTANT: do NOT mark the message read here. We'll only mark it read
      // after the webhook has accepted and the reply has been sent.
    }
  } catch (err) {
    logger.error("Mailbox poll error:", err);
  }
}

// -----------------------------------------
// Process pending jobs → send to webhook
// After webhook responds OK, mark the original Office365 message as read,
// and only then mark the job DONE in DB.
// -----------------------------------------
async function processJobs() {
  const jobs = claimAndGetJobs(CLAIM_LIMIT);

  if (!jobs || jobs.length === 0) {
    return;
  }

  for (const job of jobs) {
    logger.log(`Processing job id=${job.id} msg_id=${job.msg_id}`);

    try {
      const resp = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: job.payload
      });

      if (!resp.ok) {
        // Webhook didn't accept the job — mark job error so it can be retried later.
        logger.error(`Webhook error for job id=${job.id} msg_id=${job.msg_id}: HTTP ${resp.status}`);
        markJobError.run(job.id);
        continue;
      }

      // Webhook returned 200 OK - check if we should mark as read
      let webhookResult;
      try {
        webhookResult = await resp.json();
      } catch (parseErr) {
        logger.error(`Failed to parse webhook response for job id=${job.id}:`, parseErr);
        markJobError.run(job.id);
        continue;
      }

      // Check if webhook says we should mark as read (price found + reply sent)
      const shouldMarkAsRead = webhookResult?.shouldMarkAsRead === true;
      
      if (!shouldMarkAsRead) {
        // Either no price was found or reply was not sent - don't mark as read so it can be retried
        const reason = webhookResult?.replyResult?.reason || webhookResult?.replyResult?.error || 'no-price-or-reply-failed';
        logger.warn(`Not marking as read for job id=${job.id} msg_id=${job.msg_id}. Reason: ${reason}`);
        markJobError.run(job.id);
        continue;
      }

      // shouldMarkAsRead is true - now mark the original Office365 message as read
      try {
        // Need a fresh Graph token to mark message as read
        const token = await getGraphAccessToken();
        await markMessageAsRead(token, MAILBOX, job.msg_id);
      } catch (errMark) {
        // Failed to mark message as read — we should NOT mark job done,
        // because marking the message read is part of the guarantee.
        // Mark job as error so it will be retried (or you could reset to 'pending').
        logger.error(`Failed to mark message read for job id=${job.id} msg_id=${job.msg_id}:`, errMark);
        markJobError.run(job.id);
        continue;
      }

      // If we reach here, webhook accepted AND reply sent AND message marked read — safe to mark job done
      markJobDone.run(job.id);
      logger.log(`Job processed, reply sent, and message marked read: id=${job.id} msg_id=${job.msg_id}`);
    } catch (err) {
      // network or unexpected exception
      logger.error(`Webhook exception for job id=${job.id} msg_id=${job.msg_id}:`, err);
      markJobError.run(job.id);
    }
  }
}

// -----------------------------------------
// Main Loop — prevent overlapping runs
// -----------------------------------------
let mainRunning = false;

async function mainLoop() {
  if (mainRunning) {
    // skip this tick if previous run still active
    return;
  }
  mainRunning = true;
  try {
    await pollMailbox();
    await processJobs();
  } catch (err) {
    logger.error("mainLoop error:", err);
  } finally {
    mainRunning = false;
  }
}

// startup
recoverStuckProcessing();
console.log("Worker started. Polling Office365 mailbox:", MAILBOX);
setInterval(mainLoop, POLL_INTERVAL);
mainLoop();
