# Stage 1: Dependency builder
FROM node:20-alpine AS deps
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Stage 2: Final lightweight production runner
FROM node:20-alpine AS runner
LABEL maintainer="sombochea@cubis.tech"

# Install tini for clean signal handling (PID 1)
RUN apk add --no-cache tini

ARG JSON_FLAGS
WORKDIR /usr/src/app

# Write build metadata
RUN if [ -n "$JSON_FLAGS" ]; then echo "$JSON_FLAGS" > ./build.json; else echo "{}" > ./build.json; fi

# Copy dependencies and application source
COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=3000

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/_/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "cluster.js"]

