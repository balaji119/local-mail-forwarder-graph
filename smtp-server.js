require('dotenv').config();
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');

fs.mkdirSync(ATTACH_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'webhook-logs'), { recursive: true });

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

const insertJob = db.prepare(`INSERT INTO jobs (id, status, attempts, next_run_at, created_at, payload) VALUES (@id, @status, @attempts, @next_run_at, @created_at, @payload)`);

const PORT = Number(process.env.SMTP_PORT || 2525);

const server = new SMTPServer({
  disabledCommands: ['AUTH'],
  logger: false,
  onData(stream, session, callback) {
    let chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const parsed = await simpleParser(raw);

        const savedAttachments = [];
        if (parsed.attachments && parsed.attachments.length) {
          for (const a of parsed.attachments) {
            const fname = `${Date.now()}-${uuidv4()}-${a.filename || 'attachment'}`;
            const fpath = path.join(ATTACH_DIR, fname);
            fs.writeFileSync(fpath, a.content);
            savedAttachments.push({ filename: a.filename, path: fpath, contentType: a.contentType, size: a.size });
          }
        }

        const payload = {
          from: parsed.from?.text || session.envelope?.mailFrom?.address || '',
          subject: parsed.subject || '',
          text: parsed.text || '',
          html: parsed.html || '',
          attachments: savedAttachments,
          raw: raw.toString()
        };

        const id = uuidv4();
        const now = Date.now();
        insertJob.run({
          id,
          status: 'pending',
          attempts: 0,
          next_run_at: now,
          created_at: now,
          payload: JSON.stringify(payload)
        });

        console.log(`[smtp] enqueued job ${id} subject="${payload.subject}" from=${payload.from}`);
        callback(null);
      } catch (err) {
        console.error('[smtp] onData error', err);
        callback(err);
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`[smtp] listening on 0.0.0.0:${PORT}`);
});
