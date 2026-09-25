#!/usr/bin/env node
/**
 * migrate-redesign.js
 *
 * One-shot data migration for the Puerto Agua Verde redesign contract
 * (docs/contracts/redesign-data-contract.md). Raw SQL on the Strapi 5.39
 * physical layout (SQLite in dev, Postgres/Neon in prod), following the
 * `enrich-recommendations-from-es.js` house pattern. Steps:
 *
 *   1. Categories: relabel/reorder `experiences` (1) and `services` (3);
 *      create `gastronomy` (2, absorbs the legacy `restaurants` color) and
 *      `crafts` (4, no color yet — flagged for manual review) as published
 *      docs, one row per locale. Legacy category docs are NEVER touched.
 *      Listings are reassigned per physical row: sites/accommodation ->
 *      experiences, restaurants -> gastronomy; --crafts=<slug,slug> moves
 *      listings into crafts. Afterwards every `services` listing gets
 *      hide_contact = 1 on ALL its rows (draft + published, both locales).
 *      No other listing is written.
 *   2. Communities: create `puerto-agua-verde` and `rancho-san-cosme`
 *      (contract colors/orders/geo points, one published row per locale)
 *      with history starting content duplicated from the guide-page of the
 *      same locale (history text, historyHeader section header,
 *      historyMilestones renumbered 1..n). Component rows are always
 *      duplicated, never shared with guide_pages.
 *   3. Listing -> community: per listing document, source priority is
 *      (1) --map CSV override, (2) the embedded LISTING_COMMUNITY table,
 *      (3) a linked member's locality. Unresolved listings are reported as
 *      "needs manual review", never guessed. Every physical row of the
 *      document is linked to the SAME-LOCALE community row (listing_ord
 *      NULL, UNIQUE-respecting).
 *   4. Member -> community: locality agua-verde -> puerto-agua-verde,
 *      rancho-san-cosme -> rancho-san-cosme, same-locale row per member
 *      row. The locality column is kept. Empty/unknown locality is
 *      reported for manual review.
 *   5. Artisans group listing: create `artesanas-de-puerto-agua-verde` as
 *      a DRAFT document (both locales) in crafts + puerto-agua-verde, and
 *      link every member whose community is puerto-agua-verde and whose
 *      role matches /artesan|craft/i (names/slugs printed).
 *   6. Good-practices page: if ANY row exists, skip. Otherwise create 2
 *      DRAFT rows copying the guide-page published row of each locale
 *      (protectedArea, influence, fishing, recommendations, tips; the
 *      tipsHeader is a NEW section header built from
 *      guide_pages.driving_tips_header).
 *
 * Safety:
 *   - Dry-run by default (prints the plan, writes nothing); exits 1 with
 *     pending work, 0 when clean. Parity with enrich-recommendations.
 *   - --apply writes a JSON snapshot of the pre-write state BEFORE any
 *     write: enough for manual restore (old category labels, legacy
 *     category links that will be deleted, listings whose hide_contact
 *     will flip).
 *   - All writes happen in ONE transaction (sqlite) / BEGIN..COMMIT (pg).
 *   - Idempotent: a second run changes nothing (existence checks by slug,
 *     UNIQUE pair checks, row-level update skipping, creations only on
 *     absent documents).
 *
 * Usage:
 *   node scripts/migrate-redesign.js                          # dry-run
 *   node scripts/migrate-redesign.js --apply                  # writes
 *   node scripts/migrate-redesign.js --db /path.db            # sqlite
 *   node scripts/migrate-redesign.js --map=overrides.csv      # listingSlug,communitySlug
 *   node scripts/migrate-redesign.js --crafts=slug-a,slug-b   # move into crafts
 *   # PostgreSQL: DATABASE_CLIENT=postgres DATABASE_URL=...
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCALES = ['es-MX', 'en'];

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

// Contract §1 legacy -> current mapping. Order defines determinism when a
// row somehow links several legacy categories at once.
const LEGACY_CATEGORY_ORDER = ['sites', 'accommodation', 'restaurants'];
const LEGACY_CATEGORY_TARGET = {
  sites: 'experiences',
  accommodation: 'experiences',
  restaurants: 'gastronomy',
};

// Fallback when the legacy `restaurants` category carries no color.
const GASTRONOMY_COLOR_FALLBACK = '#F5A623';

// Contract §2 coordinates. HARD RULE: these are the contract values.
// Do NOT reuse RSC_COORDS from scripts/import-csv-listings.js — that value
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

// Strapi 5 document ids: 25-char lowercase [0-9a-z] (nanoid-style alphabet).
const DOC_ID_LEN = 25;
const DOC_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function newDocumentId() {
  const bytes = crypto.randomBytes(DOC_ID_LEN);
  let s = '';
  for (let i = 0; i < DOC_ID_LEN; i++) s += DOC_ID_ALPHABET[bytes[i] % DOC_ID_ALPHABET.length];
  return s;
}

// ---- Database access --------------------------------------------------------

async function openDb(dialect, loc) {
  if (dialect === 'sqlite') {
    const Database = require('better-sqlite3');
    const db = new Database(loc);
    db.pragma('busy_timeout = 5000');
    return db;
  }
  if (dialect === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ connectionString: loc });
    await client.connect();
    return client;
  }
  throw new Error(`Unsupported dialect: ${dialect}`);
}

async function closeDb(db, dialect) {
  if (dialect === 'sqlite') return db.close();
  if (dialect === 'postgres') return db.end();
}

function quoteIdent(name) {
  return name === 'order' ? '"order"' : name;
}

function ph(dialect, i) {
  return dialect === 'sqlite' ? '?' : `$${i}`;
}

/**
 * Translate Postgres-style `$N` placeholders into better-sqlite3 `?` form when
 * running on sqlite. better-sqlite3 binds `?` strictly positionally (no
 * named-by-number semantics), so we also expand the params array: each `$N`
 * occurrence gets the value at index N-1 repeated in the new order.
 */
