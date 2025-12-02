require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const fetch = globalThis.fetch;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');
const LOG_FILE = path.join(DATA_DIR, 'jobs.log');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://webhook:3000/webhook/email';

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT,
  result TEXT
);
`);

const getPendingJob = db.prepare(`SELECT * FROM jobs WHERE status = 'pending' AND next_run_at <= @now ORDER BY created_at ASC LIMIT 1`);
const markJob = db.prepare(`UPDATE jobs SET status=@status, attempts=@attempts, next_run_at=@next_run_at, result=@result WHERE id=@id`);
const deleteJob = db.prepare(`DELETE FROM jobs WHERE id = ?`);

function logLine(line) {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

async function deliverJob(job) {
  const payload = JSON.parse(job.payload);
  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 15000
    });

    const text = await resp.text();
    if (resp.ok) {
      markJob.run({ status: 'done', attempts: job.attempts + 1, next_run_at: Date.now(), result: text, id: job.id });
      logLine(`[ok] job ${job.id} -> webhook ${resp.status}`);
      console.log(`[worker] job ${job.id} delivered (status ${resp.status})`);
      // delete after success to keep DB small
      deleteJob.run(job.id);
    } else {
      const attempts = job.attempts + 1;
      const backoff = Math.min(60 * 60 * 1000, 1000 * Math.pow(2, attempts));
      const nextRun = Date.now() + backoff;
      markJob.run({ status: 'pending', attempts, next_run_at: nextRun, result: `HTTP ${resp.status}: ${text}`, id: job.id });
      logLine(`[retry] job ${job.id} -> webhook ${resp.status}. next in ${Math.round(backoff/1000)}s`);
      console.warn(`[worker] job ${job.id} failed status=${resp.status}. retry in ${Math.round(backoff/1000)}s`);
    }
  } catch (err) {
    const attempts = job.attempts + 1;
    const backoff = Math.min(60 * 60 * 1000, 1000 * Math.pow(2, attempts));
    const nextRun = Date.now() + backoff;
    markJob.run({ status: 'pending', attempts, next_run_at: nextRun, result: String(err), id: job.id });
    logLine(`[error] job ${job.id} -> error: ${String(err)}. next in ${Math.round(backoff/1000)}s`);
    console.error(`[worker] job ${job.id} error`, err);
  }
}

async function loop() {
  while (true) {
    try {
      const now = Date.now();
      const job = getPendingJob.get({ now });
      if (job) {
        console.log(`[worker] picked job ${job.id} attempts=${job.attempts}`);
        await deliverJob(job);
      } else {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error('[worker] main loop error', err);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

console.log('[worker] starting, webhook:', WEBHOOK_URL);
loop().catch(e => { console.error(e); process.exit(1); });
