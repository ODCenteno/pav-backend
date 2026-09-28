# Brief A5 · Backend contract-phase cleanup

- Repo: `pav-backend` (Strapi 5.39, TypeScript; SQLite in dev, Neon Postgres in prod)
- Worktree: `pav-backend-worktrees/be-schema`
- Branch: `feat/be-community-schema`. Rebase onto `redesign` first; it is level with `main`, which is production.
- Contract: `docs/contracts/redesign-data-contract.md`, §10 (Deprecated) and §11 (Phases). This is the final "contract" phase.

The redesign is live in production and the production data is migrated. The client approved
deleting the deprecated backend types, fields and data listed below. The frontend is being
changed to stop requesting all of them, and it is deployed **before** this backend change.

## Rules

- Everything in English. Conventional commits, with NO `Co-Authored-By` or AI attribution.
  Never push, never merge.
- Strict TDD: failing test first, then the code.
- Use `rg`, `fd`, `eza`, `bat` instead of grep, find, ls, cat. Never read or print `.env*` files.
- **Never connect to production or to any Neon branch.** Local SQLite only. The coordinator
  rehearses this on a Neon branch copy and runs it in production.
- Verify with `rg` before deleting anything. If something is still referenced by a type that
  stays, keep it and say so in the report.
- Before the report run `pnpm exec tsc --noEmit`, `pnpm test` and `pnpm build`. All must be
  green.

## Step 1 · Schema removal

1. Delete these content types completely: `guide-page`, `experiences-page`, `about-page`,
   `team-member` and `organization`. That means `src/api/<type>/**`, their entries in the
   public-permission bootstrap (`src/index.ts`), and their tests.
2. Delete these fields:
   - `homepage.destinations`
   - `community-member.locality`
   - the legacy `phone` and `whatsapp` in `src/components/contact/contact-info.json`. Keep
     `phoneCountryCode`, `phoneNumber`, `whatsappCountryCode` and `whatsappNumber`.
3. Delete components that no remaining type or field uses. The coordinator's analysis found
   these candidates:
   - `about.collaboration-block`, `about.values-block`
   - `common.localized-text`, `contact.links`
   - `destination.destination-story`, `experience.experience-block`
   - `guide.amenity-item`, `guide.intro-block`, `guide.route-info`

   Verify each one with `rg`. **KEEP** these, because `community` and `good-practices-page`
   use them: `cta.cta-section`, `guide.milestone`, `guide.protected-link`,
   `guide.text-list-item`, `hero.hero-section`, `section.section-header`.
4. Remove the one-time `migrateSocialToContact` from `src/index.ts` and its tests. It already
   ran, and it now fails silently on every boot because it queries a table name instead of the
   component UID.
5. Remove `scripts/migrate-redesign.js`, its `migrate:redesign` package script and
   `tests/migrate-redesign.test.js`. The migration is done, it depends on the removed fields,
   and git history keeps it. Also update `sync-shared-slug` and any other code or test that
   references the removed types or fields.
6. Regenerate `types/generated/*`.
7. **Check on local SQLite what Strapi 5 does on boot.** Boot the app on a scratch copy of a
   database that still has the old tables and columns, then report whether it drops the removed
   tables and columns, or leaves them. Step 2 must handle the data either way.

## Step 2 · Data cleanup script

Create `scripts/cleanup-redesign.js`, plus a `cleanup:redesign` package script. Use the same
approach as the old migration: load Strapi with `createStrapi`/`compileStrapi`, read with
`strapi.db.connection` (knex) or the Query Engine, and write with the Query Engine or the
Document Service.

**Safety**
- Dry-run by default, `--apply` to write, with a JSON snapshot before any write.
- One transaction. Idempotent: a second run reports nothing to do.
- Exit 0 on success. Report post-commit shutdown warnings once, not as a failure.

**Steps**
1. **Legacy categories.** Delete every row of `sites`, `accommodation` and `restaurants`, in
   all locales and both draft and published.
   - First verify that no listing row links to them. If any does, abort the whole run and list
     the listings.
2. **Corrupt rows.** Delete listing and community-member rows whose `locale` is NULL. Production
   has listing row #99 (`artesanias-andrea`). Also delete their link-table rows and their
   component rows.
3. **Orphan contact components.** Delete `components_contact_contact_infos` rows that no
   `*_cmps` link table references. Dev data had 67.
4. **Leftovers from step 1.** If Strapi does not drop the removed tables and columns on its
   own, drop them explicitly, in the same transaction. Use the table and column names you
   observed in step 1.7. Guard every drop with an existence check so the script works on both
   SQLite and Postgres.

**Tests**, with a Strapi-backed Vitest suite on a temp SQLite database, like the old migration
suite (keep `pool: 'threads'`). Seed a legacy category with and without linked listings, a
NULL-locale listing row and orphan contact rows, then assert:
- the dry-run writes nothing;
- `--apply` removes exactly those rows;
- a linked legacy category aborts the run;
- the second run is a no-op;
- the snapshot file is written.

## Report

End with this report, then stop:

1. Commits (hash and subject).
2. Types, fields and components removed, and anything kept with the reason.
3. What Strapi 5 did on boot with the removed tables and columns (step 1.7).
4. The dry-run and apply output of the cleanup on your local seeded database.
5. Command results: tsc, test, build.
6. Risks for running this in production.
