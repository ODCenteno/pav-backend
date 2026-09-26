#!/usr/bin/env node
/**
 * migrate-redesign.js
 *
 * One-shot data migration for the Puerto Agua Verde redesign contract
 * (docs/contracts/redesign-data-contract.md), running inside a loaded Strapi
 * instance and using Strapi's own APIs:
 *
 *   - Document Service (`strapi.documents(uid)`) for every NEW document
 *     (categories, communities, the artisans listing, the good-practices
 *     page): one create in `es-MX`, then one update of the same documentId
 *     with `locale: 'en'`. `status: 'published'` publishes categories and
 *     communities; the artisan listing and the good-practices page are left
 *     as drafts (no `status`), so only draft rows exist for them.
 *   - Query Engine (`strapi.db.query(uid)`) for every EXISTING row
 *     (`listing.category`, `listing.community`, `listing.hideContact`,
 *     `member.community`): each physical row (draft or published, per
 *     locale) is updated in place and linked to the SAME-status,
 *     SAME-locale row of its target, which is how Strapi 5 stores relations
 *     under draft & publish + i18n.
 *
 * This works unmodified on both SQLite (dev) and Postgres/Neon (prod):
 * Strapi's own `strapi.db` picks the dialect from its own config, so this
 * script never talks SQL directly.
 *
 * Steps, mirroring the contract:
 *   1. Categories: create the 4 contract categories (or relabel/reorder the
 *      2 that already exist under their legacy names), reassign listings
 *      per the legacy -> current map (sites/accommodation -> experiences,
 *      restaurants -> gastronomy; `--crafts=<slug,slug>` moves listings into
 *      crafts instead), then set `hideContact = true` on every row of every
 *      listing whose final category is `services`. Every other listing is
 *      left untouched. Services listings not moved into crafts are printed
 *      as manual-review crafts candidates.
 *   2. Communities: create `puerto-agua-verde` and `rancho-san-cosme`
 *      (contract colors/order/coordinates), with history content (header,
 *      milestones, text) duplicated from the guide-page of the SAME locale
 *      and highlights/quick-facts content (section headers + cards, images
 *      kept) duplicated from the homepage of the SAME locale. Communities
 *      that already exist are no longer skipped outright: each of the 4
 *      homepage-content fields is FILLED from the homepage only where
 *      empty, per document and locale with the draft/published variants
 *      considered as a pair — editor content is never overwritten. Because
 *      Strapi 5's Document Service `update` with `status: 'published'`
 *      writes the draft row first and then republishes (the published row
 *      is recreated from the draft), a field that is empty on the
 *      published variant but holds editor content on the draft cannot be
 *      filled without destroying that content: those fields are reported
 *      as manual review and left untouched.
 *   3. Listings -> community: resolved per listing document from (1) a
 *      `--map` CSV override, (2) the embedded LISTING_COMMUNITY table, (3) a
 *      linked member's `locality`. Unresolved listings are reported as
 *      "needs manual review", never guessed.
 *   4. Members -> community: `locality` `agua-verde` -> `puerto-agua-verde`,
 *      `rancho-san-cosme` -> `rancho-san-cosme`. `locality` is kept.
 *   5. Artisans group listing: "Artesanas de Puerto Agua Verde" / "Artisans
 *      of Puerto Agua Verde", category `crafts`, community
 *      `puerto-agua-verde`, created as a DRAFT (both locales) and linked to
 *      every member whose community is `puerto-agua-verde` and whose role
 *      matches /artesan|craft/i. The linked members are printed.
 *   6. Good-practices page: created once, as a DRAFT (both locales), from
 *      the current guide-page content (protected area, influence, fishing
 *      refuge, recommendations, tips). Skipped if it already has rows.
 *   7. Phones: for every listing and community-member contact component,
 *      fill the new phone/whatsapp country-code + number fields from the
 *      legacy free-text values (contract §5b normalization), on every
 *      physical row (draft and published, both locales). Pairs whose new
 *      fields are already filled are never touched; unparseable legacy
 *      values are listed as manual review with the new fields left empty.
 *
 * Safety:
 *   - Dry-run by default (prints the plan, writes nothing); exits 0.
 *   - --apply writes a JSON snapshot of the pre-write state BEFORE any
 *     write, then writes inside a single `strapi.db.transaction`. Exits 0 on
 *     success, non-zero on failure (including a rolled-back transaction).
 *   - Idempotent: a second run finds every category/community/listing/
 *     member already at its target state and reports nothing to do.
 *
 * Usage:
 *   node scripts/migrate-redesign.js                          # dry-run
 *   node scripts/migrate-redesign.js --apply                  # writes
 *   node scripts/migrate-redesign.js --db /path/to/data.db     # sqlite target
 *   node scripts/migrate-redesign.js --map=overrides.csv      # listingSlug,communitySlug
 *   node scripts/migrate-redesign.js --crafts=slug-a,slug-b   # move into crafts
 *   # PostgreSQL: DATABASE_CLIENT=postgres DATABASE_URL=... (as usual for this app)
 */

const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['es-MX', 'en'];
const [DEFAULT_LOCALE, SECOND_LOCALE] = LOCALES;

const UID = {
  category: 'api::category.category',
  listing: 'api::listing.listing',
  community: 'api::community.community',
  member: 'api::community-member.community-member',
  goodPractices: 'api::good-practices-page.good-practices-page',
  guidePage: 'api::guide-page.guide-page',
  homepage: 'api::homepage.homepage',
};

// Contract §1. Order matters; labels are per locale.
const CATEGORY_CONTRACT = [
  {
    slug: 'experiences',
    order: 1,
    name: { 'es-MX': 'Experiencias turísticas comunitarias', en: 'Community tourism experiences' },
  },
  {
    slug: 'gastronomy',
    order: 2,
    name: { 'es-MX': 'Gastronomía regional', en: 'Regional gastronomy' },
  },
  { slug: 'services', order: 3, name: { 'es-MX': 'Servicios', en: 'Services' } },
  {
    slug: 'crafts',
    order: 4,
    name: { 'es-MX': 'Artesanías y productos locales', en: 'Crafts and local products' },
  },
];

// Contract §1 legacy -> current mapping.
const LEGACY_CATEGORY_TARGET = {
  sites: 'experiences',
  accommodation: 'experiences',
  restaurants: 'gastronomy',
};

// Fallback when the legacy `restaurants` category carries no color.
const GASTRONOMY_COLOR_FALLBACK = '#F5A623';

// Contract §1: crafts category color chosen by RED.
const CRAFTS_COLOR = '#B59BD9';

// Contract §2 coordinates. HARD RULE: these are the contract values. Do NOT
// reuse RSC_COORDS from scripts/import-csv-listings.js — that value
// (24.16315, -110.3384) points at La Paz, not at the hamlet.
const PAV_COORDS = { lat: 25.51204, lng: -111.07577 };
const RSC_COORDS = { lat: 25.5784138, lng: -111.1694027 };

const COMMUNITY_CONTRACT = [
  {
    slug: 'puerto-agua-verde',
    name: 'Puerto Agua Verde',
    order: 1,
    color: '#0CA58C',
    textColor: '#08806D',
    coords: PAV_COORDS,
  },
  {
    slug: 'rancho-san-cosme',
    name: 'Rancho San Cosme',
    order: 2,
    color: '#EC6E0B',
    textColor: '#B85206',
    coords: RSC_COORDS,
  },
];

// Contract §6 locality -> community mapping (locality column is kept).
const LOCALITY_TO_COMMUNITY = {
  'agua-verde': 'puerto-agua-verde',
  'rancho-san-cosme': 'rancho-san-cosme',
};

