# ─── Builder stage ─────────────────────────────────────────────────────────
ARG NODE_VERSION=22
ARG PNPM_VERSION=11.15.0

FROM node:${NODE_VERSION}-alpine AS builder

RUN apk add --no-cache python3 make g++ \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# ─── Runner stage ──────────────────────────────────────────────────────────
ARG PNPM_VERSION=11.15.0

FROM node:22-alpine AS runner

RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/public ./public
COPY --from=builder /app/database ./database
COPY --from=builder /app/scripts ./scripts
COPY .npmrc ./.npmrc

ENV NODE_ENV=production
EXPOSE 1337

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:1337/_health || exit 1

CMD ["./node_modules/.bin/strapi", "start"]
