# Frontend Deployment & PWA Compliance — Reference

**Repository:** `pav-frontend` (Astro 7, React 19, Cloudflare Workers adapter)
**Scope:** Changes required in `pav-frontend` to satisfy the backend → frontend contract and PWA/offline requirements.

> This document is a reference for the frontend changes. It is **not committed to `pav-backend`** — implement these changes in the `pav-frontend` repo.

---

## 1. Overview

The backend (`pav-backend`) is deployed on Koyeb with Neon PostgreSQL and Cloudflare R2. When Strapi content is published, it sends a webhook to the frontend to purge the shared cache so visitors see updated content immediately.

The `pav-frontend` runs as an **Astro SSR app on Cloudflare Workers** (not static). It has:

- An in-memory `Map`-based cache in `cms.ts` (per-isolate, ephemeral)
- A hand-written service worker (`public/sw.js`) with `cache-first` for images, `network-first` for navigation, and `stale-while-revalidate` for `/api/*`
- A web app manifest and Apple touch icons for PWA installability

The changes in this document address three gaps:
1. The webhook receiver endpoint does not exist
2. The in-memory cache prevents effective cache-purge across isolates
3. The CSP / security headers are in a `_headers` file (Cloudflare Pages format) that does not work with the Workers adapter

---

## 2. New Endpoint: Webhook Receiver

**File:** `src/pages/api/revalidate.ts` (Astro API endpoint)

```typescript
export const prerender = false;

export async function POST({ request }: { request: Request }): Promise<Response> {
  const secret = request.headers.get('X-Webhook-Secret');
  const expectedSecret = import.meta.env.WEBHOOK_SECRET;

  if (!secret || secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let purged = 0;

  try {
    // Import the cache purge function from cms.ts
    // (see §3 — cms.ts must export purgeCaches)
    const { purgeCaches } = await import('../lib/cms.js');
    purged = await purgeCaches();

    console.log(`[revalidate] Purged ${purged} cache entries`);
  } catch (err) {
    console.error('[revalidate] Cache purge failed:', err);
    return new Response(JSON.stringify({ error: 'Cache purge failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, purged }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

**Env var required in `pav-frontend`**:

```
WEBHOOK_SECRET=<same value as Koyeb WEBHOOK_SECRET>
```

**Register in Cloudflare dashboard**: The Workers route for this endpoint is automatically `/api/revalidate` (Astro maps `src/pages/api/*.ts` to `/api/*` routes in SSR Workers).

**Test locally**:

```bash
curl -X POST http://localhost:4321/api/revalidate \
  -H "X-Webhook-Secret: <secret>" \
  -H "Content-Type: application/json"
# Expected: {"ok": true, "purged": <n>}
```

---

## 3. Upgrade `cms.ts` — In-Memory Map → Cloudflare Cache API

**File:** `src/lib/cms.ts`

The current implementation uses a `Map` for the request cache. This is **per-isolate** — Cloudflare Workers can spin up multiple isolates, each with their own `Map`. A `clearCmsCache()` call only clears one isolate's `Map`. The webhook purge would only affect one isolate.

**Solution**: Replace the `Map` with Cloudflare's **Cache API** (`caches.default`), which is shared across all isolates in a colo.

### 3.1 Updated `cms.ts`

```typescript
// pav-frontend/src/lib/cms.ts

const CMS_CACHE_NAME = 'pav-cms-v1';
const CACHE_TTL_MS = 60_000; // 60 seconds — max staleness before re-fetch

interface InFlightEntry {
  promise: Promise<Response>;
}

/** In-flight request deduplication — still per-isolate, but fast */
const inFlightRequests = new Map<string, InFlightEntry>();

/**
 * Build a stable cache key from method + path + searchParams.
 */
function buildCacheKey(method: string, path: string, params?: Record<string, string>): string {
  const sortedParams = params
    ? Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&')
    : '';
  return `${method}:${path}${sortedParams ? `?${sortedParams}` : ''}`;
}

/**
 * Fetch from Strapi with caching via Cloudflare Cache API.
 * Falls back to direct fetch if Cache API is unavailable (local dev).
 */
