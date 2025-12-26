# DMCP Server Dockerfile
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

# Environment defaults
ENV REDIS_HOST=redis-vss
ENV REDIS_PORT=6379
ENV EMBEDDING_URL=http://embedding-service:7997
ENV DMCP_TOP_K=30
ENV DMCP_MIN_SCORE=0.25
ENV PORT=3000

# Expose the HTTP server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3000/health || exit 1

CMD ["node", "dist/dmcp-server.js"]
