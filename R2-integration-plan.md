# Plan: Strapi Media Uploads → Cloudflare R2

**Limit:** `image/jpeg`, `image/png`, `image/webp` · ≤ 3 MB  
**Language:** All validation feedback in **Spanish**  
**Bucket + API token:** Already exist  
**Public domain:** `<your-r2-public-base-url>` (R2.dev URL or custom domain `assets.guiacomunidadesloretanas.com` TBD)

---

## 1. Dependencies

```bash
pnpm add @strapi/provider-upload-aws-s3
```

Pinned to `5.39.0` in `package.json` (matches Strapi v5.39).

---

## 2. Upload provider configuration — `config/plugins.ts`

```ts
upload: {
  config: {
    provider: 'aws-s3',
    providerOptions: {
      endpoint: env('R2_ENDPOINT'),
      baseUrl: env('R2_PUBLIC_BASE_URL'),
      params: {
        Bucket: env('R2_BUCKET'),
        ACL: undefined, // R2 does not support ACLs
      },
      s3Options: {
        credentials: {
          accessKeyId: env('R2_ACCESS_KEY_ID'),
          secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
        },
        region: 'auto',
      },
      providerConfig: {
        checksumAlgorithm: 'CRC64NVME',
        preventOverwrite: true,
      },
      forcePathStyle: true,
    },
    sizeLimit: 3 * 1024 * 1024, // 3 MB in bytes
    security: {
      allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
    },
  },
},
```

**Key details:**
- `sizeLimit` is in **bytes** (confirmed from `@strapi/upload@5.39` source, `config.js`).
- `security.allowedTypes` is enforced by Strapi v5's built-in `mime-validation.mjs`, which uses **magic-byte detection** (`file-type`) — not just extension checking. This catches renamed files.
- `forcePathStyle` is the AWS SDK v3 camelCase name (NOT `s3ForcePathStyle` — that is the v2 name).
- `baseUrl` is at the top level of `providerOptions` (cleaner than overriding `file.url` in extensions).
- `s3Options` wrapper is required by `@strapi/provider-upload-aws-s3` v5.x for credentials/region.
- R2 does **not** support ACLs (`ACL: undefined`).
- R2 does **not** support `checksumAlgorithm: 'CRC64NVME'` — use `CRC32` instead. `preventOverwrite: true` is still in config but may be safely ignored by R2 (see open items).

---

## 3. Environment variables — `.env` / `.env.example`

```
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your-access-key-id>
R2_SECRET_ACCESS_KEY=<your-secret-access-key>
R2_BUCKET=pav-assets
R2_PUBLIC_BASE_URL=https://<your-r2-public-base-url>
```

Actual values from `.env` (dev):
- `R2_ENDPOINT`: `https://<your-account-id>.r2.cloudflarestorage.com`
- `R2_PUBLIC_BASE_URL`: `<your-r2-public-base-url>`

---

## 4. Public serving via R2.dev URL (no custom domain yet)

Images are served from the `R2_PUBLIC_BASE_URL` value in `.env`.  
Once `assets.guiacomunidadesloretanas.com` is configured as a custom domain on the bucket, update `R2_PUBLIC_BASE_URL` and add it to CSP directives.

---

## 5. Spanish validation feedback — `src/extensions/upload/`

One thin override of the upload controllers via a single `strapi-server.js` (Strapi v5 plugin-extension pattern):

```
src/extensions/upload/strapi-server.js          ← single entry point
src/extensions/upload/utils/spanish-errors.js   ← shared helpers
```

**NOT** two separate controller files (`admin-upload.js` + `content-api.js`) as originally planned — Strapi v5's `strapi-server.js` pattern wraps both controllers from one file.

### What it does

Wraps `upload`, `uploadFiles`, and `replaceFile` methods on both `admin-upload` and `content-api` controllers. When Strapi's internal validation throws an error (MIME, size, or unverifiable), the Spanish translator rewrites the message:

| English | Spanish |
|---------|---------|
| `File type '<mime>' is not allowed` | `El tipo de archivo '<mime>' no está permitido` |
| `MIME type is not allowed` | `El tipo MIME no está permitido` |
| `Cannot verify file type for security reasons` | `No se puede verificar el tipo de archivo por razones de seguridad` |
| `<name> exceeds size limit of <size>.` | `<name> excede el límite de tamaño de <size>.` |

The core Strapi `allowedTypes` + `sizeLimit` remain active as safety nets, but the extension fires first (it wraps the controller before the service runs).

---

## 6. Content Security Policy — `config/middlewares.ts`

The default Strapi v5 CSP (`img-src`, `media-src`) only allows `'self'`, `data:`, `blob:`, `https://market-assets.strapi.io`, and AI plugin S3 domains. R2 images are blocked in the admin panel.

**Fix applied:** Override `strapi::security` middleware:

```ts
{
  name: 'strapi::security',
  config: {
    contentSecurityPolicy: {
      directives: {
        'img-src': [
          "'self'",
          'data:',
          'blob:',
          'https://market-assets.strapi.io',
          'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
          'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
          'https://<your-r2-public-base-url>',
        ],
        'media-src': [
          "'self'",
          'data:',
          'blob:',
          'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
          'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
          'https://<your-r2-public-base-url>',
        ],
      },
    },
  },
},
```

---

## 7. Preview URL fix — `config/admin.ts`

The content-manager preview URL endpoint (`content-manager/preview/url/api::listing.listing`) returned 404. Fixed by disabling preview:

```ts
preview: {
  enabled: false,
  config: {
    handler: () => undefined,
    allowedOrigins: [],
  },
},
```

The endpoint now returns 204 instead of 404.

---

## 8. Structured components (JSON fields → form fields)

Replaced raw JSON fields with structured components across 3 content types:

