# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=53000

# Create non-root user for maximum security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S pchat -u 1001

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public

USER pchat

EXPOSE 53000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:53000/api/health || exit 1

CMD ["node", "server.js"]
