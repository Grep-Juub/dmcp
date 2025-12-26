# DMCP Indexer Dockerfile
# Multi-stage build for smaller production image

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Environment defaults (use Docker network hostnames)
ENV MCP_GATEWAY_URL=http://host.docker.internal:15000/config_dump
ENV REDIS_HOST=redis-vss
ENV REDIS_PORT=6379
ENV EMBEDDING_URL=http://embedding-service:7997
ENV SYNC_INTERVAL=60

# Default command: run worker mode
CMD ["node", "dist/index.js", "--worker"]