| Content type | JSON fields replaced | Components |
|---|---|---|
| `listing` | `tags`, `contact`, `location`, `schedule`, `amenities`, `recommendations` | `tag.tag-item` (repeatable), `contact.contact-info`, `location.geo-point`, `schedule.hours`, `tag.tag-item` (repeatable, used for amenities too), `recommendation.visit-info` |
| `organization` | `shortDescription`, `links` | `common.localized-text`, `contact.links` |
| `team-member` | `role`, `shortBio`, `links` | `common.localized-text`, `common.localized-text`, `contact.links` |

**Pattern:** Flat `_es`/`_en` suffixed fields (NOT Strapi native i18n) — preserves dual-language-in-one-entry for the frontend.

All 9 content types and 17 component schemas have Spanish `displayName`, `description`, and per-field helper text.

---

## 9. Data migration — `scripts/migrate-json-to-components.js`

Two-phase migration for 82 listings:

1. **Phase 1** — Backup DB + export all 82 listings JSON data.
2. **Phase 2** — Start Strapi (creates component tables), restore all data as components via API.

---

##
End-to-end test script that:
1. Uploads a valid WebP image to Strapi
2. Verifies the response URL points to R2
3. Verifies public access via HTTP GET
4. Creates a listing with the uploaded image
5. Cleans up test data

**Result:** 11/11 checks passed.

---

## 11. CORS on the R2 bucket

CORS is configured in the Cloudflare dashboard (the R2 Workers API doesn't support CORS configuration):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "http://localhost:1337",
        "http://localhost:4321",
        "https://guiacomunidadesloretanas.com/"
      ],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

---

## 12. Frontend image display fix (Strapi v5 media shape)

Strapi v5 returns media fields in a **flat** shape (`{ id, url, formats, ... }`) directly on the entry, NOT wrapped in `{ data: { id, attributes: { url } } }` like Strapi v4.

The frontend `strapiTransformer.ts` originally expected the v4 wrapped shape, so all `mediaUrl()` / `mediaUrls()` calls and `?.data?.attributes?.url` access patterns returned `''`. This caused `mergeHomepage()` and `getListingsFallback()` to substitute dev-fallback `/images/...` URLs instead of R2 URLs.

**Fix applied in `pav-frontend/src/utils/strapiTransformer.ts`:**
- `StrapiMedia` and `StrapiMediaArray` interfaces updated to accept both flat and wrapped shapes
- `getUrlFromMedia()` now handles v5 flat (`media.url`, `media.attributes.url`), v4 wrapped (`media.data.attributes.url`), and legacy (`media.data[0].attributes.url`) patterns
- `getAltFromMedia()` same treatment
- All `?.data?.attributes?.url` patterns in `transformHomepage()` replaced with `getUrlFromMedia()` / `getAltFromMedia()`
- `heroImagesRaw` now uses `Array.isArray(hero.images) ? hero.images : hero.images?.data || []` to support both v4 `{ data: [...] }` and v5 flat `[{ ... }]` formats

**Fix applied in `pav-frontend/src/lib/cms.ts`:**
- `getGlobalSettings()` `ogImageUrl` and `logoImageUrl` now use `as any` cast and check both `attributes.url` and direct `url`

**Test fixtures updated** in `strapiTransformer.test.ts` and `cms.test.ts` to use flat v5 shapes. All 176 tests pass.

---

## 13. Post-implementation verification

```bash
pnpm build
tsc --noEmit
```

Then, against a running dev instance:

| Test case | Expected result |
|-----------|----------------|
| Upload a 4 MB valid `.jpg` | ❌ Spanish size error |
| Upload a valid `.gif` (not allowed) | ❌ Spanish format error |
| Upload a `.png` renamed from `.txt` | ❌ Spanish format error (magic-byte catch) |
| Upload a valid `.webp` < 3 MB | ✅ Stored in R2, URL points to `<your-r2-public-base-url>/...` |
| Upload a valid `.jpg` < 3 MB | ✅ Stored in R2, URL points to R2 public URL |
| Open Media Library | ✅ All images load from R2 public URL (after CSP fix) |
| `public/uploads/` | ✅ Unchanged (no new files) |

---

## Files touched

| File | Action |
|------|--------|
| `package.json` | Edit — add `@strapi/provider-upload-aws-s3` dep at `5.39.0` |
| `config/plugins.ts` | Edit — add `upload` block with `s3Options` wrapper, `forcePathStyle`, `baseUrl` |
| `config/middlewares.ts` | Edit — override `strapi::security` with R2 domain in CSP |
| `config/admin.ts` | Edit — disable preview to fix 404 |
| `.env` | Edit — add R2 vars |
| `.env.example` | Edit — add R2 vars |
| `src/extensions/upload/strapi-server.js` | New — wraps admin-upload + content-api controllers |
| `src/extensions/upload/utils/spanish-errors.js` | New — shared Spanish error translation helpers |
| `scripts/migrate-json-to-components.js` | New — two-phase migration for 82 listings |
| `scripts/test-r2-upload.js` | New — end-to-end upload verification script |

---

## Open items

1. **`checksumAlgorithm: 'CRC32'`** — confirmed working. `preventOverwrite: true` is still in config — R2 does not support it, but uploads work so it may be safely ignored by R2.
2. **Custom domain** — `assets.guiacomunidadesloretanas.com` is not yet configured on the R2 bucket. When added, update `R2_PUBLIC_BASE_URL` in `.env` and add the domain to CSP directives in `config/middlewares.ts`.
3. **Frontend display** — Verified working in tests; live browser verification on `localhost:4321` TBD (requires Strapi dev server running with R2).
4. **Production CORS** — When deploying to production, add the production frontend origin (e.g., `https://www.puertoaguaverde.mx`) to the R2 bucket CORS rules.
