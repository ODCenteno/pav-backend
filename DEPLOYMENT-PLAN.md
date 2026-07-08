# Puerto Agua Verde — Backend Deployment Plan

**Repository:** `pav-backend` (Strapi v5.39, TypeScript)
**Target:** Koyeb eco-small · Neon PostgreSQL · Cloudflare R2 + Image Resizing (free tier)

---

## 1. Target Architecture

```
Visitors (PWA, SW)
        │
        ▼ HTTPS
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Workers (Astro SSR, pav-frontend)              │
│  • Cache API shared cache (caches.default)                 │
│  • Service Worker: nav=navigate, img=CacheFirst, api=SWR   │
│  • Webhook receiver: POST /api/revalidate → cache purge   │
└────────────┬────────────────────────────────────────────────┘
             │ HTTPS GET / POST
             ▼
┌─────────────────────────────────────────────────────────────┐
│  Koyeb eco-small (1 GB RAM)                                │
│  Strapi 5.39 · Node 20 · port 1337                         │
│  config/server.ts: url=PUBLIC_URL, proxy=true              │
│  config/plugins.ts: R2 provider (region=auto, path-style)   │
│  config/middlewares.ts: CSP with R2 domain, CORS scoped   │
│  config/database.ts: Neon postgres (pool 0–5, SSL)         │
│  src/index.ts: public permissions bootstrapped             │
│  src/extensions/upload: Spanish validation errors           │
└──────┬─────────────────────────────────┬───────────────────┘
       │ pg (TCP, sslmode=require)        │ S3 API
       ▼                                  ▼
┌──────────────────────┐     ┌──────────────────────────────────────┐
│  Neon PostgreSQL     │     │  Cloudflare R2 bucket: pav-assets    │
│  0.5 GB compute      │     │  + R2 Image Resizing Worker           │
│  10 GB storage       │     │  (5,000 free transforms/month)        │
│  pooled 0–5 conns   │     │  Worker fetches from R2, resizes,    │
└──────────────────────┘     │  and sets long Cache-Control headers   │
                            │  (served via pub-*.r2.dev URL)         │
                            └──────────────────────────────────────┘
```

**Webhook flow:**
Strapi `entry.publish` / `entry.unpublish` → `POST https://<frontend>/api/revalidate` (header `X-Webhook-Secret`) → Cloudflare Workers purges shared Cache API keys → next request re-fetches fresh data from Strapi.

---

## 2. Decisions Locked

| Area | Decision |
|---|---|
| Frontend render mode | Astro SSR (unchanged) + **cache-purge webhook** |
| Frontend cache layer | Upgrade `cms.ts` to **Cloudflare Cache API** (`caches.default`) |
| Image optimization | **R2 bucket + Image Resizing Worker** (free tier, 5k transforms/mo) |
| Database migration | `npx @strapi/data-transfer` export → import |
| Domains | Use defaults (env-parameterized; fill production values later) |
| Build pipeline | Single **multi-stage Dockerfile** (builder + runner) |
| Koyeb plan | **eco-small** (1 GB RAM, shared vCPU, ~$5.36/mo) |

---

## 3. Backend Code / Config Changes

All changes preserve existing TypeScript patterns. No new `config/env/production/*.js` files (Strapi v5 omits plugins from env-merge).

### 3.1 `config/server.ts` — add `url` + `proxy` for absolute URLs

```typescript
import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('URL', ''),
  proxy: env.bool('IS_BEHIND_PROXY', true),
  app: {
    keys: env.array('APP_KEYS'),
  },
});

export default config;
```

- `url` = production origin (e.g. `https://pav-backend-xxx.koyeb.app`). Required for correct sitemap, admin links, and absolute media URLs.
- `proxy: true` = Koyeb terminates TLS; Strapi trusts `X-Forwarded-*` headers.

### 3.2 `config/middlewares.ts` — env-driven R2 domain + scoped CORS

```typescript
import type { Core } from '@strapi/strapi';

const r2Host = process.env.R2_PUBLIC_BASE_URL
  ? new URL(process.env.R2_PUBLIC_BASE_URL).origin
  : 'https://pub-6774f1bb5b50447c89f09d4600081fc6.r2.dev';

const frontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        directives: {
          'img-src': [
            "'self'", 'data:', 'blob:',
            'https://market-assets.strapi.io',
            'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
            'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
            r2Host,
          ],
          'media-src': [
            "'self'", 'data:', 'blob:',
            'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
            'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
            r2Host,
          ],
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      origin: frontendOrigins.length ? frontendOrigins : ['*'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-Webhook-Secret'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
```

