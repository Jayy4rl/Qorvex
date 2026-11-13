# Qorvex service: HTTP API, watcher, console and status pages in one process.
# Built and run by Railway (railway.json); works on any Docker host.
# Runtime data (SQLite database, caches, auth secret) goes to /data: mount a persistent volume there.
FROM node:24-bookworm-slim

WORKDIR /app

# Dependencies first, for layer caching. Dev dependencies are needed: the backend runs with tsx
# and the frontend is built with Vite.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY sdk/package.json sdk/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:web

ENV QORVEX_DATA_DIR=/data \
    QORVEX_SKIP_WEB_BUILD=1 \
    QORVEX_NETWORKS=testnet \
    PORT=8787
EXPOSE 8787

# tsx forwards SIGTERM to the server, which flushes the database before exiting.
CMD ["./node_modules/.bin/tsx", "backend/src/server/main.ts"]