function adaptForSqlite(sql, params) {
  const refs = [...sql.matchAll(/\$(\d+)/g)].map((m) => parseInt(m[1], 10));
  const adapted = sql.replace(/\$\d+/g, '?');
  const expanded = refs.map((n) => params[n - 1]);
  return { sql: adapted, params: expanded };
}

// ---- Planner ----------------------------------------------------------------

async function planMigration(db, dialect, opts = {}) {
  const { mapOverrides = {}, craftsSlugs = [] } = opts;
  const q = async (sql, params = []) => {
    if (dialect === 'sqlite') {
      const { sql: s, params: p } = adaptForSqlite(sql, params);
      return db.prepare(s).all(...p);
    }
    return (await db.query(sql, params)).rows;
  };

  const plan = {
    now: new Date().toISOString(),
    categories: { createDocs: [], updateRows: [], skippedRows: [], existingRows: [] },
    listingCategory: { moves: [], keptRows: 0, rowsWithoutCategory: 0 },
    hideContact: { rows: [], alreadyHidden: 0 },
    communities: { createDocs: [], skippedSlugs: [], existingRows: [] },
    listingCommunity: { links: [], existingPairs: 0, unresolved: [] },
    memberCommunity: { links: [], existingPairs: 0, noLocality: [] },
    artisan: { create: null, skipped: false, memberLinks: [], linkedMembers: [] },
    goodPractices: { create: null, skipped: false },
    craftsColorNote: false,
    warnings: [],
    snapshot: { categoryLinks: [], hideContactRows: [] },
  };

  // ---- Step 1 · Categories -------------------------------------------------

  const catRows = await q(
    `SELECT id, document_id, slug, name, color, ${quoteIdent('order')} AS ord, published_at, locale
       FROM categories`
  );
  plan.categories.existingRows = catRows;
  const catsBySlug = new Map();
  for (const r of catRows) {
    if (!catsBySlug.has(r.slug)) catsBySlug.set(r.slug, []);
    catsBySlug.get(r.slug).push(r);
  }

  const restaurantsRow = (catsBySlug.get('restaurants') || []).find((r) => r.color);
  const gastronomyColor = (restaurantsRow && restaurantsRow.color) || GASTRONOMY_COLOR_FALLBACK;

  for (const c of CATEGORY_CONTRACT) {
    const rows = catsBySlug.get(c.slug) || [];
    if (rows.length === 0) {
      plan.categories.createDocs.push({
        slug: c.slug,
        order: c.order,
        color: c.slug === 'gastronomy' ? gastronomyColor : null,
        document_id: newDocumentId(),
        rows: LOCALES.map((locale) => ({ locale, name: c.name[locale], published_at: plan.now })),
      });
    } else {
      for (const row of rows) {
        const desiredName = c.name[row.locale] ?? c.name[LOCALES[0]];
        if (row.name === desiredName && Number(row.ord) === c.order) {
          plan.categories.skippedRows.push({ id: row.id, slug: row.slug, locale: row.locale });
        } else {
          plan.categories.updateRows.push({
            id: row.id,
            slug: row.slug,
            locale: row.locale,
            oldName: row.name,
            oldOrder: row.ord,
            name: desiredName,
            order: c.order,
          });
        }
      }
    }
  }

  const craftsRows = catsBySlug.get('crafts') || [];
  plan.craftsColorNote = craftsRows.length === 0 || craftsRows.every((r) => !r.color);

  // ---- Listing documents + current category links --------------------------

  const listingRows = await q(
    `SELECT id, document_id, slug, title, locale, published_at, hide_contact FROM listings ORDER BY id`
  );
  const listingsByDoc = new Map();
  for (const r of listingRows) {
    if (!listingsByDoc.has(r.document_id)) listingsByDoc.set(r.document_id, []);
    listingsByDoc.get(r.document_id).push(r);
  }

  const catLnkRows = await q(
    `SELECT lc.id, lc.listing_id, lc.category_id, c.slug AS cat_slug, l.slug AS listing_slug, l.locale
       FROM listings_category_lnk lc
       JOIN categories c ON c.id = lc.category_id
       JOIN listings l ON l.id = lc.listing_id
      ORDER BY lc.id`
  );
  const lnksByListing = new Map();
  for (const r of catLnkRows) {
    if (!lnksByListing.has(r.listing_id)) lnksByListing.set(r.listing_id, []);
    lnksByListing.get(r.listing_id).push(r);
  }

  const movesByListing = new Map();
  for (const [docId, rows] of listingsByDoc) {
    const docSlug = rows[0].slug;
    const craftsOverride = craftsSlugs.includes(docSlug);
    for (const row of rows) {
      const links = lnksByListing.get(row.id) || [];
      if (links.length === 0) {
        plan.listingCategory.rowsWithoutCategory++;
        continue;
      }
      if (craftsOverride) {
        const toDelete = links.filter((l) => l.cat_slug !== 'crafts');
        if (toDelete.length === 0) {
          plan.listingCategory.keptRows++;
          continue;
        }
        const move = {
          listing_id: row.id,
          slug: docSlug,
          locale: row.locale,
          isDraft: row.published_at == null,
          deleteLnkIds: toDelete.map((l) => l.id),
          fromSlugs: [...new Set(toDelete.map((l) => l.cat_slug))],
          targetSlug: 'crafts',
        };
        plan.listingCategory.moves.push(move);
        movesByListing.set(row.id, move);
      } else {
        const legacy = LEGACY_CATEGORY_ORDER.flatMap((s) => links.filter((l) => l.cat_slug === s));
        if (legacy.length === 0) {
          plan.listingCategory.keptRows++;
          continue;
        }
        const move = {
          listing_id: row.id,
          slug: docSlug,
          locale: row.locale,
          isDraft: row.published_at == null,
          deleteLnkIds: legacy.map((l) => l.id),
          fromSlugs: [...new Set(legacy.map((l) => l.cat_slug))],
          targetSlug: LEGACY_CATEGORY_TARGET[legacy[0].cat_slug],
        };
        plan.listingCategory.moves.push(move);
        movesByListing.set(row.id, move);
      }
    }
  }

  // Final category per document (virtual state after the moves above).
  const finalSlugsByDoc = new Map();
  for (const [docId, rows] of listingsByDoc) {
    const finals = new Set();
    for (const row of rows) {
      const move = movesByListing.get(row.id);
      if (move) finals.add(move.targetSlug);
      for (const l of lnksByListing.get(row.id) || []) {
        if (!move || !move.deleteLnkIds.includes(l.id)) finals.add(l.cat_slug);
      }
    }
    finalSlugsByDoc.set(docId, finals);
  }

  // hideContact AFTER all category moves: services docs only, ALL their rows.
  const listingById = new Map(listingRows.map((r) => [r.id, r]));
  for (const [docId, rows] of listingsByDoc) {
    if (!finalSlugsByDoc.get(docId).has('services')) continue;
    for (const row of rows) {
      if (row.hide_contact) {
        plan.hideContact.alreadyHidden++;
      } else {
        plan.hideContact.rows.push({ id: row.id, slug: rows[0].slug });
        plan.snapshot.hideContactRows.push({ id: row.id, slug: rows[0].slug, hide_contact: row.hide_contact ? 1 : 0 });
      }
    }
  }

  // Manual review: every services listing that was not moved into crafts is
  // a crafts candidate (known artisan set first).
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

  const communityRows = await q(`SELECT id, document_id, slug, locale, published_at FROM communities`);
  plan.communities.existingRows = communityRows;
  const commBySlug = new Map();
  for (const r of communityRows) {
    if (!commBySlug.has(r.slug)) commBySlug.set(r.slug, []);
    commBySlug.get(r.slug).push(r);
  }

  const pickGuideRow = (locale) =>
    q(
      `SELECT id, locale, published_at, history_text, influence_text, fishing_text, driving_tips_header
         FROM guide_pages
        WHERE locale = $1
        ORDER BY (CASE WHEN published_at IS NULL THEN 1 ELSE 0 END), published_at DESC`,
      [locale]
    ).then((rows) => rows[0] || null);

  const guideComponent = (guideId, field, type, cmpTable, cols) =>
    q(
      `SELECT gc.cmp_id, gc.${quoteIdent('order')} AS ord, ${cols.map((c) => `t.${quoteIdent(c)}`).join(', ')}
          FROM guide_pages_cmps gc JOIN ${cmpTable} t ON t.id = gc.cmp_id
         WHERE gc.entity_id = $1 AND gc.field = $2 AND gc.component_type = $3
         ORDER BY gc.${quoteIdent('order')}`,
      [guideId, field, type]
    );

  for (const c of COMMUNITY_CONTRACT) {
    if ((commBySlug.get(c.slug) || []).length > 0) {
      plan.communities.skippedSlugs.push(c.slug);
      continue;
    }
    const perLocale = [];
    for (const locale of LOCALES) {
      const guide = await pickGuideRow(locale);
      const header = guide ? (await guideComponent(guide.id, 'historyHeader', 'section.section-header', 'components_section_section_headers', ['title', 'subtitle']))[0] : null;
      const milestones = guide
        ? await guideComponent(guide.id, 'historyMilestones', 'guide.milestone', 'components_guide_milestones', ['year', 'text'])
        : [];
      perLocale.push({
        locale,
        history_text: guide ? guide.history_text : null,
        historyHeader: header ? { title: header.title, subtitle: header.subtitle } : null,
        historyMilestones: milestones.map((m) => ({ year: m.year, text: m.text })),
      });
    }
    plan.communities.createDocs.push({
      slug: c.slug,
      name: c.name,
      order: c.order,
      color: c.color,
      textColor: c.textColor,
      coords: c.coords,
      document_id: newDocumentId(),
      published_at: plan.now,
      perLocale,
    });
  }
  const communitySlugsPlanned = new Set(plan.communities.createDocs.map((d) => d.slug));
  const commRowBySlugLocale = new Map();
  for (const r of communityRows) commRowBySlugLocale.set(`${r.slug}:${r.locale}`, r);

  // ---- Step 3 · Listings -> community ---------------------------------------

  const existingListingComm = await q(`SELECT listing_id, community_id FROM listings_community_lnk`);
  const existingListingPairs = new Set(existingListingComm.map((r) => `${r.listing_id}:${r.community_id}`));

  const memberRows = await q(
    `SELECT id, document_id, slug, name, locale, locality, role FROM community_members ORDER BY id`
  );
  const memberById = new Map(memberRows.map((r) => [r.id, r]));
  const memberListingLnks = await q(
    `SELECT community_member_id, listing_id FROM community_members_listings_lnk`
  );
  const localityByListingRow = new Map();
  for (const l of memberListingLnks) {
    const m = memberById.get(l.community_member_id);
    if (m && m.locality && LOCALITY_TO_COMMUNITY[m.locality] && !localityByListingRow.has(l.listing_id)) {
      localityByListingRow.set(l.listing_id, m.locality);
    }
  }

  for (const [docId, rows] of listingsByDoc) {
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
        const loc = localityByListingRow.get(row.id);
        if (loc) {
          communitySlug = LOCALITY_TO_COMMUNITY[loc];
          source = `member locality (${loc})`;
          break;
        }
      }
    }
    if (!communitySlug) {
      plan.listingCommunity.unresolved.push({ kind: 'listing->community', slug, reason: 'no source resolved (--map, embedded table, member locality)' });
      continue;
    }
    for (const row of rows) {
      const commRow = commRowBySlugLocale.get(`${communitySlug}:${row.locale}`);
      if (!commRow && !communitySlugsPlanned.has(communitySlug)) {
        plan.warnings.push(`no ${communitySlug} community row for locale ${row.locale}; listing ${slug} row #${row.id} left unlinked`);
        continue;
      }
      if (commRow && existingListingPairs.has(`${row.id}:${commRow.id}`)) {
        plan.listingCommunity.existingPairs++;
        continue;
      }
      plan.listingCommunity.links.push({ listing_id: row.id, slug, locale: row.locale, communitySlug, source });
    }
  }

  // ---- Step 4 · Members -> community -----------------------------------------

  const existingMemberComm = await q(
    `SELECT community_member_id, community_id FROM community_members_community_lnk`
  );
  const existingMemberPairs = new Set(existingMemberComm.map((r) => `${r.community_member_id}:${r.community_id}`));
  const noLocalitySlugs = new Set();

  for (const m of memberRows) {
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
    const commRow = commRowBySlugLocale.get(`${communitySlug}:${m.locale}`);
    if (!commRow && !communitySlugsPlanned.has(communitySlug)) {
      plan.warnings.push(`no ${communitySlug} community row for locale ${m.locale}; member ${m.slug} row #${m.id} left unlinked`);
      continue;
    }
    if (commRow && existingMemberPairs.has(`${m.id}:${commRow.id}`)) {
      plan.memberCommunity.existingPairs++;
      continue;
    }
    plan.memberCommunity.links.push({ community_member_id: m.id, slug: m.slug, locale: m.locale, communitySlug });
  }

  // ---- Step 5 · Artisans group listing ---------------------------------------

  if (listingRows.some((r) => r.slug === ARTISAN_LISTING.slug)) {
    plan.artisan.skipped = true;
  } else {
    plan.artisan.create = {
      document_id: newDocumentId(),
      rows: LOCALES.map((locale) => ({
        locale,
        title: ARTISAN_LISTING.title[locale],
        slug: ARTISAN_LISTING.slug,
        short_description: null,
        hide_contact: 0,
        order: 0,
        is_featured: 0,
        published_at: null,
      })),
    };
    const membersByDoc = new Map();
    for (const r of memberRows) {
      if (!membersByDoc.has(r.document_id)) membersByDoc.set(r.document_id, []);
      membersByDoc.get(r.document_id).push(r);
    }
    for (const [docId, mrows] of membersByDoc) {
      const communitySlugs = new Set(
        mrows.map((r) => r.locality).filter(Boolean).map((l) => LOCALITY_TO_COMMUNITY[l]).filter(Boolean)
      );
      const roleMatch = mrows.some((r) => r.role && ARTISAN_ROLE_RE.test(r.role));
      if (!communitySlugs.has(ARTISAN_LISTING.communitySlug) || !roleMatch) continue;
      for (const m of mrows) {
        plan.artisan.memberLinks.push({ community_member_id: m.id, locale: m.locale, name: m.name, slug: m.slug });
      }
      plan.artisan.linkedMembers.push({ name: mrows[0].name, slug: mrows[0].slug });
    }
  }

  // --crafts entries pointing at nothing: warn (likely a typo).
  const knownListingSlugs = new Set(listingRows.map((r) => r.slug));
  for (const s of craftsSlugs) {
    if (!knownListingSlugs.has(s)) plan.warnings.push(`--crafts slug '${s}' matches no listing document`);
  }
  for (const [slug] of Object.entries(mapOverrides)) {
    if (!knownListingSlugs.has(slug)) plan.warnings.push(`--map slug '${slug}' matches no listing document`);
  }

  // ---- Step 6 · Good-practices page ------------------------------------------

  const gpRows = await q(`SELECT id FROM good_practices_pages`);
  if (gpRows.length > 0) {
    plan.goodPractices.skipped = true;
  } else {
    const perLocale = [];
    for (const locale of LOCALES) {
      const guide = await pickGuideRow(locale);
      const header = (field) =>
        guide
          ? guideComponent(guide.id, field, 'section.section-header', 'components_section_section_headers', ['title', 'subtitle']).then((r) => r[0] || null)
          : Promise.resolve(null);
      const textItems = (field) =>
        guide
          ? guideComponent(guide.id, field, 'guide.text-list-item', 'components_guide_text_list_items', ['text']).then((r) => r.map((x) => x.text))
          : Promise.resolve([]);
      const protectedArea = guide
        ? (
            await guideComponent(
              guide.id,
              'protectedArea',
              'guide.protected-link',
              'components_guide_protected_links',
              ['title', 'text', 'link_label', 'link_href']
            )
          )[0] || null
        : null;
      perLocale.push({
        locale,
        influence_text: guide ? guide.influence_text : null,
        fishing_text: guide ? guide.fishing_text : null,
        protectedArea: protectedArea
          ? { title: protectedArea.title, text: protectedArea.text, link_label: protectedArea.link_label, link_href: protectedArea.link_href }
          : null,
        influenceHeader: await header('influenceHeader'),
        fishingHeader: await header('fishingHeader'),
        recommendationsHeader: await header('recommendationsHeader'),
        fishingRules: await textItems('fishingRules'),
        recommendations: await textItems('recommendations'),
        tipsHeader: guide && guide.driving_tips_header != null ? { title: guide.driving_tips_header, subtitle: null } : null,
        tips: await textItems('drivingTips'),
      });
    }
    plan.goodPractices.create = { document_id: newDocumentId(), internal_label: GOOD_PRACTICES_LABEL, perLocale };
  }

  // ---- Snapshot pre-state -----------------------------------------------------

  const deleteLnkIds = new Set(plan.listingCategory.moves.flatMap((m) => m.deleteLnkIds));
  plan.snapshot.categoryLinks = catLnkRows
    .filter((r) => deleteLnkIds.has(r.id))
    .map((r) => ({
      id: r.id,
      listing_id: r.listing_id,
      listing_slug: r.listing_slug,
      locale: r.locale,
      category_id: r.category_id,
      category_slug: r.cat_slug,
    }));

  return plan;
}

