# --- Build stage: compile TS, prepare prod node_modules ---
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build \
    && rm -rf node_modules src tsconfig.json \
    && npm ci --omit=dev \
    && npm cache clean --force

# --- Dev target (docker-compose development) ---
FROM node:22-slim AS dev

RUN apt-get update && apt-get install -y --no-install-recommends git curl libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

ENV HOME=/home/node
RUN mkdir -p /home/node/.claude /app/workspace/_global/sessions && chown -R node:node /app /home/node
USER node

EXPOSE 3001
CMD ["npm", "run", "dev"]

# --- Production target (default) ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git curl libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

ENV HOME=/home/node
RUN mkdir -p /home/node/.claude && chown node:node /home/node

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/
COPY --from=build --chown=node:node /app/node_modules/ /app/node_modules/
COPY --from=build --chown=node:node /app/dist/ /app/dist/
COPY --chown=node:node web/ /app/web/
RUN mkdir -p /app/workspace/_global/sessions && chown -R node:node /app/workspace

USER node

EXPOSE 3001
CMD ["sh", "-c", "node dist/agent.js dev & node dist/token-server.js & wait"]