// Homepage-content fields copied onto communities (Step 2). The two
// *Header fields are single section-header components; the other two are
// repeatable cards.
const COMMUNITY_CONTENT_FIELDS = ['highlightsHeader', 'highlights', 'quickFactsHeader', 'quickFacts'];

// Embedded listing -> community assignment, distilled from the import data
// in scripts/import-csv-listings.js. Overridden by --map.
const LISTING_COMMUNITY = {
  'restaurante-brisa-del-mar': 'puerto-agua-verde',
  'restaurante-puerto-bello': 'puerto-agua-verde',
  'restaurante-faro-san-marcial': 'puerto-agua-verde',
  'museo-la-concha': 'rancho-san-cosme',
  'artesanias-joyas-del-mar': 'rancho-san-cosme',
  'restaurante-el-arriero-del-mar': 'rancho-san-cosme',
  'artesanias-andrea': 'rancho-san-cosme',
  'romero-tours-cabalgata-en-mula': 'rancho-san-cosme',
  'restaurante-rancho-san-cosme': 'rancho-san-cosme',
};

// Known artisan listings to surface as crafts candidates (brief A2).
const KNOWN_CRAFTS_CANDIDATES = ['artesanias-andrea', 'artesanias-joyas-del-mar'];

const ARTISAN_LISTING = {
  slug: 'artesanas-de-puerto-agua-verde',
  title: { 'es-MX': 'Artesanas de Puerto Agua Verde', en: 'Artisans of Puerto Agua Verde' },
  categorySlug: 'crafts',
  communitySlug: 'puerto-agua-verde',
};
const ARTISAN_ROLE_RE = /artesan|craft/i;

const GOOD_PRACTICES_LABEL = 'Good Practices Page';

// Contract §5b phone validation (also enforced by contact-info schema regexes).
const PHONE_COUNTRY_CODE_REGEX = /^\+[1-9]\d{0,2}$/;
const PHONE_NUMBER_REGEX = /^\d{10}$/;

// Query Engine UID of the shared contact-info component. NOTE: in Strapi 5
// the Query Engine registers components under their API UID, not their
// table name ('components_contact_contact_infos' throws "Model not found").
const CONTACT_COMPONENT_UID = 'contact.contact-info';

// The two independent phone pairs of the contact-info component.
const PHONE_PAIRS = [
  { kind: 'phone', legacyField: 'phone', countryCodeField: 'phoneCountryCode', numberField: 'phoneNumber' },
  { kind: 'whatsapp', legacyField: 'whatsapp', countryCodeField: 'whatsappCountryCode', numberField: 'whatsappNumber' },
];

/**
 * Normalize a legacy free-text phone/whatsapp value (contract §5b):
 * strip to digits, then 13 digits starting with '521' or 12 digits starting
 * with '52' become '+52' + the last 10 digits, 10 digits become '+52' +
 * those digits. Returns null for anything unparseable (manual review) or
 * empty (caller treats empty legacy as "nothing to do").
 */
function normalizeLegacyPhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('521')) {
    return { countryCode: '+52', number: digits.slice(-10) };
  }
  if (digits.length === 12 && digits.startsWith('52')) {
    return { countryCode: '+52', number: digits.slice(-10) };
  }
  if (digits.length === 10) {
    return { countryCode: '+52', number: digits };
  }
  return null;
}

// ---- Strapi runtime -----------------------------------------------------

/**
 * Boot a loaded Strapi instance (register + bootstrap, no HTTP server).
 * Compiles the TS project to `dist/` first when it is missing — the script
 * itself normally runs after `pnpm build`-adjacent tooling has produced
 * `dist/`, but callers (like the test suite, which runs BEFORE `pnpm build`
 * in CI) may need this to compile on demand.
 */
async function loadStrapiInstance({ dbPath, appDir = process.cwd() } = {}) {
  if (dbPath) process.env.DATABASE_FILENAME = dbPath;
  // Required lazily: keeping it out of the top-level scope means unit tests
  // that only exercise planning/formatting helpers never need to boot Strapi.
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  let distDir = path.join(appDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'src'))) {
    const compiled = await compileStrapi({ appDir });
    distDir = compiled.distDir;
  }
  const app = await createStrapi({ appDir, distDir }).load();
  return app;
}

async function closeStrapiInstance(app) {
  if (!app) return;
  await app.destroy();
  // `createStrapi()` installs its own SIGTERM/SIGINT handlers that call
  // `strapi.destroy()` again and then `process.exit()`. When the caller
  // (the CLI, or a test's afterAll) already destroyed this instance, a
  // later signal — e.g. a test runner ending its worker process — would
  // otherwise trigger a double-destroy and an abrupt, unhandled exit.
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
}

