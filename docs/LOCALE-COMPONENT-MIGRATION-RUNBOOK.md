# Locale Component Migration — Production Deploy Runbook

**File:** `docs/LOCALE-COMPONENT-MIGRATION-RUNBOOK.md`
**Context:** Strapi v5 · `pav-backend` + `pav-frontend` · PostgreSQL (Neon) in production
**Status:** Rehearsed end-to-end on the local dev DB (2026-08-22). All phases verified.

---

## What this migrates

Dual `*_es`/`*_en` fields inside localized listing components become single
localized fields, and amenities/recommendations become flexible label+content
components (mirroring `product.item`):

| Before | After |
|---|---|
| `tag.tag-item` `label_es`/`label_en` | `label` (localized) |
| `schedule.hours` `text_es`/`text_en` | `text` (localized) |
| `common.localized-text` `text_es`/`text_en` | `text` (localized) |
| `listing.amenities` → `tag.tag-item` | `listing.amenities` → `amenity.amenity-item` (`label` + `content`) |
| `listing.recommendations` → fixed `visit-info` (8 fields) | `listing.recommendations` → `recommendation.recommendation-item` (`label` + `description`, repeatable) |

Git already carries the two schema states this runbook needs:

- **Expand commit** `5b108e4` — new single fields/components ADDED, dual fields kept, listing attributes unchanged.
- **Contract commit** `274dc82` — dual fields REMOVED, listing attributes swapped.

The migration script is **two-phase** to keep the site serving amenities and
recommendations with zero visible degradation:

- `--apply` (before the contract deploy): fills single columns, creates new
  amenity/recommendation rows + links, **keeps the old links** so the
  still-active expand schema keeps serving them.
- `--cleanup` (after the contract deploy): deletes the kept old links and
  prunes orphaned tag/visit-info rows.

The frontend (`pav-frontend` @ `77f894b` or later) contains an
expand/contract bridge: it reads `label ?? label_es` (and converts legacy
visit-info objects), so **any frontend deploy order is safe** and a backend
rollback does not break the site.

---

## Prerequisites

- [ ] `psql` or Neon console access for a logical backup (`pg_dump`).
- [ ] The production `DATABASE_URL` (connection string) — available from the
      prod Strapi env / hosting dashboard.
- [ ] A checkout of this repo at the right commit on a machine that can reach
      Neon (`node` 18+, `pnpm install` done — the script needs `pg` +
      `better-sqlite3` from devDependencies).
- [ ] Content editors notified: **no listing edits** from the start of Phase 2
      until the end of Phase 4 (edits during the window can be lost).

No Strapi admin configuration, new env vars, or permission changes are
required — the new components register automatically on boot and inherit the
existing i18n locale setup (`es-MX` default + `en`).

---

## Phase 0 — Backup (point of no return starts here)

```bash
# Logical backup of the whole DB (adjust host/db from DATABASE_URL):
pg_dump "$DATABASE_URL" --format=plain --file neon-backup-$(date +%Y%m%d-%H%M%S).sql

# Or from the Neon console: Branches -> your branch -> Reset/dump options.
```

Keep the dump. Every later phase also writes its own JSON snapshot with the
pre-write state of exactly the rows/links it touches.

## Phase 1 — Deploy the EXPAND commit (`5b108e4`)

> **Push ONLY the expand commit.** The docker image is built from the HEAD of
> `main`, so pushing everything at once would skip this phase entirely.

```bash
git push origin 5b108e4:main    # pushes ONLY the expand commit (fast-forward)
# wait for the docker-publish workflow, then restart the prod container
# with the new image using your usual procedure
```

On boot, Strapi's schema sync only ADDS columns/tables — no data changes, no
visible API change.

**Verify:**
- [ ] Strapi boots clean (no errors in logs about schema).
- [ ] `GET /api/listings?populate=tags,schedule` returns BOTH old and new
      fields (`label_es`, `label_en`, `label`) — expand state active.

## Phase 2 — Run the migration `--apply` (maintenance window)

Run with prod Strapi **stopped** (safest — prevents concurrent writes), from
the repo checkout at the expand commit:

```bash
export DATABASE_CLIENT=postgres
export DATABASE_URL="postgres://...neon..."
node scripts/migrate-locale-components.js            # DRY-RUN — review the plan
node scripts/migrate-locale-components.js --apply    # executes + writes snapshot
```

**Verify from the dry-run output:**
- [ ] Junk links reported (`missing-entity`/`missing-component`) — expected
      debris; the local rehearsal found 516.
- [ ] `updates=` / `clones=` counts for the three in-place components.
- [ ] `amenityRows=` / `recommendationRows=` counts.
- [ ] Snapshot file `locale-components-snapshot-*.json` written — note its path.

Restart prod Strapi (still on the expand image). Old links are kept, so the
site keeps serving amenities/recommendations from the dual fields; tags and
schedule already serve from the new single columns (identical values).

## Phase 3 — Deploy the CONTRACT commit (`274dc82`)

```bash
git push origin main           # now pushes contract + runbook docs
# wait for the workflow, restart the prod container with the new image
```

On boot, schema sync drops the dual columns and the listing switches
amenities/recommendations to the new components — serving the rows created in
Phase 2. **This is the point of no return for the dual columns** (restore
path = snapshot JSON from Phase 2 + the Phase 0 pg_dump).

**Verify:**
- [ ] `GET /api/listings?populate=tags,amenities,recommendations,schedule&locale=es-MX`
      returns `tags[].label`, `amenities[].label/content`,
      `recommendations[].label/description` — no `*_es`/`*_en` keys.
- [ ] Same for `locale=en` (English values).

## Phase 4 — Cleanup pass

Run after the contract deploy is confirmed live (Strapi can stay up; the
deletes touch only orphaned/legacy links):

```bash
export DATABASE_CLIENT=postgres
export DATABASE_URL="postgres://...neon..."
node scripts/migrate-locale-components.js --cleanup
```

**Verify:** re-run without flags — must print
`Nothing to migrate. Database already in post-migration state.` and exit 0.

## Phase 5 — Frontend deploy

Push `pav-frontend` main (the 4 pending commits: about fix, listing
single-locale components + member modal data, modal UI, fullscreen maps).
Cloudflare Pages builds and deploys. Thanks to the bridge this can happen at
ANY point relative to Phases 1–4; doing it last is simply tidy.

**Verify (site):**
- [ ] `/sitios/<slug>` shows "Información importante" with CMS labels
      ("Mejor época para visitar", "Qué llevar"…), amenities, schedule, tags.
- [ ] `/en/sitios/<slug>` shows English labels; a listing with empty EN
      components falls back to Spanish values.
- [ ] Admin panel: listing form shows ONE field per component per locale;
      switching the locale picker switches the values.

## Rollback

- **Before Phase 3:** redeploy the expand/pre-migration image; restore the
  JSON snapshot (reverses fills/swaps) or the pg_dump (full restore).
- **After Phase 3:** restore the Phase 0 pg_dump into Neon and redeploy the
  pre-migration image. The frontend bridge tolerates the old API shape, so
  the site stays up either way.

## Post-deploy follow-ups

- [ ] Editors review migrated amenities (label only, `content: ''`) and
      recommendations (4 fixed items per listing) and enrich at will — the
      new components are free-form label+description.
- [ ] Remove the frontend `?? label_es` bridge after the contract has been
  stable for a while (small follow-up PR in `pav-frontend`).
- [ ] The Strapi 5.51 upgrade (backlog P3) can proceed afterwards.
