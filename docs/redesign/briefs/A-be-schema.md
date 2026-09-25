# Brief A · Backend schema and migration

- Repo: `pav-backend` (Strapi 5.39, TypeScript; SQLite in dev, Neon Postgres in prod; R2 uploads; locales `es-MX` and `en`)
- Worktree: `pav-backend-worktrees/be-schema`
- Branch: `feat/be-community-schema` (based on `redesign`)
- Contract: `docs/contracts/redesign-data-contract.md` (a copy; the canonical file lives in
  `pav-frontend`). Implement it exactly. If something in it is impossible or ambiguous, stop and
  ask in your report; do not invent fields.

You are the only agent in this repo. Two frontend agents work in parallel in
`pav-frontend`; do not touch that repo.

## Rules

- All code, comments, docs and commit messages in English.
- Strict TDD: failing test first (Vitest, `tests/`), then the code.
- Conventional commits, with NO `Co-Authored-By` or AI attribution. Never push, never merge,
  never touch `main` or `redesign`.
- Use `rg`, `fd`, `eza`, `bat` instead of grep, find, ls, cat. Never read or print `.env*` files.
- **Expand only.** Add types, fields and components. Do not remove or rename anything:
  `guide-page`, `experiences-page`, `community-member.locality`, the legacy categories and
  `homepage.destinations` must keep working until the final cleanup.
- Never connect to or write to the production database. Scripts run against local SQLite. The
  coordinator runs them against a Neon branch copy later.
- Before each report run `pnpm exec tsc --noEmit`, `pnpm test` and `pnpm build`, all green.
  These are the same checks as CI.

## Milestone A1 · Schema

1. **New collection type `community`**, exactly as in contract §4:
   - Localized, with draft and publish.
   - Reuse the existing components listed there: highlight card, quick fact, guide history
     milestone, geo-point, CTA.
   - `slug` must be shared across locales the way `listing` does it (see
     `src/sync-shared-slug.ts`). Add `community` to that sync.
   - `color` and `textColor` are not localized.
   - Admin labels in Spanish, following the existing content-manager label convention in this
     repo.
2. **`listing`**: add `community` (manyToOne → community, inverse `listings`) and `hideContact`
   (boolean, default false). See contract §5.
3. **`community-member`**: add `community` (manyToOne → community, inverse `members`) and
   `shortDescription` (text, max 200). See contract §6.
4. **New single type `good-practices-page`**, localized, as in contract §7:
   - Add the new component `campaign.campaign-block` (title, description, logo, url, linkLabel).
   - Reuse the guide components the contract names.
5. **`homepage`**: add `regionMapImage` (single media). See contract §8.
6. **Public permissions**: add `find`/`findOne` for `community` and `find` for
   `good-practices-page` in the bootstrap (`src/index.ts`). Extend `tests/bootstrap*` to cover
   them.
7. Regenerate `types/generated/*` with the Strapi build and commit them.

Tests:
- Every schema file matches the contract: fields, relation targets, inverses and localization
  flags. Write this as a test that reads the schema JSON.
- Bootstrap grants the new permissions.
- Slug sync covers `community`.

Report and stop after A1.

## Milestone A2 · Migration script

**Step 0 (schema follow-up from A1 review).** Add `internalLabel` (string, default
`"Good Practices Page"`, not localized, Spanish admin description like the other page single
types) to `good-practices-page`, update the schema test's exact key set, and regenerate
`types/generated/*`. Commit it separately (`feat(good-practices): add internalLabel`).


Create `scripts/migrate-redesign.js`, plus a `migrate:redesign` script in `package.json`.

**Approach**
- Prefer a loaded Strapi instance and the Document Service API (`createStrapi` or
  `compileStrapi`), so locales, draft/publish and relation links are handled correctly.
- If you choose raw SQL instead (like `enrich-recommendations-from-es.js`), explain why in the
  report and support both SQLite and Postgres.

**Safety**
- **Dry-run by default.** `--apply` writes.
- Before any write, the script saves a JSON snapshot of every row it will touch.
- **Idempotent.** A second run changes nothing.
- It prints a summary table: created, updated, skipped, and needs manual review.