- R2 domain is read from `R2_PUBLIC_BASE_URL` env var — no hardcoded secrets in source.
- `strapi::cors` is scoped to `FRONTEND_URL` (or `*` in dev); the `X-Webhook-Secret` header is whitelisted for the cache-purge webhook.

### 3.3 `config/plugins.ts` — NO CHANGE

Already correct: `provider: 'aws-s3'`, `region: 'auto'`, `forcePathStyle: true`, `ACL: undefined`, `baseUrl: env('R2_PUBLIC_BASE_URL')`, `checksumAlgorithm: 'CRC32'`, `preventOverwrite: true`. Reads all values from env vars. Leave as-is.

### 3.4 `config/database.ts` — NO CHANGE

Already env-aware. For Neon production:
- `DATABASE_CLIENT=postgres`
- `DATABASE_URL=postgresql://...@ep-xxx.neon.tech/strapi?sslmode=require`
- `DATABASE_SSL=true` (enables SSL block with `rejectUnauthorized: true` by default)
- `DATABASE_POOL_MIN=0`, `DATABASE_POOL_MAX=5`

### 3.5 `package.json` — three edits

```diff
  "dependencies": {
    "@strapi/plugin-cloud": "5.39.0",
    "@strapi/plugin-users-permissions": "5.39.0",
    "@strapi/provider-upload-aws-s3": "5.39.0",
    "@strapi/strapi": "5.39.0",
+   "pg": "^8.13.0",
    "better-sqlite3": "12.6.2",
    "csv-parse": "^5.6.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0",
    "styled-components": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "typescript": "^5"
  },
  "engines": {
    "node": ">=20.0.0 <=22.x.x",
+   "pnpm": ">=9.0.0"
-   "npm": ">=6.0.0"
  }
```

- `pg` is required for Neon PostgreSQL (Strapi uses Knex which loads `pg` for postgres).
- `better-sqlite3` is kept for local dev against SQLite.
- Node upper bound tightened to 22.x for stability on Koyeb eco-small.
- `pnpm` added to engines; `npm` constraint removed.

### 3.6 `src/index.ts` — NO CHANGE

16 public permissions (`find` / `findOne` for all content types) are already bootstrapped at startup. Applies to both SQLite and Neon automatically.

### 3.7 `src/extensions/upload/strapi-server.js` — NO CHANGE

Spanish error translation already wraps both `admin-upload` and `content-api` controllers. Works with the existing R2 config.

---

## 4. New Files to Create

### 4.1 `Dockerfile` (multi-stage, pnpm, Node 20 Alpine)

```dockerfile
# ─── Builder ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ \
 && corepack enable \
 && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build   # runs "strapi build" → build/ + dist/

# ─── Runner ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache tini wget \
 && corepack enable \
 && corepack prepare pnpm@10 --activate

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build       ./build
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config      ./config
COPY --from=builder /app/src         ./src
COPY --from=builder /app/types       ./types
COPY --from=builder /app/public       ./public
COPY --from=builder /app/scripts      ./scripts

EXPOSE 1337

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:1337/_health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "start"]
```

- **Builder stage**: pulls deps, builds Strapi admin panel (peaks ~900 MB RAM).
- **Runner stage**: lean production image (~250 MB) with no build tools.
- `HEALTHCHECK` hits the built-in Strapi `/_health` endpoint (returns 204 when ready).

### 4.2 `.dockerignore`

```
node_modules
.tmp
.env
.env.*
!.env.example
dist
build
.git
.github
.agents
opencode.json
skills-lock.json
*.sqlite*
FRONTEND_HANDOFF.md
coverage
playwright-report
test-results
exports
.strapi-updater.json
.strapi-cloud.json
license.txt
```

### 4.3 `koyeb.yaml` (optional — for `koyeb app deploy` CLI)

```yaml
services:
  - name: pav-backend
    instance_type: eco-small
    regions:
      - fra  # Frankfurt — matches Neon free compute region
    image:
      dockerfile: Dockerfile
    ports:
      - port: 1337
        protocol: http
        healthcheck:
          path: /_health
          grace_period: 60s
    scaling:
      min: 1
      max: 1
    env:
      - key: NODE_ENV
        value: production
      - key: NODE_OPTIONS
        value: --max-old-space-size=768
      - key: HOST
        value: "0.0.0.0"
      - key: PORT
        value: "1337"
```