// ---- Small helpers --------------------------------------------------------

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/** Index of {slug -> [{ id, locale, draft }]} rebuilt from a fresh DB read. */
async function reindexRows(strapi, uid) {
  const rows = await strapi.db.query(uid).findMany({ select: ['id', 'slug', 'locale', 'publishedAt'] });
  const idx = new Map();
  for (const r of rows) {
    const key = `${r.slug}:${r.locale}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ id: r.id, draft: r.publishedAt == null });
  }
  return idx;
}

/** Draft row preferred for new (unpublished) rows; published preferred for published targets. */
function resolveRow(idx, slug, locale, preferDraft) {
  const list = idx.get(`${slug}:${locale}`) || [];
  if (list.length === 0) return null;
  return (preferDraft ? list.find((r) => r.draft) : list.find((r) => !r.draft)) || list[0];
}

/**
 * Homepage highlights/quick-facts content, mapped for Document Service
 * writes: section headers as { title, subtitle }, highlight cards with the
 * image kept as the upload-file id, quick facts as { title, value,
 * description }. Returns null headers / empty arrays when the homepage (or
 * the field) has nothing, so callers can treat "no source" uniformly.
 */
function homepageContent(homepage) {
  if (!homepage) return { highlightsHeader: null, highlights: [], quickFactsHeader: null, quickFacts: [] };
  return {
    highlightsHeader: homepage.highlightsHeader
      ? { title: homepage.highlightsHeader.title, subtitle: homepage.highlightsHeader.subtitle ?? null }
      : null,
    highlights: (homepage.highlights ?? []).map((x) => ({
      title: x.title,
      description: x.description ?? null,
      image: x.image?.id ?? null,
      link: x.link ?? null,
    })),
    quickFactsHeader: homepage.quickFactsHeader
      ? { title: homepage.quickFactsHeader.title, subtitle: homepage.quickFactsHeader.subtitle ?? null }
      : null,
    quickFacts: (homepage.quickFacts ?? []).map((x) => ({
      title: x.title,
      value: x.value,
      description: x.description ?? null,
    })),
  };
}

// ---- Planner ----------------------------------------------------------------

async function planMigration(strapi, opts = {}) {
  const { mapOverrides = {}, craftsSlugs = [] } = opts;

  const plan = {
    now: new Date().toISOString(),
    categories: { createDocs: [], updateRows: [], skippedRows: [] },
    listingCategory: { moves: [], keptRows: 0 },
    hideContact: { rows: [], alreadyHidden: 0 },
    communities: { createDocs: [], skippedSlugs: [] },
    communityContent: { fills: [], alreadyFilled: 0, noSource: 0, manualReview: [] },
    listingCommunity: { links: [], existingPairs: 0, unresolved: [] },
    memberCommunity: { links: [], existingPairs: 0, noLocality: [] },
    phones: { updates: [], alreadyFilled: 0, noContact: 0, emptyLegacy: 0, manualReview: [] },
    artisan: { create: null, skipped: false, memberLinks: [], linkedMembers: [] },
    goodPractices: { create: null, skipped: false },
    craftsCandidates: [],
    craftsColorNote: false,
    warnings: [],
    snapshot: { touches: [], newDocuments: [] },
  };

  // ---- Step 1 · Categories -------------------------------------------------

  const catRows = await strapi.db.query(UID.category).findMany({
    select: ['id', 'documentId', 'slug', 'name', 'color', 'order', 'locale', 'publishedAt'],
  });
  const catsBySlug = groupBy(catRows, (r) => r.slug);

  const restaurantsRow = (catsBySlug.get('restaurants') || []).find((r) => r.color);
  const gastronomyColor = (restaurantsRow && restaurantsRow.color) || GASTRONOMY_COLOR_FALLBACK;

  for (const c of CATEGORY_CONTRACT) {
    const rows = catsBySlug.get(c.slug) || [];
    if (rows.length === 0) {
      plan.categories.createDocs.push({
        slug: c.slug,
        order: c.order,
        color: c.slug === 'gastronomy' ? gastronomyColor : c.slug === 'crafts' ? CRAFTS_COLOR : null,
        name: c.name,
      });
      plan.snapshot.newDocuments.push({ uid: UID.category, slug: c.slug });
    } else {
      for (const row of rows) {
        const desiredName = c.name[row.locale] ?? c.name[DEFAULT_LOCALE];
        if (row.name === desiredName && Number(row.order) === c.order) {
          plan.categories.skippedRows.push({ id: row.id, slug: row.slug, locale: row.locale });
        } else {
          plan.categories.updateRows.push({
            id: row.id,
            slug: row.slug,
            locale: row.locale,
            oldName: row.name,
            oldOrder: row.order,
            name: desiredName,
            order: c.order,
          });
          plan.snapshot.touches.push({
            uid: UID.category,
            id: row.id,
            slug: row.slug,
            locale: row.locale,
            field: 'name/order',
            before: { name: row.name, order: row.order },
          });
        }
      }
    }
  }

  const craftsRows = catsBySlug.get('crafts') || [];
  // Only existing crafts rows can lack a color: new ones get CRAFTS_COLOR.
  plan.craftsColorNote = craftsRows.length > 0 && craftsRows.every((r) => !r.color);

  // ---- Listings + current category -------------------------------------

  // Rows without a locale are corrupt (the Document Service cannot reach them
  // and there is no same-locale target to link): report them, never plan them.
  for (const uid of [UID.listing, UID.member]) {
    const orphans = await strapi.db.query(uid).findMany({
      select: ['id', 'slug'],
      where: { locale: { $null: true } },
    });
    for (const r of orphans) {
      plan.warnings.push(`${uid.split('.').pop()} row #${r.id} (${r.slug}) has no locale: corrupt row without a locale, skipped; remove it manually`);
    }
  }

  const listingRows = await strapi.db.query(UID.listing).findMany({
    where: { locale: { $notNull: true } },
    select: ['id', 'documentId', 'slug', 'locale', 'publishedAt', 'hideContact'],
    populate: {
      category: { select: ['id', 'slug', 'locale', 'publishedAt'] },
      community: { select: ['id', 'slug'] },
      contact: true,
    },
    orderBy: { id: 'asc' },
  });
  const listingsByDoc = groupBy(listingRows, (r) => r.documentId);

  // Category links per listing row, straight from the join table. Real data has
  // draft rows linked to PUBLISHED category rows (or to two rows at once); the
  // Document Service cannot resolve those, so they are re-linked in place.
  const categoryJoin = strapi.db.metadata.get(UID.listing).attributes.category.joinTable;
  const linkCounts = new Map(
    (
      await strapi.db
        .connection(categoryJoin.name)
        .select(categoryJoin.joinColumn.name)
        .count('* as n')
        .groupBy(categoryJoin.joinColumn.name)
    ).map((r) => [Number(r[categoryJoin.joinColumn.name]), Number(r.n)])
  );
  const isAligned = (row) =>
    Boolean(row.category) &&
    row.category.locale === row.locale &&
    (row.category.publishedAt == null) === (row.publishedAt == null) &&
    linkCounts.get(row.id) === 1;

  const movesByRowId = new Map();
  for (const [, rows] of listingsByDoc) {
    const docSlug = rows[0].slug;
    const craftsOverride = craftsSlugs.includes(docSlug);
    // Category a row without one inherits: the mapped category of a sibling row
    // (same document), preferring es-MX. Real data has EN rows never linked.
    const siblingWithCategory =
      rows.find((r) => r.category && r.locale === DEFAULT_LOCALE) || rows.find((r) => r.category);
    const inheritedSlug = siblingWithCategory
      ? LEGACY_CATEGORY_TARGET[siblingWithCategory.category.slug] || siblingWithCategory.category.slug
      : null;
    for (const row of rows) {
      const currentSlug = row.category ? row.category.slug : null;
      let targetSlug = null;
      let fromSlug = null;
      if (craftsOverride) {
        if (currentSlug !== 'crafts') {
          targetSlug = 'crafts';
          fromSlug = currentSlug;
        }
      } else if (currentSlug && LEGACY_CATEGORY_TARGET[currentSlug]) {
        targetSlug = LEGACY_CATEGORY_TARGET[currentSlug];
        fromSlug = currentSlug;
      } else if (!currentSlug && inheritedSlug) {
        targetSlug = inheritedSlug;
      } else if (currentSlug && !isAligned(row)) {
        targetSlug = currentSlug;
        fromSlug = currentSlug;
      }
      if (!targetSlug) {
        plan.listingCategory.keptRows++;
        continue;
      }
      const isDraft = row.publishedAt == null;
      const move = { listingRowId: row.id, slug: docSlug, locale: row.locale, isDraft, fromSlug, targetSlug };
      plan.listingCategory.moves.push(move);
      movesByRowId.set(row.id, move);
      plan.snapshot.touches.push({
        uid: UID.listing,
        id: row.id,
        slug: docSlug,
        locale: row.locale,
        field: 'category',
        before: currentSlug,
      });
    }
  }

  // Final category slug per document (after the virtual moves above).
  const finalSlugsByDoc = new Map();
  for (const [docId, rows] of listingsByDoc) {
    const finals = new Set();
    for (const row of rows) {
      const move = movesByRowId.get(row.id);
      finals.add(move ? move.targetSlug : row.category ? row.category.slug : null);
    }
    finalSlugsByDoc.set(docId, finals);
  }

  // hideContact AFTER all category moves: services docs only, ALL their rows.
  for (const [docId, rows] of listingsByDoc) {
    if (!finalSlugsByDoc.get(docId).has('services')) continue;
    for (const row of rows) {
      if (row.hideContact) {
        plan.hideContact.alreadyHidden++;
      } else {
        plan.hideContact.rows.push({ id: row.id, slug: rows[0].slug, locale: row.locale });
        plan.snapshot.touches.push({
          uid: UID.listing,
          id: row.id,
          slug: rows[0].slug,
          locale: row.locale,
          field: 'hideContact',
          before: false,
        });
      }
    }
  }

  // Manual review: every services listing not moved into crafts.
  const craftsCandidates = [];
  for (const [docId, rows] of listingsByDoc) {
    if (!finalSlugsByDoc.get(docId).has('services')) continue;
    const slug = rows[0].slug;
    if (craftsSlugs.includes(slug)) continue;
    craftsCandidates.push({ slug, known: KNOWN_CRAFTS_CANDIDATES.includes(slug) });
  }
  craftsCandidates.sort((a, b) => Number(b.known) - Number(a.known) || a.slug.localeCompare(b.slug));
  plan.craftsCandidates = craftsCandidates;

  // ---- Step 2 · Communities -------------------------------------------------

  const commRows = await strapi.db.query(UID.community).findMany({
    select: ['id', 'documentId', 'slug', 'locale', 'publishedAt'],
  });
  const commBySlug = groupBy(commRows, (r) => r.slug);

  const guideByLocale = new Map();
  for (const locale of LOCALES) {
    const rows = await strapi.db.query(UID.guidePage).findMany({
      where: { locale },
      select: ['id', 'historyText', 'influenceText', 'fishingText', 'drivingTipsHeader', 'publishedAt'],
      populate: {
        historyHeader: true,
        historyMilestones: true,
        influenceHeader: true,
        fishingHeader: true,
        recommendationsHeader: true,
        fishingRules: true,
        recommendations: true,
        drivingTips: true,
        protectedArea: true,
      },
    });
    guideByLocale.set(locale, rows.find((r) => r.publishedAt != null) || rows[0] || null);
  }

  // Homepage per locale (the Step 2 content source for communities), same
  // pattern as the guide-page: prefer the published row, fall back to the
  // draft, else null. Highlight images are populated so their file ids can
  // be re-linked on the community copies ("images kept").
  const homepageByLocale = new Map();
  for (const locale of LOCALES) {
    const rows = await strapi.db.query(UID.homepage).findMany({
      where: { locale },
      populate: {
        highlightsHeader: true,
        highlights: { populate: { image: true } },
        quickFactsHeader: true,
        quickFacts: true,
      },
    });
    homepageByLocale.set(locale, rows.find((r) => r.publishedAt != null) || rows[0] || null);
  }

  for (const c of COMMUNITY_CONTRACT) {
    if ((commBySlug.get(c.slug) || []).length > 0) {
      plan.communities.skippedSlugs.push(c.slug);

      // Existing community: fill homepage content ONLY where empty, per
      // document and locale, with the draft/published variants considered
      // as a pair (component values live on each physical row, so the
      // variants are re-read with their components populated). A
      // status 'published' update in Strapi 5 writes the draft first and
      // republishes, so:
      //   - both variants empty            -> one fill, status 'published'
      //   - draft empty, published filled  -> fill, status 'draft' only
      //   - published empty, draft filled  -> manual review, never written
      const variantsByDoc = groupBy(
        await strapi.db.query(UID.community).findMany({
          where: { slug: c.slug },
          populate: { highlightsHeader: true, highlights: true, quickFactsHeader: true, quickFacts: true },
        }),
        (r) => r.documentId
      );
      for (const [documentId, docRows] of variantsByDoc) {
        const docLocales = [...new Set(docRows.map((r) => r.locale).filter(Boolean))];
        for (const locale of docLocales) {
          const source = homepageContent(homepageByLocale.get(locale));
          const draftRow = docRows.find((r) => r.locale === locale && r.publishedAt == null) ?? null;
          const pubRow = docRows.find((r) => r.locale === locale && r.publishedAt != null) ?? null;
          for (const field of COMMUNITY_CONTENT_FIELDS) {
            const fieldIsEmpty = (row) => {
              if (!row) return false; // absent variant: nothing to fill there
              const v = row[field];
              if (v == null) return true;
              return Array.isArray(v) && v.length === 0;
            };
            const src = source[field];
            const srcHasContent = Array.isArray(src) ? src.length > 0 : src != null;
            const draftEmpty = fieldIsEmpty(draftRow);
            const pubEmpty = fieldIsEmpty(pubRow);
            if (!draftEmpty && !pubEmpty) {
              plan.communityContent.alreadyFilled++;
              continue;
            }
            if (!srcHasContent) {
              plan.communityContent.noSource++;
              continue;
            }
            const blocked = (reason) => {
              plan.communityContent.manualReview.push({ documentId, slug: c.slug, locale, field, reason });
            };
            if (draftRow && pubRow && draftEmpty && pubEmpty) {
              plan.communityContent.fills.push({
                documentId,
                slug: c.slug,
                locale,
                status: 'published',
                field,
                data: src,
              });
              for (const row of [draftRow, pubRow]) {
                plan.snapshot.touches.push({
                  uid: UID.community,
                  id: row.id,
                  slug: c.slug,
                  locale,
                  field: `content.${field}`,
                  before: '<empty>',
                });
              }
            } else if (draftRow && draftEmpty && (!pubRow || !pubEmpty)) {
              // Draft empty while the published variant keeps editor
              // content (or does not exist): write the draft only, never
              // publish, so the published row is left as the editor set it.
              plan.communityContent.fills.push({
                documentId,
                slug: c.slug,
                locale,
                status: 'draft',
                field,
                data: src,
              });
              plan.snapshot.touches.push({
                uid: UID.community,
                id: draftRow.id,
                slug: c.slug,
                locale,
                field: `content.${field}`,
                before: '<empty>',
              });
            } else if (!draftRow) {
              blocked('no draft variant row; the Document Service updates drafts, refusing to write');
            } else {
              blocked('draft variant has editor content; filling the published variant would overwrite it');
            }
          }
        }
      }
      continue;
    }
    const perLocale = {};
    for (const locale of LOCALES) {
      const guide = guideByLocale.get(locale);
      perLocale[locale] = {
        historyText: guide ? guide.historyText : null,
        historyHeader: guide && guide.historyHeader
          ? { title: guide.historyHeader.title, subtitle: guide.historyHeader.subtitle ?? null }
          : null,
        historyMilestones: guide
          ? guide.historyMilestones.map((m) => ({ year: m.year, text: m.text }))
          : [],
        // Homepage highlights/quick-facts copy (null/[] when the homepage
        // lacks them; buildCommunityData omits empty keys).
        ...homepageContent(homepageByLocale.get(locale)),
      };
    }
    plan.communities.createDocs.push({
      slug: c.slug,
      name: c.name,
      order: c.order,
      color: c.color,
      textColor: c.textColor,
      coords: c.coords,
      perLocale,
    });
    plan.snapshot.newDocuments.push({ uid: UID.community, slug: c.slug });
  }
  const communitySlugsPlanned = new Set(plan.communities.createDocs.map((d) => d.slug));

  // ---- Step 3 · Listings -> community ---------------------------------------

  const memberRows = await strapi.db.query(UID.member).findMany({
    where: { locale: { $notNull: true } },
    select: ['id', 'documentId', 'slug', 'name', 'locale', 'locality', 'role', 'publishedAt'],
    populate: { listings: { select: ['id'] }, community: { select: ['id', 'slug'] }, contact: true },
    orderBy: { id: 'asc' },
  });

  const localityByListingRowId = new Map();
  for (const m of memberRows) {
    if (!m.locality || !LOCALITY_TO_COMMUNITY[m.locality]) continue;
    for (const l of m.listings || []) {
      if (!localityByListingRowId.has(l.id)) localityByListingRowId.set(l.id, m.locality);
    }
  }

  const communityAvailable = (slug) => (commBySlug.get(slug) || []).length > 0 || communitySlugsPlanned.has(slug);

  for (const [, rows] of listingsByDoc) {
    const slug = rows[0].slug;
    let communitySlug = null;
    let source = null;
    if (Object.prototype.hasOwnProperty.call(mapOverrides, slug)) {
      communitySlug = mapOverrides[slug];
      source = '--map override';
    } else if (Object.prototype.hasOwnProperty.call(LISTING_COMMUNITY, slug)) {
      communitySlug = LISTING_COMMUNITY[slug];
      source = 'embedded table';
    } else {
      for (const row of rows) {
        const loc = localityByListingRowId.get(row.id);
        if (loc) {
          communitySlug = LOCALITY_TO_COMMUNITY[loc];
          source = `member locality (${loc})`;
          break;
        }
      }
    }
    if (!communitySlug) {
      plan.listingCommunity.unresolved.push({
        kind: 'listing->community',
        slug,
        reason: 'no source resolved (--map, embedded table, member locality)',
      });
      continue;
    }
    for (const row of rows) {
      const currentSlug = row.community ? row.community.slug : null;
      if (currentSlug === communitySlug) {
        plan.listingCommunity.existingPairs++;
        continue;
      }
      if (!communityAvailable(communitySlug)) {
        plan.warnings.push(
          `no ${communitySlug} community row for locale ${row.locale}; listing ${slug} row #${row.id} left unlinked`
        );
        continue;
      }
      const isDraft = row.publishedAt == null;
      plan.listingCommunity.links.push({
        listingRowId: row.id,
        slug,
        locale: row.locale,
        isDraft,
        communitySlug,
        source,
      });
      plan.snapshot.touches.push({
        uid: UID.listing,
        id: row.id,
        slug,
        locale: row.locale,
        field: 'community',
        before: currentSlug,
      });
    }
  }

  // ---- Step 4 · Members -> community -----------------------------------------

  const noLocalitySlugs = new Set();
  for (const m of memberRows) {
    const currentSlug = m.community ? m.community.slug : null;
    if (!m.locality) {
      if (!noLocalitySlugs.has(m.slug)) {
        noLocalitySlugs.add(m.slug);
        plan.memberCommunity.noLocality.push({ slug: m.slug, reason: 'locality is empty' });
      }
      continue;
    }
    const communitySlug = LOCALITY_TO_COMMUNITY[m.locality];
    if (!communitySlug) {
      if (!noLocalitySlugs.has(m.slug)) {
        noLocalitySlugs.add(m.slug);
        plan.memberCommunity.noLocality.push({ slug: m.slug, reason: `unknown locality '${m.locality}'` });
      }
      continue;
    }
    if (currentSlug === communitySlug) {
      plan.memberCommunity.existingPairs++;
      continue;
    }
    if (!communityAvailable(communitySlug)) {
      plan.warnings.push(
        `no ${communitySlug} community row for locale ${m.locale}; member ${m.slug} row #${m.id} left unlinked`
      );
      continue;
    }
    const isDraft = m.publishedAt == null;
    plan.memberCommunity.links.push({ memberRowId: m.id, slug: m.slug, locale: m.locale, isDraft, communitySlug });
    plan.snapshot.touches.push({
      uid: UID.member,
      id: m.id,
      slug: m.slug,
      locale: m.locale,
      field: 'community',
      before: currentSlug,
    });
  }

  // ---- Step 7 · Phones (contact component, contract §5b) ---------------------
  //
  // Each physical row (draft/published, per locale) of every listing and
  // member is considered, for the phone pair and the whatsapp pair
  // independently. A pair's target counts as "already filled" when the
  // national NUMBER is set, or when the country code holds anything other
  // than the '+52' default: the Document Service persists the schema
  // default ('+52') into both country-code columns on every create, so a
  // lone '+52' next to an empty number is the default, not human data —
  // and '+52' is the only country code this step ever writes, so filling
  // such a pair destroys nothing. Anything else is left untouched
  // (contract: never overwrite).

  const isNonEmpty = (v) => v != null && String(v).trim() !== '';

  const planPhonesForRow = (uid, row) => {
    const contact = row.contact;
    if (!contact) {
      plan.phones.noContact++;
      return;
    }
    const isDraft = row.publishedAt == null;
    for (const pair of PHONE_PAIRS) {
      const countryCode = contact[pair.countryCodeField];
      const number = contact[pair.numberField];
      if (isNonEmpty(number) || (isNonEmpty(countryCode) && countryCode !== '+52')) {
        plan.phones.alreadyFilled++;
        continue;
      }
      const legacy = contact[pair.legacyField];
      if (!isNonEmpty(legacy)) {
        plan.phones.emptyLegacy++;
        continue;
      }
      const parsed = normalizeLegacyPhone(legacy);
      if (!parsed) {
        plan.phones.manualReview.push({ uid, kind: pair.kind, slug: row.slug, locale: row.locale, isDraft, value: legacy });
        continue;
      }
      plan.phones.updates.push({
        componentRowId: contact.id,
        uid,
        slug: row.slug,
        locale: row.locale,
        isDraft,
        kind: pair.kind,
        countryCode: parsed.countryCode,
        number: parsed.number,
        legacyValue: String(legacy),
      });
      plan.snapshot.touches.push({
        uid,
        id: row.id,
        slug: row.slug,
        locale: row.locale,
        field: `contact.${pair.kind}`,
        before: { countryCode: countryCode ?? null, number: number ?? null },
      });
    }
  };

  for (const row of listingRows) planPhonesForRow(UID.listing, row);
  for (const m of memberRows) planPhonesForRow(UID.member, m);

  // ---- Step 5 · Artisans group listing ---------------------------------------

  const artisanExists = listingRows.some((r) => r.slug === ARTISAN_LISTING.slug);
  if (artisanExists) {
    plan.artisan.skipped = true;
  } else {
    plan.artisan.create = { slug: ARTISAN_LISTING.slug, title: ARTISAN_LISTING.title };
    plan.snapshot.newDocuments.push({ uid: UID.listing, slug: ARTISAN_LISTING.slug });
    const membersByDoc = groupBy(memberRows, (m) => m.documentId);
    for (const [, mrows] of membersByDoc) {
      const communitySlugs = new Set(
        mrows.map((r) => r.locality).filter(Boolean).map((l) => LOCALITY_TO_COMMUNITY[l]).filter(Boolean)
      );
      const roleMatch = mrows.some((r) => r.role && ARTISAN_ROLE_RE.test(r.role));
      if (!communitySlugs.has(ARTISAN_LISTING.communitySlug) || !roleMatch) continue;
      for (const m of mrows) {
        plan.artisan.memberLinks.push({ memberRowId: m.id, locale: m.locale, name: m.name, slug: m.slug });
      }
      plan.artisan.linkedMembers.push({ name: mrows[0].name, slug: mrows[0].slug });
    }
  }

  // --crafts / --map entries pointing at nothing: warn (likely a typo).
  const knownListingSlugs = new Set(listingRows.map((r) => r.slug));
  for (const s of craftsSlugs) {
    if (!knownListingSlugs.has(s)) plan.warnings.push(`--crafts slug '${s}' matches no listing document`);
  }
  for (const slug of Object.keys(mapOverrides)) {
    if (!knownListingSlugs.has(slug)) plan.warnings.push(`--map slug '${slug}' matches no listing document`);
  }

  // ---- Step 6 · Good-practices page ------------------------------------------

  const gpRows = await strapi.db.query(UID.goodPractices).findMany({ select: ['id'] });
  if (gpRows.length > 0) {
    plan.goodPractices.skipped = true;
  } else {
    const perLocale = {};
    for (const locale of LOCALES) {
      const guide = guideByLocale.get(locale);
      perLocale[locale] = {
        influenceText: guide ? guide.influenceText : null,
        fishingText: guide ? guide.fishingText : null,
        protectedArea: guide && guide.protectedArea
          ? {
              title: guide.protectedArea.title,
              text: guide.protectedArea.text,
              linkLabel: guide.protectedArea.linkLabel,
              linkHref: guide.protectedArea.linkHref,
            }
          : null,
        influenceHeader: guide && guide.influenceHeader
          ? { title: guide.influenceHeader.title, subtitle: guide.influenceHeader.subtitle ?? null }
          : null,
        fishingHeader: guide && guide.fishingHeader
          ? { title: guide.fishingHeader.title, subtitle: guide.fishingHeader.subtitle ?? null }
          : null,
        recommendationsHeader: guide && guide.recommendationsHeader
          ? { title: guide.recommendationsHeader.title, subtitle: guide.recommendationsHeader.subtitle ?? null }
          : null,
        fishingRules: guide ? guide.fishingRules.map((r) => r.text) : [],
        recommendations: guide ? guide.recommendations.map((r) => r.text) : [],
        tipsHeader: guide && guide.drivingTipsHeader != null ? { title: guide.drivingTipsHeader, subtitle: null } : null,
        tips: guide ? guide.drivingTips.map((r) => r.text) : [],
      };
    }
    plan.goodPractices.create = { perLocale };
    plan.snapshot.newDocuments.push({ uid: UID.goodPractices, slug: 'good-practices-page' });
  }

  return plan;
}

