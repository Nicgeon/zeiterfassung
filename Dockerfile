# syntax=docker/dockerfile:1

# --- Stage 1: Abhaengigkeiten bauen -----------------------------------
# better-sqlite3 und argon2 sind native Module. Prebuilt-Binaries decken
# die meisten Plattformen ab, aber diese Stage haette im Notfall auch die
# Werkzeuge, um aus dem Quellcode zu kompilieren.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 2: schlankes Laufzeit-Image ---------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home /app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R app:app /app

USER app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
# CLI-Aktionen (docker compose exec) zusaetzlich in "docker compose logs" anzeigen
ENV AUDIT_MIRROR_TO_PID1=1
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
