FROM node:20-alpine

WORKDIR /usr/src/app

# system deps for better-sqlite3
RUN apk add --no-cache build-base python3 sqlite-dev

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

# create data dirs
RUN mkdir -p /usr/src/app/data/attachments /usr/src/app/data/webhook-logs

EXPOSE 2525 3000

CMD ["node", "smtp-server.js"]