const planHasWork = (plan) =>
  plan.categories.createDocs.length > 0 ||
  plan.categories.updateRows.length > 0 ||
  plan.listingCategory.moves.length > 0 ||
  plan.hideContact.rows.length > 0 ||
  plan.communities.createDocs.length > 0 ||
  plan.communityContent.fills.length > 0 ||
  plan.listingCommunity.links.length > 0 ||
  plan.memberCommunity.links.length > 0 ||
  plan.artisan.create !== null ||
  plan.goodPractices.create !== null ||
  plan.phones.updates.length > 0;

// ---- Snapshot ----------------------------------------------------------------

function buildSnapshot(plan) {
  return {
    generatedAt: new Date().toISOString(),
    script: 'migrate-redesign.js',
    preState: plan.snapshot.touches,
    newDocuments: plan.snapshot.newDocuments,
    planned: {
      categoriesCreated: plan.categories.createDocs.map((d) => d.slug),
      categoriesUpdated: plan.categories.updateRows.length,
      listingCategoryMoves: plan.listingCategory.moves.length,
      hideContactRows: plan.hideContact.rows.length,
      communitiesCreated: plan.communities.createDocs.map((d) => d.slug),
      communityContentFills: plan.communityContent.fills.length,
      listingCommunityLinks: plan.listingCommunity.links.length,
      memberCommunityLinks: plan.memberCommunity.links.length,
      artisanListingCreated: plan.artisan.create ? plan.artisan.create.slug : null,
      goodPracticesPageCreated: plan.goodPractices.create !== null,
      phonesRows: plan.phones.updates.length,
    },
  };
}

