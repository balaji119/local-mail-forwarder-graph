# Dockerfile (recommended: Debian slim)
FROM node:20-bullseye-slim

WORKDIR /usr/src/app

# system deps for building native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 make g++ libc6-dev libsqlite3-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# copy package files and install inside the image (ensures native modules are built for linux)
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# copy app code (but exclude node_modules to avoid Windows binaries)
COPY . .

# rebuild native modules for Linux to fix better-sqlite3 ELF header issue
RUN npm rebuild better-sqlite3

# create data dirs
RUN mkdir -p /usr/src/app/data/attachments /usr/src/app/data/webhook-logs /usr/src/app/logs

EXPOSE 2525 3000

CMD ["node", "smtp-server.js"]