const planHasWork = (plan) =>
  plan.categories.createDocs.length > 0 ||
  plan.categories.updateRows.length > 0 ||
  plan.listingCategory.moves.length > 0 ||
  plan.hideContact.rows.length > 0 ||
  plan.communities.createDocs.length > 0 ||
  plan.listingCommunity.links.length > 0 ||
  plan.memberCommunity.links.length > 0 ||
  plan.artisan.create !== null ||
  plan.goodPractices.create !== null;

// ---- Snapshot ----------------------------------------------------------------

function buildSnapshot(dialect, target, plan) {
  return {
    generatedAt: new Date().toISOString(),
    dialect,
    target: dialect === 'postgres' ? '<redacted>' : target,
    script: 'migrate-redesign.js',
    preState: {
      categoriesToUpdate: plan.categories.updateRows.map((r) => ({
        id: r.id,
        slug: r.slug,
        locale: r.locale,
        name: r.oldName,
        ord: r.oldOrder,
      })),
      categoryLinksToDelete: plan.snapshot.categoryLinks,
      listingsToHideContact: plan.snapshot.hideContactRows,
    },
    planned: {
      categoriesCreated: plan.categories.createDocs.map((d) => d.slug),
      communitiesCreated: plan.communities.createDocs.map((d) => d.slug),
      listingCommunityLinks: plan.listingCommunity.links.length,
      memberCommunityLinks: plan.memberCommunity.links.length,
      artisanListingCreated: plan.artisan.create ? plan.artisan.create.rows[0].slug : null,
      goodPracticesPageCreated: plan.goodPractices.create !== null,
    },
  };
}

