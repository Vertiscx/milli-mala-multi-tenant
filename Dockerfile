# Milli-Mala Service
# Dockerfile for self-hosted deployment

FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist/ ./dist/
COPY entrypoint.sh ./

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs && \
    mkdir -p /app/audit-data && chown -R nodejs:nodejs /app && \
    chmod +x /app/entrypoint.sh

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/v1/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
