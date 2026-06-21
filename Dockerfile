# =============================================================================
# Work Project — Multi-stage Dockerfile
# =============================================================================
# Target:
#   wechat-bot  — wechat-acp bridge + wechat-adapter.js
#
# opencode-server uses official image: ghcr.io/anomalyco/opencode
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 0: Base — Alpine Node.js runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 1: Dependencies — npm production deps
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: wechat-bot target
# ---------------------------------------------------------------------------
FROM base AS wechat-bot
COPY --from=deps /app/node_modules ./node_modules
RUN npm install -g wechat-acp@0.8.0 && npm cache clean --force
COPY . .
RUN mkdir -p /home/appuser/.wechat-acp && \
    chown -R appuser:appgroup /home/appuser/.wechat-acp && \
    chown appuser:appgroup /app
USER appuser