> All other env vars (DB, R2, secrets) are set via the Koyeb dashboard. This file defines the runtime contract (port, health path, memory).

### 4.4 `scripts/generate-secrets.ts` — mint fresh secrets

```typescript
import { randomBytes } from 'node:crypto';

const keys = Array.from({ length: 2 }, () =>
  randomBytes(32).toString('base64')
).join(',');

const out: Record<string, string> = {
  APP_KEYS: `"${keys}"`,
  ADMIN_JWT_SECRET: randomBytes(32).toString('base64'),
  API_TOKEN_SALT: randomBytes(32).toString('base64'),
  TRANSFER_TOKEN_SALT: randomBytes(32).toString('base64'),
  JWT_SECRET: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  WEBHOOK_SECRET: randomBytes(24).toString('hex'),
};

console.log('# Strapi secrets — paste into Koyeb env vars (secret type)\n');
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}=${v}`);
}
```

Run: `npx tsx scripts/generate-secrets.ts`

---

## 5. Koyeb Environment Variable Matrix

Exact names matching the actual code. Mark sensitive values as **secret** in the Koyeb dashboard.

### Runtime

| Key | Example value | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Default (no change) |
| `PORT` | `1337` | Default (no change) |
| `URL` | `https://pav-backend-xxx.koyeb.app` | **Required** — Strapi uses for absolute URLs |
| `PUBLIC_URL` | `https://pav-backend-xxx.koyeb.app` | Mirror of `URL` |
| `IS_BEHIND_PROXY` | `true` | Koyeb terminates TLS |
| `NODE_ENV` | `production` | Enables Strapi production mode |
| `NODE_OPTIONS` | `--max-old-space-size=768` | 768 MB V8 heap; leaves ~256 MB for OS + native modules on 1 GB eco-small |

### Database (Neon PostgreSQL)

| Key | Example value | Notes |
|---|---|---|
| `DATABASE_CLIENT` | `postgres` | Switches `config/database.ts` to postgres branch |
| `DATABASE_URL` | `postgresql://user:pwd@ep-xxx.neon.tech/strapi?sslmode=require&connect_timeout=30` | Full Neon connection string |
| `DATABASE_SSL` | `true` | Enables SSL block; `rejectUnauthorized: true` by default |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `true` | Secure (Neon uses valid CA certs) |
| `DATABASE_POOL_MIN` | `0` | eco-small: allow all connections to close when idle |
| `DATABASE_POOL_MAX` | `5` | eco-small: cap at 5 concurrent connections |
| `DATABASE_SCHEMA` | `public` | Neon default |

### Cloudflare R2

| Key | Example value | Notes |
|---|---|---|
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | From Cloudflare R2 dashboard |
| `R2_BUCKET` | `pav-assets` | — |
| `R2_PUBLIC_BASE_URL` | `https://pub-6774f1bb5b50447c89f09d4600081fc6.r2.dev` | R2 public URL (swap for Worker URL after §6 setup) |
| `R2_ACCESS_KEY_ID` | `cfat_xxxxxxxxxxxxxxxxxxxxxxxx` | 🔒 secret |
| `R2_SECRET_ACCESS_KEY` | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | 🔒 secret |

### Secrets (generate via `scripts/generate-secrets.ts`)

| Key | Example value | Notes |
|---|---|---|
| `APP_KEYS` | `"base64...,base64..."` | Two 32-byte keys, comma-separated |
| `ADMIN_JWT_SECRET` | `base64...` | 🔒 secret |
| `API_TOKEN_SALT` | `base64...` | 🔒 secret |
| `TRANSFER_TOKEN_SALT` | `base64...` | 🔒 secret |
| `JWT_SECRET` | `base64...` | 🔒 secret |
| `ENCRYPTION_KEY` | `base64...` | 🔒 secret |

### Integration

| Key | Example value | Notes |
|---|---|---|
| `FRONTEND_URL` | `https://pav-frontend.pixie-cemodan.workers.dev` | For CORS; add custom domain when ready |
| `WEBHOOK_SECRET` | `hex...` | 🔒 secret; copy to frontend `WEBHOOK_SECRET` env |
| `STRAPI_TELEMETRY_DISABLED` | `true` | Opt out of Strapi anonymous telemetry |

