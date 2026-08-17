# Puerto Agua Verde — Strapi Backend

Strapi v5 CMS backend for the Puerto Agua Verde / Rancho San Cosme destination site.

## Stack

- **Strapi v5.39** with SQLite (dev) / PostgreSQL-ready (prod)
- **Cloudflare R2** for media storage (S3-compatible API)
- **pnpm** workspace member

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values — see .env.example for all required vars

# 3. Start development server
pnpm develop
```

The admin panel will be at `http://localhost:1337/admin`.

## Environment variables

Copy `.env.example` → `.env` and fill in all values. Key variables:

| Variable | Description |
|---|---|
| `APP_KEYS` | Strapi app keys (comma-separated) |
| `ADMIN_JWT_SECRET` | Admin auth secret |
| `API_TOKEN_SALT` | API token salt |
| `TRANSFER_TOKEN_SALT` | Transfer token salt |
| `USERS_PERMISSIONS_JWT_SECRET` | users-permissions plugin secret (falls back to `ADMIN_JWT_SECRET` when unset) |
| `ENCRYPTION_KEY` | Strapi encryption key |
| `DATABASE_CLIENT` | `sqlite` (dev) or `postgres` (prod) |
| `DATABASE_FILENAME` | SQLite DB path (dev; e.g. `.tmp/data.db`) |
| `DATABASE_URL` | Full Neon PostgreSQL connection string (prod; `sslmode=require`) |
| `DATABASE_SSL` | `true` in production |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | Connection pool bounds (prod; e.g. `0` / `5`) |
| `URL` | Public origin of the Strapi instance (e.g. `https://admin.guiacomunidadesloretanas.com`) |
| `FRONTEND_URL` | Public origin of the frontend (e.g. `https://guiacomunidadesloretanas.com`) |
| `STRAPI_URL` | Alias for `URL` (used by frontend for API calls) |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key (restricted to admin domain in production) |
| `R2_ENDPOINT` | Cloudflare R2 S3 API endpoint |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | R2 bucket name (e.g. `pav-assets`) |
| `R2_PUBLIC_BASE_URL` | Public URL for R2 bucket (R2.dev URL or custom domain) |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server host and port (e.g. `smtp.resend.com` / `465`) |
| `SMTP_USER` / `SMTP_PASS` | SMTP auth credentials |
| `EMAIL_FROM` | Sender address (e.g. `PAV <no-reply@mail.puertoaguaverde.mx>`) |
| `EMAIL_REPLY_TO` | Reply-to address |
| `STRAPI_TELEMETRY_DISABLED` | Set to `true` to opt out of Strapi anonymous telemetry |

## Media uploads

Images are stored in **Cloudflare R2** via `@strapi/provider-upload-aws-s3`.

- Allowed formats: `jpg`, `png`, `webp`
- Max size: 3 MB
- Validation errors shown in **Spanish**

### R2 CORS

Add the following CORS rule to your R2 bucket in the Cloudflare dashboard:

```json
{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:1337", "http://localhost:4321", "https://guiacomunidadesloretanas.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
}
```

## Content types

- **Listing** — places, restaurants, experiences (with structured components for location, contact, schedule, tags, amenities, recommendations)
- **Category** — listing categories
- **Organization** — community org info
- **Team Member** — community team
- **Site Content** — reusable content blocks
- **Homepage** — homepage sections (hero, destinations, highlights, quick facts, map, CTA)

All schemas use Spanish `displayName`, `description`, and field-level helper text for non-technical admin users.

## Scripts

```bash
pnpm develop      # Start dev server with auto-reload
pnpm build        # Build admin panel
pnpm start        # Start production server
pnpm seed         # Run the seed script (populates initial data)
```

## Deployment

Strapi supports multiple deployment targets. See the [Strapi deployment docs](https://docs.strapi.io/dev-docs/deployment) for options (Strapi Cloud, Node server, Docker, etc.).

For production, switch `DATABASE_CLIENT` to `postgres` and set the corresponding `DATABASE_*` env vars.

## Frontend revalidation webhook

Content changes go live by triggering a full frontend rebuild. The webhook is configured in the **Strapi admin UI** (Settings → Webhooks) and stored in Strapi's database — the backend consumes **no env var** for it.

| Field | Value |
|---|---|
| Name | `pav_frontend_revalidate` |
| URL | `https://guiacomunidadesloretanas.com/api/revalidate` |
| Header | `X-Webhook-Secret` — must match the frontend's `REVALIDATE_WEBHOOK_SECRET` GitHub Actions secret |
| Events | ✅ `entry.publish` · ✅ `entry.unpublish` · ✅ `entry.delete` |

On a valid secret, the frontend fires a GitHub `repository_dispatch` (event `cms-revalidate`) to `ODCenteno/pav-frontend`; the Deploy workflow rebuilds and redeploys the statically-prerendered site — the rebuild is what makes new CMS content visible.

- `entry.update` is intentionally excluded: it fires on every draft save and would trigger wasted rebuilds (all content types are draftAndPublish).
- `REVALIDATE_WEBHOOK_SECRET` is baked into the Worker bundle at build time; rotating it requires updating the Strapi webhook header **and** redeploying the frontend.
- Response codes: **202** dispatch fired · **401** secret mismatch · **502** dispatch failed · **503** env vars missing at build time.
- Cloudflare WAF requires `Content-Type: application/json` on POSTs — Strapi sends JSON natively, so requests pass.

Source of truth: `pav-frontend` `src/pages/api/revalidate.ts`.
