FROM node:22-slim

# Claude Code CLI needs git and basic tools
RUN apt-get update && apt-get install -y git curl libglib2.0-0 libgio2.0-cil && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (needed by Agent SDK)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

# Build
RUN npm run build

# Claude config will be mounted as volume at /home/node/.claude
ENV HOME=/home/node
RUN mkdir -p /home/node/.claude

EXPOSE 3001

CMD ["npm", "run", "dev"]
