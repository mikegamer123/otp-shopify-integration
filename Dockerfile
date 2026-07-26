# Host-agnostic image. Works on Render, Koyeb, Fly, Railway, or any VPS.
#
# Pinned to a Node 18 digest-free LTS tag rather than :latest so a redeploy six
# months from now builds the same thing that was tested today.
FROM node:18-alpine

WORKDIR /app

# Copy manifests first so `npm ci` is cached and only re-runs when deps change.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The audit log lives here. On free tiers this is ephemeral and gets wiped on
# every restart — that is expected and handled: /order-status falls back to
# Shopify's own draft-order state when the log has no record. Mount a volume
# here on a paid plan to keep the history.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Hosts inject PORT; lib/config.js already reads it. This is only the default.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# /health returns 200 with a JSON body listing any config errors, so a failing
# deploy is visible from the platform dashboard rather than only in the logs.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