---

## 6. Cloudflare R2 + Image Resizing Worker (Free Tier)

> **Cloudflare Image Resizing free plan**: up to **5,000 unique transformations per month** at no cost. Works with externally stored images (R2 bucket) via a thin Worker — no Pro plan needed.

### How it works

```
Browser                    R2 bucket               Image Resizing Worker
  │                            │                            │
  │ GET /cdn-cgi/image/...     │                            │
  │────────────────────────────▶                           │
  │                     Worker fetches original from R2     │
  │                            │◀──────────────────────────┤
  │                            │    fetch(url, cf: {imageResizing } })
  │   Resized + optimized ◀────┘                            │
  │◀───────────────────────────────────────────────────────
  │ Cache-Control: public, max-age=31536000, immutable     │
```

The Worker serves as a proxy: it fetches the original from R2, Cloudflare applies the resize/format transform, and the result is cached at the Cloudflare edge (no additional R2 egress on repeat requests).

### Setup steps

1. **Keep R2 bucket public**: In Cloudflare dashboard → R2 → `pav-assets` → Settings → **Bucket access** = **No Cloudflare accounts can access**. This makes objects publicly readable via the R2 public URL.

2. **CORS on R2 bucket** (already done for dev):
   - Allowed origins: `https://pav-frontend.pixie-cemodan.workers.dev`, `https://<koyeb-url>`
   - Methods: `GET`, `PUT`, `HEAD`

3. **Create Image Resizing Worker** (in `pav-frontend` or a separate Worker project):

   ```javascript
   // workers/image-resize/index.js  (or pav-frontend/src/workers/image-resize.ts)
   export default {
     async fetch(request, env, ctx) {
       const url = new URL(request.url);

       // Transform query params: width, height, quality, format, fit
       const resizeOptions = {
         width: url.searchParams.get('w') ? parseInt(url.searchParams.get('w')) : undefined,
         height: url.searchParams.get('h') ? parseInt(url.searchParams.get('h')) : undefined,
         quality: url.searchParams.get('q') ? parseInt(url.searchParams.get('q')) : 80,
         format: url.searchParams.get('f') || 'auto',
         fit: 'cover',
         trim: url.searchParams.get('trim') === '1',
       };

       // Original R2 URL (strip the /image-resize prefix)
       const r2Path = url.pathname.replace('/image-resize/', '/');
       const r2Url = `https://pub-6774f1bb5b50447c89f09d4600081fc6.r2.dev${r2Path}${url.search}`;

       const r2Response = await fetch(r2Url, {
         cf: { imageResizing: resizeOptions },
       });

       if (!r2Response.ok) {
         return new Response('Image not found', { status: r2Response.status });
       }

       const newResponse = new Response(r2Response.body, r2Response);

       // Long cache for resized images (immutable, 1 year)
       newResponse.headers.set(
         'Cache-Control',
         'public, max-age=31536000, immutable'
       );
       // Prevent double caching in SW / browser
       newResponse.headers.set('Vary', 'Accept');

       ctx.waitUntil(
         caches.default.put(
           request,
           new Response(r2Response.body, {
             headers: {
               'Content-Type': r2Response.headers.get('Content-Type') || 'image/webp',
               'Cache-Control': 'public, max-age=31536000, immutable',
               'Vary': 'Accept',
             },
           })
         )
       );

       return newResponse;
     },
   };
   ```

4. **Deploy the Worker** (via `wrangler`):

   ```bash
   cd workers/image-resize
   npx wrangler deploy
   ```

   Or add it to the existing `pav-frontend` Wrangler config (`wrangler.jsonc` / `wrangler.toml`).

5. **Route**: after deploying, the Worker URL becomes the image base. Update `R2_PUBLIC_BASE_URL` in Koyeb to point to the Worker URL (e.g. `https://image-resize.<your-subdomain>.workers.dev`).

6. **Usage in frontend**: images are requested as `https://image-resize.../image-resize/<original-path>?w=400&q=75`. The Worker fetches from R2, Cloudflare resizes, result is cached at edge.

### Image URL mapping

| Source | URL pattern | Example |
|---|---|---|
| Raw R2 (no resize) | `https://pub-xxx.r2.dev/<filename>` | Dev only |
| Via Worker (resize) | `https://<worker-url>/image-resize/<filename>?w=400&q=75` | Production |

