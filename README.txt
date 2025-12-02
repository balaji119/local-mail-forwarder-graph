Files included:
- package.json
- Dockerfile
- docker-compose.yml
- .env.example
- smtp-server.js
- worker.js
- webhook-server.js
- ms-graph-mail.js
- README.md

Instructions:
1. Copy .env.example to .env and fill in OPENAI_API_KEY, PrintIQ credentials, and MS Graph client id/secret/tenant, EMAIL_FROM.
2. Build and run:
   docker-compose up --build -d
3. POST test to webhook to simulate an inbound email or use swaks to send to SMTP.
