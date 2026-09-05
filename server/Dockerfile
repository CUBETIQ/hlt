# Stage 1: Dependency builder
FROM oven/bun:alpine AS deps
WORKDIR /usr/src/app

COPY package*.json ./
RUN bun install --production

# Stage 2: Final lightweight production runner with Bun on Alpine
FROM oven/bun:alpine AS runner
LABEL maintainer="sombochea@cubis.tech"

ARG JSON_FLAGS
WORKDIR /usr/src/app

# Write build metadata
RUN if [ -n "$JSON_FLAGS" ]; then echo "$JSON_FLAGS" > ./build.json; else echo "{}" > ./build.json; fi

# Copy dependencies and application source
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/_/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["bun", "cluster.js"]

