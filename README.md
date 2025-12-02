# Local Mail Forwarder (Microsoft Graph edition)

This project receives inbound SMTP, enqueues jobs, converts RFQ emails into PrintIQ JSON via OpenAI, creates quotes in PrintIQ, extracts the price and replies using **Microsoft Graph API** (app-only).

## Quick start

1. Copy `.env.example` to `.env` and fill the values (OpenAI key, PrintIQ creds, and MS Graph client id/secret/tenant, EMAIL_FROM).
2. Build and start:
   ```bash
   docker-compose up --build -d
   ```
3. Send a test email to the local SMTP server (port 2525) or POST to the webhook:
   ```bash
   curl -X POST http://localhost:3000/webhook/email -H "Content-Type: application/json" -d '{"from":"buyer@example.com","subject":"RFQ","text":"Please quote 10"}'
   ```

## Files
- smtp-server.js: inbound SMTP, parses email, enqueues into SQLite
- worker.js: polls jobs and posts to webhook
- webhook-server.js: converts email to PrintIQ payload, calls PrintIQ, extracts price and sends reply via Microsoft Graph
- ms-graph-mail.js: helper to get token and send mail via Graph API
- data/: persistent storage (db.sqlite, attachments, logs)