// ---- Apply ---------------------------------------------------------------------

async function applyMigration(db, dialect, plan, opts = {}) {
  const { snapshotPath, target } = opts;
  if (snapshotPath) {
    const snap = buildSnapshot(dialect, target, plan);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snap, null, 2)}\n`);
  }

  const x = (sql, params) =>
    dialect === 'sqlite' ? db.prepare(sql).run(...params) : db.query(sql, params);
  const insertReturningId = async (table, cols, values) => {
    const params = [];
    const phs = values.map((v) => {
      params.push(v);
      return dialect === 'sqlite' ? '?' : `$${params.length}`;
    });
    const colList = cols.map(quoteIdent).join(', ');
    if (dialect === 'sqlite') {
      const res = x(`INSERT INTO ${table} (${colList}) VALUES (${phs.join(', ')})`, params);
      return Number(res.lastInsertRowid);
    }
    const res = await db.query(
      `INSERT INTO ${table} (${colList}) VALUES (${phs.join(', ')}) RETURNING id`,
      params
    );
    return res.rows[0].id;
  };
  // geo_point is a json column: plain text bind on sqlite, explicit cast on pg.
  const insertGeoPoint = async (coords) => {
    const json = JSON.stringify({ lat: coords.lat, lng: coords.lng });
    if (dialect === 'postgres') {
      const res = await db.query(`INSERT INTO components_location_geo_points (geo_point) VALUES ($1::json) RETURNING id`, [json]);
      return res.rows[0].id;
    }
    const res = x(`INSERT INTO components_location_geo_points (geo_point) VALUES (?)`, [json]);
    return Number(res.lastInsertRowid);
  };
  const insertCmpLink = (table, entity_id, cmp_id, componentType, field, order) =>
    x(
      `INSERT INTO ${table} (entity_id, cmp_id, component_type, field, ${quoteIdent('order')})
       VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)})`,
      [entity_id, cmp_id, componentType, field, order]
    );

  // Row resolvers for link targets: existing rows + rows created below.
  const rowIndex = new Map(); // `${kind}:${slug}:${locale}` -> [{ id, draft }]
  const indexRow = (kind, slug, locale, id, draft) => {
    const key = `${kind}:${slug}:${locale}`;
    if (!rowIndex.has(key)) rowIndex.set(key, []);
    rowIndex.get(key).push({ id, draft });
  };
  for (const r of plan.categories.existingRows) indexRow('category', r.slug, r.locale, r.id, r.published_at == null);
  for (const r of plan.communities.existingRows) indexRow('community', r.slug, r.locale, r.id, r.published_at == null);
  // Draft listing rows prefer draft targets, published rows prefer published
  // targets; fall back to whatever exists in that locale.
  const resolveRow = (kind, slug, locale, preferDraft) => {
    const list = rowIndex.get(`${kind}:${slug}:${locale}`) || [];
    if (list.length === 0) return null;
    return (preferDraft ? list.find((r) => r.draft) : list.find((r) => !r.draft)) || list[0];
  };

  const TRUE = dialect === 'postgres' ? true : 1;

  const run = async () => {
    // 1. Categories: create then update (updates also fix rows of mixed docs).
    for (const doc of plan.categories.createDocs) {
      for (const row of doc.rows) {
        const id = await insertReturningId(
          'categories',
          ['document_id', 'name', 'slug', 'color', 'order', 'published_at', 'locale', 'created_at', 'updated_at'],
          [doc.document_id, row.name, doc.slug, doc.color, doc.order, row.published_at, row.locale, plan.now, plan.now]
        );
        indexRow('category', doc.slug, row.locale, id, false);
      }
    }
    for (const r of plan.categories.updateRows) {
      await x(
        `UPDATE categories SET name = ${ph(dialect, 1)}, ${quoteIdent('order')} = ${ph(dialect, 2)}, updated_at = ${ph(dialect, 3)} WHERE id = ${ph(dialect, 4)}`,
        [r.name, r.order, plan.now, r.id]
      );
    }

    // 2. Listing category moves (per physical row, same-locale target).
    for (const m of plan.listingCategory.moves) {
      for (const lnkId of m.deleteLnkIds) {
        await x(`DELETE FROM listings_category_lnk WHERE id = ${ph(dialect, 1)}`, [lnkId]);
      }
      const target = resolveRow('category', m.targetSlug, m.locale, m.isDraft);
      if (!target) {
        console.warn(`[WARN] no ${m.targetSlug} category row for locale ${m.locale}; listing ${m.slug} row #${m.listing_id} left without category`);
        continue;
      }
      await x(
        `INSERT INTO listings_category_lnk (listing_id, category_id, listing_ord, category_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, 1, 1)`,
        [m.listing_id, target.id]
      );
    }

    // 3. hideContact for final-category services docs (ALL rows).
    for (const r of plan.hideContact.rows) {
      await x(
        `UPDATE listings SET hide_contact = ${ph(dialect, 1)}, updated_at = ${ph(dialect, 2)} WHERE id = ${ph(dialect, 3)}`,
        [TRUE, plan.now, r.id]
      );
    }

    // 4. Communities (+ duplicated history components + geo point).
    for (const doc of plan.communities.createDocs) {
      for (const loc of doc.perLocale) {
        const id = await insertReturningId(
          'communities',
          [
            'document_id', 'name', 'slug', 'tagline', 'description', 'order', 'color', 'text_color',
            'google_maps_url', 'history_text', 'tourist_map_caption', 'created_at', 'updated_at',
            'published_at', 'locale',
          ],
          [
            doc.document_id, doc.name, doc.slug, null, null, doc.order, doc.color, doc.textColor,
            null, loc.history_text, null, plan.now, plan.now, doc.published_at, loc.locale,
          ]
        );
        indexRow('community', doc.slug, loc.locale, id, false);
        const geoId = await insertGeoPoint(doc.coords);
        await insertCmpLink('communities_cmps', id, geoId, 'location.geo-point', 'location', 1);
        if (loc.historyHeader) {
          const shId = await insertReturningId(
            'components_section_section_headers',
            ['title', 'subtitle'],
            [loc.historyHeader.title, loc.historyHeader.subtitle]
          );
          await insertCmpLink('communities_cmps', id, shId, 'section.section-header', 'historyHeader', 1);
        }
        for (let i = 0; i < loc.historyMilestones.length; i++) {
          const m = loc.historyMilestones[i];
          const mid = await insertReturningId('components_guide_milestones', ['year', 'text'], [m.year, m.text]);
          await insertCmpLink('communities_cmps', id, mid, 'guide.milestone', 'historyMilestones', i + 1);
        }
      }
    }

    // 5. Listings -> community links (same-locale row, listing_ord NULL).
    for (const l of plan.listingCommunity.links) {
      const comm = resolveRow('community', l.communitySlug, l.locale, false);
      if (!comm) {
        console.warn(`[WARN] no ${l.communitySlug} community row for locale ${l.locale}; listing ${l.slug} row #${l.listing_id} left unlinked`);
        continue;
      }
      await x(
        `INSERT INTO listings_community_lnk (listing_id, community_id, listing_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, NULL)`,
        [l.listing_id, comm.id]
      );
    }

    // 6. Members -> community links (same-locale row).
    for (const l of plan.memberCommunity.links) {
      const comm = resolveRow('community', l.communitySlug, l.locale, false);
      if (!comm) {
        console.warn(`[WARN] no ${l.communitySlug} community row for locale ${l.locale}; member ${l.slug} row #${l.community_member_id} left unlinked`);
        continue;
      }
      await x(
        `INSERT INTO community_members_community_lnk (community_member_id, community_id, community_member_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, NULL)`,
        [l.community_member_id, comm.id]
      );
    }

    // 7. Artisans group listing (draft) + links.
    if (plan.artisan.create) {
      const artisanIdsByLocale = new Map();
      for (const row of plan.artisan.create.rows) {
        const id = await insertReturningId(
          'listings',
          ['document_id', 'title', 'slug', 'short_description', 'hide_contact', 'order', 'is_featured', 'published_at', 'locale', 'created_at', 'updated_at'],
          [
            plan.artisan.create.document_id, row.title, row.slug, row.short_description,
            dialect === 'postgres' ? false : 0, row.order, dialect === 'postgres' ? false : 0,
            row.published_at, row.locale, plan.now, plan.now,
          ]
        );
        artisanIdsByLocale.set(row.locale, id);
        const cat = resolveRow('category', ARTISAN_LISTING.categorySlug, row.locale, true);
        if (cat) {
          await x(
            `INSERT INTO listings_category_lnk (listing_id, category_id, listing_ord, category_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, 1, 1)`,
            [id, cat.id]
          );
        }
        const comm = resolveRow('community', ARTISAN_LISTING.communitySlug, row.locale, false);
        if (comm) {
          await x(
            `INSERT INTO listings_community_lnk (listing_id, community_id, listing_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, NULL)`,
            [id, comm.id]
          );
        }
      }
      // Member links: no UNIQUE on this table, so the plan-time skip logic is
      // the only guard (creation path only — the plan skips when the artisan
      // listing already exists).
      for (const ml of plan.artisan.memberLinks) {
        const target = artisanIdsByLocale.get(ml.locale);
        if (!target) continue;
        await x(
          `INSERT INTO community_members_listings_lnk (community_member_id, listing_id, listing_ord, community_member_ord) VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, NULL, NULL)`,
          [ml.community_member_id, target]
        );
      }
    }

    // 8. Good-practices page (draft) with duplicated guide components.
    if (plan.goodPractices.create) {
      for (const loc of plan.goodPractices.create.perLocale) {
        const gid = await insertReturningId(
          'good_practices_pages',
          ['document_id', 'internal_label', 'conanp_url', 'influence_text', 'fishing_text', 'created_at', 'updated_at', 'published_at', 'locale'],
          [
            plan.goodPractices.create.document_id, plan.goodPractices.create.internal_label, null,
            loc.influence_text, loc.fishing_text, plan.now, plan.now, null, loc.locale,
          ]
        );
        const linkHeader = async (field, header) => {
          if (!header) return;
          const shId = await insertReturningId(
            'components_section_section_headers',
            ['title', 'subtitle'],
            [header.title, header.subtitle ?? null]
          );
          await insertCmpLink('good_practices_pages_cmps', gid, shId, 'section.section-header', field, 1);
        };
        const linkItems = async (field, texts) => {
          for (let i = 0; i < texts.length; i++) {
            const tid = await insertReturningId('components_guide_text_list_items', ['text'], [texts[i]]);
            await insertCmpLink('good_practices_pages_cmps', gid, tid, 'guide.text-list-item', field, i + 1);
          }
        };
        if (loc.protectedArea) {
          const pid = await insertReturningId(
            'components_guide_protected_links',
            ['title', 'text', 'link_label', 'link_href'],
            [loc.protectedArea.title, loc.protectedArea.text, loc.protectedArea.link_label, loc.protectedArea.link_href]
          );
          await insertCmpLink('good_practices_pages_cmps', gid, pid, 'guide.protected-link', 'protectedArea', 1);
        }
        await linkHeader('influenceHeader', loc.influenceHeader);
        await linkHeader('fishingHeader', loc.fishingHeader);
        await linkItems('fishingRules', loc.fishingRules);
        await linkHeader('recommendationsHeader', loc.recommendationsHeader);
        await linkItems('recommendations', loc.recommendations);
        await linkHeader('tipsHeader', loc.tipsHeader);
        await linkItems('tips', loc.tips);
      }
    }
  };

  if (dialect === 'sqlite') {
    db.exec('BEGIN');
    try { await run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else {
    await x('BEGIN');
    try { await run(); await x('COMMIT'); } catch (e) { await x('ROLLBACK'); throw e; }
  }

  return {
    categoriesCreated: plan.categories.createDocs.reduce((n, d) => n + d.rows.length, 0),
    categoriesUpdated: plan.categories.updateRows.length,
    listingRowsRelinked: plan.listingCategory.moves.length,
    hideContactRows: plan.hideContact.rows.length,
    communitiesCreated: plan.communities.createDocs.reduce((n, d) => n + d.perLocale.length, 0),
    listingCommunityLinks: plan.listingCommunity.links.length,
    memberCommunityLinks: plan.memberCommunity.links.length,
    artisanRows: plan.artisan.create ? plan.artisan.create.rows.length : 0,
    goodPracticesRows: plan.goodPractices.create ? plan.goodPractices.create.perLocale.length : 0,
  };
}

// ---- Plan printing --------------------------------------------------------------

function printPlan(plan) {
  for (const d of plan.categories.createDocs) {
    console.log(
      `[CATEGORY-CREATE] ${d.slug} — ${d.rows.map((r) => `${r.locale} "${r.name}"`).join(', ')} (order ${d.order}, color ${d.color ?? 'NULL'})`
    );
  }
  for (const r of plan.categories.updateRows) {
    console.log(
      `[CATEGORY-UPDATE] ${r.slug} ${r.locale}: "${r.oldName}" -> "${r.name}" (order ${r.oldOrder} -> ${r.order})`
    );
  }
  for (const m of plan.listingCategory.moves) {
    console.log(`[RELINK] ${m.slug} (${m.locale})${m.isDraft ? ' [draft]' : ''}: ${m.fromSlugs.join(', ')} -> ${m.targetSlug}`);
  }
  for (const d of plan.communities.createDocs) {
    console.log(
      `[COMMUNITY-CREATE] ${d.slug} — ${d.perLocale.map((l) => l.locale).join(' + ')}, order ${d.order}, color ${d.color}, geo ${JSON.stringify(d.coords)}`
    );
  }
  for (const s of plan.communities.skippedSlugs) console.log(`[SKIP] community ${s} already exists (usable as link target)`);
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
    console.log(`[ARTISAN-CREATE] ${ARTISAN_LISTING.slug} (draft, ${plan.artisan.create.rows.map((r) => r.locale).join(' + ')})`);
    for (const m of plan.artisan.linkedMembers) console.log(`[ARTISAN-MEMBER] ${m.slug} — ${m.name}`);
  }
  if (plan.goodPractices.skipped) console.log('[SKIP] good-practices-page already has rows');
  if (plan.goodPractices.create) {
    console.log(`[GOOD-PRACTICES-CREATE] ${plan.goodPractices.create.perLocale.map((l) => l.locale).join(' + ')} (draft, copied from guide-page)`);
  }
  if (plan.hideContact.rows.length > 0) {
    const byDoc = new Map();
    for (const r of plan.hideContact.rows) byDoc.set(r.slug, (byDoc.get(r.slug) || 0) + 1);
    for (const [slug, n] of byDoc) console.log(`[HIDE-CONTACT] ${slug} — ${n} row(s)`);
  }
  for (const w of plan.warnings) console.log(`[WARN] ${w}`);
  if (plan.listingCategory.rowsWithoutCategory > 0) {
    console.log(`[NOTE] ${plan.listingCategory.rowsWithoutCategory} listing row(s) have no category link at all — left as-is (existing data state)`);
  }

  // Summary table (both modes).
  const catCreated = plan.categories.createDocs.reduce((n, d) => n + d.rows.length, 0);
  const rows = [
    ['categories', catCreated, plan.categories.updateRows.length, plan.categories.skippedRows.length],
    ['listing categories', plan.listingCategory.moves.length, 0, plan.listingCategory.keptRows],
    ['hide_contact (services)', 0, plan.hideContact.rows.length, plan.hideContact.alreadyHidden],
    ['communities', plan.communities.createDocs.reduce((n, d) => n + d.perLocale.length, 0), 0, plan.communities.skippedSlugs.length],
    ['listings -> community', plan.listingCommunity.links.length, 0, plan.listingCommunity.existingPairs],
    ['members -> community', plan.memberCommunity.links.length, 0, plan.memberCommunity.existingPairs],
    ['artisan listing', plan.artisan.create ? plan.artisan.create.rows.length : 0, 0, plan.artisan.skipped ? 1 : 0],
    ['good-practices page', plan.goodPractices.create ? plan.goodPractices.create.perLocale.length : 0, 0, plan.goodPractices.skipped ? 1 : 0],
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
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const explicitLoc = valueFlag(args, '--db');
  const mapPath = valueFlag(args, '--map');
  const craftsArg = valueFlag(args, '--crafts');

  let mapOverrides = {};
  if (mapPath) {
    if (!fs.existsSync(mapPath)) {
      console.error(`Map file not found: ${mapPath}`);
      process.exit(2);
    }
    try {
      mapOverrides = parseMapFile(mapPath, COMMUNITY_CONTRACT.map((c) => c.slug));
    } catch (e) {
      console.error(`Bad --map config: ${e.message}`);
      process.exit(2);
    }
  }
  const craftsSlugs = craftsArg ? craftsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const dialect = process.env.DATABASE_CLIENT === 'postgres' || /^postgres(ql)?:\/\//.test(explicitLoc || '')
    ? 'postgres'
    : 'sqlite';
  const loc = dialect === 'postgres'
    ? explicitLoc || process.env.DATABASE_URL
    : explicitLoc
      ? path.resolve(process.cwd(), explicitLoc)
      : path.resolve(process.cwd(), process.env.DATABASE_FILENAME || '.tmp/data.db');

  if (dialect === 'sqlite' && !fs.existsSync(loc)) {
    console.error(`Database not found: ${loc}`);
    process.exit(2);
  }
  if (dialect === 'postgres' && !loc) {
    console.error('PostgreSQL target missing: pass --db <connection-string> or set DATABASE_URL');
    process.exit(2);
  }

  console.log(`Dialect:    ${dialect}`);
  console.log(`Target:     ${dialect === 'postgres' ? '<connection string redacted>' : loc}`);
  console.log(`Mode:       ${APPLY ? 'APPLY (migrate + snapshot written)' : 'DRY-RUN (no writes)'}\n`);

  const db = await openDb(dialect, loc);
  const plan = await planMigration(db, dialect, { mapOverrides, craftsSlugs });

  printPlan(plan);

  if (!planHasWork(plan)) {
    console.log('\nNothing to migrate — database already matches the redesign contract.');
    await closeDb(db, dialect);
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to execute.');
    await closeDb(db, dialect);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(
    dialect === 'sqlite' ? path.dirname(loc) : process.cwd(),
    `migrate-redesign-snapshot-${stamp}.json`
  );
  const totals = await applyMigration(db, dialect, plan, { snapshotPath, target: loc });
  console.log(
    `\nMigration complete: ${totals.categoriesCreated + totals.categoriesUpdated} category row(s), ` +
      `${totals.listingRowsRelinked} relink(s), ${totals.hideContactRows} hide_contact row(s), ` +
      `${totals.communitiesCreated} community row(s), ${totals.listingCommunityLinks} listing link(s), ` +
      `${totals.memberCommunityLinks} member link(s), artisan listing ${totals.artisanRows} row(s), ` +
      `good-practices ${totals.goodPracticesRows} row(s). Snapshot: ${snapshotPath}`
  );
  console.log('Re-run without --apply to confirm there is nothing left to do.');
  await closeDb(db, dialect);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('migrate-redesign failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  planMigration,
  planHasWork,
  applyMigration,
  buildSnapshot,
  parseMapFile,
  newDocumentId,
  CATEGORY_CONTRACT,
  COMMUNITY_CONTRACT,
  LEGACY_CATEGORY_TARGET,
  LISTING_COMMUNITY,
  LOCALITY_TO_COMMUNITY,
  KNOWN_CRAFTS_CANDIDATES,
  PAV_COORDS,
  RSC_COORDS,
  ARTISAN_LISTING,
};