// ---- Data builders for Document Service creates ------------------------------

function buildCommunityData(doc, locale) {
  const loc = doc.perLocale[locale];
  const data = {
    name: doc.name,
    slug: doc.slug,
    order: doc.order,
    color: doc.color,
    textColor: doc.textColor,
    location: { geoPoint: { lat: doc.coords.lat, lng: doc.coords.lng } },
    historyText: loc.historyText,
    historyMilestones: loc.historyMilestones,
  };
  if (loc.historyHeader) data.historyHeader = loc.historyHeader;
  // Homepage content: only include keys that carry content (mirroring
  // historyHeader), so an empty homepage never forces the Document Service
  // to clear or create empty component rows.
  if (loc.highlightsHeader) data.highlightsHeader = loc.highlightsHeader;
  if (loc.highlights && loc.highlights.length > 0) data.highlights = loc.highlights;
  if (loc.quickFactsHeader) data.quickFactsHeader = loc.quickFactsHeader;
  if (loc.quickFacts && loc.quickFacts.length > 0) data.quickFacts = loc.quickFacts;
  return data;
}

function buildGoodPracticesData(loc) {
  const data = {
    internalLabel: GOOD_PRACTICES_LABEL,
    influenceText: loc.influenceText,
    fishingText: loc.fishingText,
    fishingRules: loc.fishingRules.map((text) => ({ text })),
    recommendations: loc.recommendations.map((text) => ({ text })),
    tips: loc.tips.map((text) => ({ text })),
  };
  if (loc.protectedArea) data.protectedArea = loc.protectedArea;
  if (loc.influenceHeader) data.influenceHeader = loc.influenceHeader;
  if (loc.fishingHeader) data.fishingHeader = loc.fishingHeader;
  if (loc.recommendationsHeader) data.recommendationsHeader = loc.recommendationsHeader;
  if (loc.tipsHeader) data.tipsHeader = loc.tipsHeader;
  return data;
}