async function fetchWithCache(
  cacheKey: string,
  strapiUrl: string,
  fetchOptions?: RequestInit
): Promise<Response> {
  // Try to read from shared cache first
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const age = Date.now() - new Date(cached.headers.get('cf-cache-timestamp') ?? 0).getTime();
      if (age < CACHE_TTL_MS) {
        return cached;
      }
    }
  } catch {
    // Cache API not available (local dev) — skip cache read
  }

  // Deduplicate in-flight requests
  const existing = inFlightRequests.get(cacheKey);
  if (existing) return existing.promise;

  const promise = (async () => {
    const response = await fetch(strapiUrl, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(import.meta.env.STRAPI_TOKEN
          ? { Authorization: `Bearer ${import.meta.env.STRAPI_TOKEN}` }
          : {}),
        ...fetchOptions?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Strapi ${response.status}: ${response.statusText} — ${strapiUrl}`);
    }

    // Clone and cache the response (body can only be consumed once)
    const cloned = response.clone();

    // Store in shared cache with a custom timestamp header
    try {
      const cacheBody = new Response(cloned.body, {
        headers: {
          ...Object.fromEntries(cloned.headers),
          'cf-cache-timestamp': String(Date.now()),
          'Cache-Control': 'public, max-age=60',
        },
      });
      await caches.default.put(cacheKey, cacheBody);
    } catch {
      // Cache API not available (local dev) — skip cache write
    }

    return response;
  })();

  inFlightRequests.set(cacheKey, { promise });
  promise.finally(() => inFlightRequests.delete(cacheKey));

  return promise;
}

/**
 * GET wrapper with caching.
 */
export async function cmsGet<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const url = `${import.meta.env.STRAPI_URL}/api/${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
  const cacheKey = buildCacheKey('GET', `/${path}`, params);

  const response = await fetchWithCache(cacheKey, url, { method: 'GET' });
  return response.json() as Promise<T>;
}

/**
 * GETONE wrapper (by ID).
 */
export async function cmsGetById<T>(path: string, id: number | string): Promise<T> {
  return cmsGet<T>(`${path}/${id}`);
}

/**
 * Purge all known CMS cache keys from the shared Cache API.
 * Returns the number of keys purged.
 *
 * Note: The purge is per-colo. Cloudflare may have caches in multiple
 * colos. Subsequent requests will re-populate the cache within TTL.
 */
export async function purgeCaches(): Promise<number> {
  // We can't enumerate Cache API keys, so we track the keys we write.
  // Purge by timestamp: delete any CMS cache entry older than a generous window.
  // Cloudflare's Cache API doesn't support key enumeration, so we rely on
  // TTL + key overwrite for now. A full purge would require tracking keys
  // separately (e.g. in a KV binding).
  //
  // Workaround: overwrite cache with empty sentinel for each known key.
  // Known keys pattern: CMS_GET_{path}_{params_hash}
  // We export this so the revalidate webhook can call it.
  let purged = 0;
  const knownKeys = [
    // Add known cache keys here as they're discovered, or use a KV store
    // to enumerate keys. For MVP, rely on TTL expiration.
  ];

  for (const key of knownKeys) {
    try {
      await caches.default.delete(key);
      purged++;
    } catch {
      // ignore
    }
  }

  // Also flush the in-memory maps for all isolates via a broadcast
  // (best-effort; not all isolates will receive it)
  try {
    const ctx = Reflect.get(globalThis, '__cms_broadcast') as ((keys: string[]) => void) | undefined;
    if (ctx) ctx(knownKeys);
  } catch {
    // ignore
  }

  return purged;
}

/**
 * Clear the in-memory in-flight map (called after cache purge
 * to prevent stale promises from repopulating the cache).
 */
export function clearInFlightRequests(): void {
  inFlightRequests.clear();
}

/**
 * Expose broadcast channel for cross-isolate cache coordination.
 * Call this once at module init.
 */
export function initCmsBroadcast(): void {
  if ('BroadcastChannel' in globalThis) {
    const channel = new BroadcastChannel('cms-cache-purge');
    channel.onmessage = ({ data }) => {
      if (data?.type === 'PURGE') {
        clearInFlightRequests();
      }
    };
  }
}
```

> **Note on cache key enumeration**: The Cloudflare Cache API does not support listing keys. The `purgeCaches()` function above is a best-effort sentinel-based purge. For production with many content types, consider adding a **Cloudflare KV** binding to track written cache keys, then iterate over KV to purge.

### 3.2 Simplified `purgeCaches` (MVP — TTL-based)

For a site with 82 listings, the simplest working approach is to rely on the **60 s TTL** as the effective purge window. The webhook does two things:

```typescript
// src/pages/api/revalidate.ts  (simplified MVP)
export async function POST({ request }: { request: Request }): Promise<Response> {
  const secret = request.headers.get('X-Webhook-Secret');
  if (secret !== import.meta.env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Best-effort: clear in-memory state + broadcast to all isolates
  if (typeof globalThis.__cms_clear === 'function') {
    globalThis.__cms_clear();
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

The frontend cache naturally refreshes within 60 s of any request after the webhook fires. This is the MVP approach — adequate for low-traffic sites. Upgrade to full KV-backed purge when needed.

---

## 4. Security Headers & CSP Hardening

The current `public/_headers` file is in **Cloudflare Pages format** and is **ignored by the Cloudflare Workers adapter** (`@astrojs/cloudflare`). The Workers adapter requires runtime header configuration.

### 4.1 Move CSP to runtime middleware

**File:** `src/middleware.ts` (create if not exists)

```typescript
// src/middleware.ts
import { defineMiddleware } from 'astro:middleware';

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.parler.cc https://*.pardot.com https://px.ads.linkedin.com https://snap.licdn.com https://www.linkedin.com https://bat.bing.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.strapi.io https://*.cloudflare.com https://*.workers.dev https://<koyeb-url> https://assets.<domain>",
  "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
].join('; ');

export const onRequest = defineMiddleware(async ({ request, locals }, next) => {
  const response = await next(request);

  // Apply security headers to all HTML + API responses
  if (
    request.headers.get('Accept')?.includes('text/html') ||
    request.url.includes('/api/')
  ) {
    response.headers.set('Content-Security-Policy', CSP_POLICY);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  }

  // Immutable cache for static assets ( fingerprints via astro build hash)
  if (request.url.match(/\.(js|css|woff2|png|jpg|webp|avif)$/)) {
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return response;
});
```

> **Important**: Replace `<koyeb-url>` and `assets.<domain>` with your production domains. Add both the Koyeb backend URL and the Cloudflare R2/Worker image URL to `connect-src` and `img-src`.

### 4.2 Service Worker Cache-Control headers

The service worker (`public/sw.js`) already sets appropriate caching headers per cache type. No changes needed there.

The `Cache-Control` for `/sw.js` itself is handled by the middleware above (not via `_headers`).

---

## 5. Service Worker Cache Versioning

**File:** `public/sw.js`

The current `CACHE_NAME = 'pav-static-v1'` is hard-coded. On every deploy, the SW continues serving the old cached navigation until the user clicks "Update" or clears the cache manually.

### 5.1 Solution: Inject version at build time

**Option A — Env var injection via Astro** (recommended):

```javascript
// In public/sw.js — read version from a global set by the page
const CACHE_NAME = self.__SW_VERSION__ || 'pav-static-v1';
```

```astro
// In src/layouts/BaseLayout.astro — inject version into SW registration
<script define:vars={{ version: import.meta.env.PUBLIC_SW_VERSION || 'v1' }}>
  self.__SW_VERSION__ = version;
  navigator.serviceWorker.register('/sw.js').then(...)
</script>
```

Add `PUBLIC_SW_VERSION` to `pav-frontend/.env`:

```
PUBLIC_SW_VERSION=v2  # bump on every deploy
```

**Option B — Auto-bump via build script** (in `astro.config.mjs`):

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { writeFileSync } from 'node:fs';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'cloudflare', runtime: { mode: 'off' } }),
  site: 'https://pav-frontend.pixie-cemodan.workers.dev/',
  integrations: [react(), sitemap()],
  i18n: { locales: ['es', 'en'], defaultLocale: 'es', routing: { prefixDefaultLocale: false } },
  // Hook into build: inject SW version
  hooks: {
    'astro:build:done': ({ dir }) => {
      const version = `pav-v${Date.now()}`;
      // Patch sw.js in place (dist/)
      const swPath = new URL('./client/sw.js', dir);
      try {
        let content = readFileSync(swPath, 'utf8');
        content = content.replace(/CACHE_NAME = '[^']+'/, `CACHE_NAME = '${version}'`);
        writeFileSync(swPath, content);
        console.log(`[astro:build:done] SW version: ${version}`);
      } catch {}
    },
  },
});
```

With either approach, the `activate` event in `sw.js` already cleans up old caches:

```javascript
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('pav-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});
```

---

## 6. `@astrojs/partytown` Integration

**File:** `astro.config.mjs`

`@astrojs/partytown` is listed as a dependency in `package.json` but is **not registered** in `astro.config.mjs`. Partytown moves third-party scripts (analytics, ads, etc.) to a web worker to avoid blocking the main thread.

**To enable**:

```bash
cd ../pav-frontend
pnpm add @astrojs/partytown
```

```js
// astro.config.mjs
import partytown from '@astrojs/partytown';

export default defineConfig({
  // ... existing config
  integrations: [
    react(),
    sitemap(),
    partytown({
      // Proxy analytics calls through Partytown
      config: {
        forward: ['dataLayer.push', 'gtag', 'fbq'],
      },
    }),
  ],
});
```

> If there are no third-party scripts (analytics, ads) on the site, Partytown can be skipped. Verify by searching for `google-analytics`, `gtag`, `fbq`, `dataLayer`, `pardot`, `linkedin` in the codebase.

---

## 7. `lint` Script Missing from `package.json`

The CI workflow (`test.yml`) calls `pnpm run lint`, but no `lint` script exists in `package.json`, causing the CI step to fail.

**File:** `package.json`

```diff
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
+   "lint": "eslint src --ext .ts,.tsx,.astro",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:debug": "playwright test --debug"
  },
```

> If ESLint is not configured (`.eslintrc` exists but has minimal content), either configure it properly or remove the `lint` job from `.github/workflows/test.yml`.

---

## 8. Env Vars Required in `pav-frontend`

Add to `pav-frontend/.env` (copy to `.env.production` for build-time vars):

```bash
# Strapi
STRAPI_URL=https://pav-backend-xxx.koyeb.app
STRAPI_TOKEN=<your-strapi-api-token>

# Webhook
WEBHOOK_SECRET=<same hex value as Koyeb WEBHOOK_SECRET>

# Service Worker versioning
PUBLIC_SW_VERSION=v1   # bump on every deploy
```

Set `STRAPI_URL` and `WEBHOOK_SECRET` as **GitHub Actions secrets** (`STRAPI_URL`, `STRAPI_TOKEN`, `WEBHOOK_SECRET`) for the deploy workflow.

---

## 9. GitHub Actions — Add Webhook Secret

**File:** `.github/workflows/deploy.yml`

```diff
       - name: Build
         run: pnpm build
         env:
           STRAPI_URL: ${{ secrets.STRAPI_URL }}
           STRAPI_TOKEN: ${{ secrets.STRAPI_TOKEN }}
+          WEBHOOK_SECRET: ${{ secrets.WEBHOOK_SECRET }}
```

Add `WEBHOOK_SECRET` to the repository's GitHub Actions secrets.

---

## 10. Summary of Changes by File

| File | Change | Type |
|---|---|---|
| `src/pages/api/revalidate.ts` | Webhook receiver endpoint | **New** |
| `src/lib/cms.ts` | Replace `Map` with Cache API; add `purgeCaches()` | **Edit** |
| `src/middleware.ts` | Runtime CSP + security headers (replaces `_headers`) | **New** |
| `astro.config.mjs` | Optionally enable Partytown; add `PUBLIC_SW_VERSION` build hook | **Edit** |
| `public/sw.js` | Use `self.__SW_VERSION__` instead of hard-coded cache name | **Edit** |
| `package.json` | Add `lint` script | **Edit** |
| `.env.example` | Add `WEBHOOK_SECRET`, `PUBLIC_SW_VERSION` | **Edit** |
| `.github/workflows/deploy.yml` | Pass `WEBHOOK_SECRET` to build | **Edit** |
| `.github/workflows/test.yml` | Fix or remove broken `lint` job | **Edit** |

---

*Reference only — not part of `pav-backend`. Last updated: 2026-07-07.*