**Steps, for both `es-MX` and `en`**
1. **Categories.** Create the 4 contract categories (`experiences`, `gastronomy`, `services`,
   `crafts`) with their labels and order, or update them if they already exist.
   - Keep the legacy category records.
   - Reassign listings with the contract mapping: `sites` and `accommodation` → `experiences`,
     `restaurants` → `gastronomy`, `services` stays.
   - Set `hideContact = true` on every listing whose category ends up as `services`
     (contract §5). Leave every other listing untouched.
   - Do not move anything into `crafts` automatically.
   - Print the listings that are candidates for `crafts` (Artesanías Andrea, Joyas del Mar) as
     "needs manual review", unless `--crafts=<slug,slug>` is given.
2. **Communities.** Create `puerto-agua-verde` and `rancho-san-cosme` with name, slug, color,
   textColor, order and location from the contract.
   - Rancho San Cosme is at `25.5784138, -111.1694027`. Do NOT use `RSC_COORDS` from
     `scripts/import-csv-listings.js`; it points to La Paz.
   - Copy the history milestones and the history text from `guide-page` into both communities
     as starting content.
   - Leave all media empty. The frontend has mock fallbacks.
3. **Listing → community.**
   - Assign each listing's community from the best available source in the repo, such as the
     community data in `import-csv-listings.js` or `import-community.js`, or linked members'
     `locality`.
   - Anything that cannot be resolved goes to "needs manual review".
   - Support `--map=<csv>`, a file with `listingSlug,communitySlug` rows, for manual overrides.
4. **Members.** Set `community` from `locality` (`agua-verde` → `puerto-agua-verde`,
   `rancho-san-cosme` → `rancho-san-cosme`). Keep `locality`.
5. **Artisans group listing.**
   - Create the listing "Artesanas de Puerto Agua Verde" (EN: "Artisans of Puerto Agua Verde")
     in category `crafts`, with community `puerto-agua-verde`.
   - Link every member whose community is `puerto-agua-verde` and whose role or data marks them
     as an artisan. Print the list you linked.
   - It is created as a draft; editors publish it.
6. **Good-practices page.** Create it from the current `guide-page` content (protected area,
   influence, fishing refuge, recommendations and tips) as a draft, only if it does not exist.

Tests (Vitest with SQLite, like `tests/enrich-recommendations.test.*`):
- The dry-run writes nothing.
- `--apply` produces the expected rows, including `hideContact = true` on `services` listings only.
- Relations (`listing.community`, `member.community`) are set in both locales, since Strapi 5
  stores relations per locale.
- A second run is a no-op.
- The snapshot file is written.
- Unresolved listings are reported, not guessed.
- The RSC coordinates are the contract ones.

## Milestone A3 · Phone number fields (after A2 is reviewed)

Contract §5b. Expand only.

1. Add `phoneCountryCode`, `phoneNumber`, `whatsappCountryCode` and `whatsappNumber` to
   `src/components/contact/contact-info.json` with the exact regexes and defaults from §5b.
   Spanish admin descriptions, e.g. "Código de país, por defecto +52" and "10 dígitos, sin
   espacios ni guiones". Mark legacy `phone` and `whatsapp` descriptions as
   "Obsoleto: usar los campos de código y número".
2. Add a content-manager layout so each country code sits next to its number (narrow code,
   wide number), following how this repo configures layouts. If it has no layout
   configuration, skip this and say so in the report.
3. Add a `phones` step to `scripts/migrate-redesign.js` that fills the new fields from the
   legacy ones with the §5b rules, in both locales, for listings and community members.
   Same safety: dry-run by default, snapshot, idempotent, never overwrite non-empty new
   fields, and unparseable values listed as "needs manual review".
4. Regenerate `types/generated/*`.

Tests first:
- Schema test for the 4 fields, including regex and default.
- A test showing Strapi rejects `phoneNumber: "613 123 4567"` and `"61312345"`.
- Parser table tests: `5216131234567`, `526131234567`, `+52 613 123 4567`, `613-123-4567`
  must all give `+52` + `6131234567`. `12345` must go to manual review.
- An idempotency test.

## Milestone report format

End with this report, then stop:

1. Branch and commits (hash and subject)
2. What was done, by milestone and step
3. Command results: tsc, test, build
4. Any contract deviation and its reason
5. For A2: dry-run output on your local data, and the list of manual-review items