// ---- Apply ---------------------------------------------------------------------

async function applyMigration(strapi, plan, opts = {}) {
  const { snapshotPath } = opts;
  if (snapshotPath) {
    const snap = buildSnapshot(plan);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snap, null, 2)}\n`);
  }

  const totals = {
    categoriesCreated: plan.categories.createDocs.length * LOCALES.length,
    categoriesUpdated: plan.categories.updateRows.length,
    listingRowsRelinked: plan.listingCategory.moves.length,
    hideContactRows: plan.hideContact.rows.length,
    communitiesCreated: plan.communities.createDocs.length * LOCALES.length,
    communityContentFills: plan.communityContent.fills.length,
    listingCommunityLinks: plan.listingCommunity.links.length,
    memberCommunityLinks: plan.memberCommunity.links.length,
    artisanRows: plan.artisan.create ? LOCALES.length : 0,
    goodPracticesRows: plan.goodPractices.create ? LOCALES.length : 0,
    phonesRows: plan.phones.updates.length,
    snapshotPath: snapshotPath || null,
  };

  await strapi.db.transaction(async () => {
    // 1. Categories: create missing docs, then relabel/reorder existing rows.
    for (const doc of plan.categories.createDocs) {
      const es = await strapi.documents(UID.category).create({
        data: { name: doc.name[DEFAULT_LOCALE], slug: doc.slug, order: doc.order, color: doc.color },
        locale: DEFAULT_LOCALE,
        status: 'published',
      });
      await strapi.documents(UID.category).update({
        documentId: es.documentId,
        locale: SECOND_LOCALE,
        data: { name: doc.name[SECOND_LOCALE], slug: doc.slug, order: doc.order, color: doc.color },
        status: 'published',
      });
    }
    for (const r of plan.categories.updateRows) {
      await strapi.db.query(UID.category).update({ where: { id: r.id }, data: { name: r.name, order: r.order } });
    }

    const categoryIdx = await reindexRows(strapi, UID.category);

    // 2. Listing category moves (per physical row, same-locale target).
    for (const m of plan.listingCategory.moves) {
      const target = resolveRow(categoryIdx, m.targetSlug, m.locale, m.isDraft);
      if (!target) {
        strapi.log.warn(`[migrate-redesign] no ${m.targetSlug} category row for locale ${m.locale}; listing ${m.slug} row #${m.listingRowId} left without category`);
        continue;
      }
      await strapi.db.query(UID.listing).update({ where: { id: m.listingRowId }, data: { category: target.id } });
    }

    // 3. hideContact for final-category services docs (ALL rows).
    for (const r of plan.hideContact.rows) {
      await strapi.db.query(UID.listing).update({ where: { id: r.id }, data: { hideContact: true } });
    }

    // 4. Communities (+ duplicated history content).
    for (const doc of plan.communities.createDocs) {
      const es = await strapi.documents(UID.community).create({
        data: buildCommunityData(doc, DEFAULT_LOCALE),
        locale: DEFAULT_LOCALE,
        status: 'published',
      });
      await strapi.documents(UID.community).update({
        documentId: es.documentId,
        locale: SECOND_LOCALE,
        data: buildCommunityData(doc, SECOND_LOCALE),
        status: 'published',
      });
    }

    // 4b. Existing communities: fill homepage content where empty. A
    //     status 'published' fill updates the draft then republishes, so
    //     the content lands on BOTH variants (the planner only schedules
    //     it when both variants of the field are empty); a status 'draft'
    //     fill writes the draft row only and never publishes. Fields whose
    //     draft holds editor content are never planned here (manual
    //     review), so editor content is never overwritten.
    for (const f of plan.communityContent.fills) {
      await strapi.documents(UID.community).update({
        documentId: f.documentId,
        locale: f.locale,
        status: f.status,
        data: { [f.field]: f.data },
      });
    }

    const communityIdx = await reindexRows(strapi, UID.community);

    // 5. Listings -> community links (same-locale, same-status row).
    for (const l of plan.listingCommunity.links) {
      const comm = resolveRow(communityIdx, l.communitySlug, l.locale, l.isDraft);
      if (!comm) {
        strapi.log.warn(`[migrate-redesign] no ${l.communitySlug} community row for locale ${l.locale}; listing ${l.slug} row #${l.listingRowId} left unlinked`);
        continue;
      }
      await strapi.db.query(UID.listing).update({ where: { id: l.listingRowId }, data: { community: comm.id } });
    }

    // 6. Members -> community links (same-locale, same-status row).
    for (const l of plan.memberCommunity.links) {
      const comm = resolveRow(communityIdx, l.communitySlug, l.locale, l.isDraft);
      if (!comm) {
        strapi.log.warn(`[migrate-redesign] no ${l.communitySlug} community row for locale ${l.locale}; member ${l.slug} row #${l.memberRowId} left unlinked`);
        continue;
      }
      await strapi.db.query(UID.member).update({ where: { id: l.memberRowId }, data: { community: comm.id } });
    }

    // 7. Artisans group listing (draft only) + member links.
    if (plan.artisan.create) {
      const freshMembers = await strapi.db.query(UID.member).findMany({ select: ['id', 'slug', 'locale', 'publishedAt'] });
      const memberDraftId = new Map();
      for (const m of freshMembers) {
        if (m.publishedAt == null) memberDraftId.set(`${m.slug}:${m.locale}`, m.id);
      }
      const membersFor = (locale) =>
        plan.artisan.memberLinks
          .filter((l) => l.locale === locale)
          .map((l) => memberDraftId.get(`${l.slug}:${locale}`))
          .filter((id) => id != null);

      const craftsEs = resolveRow(categoryIdx, ARTISAN_LISTING.categorySlug, DEFAULT_LOCALE, true);
      const pavEs = resolveRow(communityIdx, ARTISAN_LISTING.communitySlug, DEFAULT_LOCALE, true);
      const craftsEn = resolveRow(categoryIdx, ARTISAN_LISTING.categorySlug, SECOND_LOCALE, true);
      const pavEn = resolveRow(communityIdx, ARTISAN_LISTING.communitySlug, SECOND_LOCALE, true);

      const esListing = await strapi.documents(UID.listing).create({
        data: {
          title: ARTISAN_LISTING.title[DEFAULT_LOCALE],
          slug: ARTISAN_LISTING.slug,
          hideContact: false,
          isFeatured: false,
          order: 0,
          category: craftsEs ? craftsEs.id : undefined,
          community: pavEs ? pavEs.id : undefined,
          members: membersFor(DEFAULT_LOCALE),
        },
        locale: DEFAULT_LOCALE,
      });
      await strapi.documents(UID.listing).update({
        documentId: esListing.documentId,
        locale: SECOND_LOCALE,
        data: {
          title: ARTISAN_LISTING.title[SECOND_LOCALE],
          slug: ARTISAN_LISTING.slug,
          category: craftsEn ? craftsEn.id : undefined,
          community: pavEn ? pavEn.id : undefined,
          members: membersFor(SECOND_LOCALE),
        },
      });
    }

    // 8. Good-practices page (draft only) with duplicated guide content.
    if (plan.goodPractices.create) {
      const es = await strapi.documents(UID.goodPractices).create({
        data: buildGoodPracticesData(plan.goodPractices.create.perLocale[DEFAULT_LOCALE]),
        locale: DEFAULT_LOCALE,
      });
      await strapi.documents(UID.goodPractices).update({
        documentId: es.documentId,
        locale: SECOND_LOCALE,
        data: buildGoodPracticesData(plan.goodPractices.create.perLocale[SECOND_LOCALE]),
      });
    }

    // 9. Phones: fill the new contact fields from the legacy ones. The
    //    planner only schedules genuinely empty pairs, so existing values
    //    are never overwritten. Field names follow the pair's kind.
    for (const u of plan.phones.updates) {
      const data =
        u.kind === 'whatsapp'
          ? { whatsappCountryCode: u.countryCode, whatsappNumber: u.number }
          : { phoneCountryCode: u.countryCode, phoneNumber: u.number };
      await strapi.db.query(CONTACT_COMPONENT_UID).update({ where: { id: u.componentRowId }, data });
    }
  });

  return totals;
}