> The `pub-*.r2.dev` URL remains valid for direct/unprocessed access. Switch `R2_PUBLIC_BASE_URL` in Koyeb to the Worker URL to route all Strapi-generated image URLs through the resize pipeline.

---

## 7. Prerequisites Checklist

Do these in the dashboards before deploying.

- [ ] **Neon**: create project → copy connection string (`DATABASE_URL`) → verify `psql` connects with `sslmode=require`
- [ ] **Cloudflare R2**:
  - [ ] Bucket `pav-assets` exists with read/write API token
  - [ ] CORS set: origins = `https://pav-frontend.pixie-cemodan.workers.dev`, `https://<koyeb-url>`; methods `GET, PUT, HEAD`
  - [ ] Bucket access: public (objects readable without auth via `pub-*.r2.dev`)
- [ ] **Cloudflare Workers** (Image Resizing):
  - [ ] Deploy the resize Worker (§6)
  - [ ] Note its URL for `R2_PUBLIC_BASE_URL`
  - [ ] Verify: `curl "https://<worker>/image-resize/<file>?w=400" -I` returns 200 with `Cache-Control`
- [ ] **Koyeb**: account created, GitHub repo connected, eco-small enabled
- [ ] **Secrets**: run `npx tsx scripts/generate-secrets.ts` locally → paste into Koyeb dashboard (mark secret)
- [ ] **Webhook secret shared with frontend**: one of the generated `WEBHOOK_SECRET` values is copied to `pav-frontend` `WEBHOOK_SECRET` env

---

## 8. Migration Procedure (SQLite → Neon)

Run **before** the first Koyeb deploy so the production DB starts with all 82 listings, components, i18n, and media metadata.

```bash
# 1. Ensure local Strapi is running against SQLite (so schema is current)
pnpm dev
# Wait for "Server listening on port 1337", then Ctrl+C

# 2. Export everything (content types, components, i18n, file metadata)
npx @strapi/data-transfer export \
  --output file:./backup/pav-$(date +%Y%m%d).tar.gz \
  --only contentTypes,components,plugins

# 3. Apply production env (Neon) temporarily
export DATABASE_CLIENT=postgres
export DATABASE_URL="postgresql://user:pwd@ep-xxx.neon.tech/strapi?sslmode=require"
export DATABASE_SSL=true
export DATABASE_SSL_REJECT_UNAUTHORIZED=true

# 4. Start Strapi against Neon — creates tables then waits for Ctrl+C
pnpm dev

# 5. Import into Neon
npx @strapi/data-transfer import \
  --input file:./backup/pav-$(date +%Y%m%d).tar.gz

# 6. Verify in admin:
#    • Listings count = 82
#    • Components populated (tags, contact, location, etc.)
#    • Images show R2 URLs (not local)
#    • Both es-MX and en locales present

# 7. Keep the backup tarball locally (add to .gitignore if not already)
#    Do NOT commit it to the repo
```

> **Media stays in R2** — only DB rows are migrated. All image URLs in the DB already use `R2_PUBLIC_BASE_URL` (set in the `.env` used during migration), so they resolve immediately after switching `R2_PUBLIC_BASE_URL` to the production value.

---

## 9. Deploy Procedure (Koyeb)

1. Apply all §3 code changes and §4 new files. Commit.

2. In **Koyeb dashboard**: **New Service → GitHub → select `pav-backend` repo**
   - **Builder**: Dockerfile
   - **Instance**: eco-small
   - **Region**: match your Neon region (e.g. `fra` for EU)
   - **Port**: `1337`, **Health check path**: `/_health`, **Grace period**: `60s`

3. Set every env var from §5 (secrets as secret type).

