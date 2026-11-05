# syntax=docker/dockerfile:1.7
# AI Timetable Engine — multi-stage, offline-friendly, fast startup

############################
# 1) Dependencies (cached)
############################
FROM node:20-alpine AS deps
WORKDIR /app

# Keep apk index local to this layer; no runtime network needed later
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
# Install from package.json (lock may lag during competition scaffolding)
RUN npm install --no-audit --no-fund

############################
# 2) Build (Next.js standalone)
############################
FROM node:20-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    OFFLINE_MODE=true

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma generate is optional — schema may be unused at runtime (client CSP solver)
RUN npx prisma generate --schema=prisma/schema.prisma || true
RUN npm run build

############################
# 3) Production runner (lean)
############################
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OFFLINE_MODE=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # No external API / CDN dependency for the scheduling engine
    NEXT_PUBLIC_OFFLINE_MODE=true \
    DATABASE_URL="file:./data/offline.db"

RUN apk add --no-cache libc6-compat \
  && addgroup -S nodejs \
  && adduser -S nextjs -G nodejs \
  && mkdir -p /app/data \
  && chown -R nextjs:nodejs /app

# Standalone output = tiny footprint + fast cold start
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Lightweight healthcheck without curling external hosts
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