// ---- Plan printing --------------------------------------------------------------

function printPlan(plan) {
  for (const d of plan.categories.createDocs) {
    console.log(
      `[CATEGORY-CREATE] ${d.slug} — ${LOCALES.map((l) => `${l} "${d.name[l]}"`).join(', ')} (order ${d.order}, color ${d.color ?? 'NULL'})`
    );
  }
  for (const r of plan.categories.updateRows) {
    console.log(`[CATEGORY-UPDATE] ${r.slug} ${r.locale}: "${r.oldName}" -> "${r.name}" (order ${r.oldOrder} -> ${r.order})`);
  }
  for (const m of plan.listingCategory.moves) {
    console.log(`[RELINK] ${m.slug} (${m.locale})${m.isDraft ? ' [draft]' : ''}: ${m.fromSlug ?? '(none, from sibling)'} -> ${m.targetSlug}`);
  }
  for (const d of plan.communities.createDocs) {
    console.log(`[COMMUNITY-CREATE] ${d.slug} — ${LOCALES.join(' + ')}, order ${d.order}, color ${d.color}, geo ${JSON.stringify(d.coords)}`);
  }
  for (const s of plan.communities.skippedSlugs) console.log(`[SKIP] community ${s} already exists (usable as link target)`);
  for (const f of plan.communityContent.fills) {
    console.log(`[COMMUNITY-FILL] ${f.slug} (${f.locale}, ${f.status}) ${f.field} from homepage`);
  }

  const byPair = new Map();
  for (const l of plan.listingCommunity.links) {
    const key = `${l.slug} -> ${l.communitySlug} [${l.source}]`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(l.locale);
  }
  for (const [key, locales] of byPair) console.log(`[LISTING-COMMUNITY] ${key} (${locales.join(', ')})`);

  const memberByPair = new Map();
  for (const l of plan.memberCommunity.links) {
    const key = `${l.slug} -> ${l.communitySlug}`;
    if (!memberByPair.has(key)) memberByPair.set(key, []);
    memberByPair.get(key).push(l.locale);
  }
  for (const [key, locales] of memberByPair) console.log(`[MEMBER-COMMUNITY] ${key} (${locales.join(', ')})`);

  if (plan.artisan.skipped) console.log(`[SKIP] artisan listing ${ARTISAN_LISTING.slug} already exists`);
  if (plan.artisan.create) {
    console.log(`[ARTISAN-CREATE] ${ARTISAN_LISTING.slug} (draft, ${LOCALES.join(' + ')})`);
    for (const m of plan.artisan.linkedMembers) console.log(`[ARTISAN-MEMBER] ${m.slug} — ${m.name}`);
  }
  if (plan.goodPractices.skipped) console.log('[SKIP] good-practices-page already has rows');
  if (plan.goodPractices.create) console.log(`[GOOD-PRACTICES-CREATE] ${LOCALES.join(' + ')} (draft, copied from guide-page)`);

  for (const u of plan.phones.updates) {
    console.log(`[PHONE-FILL] ${u.slug} (${u.locale}${u.isDraft ? ', draft' : ''}) ${u.kind}: "${u.legacyValue}" -> ${u.countryCode} ${u.number}`);
  }

  if (plan.hideContact.rows.length > 0) {
    const byDoc = new Map();
    for (const r of plan.hideContact.rows) byDoc.set(r.slug, (byDoc.get(r.slug) || 0) + 1);
    for (const [slug, n] of byDoc) console.log(`[HIDE-CONTACT] ${slug} — ${n} row(s)`);
  }
  for (const w of plan.warnings) console.log(`[WARN] ${w}`);

  const catCreated = plan.categories.createDocs.length * LOCALES.length;
  const rows = [
    ['categories', catCreated, plan.categories.updateRows.length, plan.categories.skippedRows.length],
    ['listing categories', plan.listingCategory.moves.length, 0, plan.listingCategory.keptRows],
    ['hide_contact (services)', 0, plan.hideContact.rows.length, plan.hideContact.alreadyHidden],
    ['communities', plan.communities.createDocs.length * LOCALES.length, 0, plan.communities.skippedSlugs.length],
    ['community content', 0, plan.communityContent.fills.length, plan.communityContent.alreadyFilled + plan.communityContent.noSource],
    ['listings -> community', plan.listingCommunity.links.length, 0, plan.listingCommunity.existingPairs],
    ['members -> community', plan.memberCommunity.links.length, 0, plan.memberCommunity.existingPairs],
    ['artisan listing', plan.artisan.create ? LOCALES.length : 0, 0, plan.artisan.skipped ? 1 : 0],
    ['good-practices page', plan.goodPractices.create ? LOCALES.length : 0, 0, plan.goodPractices.skipped ? 1 : 0],
    ['phones (contact)', 0, plan.phones.updates.length, plan.phones.alreadyFilled + plan.phones.emptyLegacy + plan.phones.noContact],
  ];
  console.log('\nSummary (rows):');
  console.log('  section                     created  updated  skipped');
  for (const [name, c, u, s] of rows) {
    console.log(`  ${name.padEnd(26)} ${String(c).padStart(7)} ${String(u).padStart(8)} ${String(s).padStart(8)}`);
  }

  const review = [];
  for (const u of plan.listingCommunity.unresolved) review.push(`  [${u.kind}] ${u.slug} — ${u.reason}`);
  for (const c of plan.craftsCandidates) {
    review.push(`  [crafts-candidate] ${c.slug} — services listing, candidate for crafts${c.known ? ' (known artisan set)' : ''}`);
  }
  if (plan.craftsColorNote) review.push('  [crafts-color] crafts category has no color yet — editors pick one');
  for (const m of plan.memberCommunity.noLocality) review.push(`  [member-locality] ${m.slug} — ${m.reason}`);
  for (const m of plan.communityContent.manualReview) {
    review.push(`  [community-content] ${m.slug} (${m.locale}) ${m.field} — ${m.reason}; fill manually`);
  }
  for (const m of plan.phones.manualReview) {
    review.push(`  [phone-review] ${m.slug} (${m.locale}) ${m.kind}: "${m.value}" — unparseable, new fields left empty`);
  }
  if (review.length > 0) {
    console.log('\nNeeds manual review:');
    for (const line of review) console.log(line);
  }
}

