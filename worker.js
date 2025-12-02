// worker.js — now with Microsoft Graph inbound email polling

require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const Database = require('better-sqlite3');
const {
  getGraphAccessToken,
  fetchUnreadEmails,
  markMessageAsRead,
  convertGraphMessage
} = require('./ms-graph-mail');

// -----------------------------------------
// Config
// -----------------------------------------
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://webhook:3000/webhook/email";
const POLL_INTERVAL = 10000; // 10 seconds
const MAILBOX = process.env.EMAIL_FROM; // mailbox to poll with Graph

if (!MAILBOX) {
  console.error("ERROR: EMAIL_FROM is required (mailbox to poll)");
  process.exit(1);
}

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

const insertJob = db.prepare(`
INSERT OR IGNORE INTO jobs (msg_id, status, payload, created_at)
VALUES (@msg_id, @status, @payload, datetime('now'))
`);

const getPendingJobs = db.prepare(`SELECT * FROM jobs WHERE status='pending'`);
const markJobDone = db.prepare(`UPDATE jobs SET status='done' WHERE id=?`);
const markJobError = db.prepare(`UPDATE jobs SET status='error' WHERE id=?`);

// -----------------------------------------
// Poll Office365 for emails
// -----------------------------------------
async function pollMailbox() {
  try {
    const token = await getGraphAccessToken();
    const messages = await fetchUnreadEmails(token, MAILBOX);

    if (messages.length > 0) {
      console.log(`📩 Found ${messages.length} unread message(s)`);
    }

    for (const msg of messages) {
      const converted = convertGraphMessage(msg);

      insertJob.run({
        msg_id: msg.id,
        status: "pending",
        payload: JSON.stringify(converted)
      });

      // mark message as read so we don't reprocess
      await markMessageAsRead(token, MAILBOX, msg.id);
    }
  } catch (err) {
    console.error("Mailbox poll error:", err);
  }
}

// -----------------------------------------
// Process pending jobs → send to webhook
// -----------------------------------------
async function processJobs() {
  const jobs = getPendingJobs.all();

  for (const job of jobs) {
    console.log("🚀 Sending job to webhook:", job.id);

    try {
      const resp = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: job.payload
      });

      if (!resp.ok) {
        console.error(`Webhook error: ${resp.status}`);
        markJobError.run(job.id);
        continue;
      }

      markJobDone.run(job.id);
      console.log("✅ Job processed:", job.id);
    } catch (err) {
      console.error("Webhook exception:", err);
      markJobError.run(job.id);
    }
  }
}

// -----------------------------------------
// Main Loop
// -----------------------------------------
async function mainLoop() {
  await pollMailbox();
  await processJobs();
}

console.log("📡 Worker started. Polling Office365 mailbox:", MAILBOX);

setInterval(mainLoop, POLL_INTERVAL);
mainLoop();