4. **Deploy**. First build:
   - Pulls `node:20-alpine`
   - `pnpm install --frozen-lockfile`
   - `pnpm build` (Strapi admin panel — peaks ~900 MB RAM on eco-small; if it OOMs, see §16 Risk #3)
   - Image ~250 MB when done

5. After "Healthy": visit `https://<koyeb-url>/admin` → log in with migrated admin credentials.

6. Post-deploy one-time setup (see §10).

---

## 10. Admin Panel One-Time Setup

After first successful Koyeb deploy + migration:

1. **Settings → Media Library → Global settings**:
   - "Responsive friendly upload" → **OFF** (images served via R2 + CF, not Strapi)
   - "Size optimization" → **OFF** (originals are ≤3 MB webp/jpeg; CF handles further optimization)
   - "Auto orientation" → leave default

2. **Settings → Internationalization**: confirm `es-MX` (default) and `en` locales present.

3. **Settings → Webhooks → Add new webhook**:

   | Field | Value |
   |---|---|
   | Name | `Frontend cache purge` |
   | URL | `https://pav-frontend.pixie-cemodan.workers.dev/api/revalidate` |
   | Headers | `X-Webhook-Secret: <WEBHOOK_SECRET>` |
   | Events | ✅ `entry.publish` · ✅ `entry.unpublish` |

   > **Only `entry.publish` and `entry.unpublish`** — these fire only when content goes live. `entry.create` / `entry.update` fire on every draft save and would hit the Cloudflare Workers free-tier request limit (100k/day).

4. **Settings → Users & Permissions → Roles → Public**: verify the 16 actions (find / findOne for all content types) are granted. If missing, any API call to Strapi triggers the bootstrap in `src/index.ts`.

5. **Optional — disable Strapi telemetry** (already set `STRAPI_TELEMETRY_DISABLED=true` in env):

   Verify no outbound calls to `https://telemetry.strapi.io` in Koyeb logs after startup.

---

## 11. Previous Research — 19 Issues Fixed

| # | Issue | Fix |
|---|---|---|
| 1 | Env var `R2_ACCESS_SECRET` doesn't exist | Use correct name `R2_SECRET_ACCESS_KEY` (§5) |
| 2 | Missing R2 settings (forcePathStyle, ACL, baseUrl) | None removed; all preserved in `config/plugins.ts` (§3.3) |
| 3 | `build/` doesn't exist in git | Dockerfile builder stage creates it at deploy time (§4.1) |
| 4 | Committing build artifacts | Multi-stage Dockerfile; `build/` stays in `.gitignore` |
| 5 | `config/env/production/plugins.js` ignored by v5 | Edit existing `.ts` files; no env-merge overrides (§3.3) |
| 6 | `region: us-east-1` claim was wrong | Keep `region: 'auto'` (current working config) |
| 7 | CF Image Resizing needs Pro | **Free tier**: Worker fetches R2 + CF resize API; 5k/mo free (§6) |
| 8 | `npm` vs `pnpm` | All commands use `pnpm`; Dockerfile uses `pnpm@10` |
| 9 | Proposed `.js` config files | All changes are TypeScript `.ts` (§3) |
| 10 | Database config not env-aware | Already handles `DATABASE_CLIENT=postgres` via env vars; set `DATABASE_POOL_MIN=0`, `DATABASE_POOL_MAX=5` |
| 11 | No `URL` env var | Added `url: env('URL')` to `config/server.ts` (§3.1) |
| 12 | `rejectUnauthorized: false` | Default is `true`; set `DATABASE_SSL_REJECT_UNAUTHORIZED=true` (§5) |
| 13 | Build artifacts in git | Avoided via Dockerfile multi-stage build |
| 14 | `--max-old-space-size=400` too low for 1 GB | Set `768` (room for OS + native on 1 GB eco-small) |
| 15 | Deploy hook URL in plaintext DB | Webhook sends `X-Webhook-Secret` header; URL itself is not a secret |
| 16 | `Update` webhook too broad | Only `entry.publish` + `entry.unpublish` (§10) |
| 17 | No SQLite → Postgres migration | data-transfer export → import procedure (§8) |
| 18 | Admin settings reset on fresh DB | Re-disable "Responsive friendly upload" + "Size optimization" after migration (§10) |
| 19 | No health check | `HEALTHCHECK` in Dockerfile hits built-in `/_health` (§4.1) |

---

## 12. Backend → Frontend Contract (PWA / Offline Requirements)

These guarantees allow the frontend PWA to function correctly.

| Frontend need | Backend guarantee | Status |
|---|---|---|
| GET `/api/*` is idempotent | No mutating side effects on GET | ✅ Strapi REST default |
| API responses cacheable by SW | `Cache-Control` not blocked by Strapi | ✅ Frontend SW handles caching |
| R2 images have stable long-lived URLs | R2 object URLs are immutable; `Cache-Control: public, max-age=31536000, immutable` set by Worker | ✅ §6 |
| Images work offline | SW caches images `cache-first`; R2 URLs stable | ✅ Frontend SW already implemented |
| Navigation works offline | SW `navigate` strategy: network → cache → `/offline` → `/` | ✅ Already in `public/sw.js` |
| Slow network resilience | API paginated (default 25, max 100) | ✅ Already in `config/api.ts` |
| Health / uptime monitoring | `GET /_health` → 204 when Strapi is ready | ✅ Built-in Strapi v5 |
| Content updates propagate (near real-time) | Webhook purges Cloudflare Cache API → next request fetches fresh | ✅ §10 + FRONTEND-DEPLOYMENT.md |

---

## 13. Cost Summary

| Service | Tier | Monthly |
|---|---|---|
| Koyeb | eco-small (1 GB, shared CPU) | ~$5.36 |
| Neon PostgreSQL | Free (0.5 GB compute, 10 GB storage, scales to zero) | $0 |
| Cloudflare R2 | 10 GB storage free, 1 M Class A ops/mo free | $0 |
| Cloudflare Workers | 100k requests/day free | $0 |
| CF Image Resizing | 5,000 unique transformations/month free | $0 |
| **Total** | | **~$5.36/mo** |

> Neon free tier autosuspends after 5 days of inactivity (cold start ~1–2 s on first request). Acceptable for low-traffic site. For always-on production, upgrade Neon compute.

---

## 14. Verification Checklist

Run these after the Koyeb deploy is healthy.

- [ ] `curl https://<koyeb-url>/_health` → HTTP 204
- [ ] `curl https://<koyeb-url>/api/listings?pagination[pageSize]=1` → 200 JSON
- [ ] Image URL from API points to R2/Worker URL and returns 200 with `Cache-Control: public, max-age=31536000`
- [ ] Image Resizing Worker: `curl "https://<worker>/image-resize/<file>?w=400" -I` → 200 + resized dimensions
- [ ] Strapi admin: `https://<koyeb-url>/admin` → login works; 82 listings visible; thumbnails load
- [ ] Koyeb logs: no `DATABASE_SSL` warnings; no `pool exhaustion`; no OOM
- [ ] Koyeb metrics: RAM < 700 MB steady state; no restart loops
- [ ] Neon dashboard: 1 connection at idle, ≤5 under load
- [ ] Webhook test: publish a listing → Cloudflare Workers logs show `POST /api/revalidate` 200
- [ ] Browser offline: navigate to site → SW intercepts → stale content renders from cache
- [ ] Lighthouse PWA audit: installable, service worker active, offline test passes
- [ ] CORS preflight: `curl -X OPTIONS -H "Origin: https://pav-frontend.pixie-cemodan.workers.dev" -H "Access-Control-Request-Method: GET" https://<koyeb-url>/api/listings -I` → `Access-Control-Allow-Origin` matches
- [ ] CSP: Strapi admin console shows no `Refused to load` for R2 images
- [ ] Telemetry: Koyeb outbound logs show no calls to `telemetry.strapi.io`

---

## 15. Risks & Mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | Neon cold start (~1–2 s on first request after idle) | Medium | Accept for free tier; upgrade compute if SLA needed |
| 2 | Admin panel build OOM on eco-small (~900 MB peak) | Low | If OOM: build admin panel in GitHub Actions CI, push image to Koyeb Container Registry, pull in runner stage |
| 3 | CF Image Resizing >5k transforms/mo | Low | Monitor in Cloudflare dashboard; R2 URLs are still valid without transforms |
| 4 | Webhook secret drift (backend ≠ frontend) | Low | Store secret in both Koyeb and Workers env; document in ops runbook |
| 5 | `better-sqlite3` native module breaks alpine image | Low | Runner stage doesn't load it (dev dep); `pg` is pure JS + native SSL via Node |
| 6 | `pub-*.r2.dev` URL changes (Cloudflare rotates it) | Very Low | Switch `R2_PUBLIC_BASE_URL` to Worker URL (stable) once §6 deployed |

---

## 16. Related Documents

| Document | Scope |
|---|---|
| `FRONTEND-DEPLOYMENT.md` | Frontend changes required for the webhook contract: webhook receiver endpoint, cms.ts Cache API upgrade, CSP hardening, SW cache versioning |
| `R2-integration-plan.md` | Original R2 integration research and decisions (historical) |
| `README.md` | Project overview, local dev setup |
| `.env.example` | All env var names and placeholder values |

---

*Last updated: 2026-07-07 · pav-backend main branch commit `0a42a0b`*