// ---- CLI --------------------------------------------------------------------------

function valueFlag(args, name) {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return null;
  const a = args[idx];
  if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  return args[idx + 1] || null;
}

function parseMapFile(mapPath, validCommunitySlugs) {
  const overrides = {};
  const raw = fs.readFileSync(mapPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`invalid --map row (expected 'listingSlug,communitySlug'): ${JSON.stringify(trimmed)}`);
    }
    const [listingSlug, communitySlug] = parts;
    if (!validCommunitySlugs.includes(communitySlug)) {
      throw new Error(`--map row for '${listingSlug}' targets unknown community '${communitySlug}' (expected one of: ${validCommunitySlugs.join(', ')})`);
    }
    overrides[listingSlug] = communitySlug;
  }
  return overrides;
}

async function main() {
  let committed = false;
  // A pooled connection can also reject asynchronously while shutting down.
  let shutdownWarnings = 0;
  process.on('unhandledRejection', (e) => {
    if (!committed) throw e;
    // Pooled connections dropping on shutdown reject once per connection;
    // report it a single time so a successful run does not look alarming.
    if (shutdownWarnings++ === 0) {
      console.warn(`[migrate-redesign] shutdown warning (data already committed): ${e && e.message}`);
    }
  });
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const explicitDb = valueFlag(args, '--db');
  const mapPath = valueFlag(args, '--map');
  const craftsArg = valueFlag(args, '--crafts');

  let mapOverrides = {};
  if (mapPath) {
    if (!fs.existsSync(mapPath)) {
      console.error(`Map file not found: ${mapPath}`);
      return 2;
    }
    try {
      mapOverrides = parseMapFile(mapPath, COMMUNITY_CONTRACT.map((c) => c.slug));
    } catch (e) {
      console.error(`Bad --map config: ${e.message}`);
      return 2;
    }
  }
  const craftsSlugs = craftsArg ? craftsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];

  console.log(`Mode:       ${APPLY ? 'APPLY (migrate + snapshot written)' : 'DRY-RUN (no writes)'}\n`);

  let strapiApp;
  try {
    strapiApp = await loadStrapiInstance({ dbPath: explicitDb });
    const plan = await planMigration(strapiApp, { mapOverrides, craftsSlugs });
    printPlan(plan);

    if (!planHasWork(plan)) {
      console.log('\nNothing to migrate — database already matches the redesign contract.');
      return 0;
    }

    if (!APPLY) {
      console.log('\nDry-run complete. Re-run with --apply to execute.');
      return 0;
    }

    const dbFile = process.env.DATABASE_FILENAME;
    const snapshotDir = process.env.DATABASE_CLIENT === 'postgres' || !dbFile
      ? process.cwd()
      : path.dirname(path.resolve(process.cwd(), dbFile));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(snapshotDir, `migrate-redesign-snapshot-${stamp}.json`);

    const totals = await applyMigration(strapiApp, plan, { snapshotPath });
    committed = true;
    console.log(
      `\nMigration complete: ${totals.categoriesCreated + totals.categoriesUpdated} category row(s), ` +
        `${totals.listingRowsRelinked} relink(s), ${totals.hideContactRows} hide_contact row(s), ` +
        `${totals.communitiesCreated} community row(s), ${totals.communityContentFills} community content fill(s), ` +
        `${totals.listingCommunityLinks} listing link(s), ` +
        `${totals.memberCommunityLinks} member link(s), artisan listing ${totals.artisanRows} row(s), ` +
        `good-practices ${totals.goodPracticesRows} row(s), phones ${totals.phonesRows} row(s). Snapshot: ${snapshotPath}`
    );
    console.log('Re-run without --apply to confirm there is nothing left to do.');
    return 0;
  } finally {
    try {
      await closeStrapiInstance(strapiApp);
    } catch (e) {
      // After a committed transaction a dropped pooled connection (seen on Neon
      // after long runs) must not turn a successful migration into exit 1.
      if (!committed) throw e;
      console.warn(`[migrate-redesign] shutdown warning (data already committed): ${e.message}`);
    }
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error('migrate-redesign failed:', e.message);
      process.exit(1);
    });
}

module.exports = {
  loadStrapiInstance,
  closeStrapiInstance,
  planMigration,
  planHasWork,
  applyMigration,
  buildSnapshot,
  buildCommunityData,
  buildGoodPracticesData,
  parseMapFile,
  reindexRows,
  resolveRow,
  UID,
  LOCALES,
  CATEGORY_CONTRACT,
  COMMUNITY_CONTRACT,
  LEGACY_CATEGORY_TARGET,
  LISTING_COMMUNITY,
  LOCALITY_TO_COMMUNITY,
  KNOWN_CRAFTS_CANDIDATES,
  PAV_COORDS,
  RSC_COORDS,
  ARTISAN_LISTING,
  GOOD_PRACTICES_LABEL,
  normalizeLegacyPhone,
  PHONE_COUNTRY_CODE_REGEX,
  PHONE_NUMBER_REGEX,
  CONTACT_COMPONENT_UID,
};
