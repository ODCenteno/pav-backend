import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require_ = createRequire(import.meta.url);
const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'migrate-redesign.js'
);

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pav-migrate-redesign-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(dbPath, ...args) {
  const res = spawnSync('node', [SCRIPT_PATH, '--db', dbPath, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

/**
 * Minimal Strapi-shaped schema mirroring the verified physical layout of the
 * redesign tables: categories/listings/communities/good_practices_pages with
 * locale + draft/publish rows, the relation link tables (_lnk) with the same
 * unique indexes as production, and the component tables + _cmps link tables
 * the migration copies from guide_pages.
 */
function seedDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), name VARCHAR(255), slug VARCHAR(255),
      color VARCHAR(255), "order" INTEGER, published_at TEXT, locale VARCHAR(255),
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), title VARCHAR(255), slug VARCHAR(255),
      short_description TEXT, hide_contact BOOLEAN DEFAULT 0,
      "order" INTEGER, is_featured BOOLEAN DEFAULT 0,
      published_at TEXT, locale VARCHAR(255),
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE communities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), name VARCHAR(255), slug VARCHAR(255),
      tagline VARCHAR(255), description TEXT, "order" INTEGER,
      color VARCHAR(255), text_color VARCHAR(255), google_maps_url VARCHAR(255),
      history_text TEXT, tourist_map_caption VARCHAR(255),
      created_at TEXT, updated_at TEXT, published_at TEXT, locale VARCHAR(255)
    );
    CREATE TABLE good_practices_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), internal_label VARCHAR(255), conanp_url VARCHAR(255),
      influence_text TEXT, fishing_text TEXT,
      created_at TEXT, updated_at TEXT, published_at TEXT, locale VARCHAR(255)
    );
    CREATE TABLE listings_category_lnk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER, category_id INTEGER, listing_ord FLOAT, category_ord FLOAT
    );
    CREATE TABLE listings_community_lnk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER, community_id INTEGER, listing_ord FLOAT,
      UNIQUE (listing_id, community_id)
    );
    CREATE TABLE community_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), name VARCHAR(255), slug VARCHAR(255),
      locality VARCHAR(255), role VARCHAR(255),
      published_at TEXT, locale VARCHAR(255)
    );
    CREATE TABLE community_members_community_lnk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_member_id INTEGER, community_id INTEGER, community_member_ord FLOAT,
      UNIQUE (community_member_id, community_id)
    );
    CREATE TABLE community_members_listings_lnk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_member_id INTEGER, listing_id INTEGER, listing_ord FLOAT, community_member_ord FLOAT
    );
    CREATE TABLE communities_cmps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER, cmp_id INTEGER, component_type VARCHAR(255), field VARCHAR(255), "order" FLOAT,
      UNIQUE (entity_id, cmp_id, field, component_type)
    );
    CREATE TABLE good_practices_pages_cmps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER, cmp_id INTEGER, component_type VARCHAR(255), field VARCHAR(255), "order" FLOAT,
      UNIQUE (entity_id, cmp_id, field, component_type)
    );
    CREATE TABLE guide_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), locale VARCHAR(255), published_at TEXT,
      history_text TEXT, influence_text TEXT, fishing_text TEXT, driving_tips_header VARCHAR(255)
    );
    CREATE TABLE guide_pages_cmps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER, cmp_id INTEGER, component_type VARCHAR(255), field VARCHAR(255), "order" FLOAT
    );
    CREATE TABLE components_location_geo_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, geo_point TEXT
    );
    CREATE TABLE components_section_section_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title VARCHAR(255), subtitle VARCHAR(255)
    );
    CREATE TABLE components_guide_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, year VARCHAR(255), text TEXT
    );
    CREATE TABLE components_guide_text_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT
    );
    CREATE TABLE components_guide_protected_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title VARCHAR(255), text TEXT,
      link_label VARCHAR(255), link_href VARCHAR(255)
    );
  `);
  return db;
}

const linkCategory = (db, listingId, categoryId) =>
  db
    .prepare('INSERT INTO listings_category_lnk (listing_id, category_id, listing_ord, category_ord) VALUES (?, ?, 1, 1)')
    .run(listingId, categoryId).lastInsertRowid;

const linkMemberListing = (db, memberId, listingId) =>
  db
    .prepare('INSERT INTO community_members_listings_lnk (community_member_id, listing_id, listing_ord, community_member_ord) VALUES (?, ?, NULL, NULL)')
    .run(memberId, listingId).lastInsertRowid;

/**
 * Full pre-migration fixture:
 * - legacy categories (sites, accommodation, restaurants) + mislabeled
 *   experiences/services docs; NO gastronomy/crafts.
 * - listing documents with es-MX + en rows (artesanias-andrea has an extra
 *   es-MX draft row to prove "all rows" semantics).
 * - community members: leonor (artisan, agua-verde), chencha (cook,
 *   agua-verde, linked to her listing), one member with no locality.
 * - guide_pages published rows for both locales with linked components
 *   (headers, milestones, protected link, text list items) at non-contiguous
 *   orders so the renumbering is observable.
 */
function seedRedesignFixture(db) {
  const ids = { cats: {}, listings: {}, members: {}, guide: { cmps: {} } };

  const cat = (docId, slug, name, order, locale, color) =>
    db
      .prepare(
        `INSERT INTO categories (document_id, slug, name, color, "order", published_at, locale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '2026-01-01', ?, '2026-01-01', '2026-01-01')`
      )
      .run(docId, slug, name, color, order, locale).lastInsertRowid;
  for (const [slug, esName, enName, order, color] of [
    ['experiences', 'Experiencias', 'Experiences', 5, '#4A90D9'],
    ['services', 'Servicios extra', 'Extra services', 7, '#9B59B6'],
    ['sites', 'Sitios', 'Sites', 2, '#123456'],
    ['accommodation', 'Alojamiento', 'Accommodation', 3, '#654321'],
    ['restaurants', 'Restaurantes', 'Restaurants', 4, '#FF7043'],
  ]) {
    ids.cats[slug] = {
      'es-MX': cat(`doc-cat-${slug}`, slug, esName, order, 'es-MX', color),
      en: cat(`doc-cat-${slug}`, slug, enName, order, 'en', color),
    };
  }

  const listing = (docId, slug, title, locale, published = true) =>
    db
      .prepare(
        `INSERT INTO listings (document_id, title, slug, short_description, hide_contact, "order", is_featured, published_at, locale, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 0, 0, 0, ?, ?, '2026-01-01', '2026-01-01')`
      )
      .run(docId, title, slug, published ? '2026-01-01' : null, locale).lastInsertRowid;
  const listingDoc = (slug, esTitle, enTitle, categorySlug, opts = {}) => {
    const docId = `doc-l-${slug}`;
    ids.listings[slug] = {
      'es-MX': listing(docId, slug, esTitle, 'es-MX', !opts.draftEs),
      ...(opts.draftEs ? { 'es-MX-draft': listing(docId, slug, esTitle, 'es-MX', false) } : {}),
      en: listing(docId, slug, enTitle, 'en'),
    };
    for (const key of Object.keys(ids.listings[slug])) {
      linkCategory(db, ids.listings[slug][key], ids.cats[categorySlug][key === 'es-MX-draft' ? 'es-MX' : key]);
    }
  };

  listingDoc('museo-la-concha', 'Museo La Concha', 'La Concha Museum', 'sites');
  listingDoc('hospedaje-playa', 'Hospedaje Playa', 'Beach Lodging', 'accommodation');
  listingDoc('restaurante-brisa-del-mar', 'Restaurante Brisa del Mar', 'Brisa del Mar Restaurant', 'restaurants');
  listingDoc('restaurante-puerto-bello', 'Restaurante Puerto Bello', 'Puerto Bello Restaurant', 'restaurants');
  listingDoc('cocina-de-dona-chencha', 'Cocina de Doña Chencha', "Doña Chencha's Kitchen", 'sites');
  listingDoc('mystery-place', 'Lugar misterioso', 'Mystery Place', 'sites');
  listingDoc('artesanias-joyas-del-mar', 'Artesanías Joyas del Mar', 'Joyas del Mar Crafts', 'services');
  listingDoc('artesanias-andrea', 'Artesanías Andrea', 'Andrea Crafts', 'services', { draftEs: true });

  const member = (docId, slug, name, locality, role, locale) =>
    db
      .prepare(
        `INSERT INTO community_members (document_id, name, slug, locality, role, published_at, locale)
         VALUES (?, ?, ?, ?, ?, '2026-01-01', ?)`
      )
      .run(docId, name, slug, locality, role, locale).lastInsertRowid;
  ids.members['leonor-gonzalez-cota'] = {
    'es-MX': member('doc-m-leonor', 'leonor-gonzalez-cota', 'Leonor González Cota', 'agua-verde', 'Artesana', 'es-MX'),
    en: member('doc-m-leonor', 'leonor-gonzalez-cota', 'Leonor González Cota', 'agua-verde', 'Artisan and craftswoman', 'en'),
  };
  ids.members['dona-chencha'] = {
    'es-MX': member('doc-m-chencha', 'dona-chencha', 'Doña Chencha', 'agua-verde', 'Cocinera', 'es-MX'),
    en: member('doc-m-chencha', 'dona-chencha', 'Doña Chencha', 'agua-verde', 'Cook', 'en'),
  };
  ids.members['miembro-sin-localidad'] = {
    'es-MX': member('doc-m-guia', 'miembro-sin-localidad', 'Guía Local', null, 'Guía', 'es-MX'),
    en: member('doc-m-guia', 'miembro-sin-localidad', 'Local Guide', null, 'Guide', 'en'),
  };
  linkMemberListing(db, ids.members['dona-chencha']['es-MX'], ids.listings['cocina-de-dona-chencha']['es-MX']);
  linkMemberListing(db, ids.members['dona-chencha'].en, ids.listings['cocina-de-dona-chencha'].en);

  // Guide pages (single type): one published row per locale with distinct texts.
  const addCmp = (entityId, field, type, order, table, values) => {
    const cols = Object.keys(values);
    const cmpId = db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...Object.values(values)).lastInsertRowid;
    db
      .prepare(`INSERT INTO guide_pages_cmps (entity_id, cmp_id, component_type, field, "order") VALUES (?, ?, ?, ?, ?)`)
      .run(entityId, cmpId, type, field, order);
    return cmpId;
  };
  for (const locale of ['es-MX', 'en']) {
    const suffix = locale === 'es-MX' ? 'ES' : 'EN';
    ids.guide[locale] = db
      .prepare(
        `INSERT INTO guide_pages (document_id, locale, published_at, history_text, influence_text, fishing_text, driving_tips_header)
         VALUES ('doc-guide', ?, '2026-01-01', ?, ?, ?, ?)`
      )
      .run(locale, `Historia de las comunidades ${suffix}`, `Texto de influencia ${suffix}`, `Texto de pesca ${suffix}`, `Consejos para conducir ${suffix}`)
      .lastInsertRowid;
    const gp = ids.guide[locale];
    const cmps = {};
    cmps.historyHeader = addCmp(gp, 'historyHeader', 'section.section-header', 1, 'components_section_section_headers', {
      title: `Nuestra historia ${suffix}`, subtitle: `Dos comunidades ${suffix}`,
    });
    cmps.historyMilestones = [
      addCmp(gp, 'historyMilestones', 'guide.milestone', 3, 'components_guide_milestones', { year: '1920', text: `Llegada ${suffix}` }),
      addCmp(gp, 'historyMilestones', 'guide.milestone', 7, 'components_guide_milestones', { year: '1985', text: `Escuela ${suffix}` }),
    ];
    cmps.influenceHeader = addCmp(gp, 'influenceHeader', 'section.section-header', 1, 'components_section_section_headers', {
      title: `Influencia ${suffix}`, subtitle: `Área de influencia ${suffix}`,
    });
    cmps.fishingHeader = addCmp(gp, 'fishingHeader', 'section.section-header', 1, 'components_section_section_headers', {
      title: `Refugio ${suffix}`, subtitle: `Pesca ${suffix}`,
    });
    cmps.protectedArea = addCmp(gp, 'protectedArea', 'guide.protected-link', 1, 'components_guide_protected_links', {
      title: `Área protegida ${suffix}`, text: `Texto ANP ${suffix}`,
      link_label: `Ver CONANP ${suffix}`, link_href: 'https://www.gob.mx/conanp',
    });
    cmps.fishingRules = [
      addCmp(gp, 'fishingRules', 'guide.text-list-item', 5, 'components_guide_text_list_items', { text: `Regla 1 ${suffix}` }),
      addCmp(gp, 'fishingRules', 'guide.text-list-item', 9, 'components_guide_text_list_items', { text: `Regla 2 ${suffix}` }),
    ];
    cmps.recommendationsHeader = addCmp(gp, 'recommendationsHeader', 'section.section-header', 1, 'components_section_section_headers', {
      title: `Recomendaciones ${suffix}`, subtitle: `Antes de viajar ${suffix}`,
    });
    cmps.recommendations = [
      addCmp(gp, 'recommendations', 'guide.text-list-item', 2, 'components_guide_text_list_items', { text: `Recomendación 1 ${suffix}` }),
      addCmp(gp, 'recommendations', 'guide.text-list-item', 6, 'components_guide_text_list_items', { text: `Recomendación 2 ${suffix}` }),
    ];
    cmps.drivingTips = [
      addCmp(gp, 'drivingTips', 'guide.text-list-item', 4, 'components_guide_text_list_items', { text: `Tip 1 ${suffix}` }),
      addCmp(gp, 'drivingTips', 'guide.text-list-item', 8, 'components_guide_text_list_items', { text: `Tip 2 ${suffix}` }),
    ];
    ids.guide.cmps[locale] = cmps;
  }

  return ids;
}

function seedFixtureDb(dbPath) {
  const db = seedDb(dbPath);
  const ids = seedRedesignFixture(db);
  db.close();
  return ids;
}

const COUNTED_TABLES = [
  'categories', 'listings', 'communities', 'good_practices_pages', 'community_members', 'guide_pages',
  'listings_category_lnk', 'listings_community_lnk',
  'community_members_community_lnk', 'community_members_listings_lnk',
  'communities_cmps', 'good_practices_pages_cmps', 'guide_pages_cmps',
  'components_location_geo_points', 'components_section_section_headers',
  'components_guide_milestones', 'components_guide_text_list_items', 'components_guide_protected_links',
];
function countRows(dbPath) {
  const db = new Database(dbPath);
  const out = {};
  for (const t of COUNTED_TABLES) out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  db.close();
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('migrate-redesign CLI (sqlite)', () => {
  it('dry-run writes nothing and exits 1 with plan markers', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    seedFixtureDb(dbPath);
    const before = fs.readFileSync(dbPath);

    const res = runCli(dbPath);
    expect(res.code).toBe(1);
    expect(res.out).toContain('DRY-RUN');
    expect(res.out).toContain('[CATEGORY-CREATE]');
    expect(res.out).toContain('[CATEGORY-UPDATE]');
    expect(res.out).toContain('[RELINK]');
    expect(res.out).toContain('[COMMUNITY-CREATE]');
    expect(res.out).toContain('[GOOD-PRACTICES-CREATE]');

    // Byte-identical database file after the dry run.
    expect(sha256(fs.readFileSync(dbPath))).toBe(sha256(before));
    const check = new Database(dbPath);
    for (const t of ['communities', 'good_practices_pages', 'listings_community_lnk', 'community_members_community_lnk', 'communities_cmps', 'good_practices_pages_cmps', 'components_location_geo_points']) {
      expect(check.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c).toBe(0);
    }
    expect(check.prepare(`SELECT name FROM categories WHERE slug = 'experiences' AND locale = 'es-MX'`).get().name).toBe('Experiencias');
    expect(check.prepare(`SELECT COUNT(*) AS c FROM categories WHERE slug IN ('gastronomy', 'crafts')`).get().c).toBe(0);
    check.close();

    // No snapshot on dry-run.
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('migrate-redesign-snapshot-'))).toHaveLength(0);
  });

  it('--apply produces the contract rows, and a second --apply is a no-op', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const ids = seedFixtureDb(dbPath);

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    const check = new Database(dbPath);

    // --- Categories -------------------------------------------------------
    const cats = check.prepare(`SELECT document_id, slug, locale, name, color, "order" AS ord, published_at FROM categories`).all();
    const by = (slug, locale) => cats.filter((c) => c.slug === slug && c.locale === locale);
    expect(by('gastronomy', 'es-MX')).toEqual([
      matchDoc({ name: 'Gastronomía regional', color: '#FF7043', ord: 2, published_at: expect.any(String) }),
    ]);
    expect(by('gastronomy', 'en')).toEqual([
      matchDoc({ name: 'Regional gastronomy', color: '#FF7043', ord: 2, published_at: expect.any(String) }),
    ]);
    expect(by('crafts', 'es-MX')).toEqual([
      matchDoc({ name: 'Artesanías y productos locales', color: null, ord: 4, published_at: expect.any(String) }),
    ]);
    expect(by('crafts', 'en')).toEqual([
      matchDoc({ name: 'Crafts and local products', color: null, ord: 4, published_at: expect.any(String) }),
    ]);
    for (const slug of ['gastronomy', 'crafts']) {
      const docs = new Set(cats.filter((c) => c.slug === slug).map((c) => c.document_id));
      expect(docs.size).toBe(1);
      expect([...docs][0]).toMatch(/^[0-9a-z]{25}$/);
    }
    // Relabeled existing docs (both locales, no new rows).
    expect(by('experiences', 'es-MX').map((c) => [c.name, c.ord])).toEqual([['Experiencias turísticas comunitarias', 1]]);
    expect(by('experiences', 'en').map((c) => [c.name, c.ord])).toEqual([['Community tourism experiences', 1]]);
    expect(by('services', 'es-MX').map((c) => [c.name, c.ord])).toEqual([['Servicios', 3]]);
    expect(by('services', 'en').map((c) => [c.name, c.ord])).toEqual([['Services', 3]]);
    // Legacy docs untouched.
    expect(by('sites', 'es-MX').map((c) => [c.name, c.ord])).toEqual([['Sitios', 2]]);
    expect(by('restaurants', 'en').map((c) => [c.name, c.ord])).toEqual([['Restaurants', 4]]);

    // --- Listing category reassignment (per physical row, same locale) ----
    const listingCategorySlugs = (listingId) =>
      check
        .prepare(
          `SELECT c.slug FROM listings_category_lnk lc JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id = ?`
        )
        .all(listingId)
        .map((r) => r.slug);
    expect(listingCategorySlugs(ids.listings['museo-la-concha']['es-MX'])).toEqual(['experiences']);
    expect(listingCategorySlugs(ids.listings['museo-la-concha'].en)).toEqual(['experiences']);
    expect(listingCategorySlugs(ids.listings['hospedaje-playa'].en)).toEqual(['experiences']);
    expect(listingCategorySlugs(ids.listings['restaurante-brisa-del-mar']['es-MX'])).toEqual(['gastronomy']);
    expect(listingCategorySlugs(ids.listings['restaurante-puerto-bello'].en)).toEqual(['gastronomy']);
    expect(listingCategorySlugs(ids.listings['artesanias-andrea']['es-MX'])).toEqual(['services']);
    // No listing row still points at a legacy category.
    const legacyLeft = check
      .prepare(
        `SELECT COUNT(*) AS c FROM listings_category_lnk lc JOIN categories c ON c.id = lc.category_id WHERE c.slug IN ('sites', 'accommodation', 'restaurants')`
      )
      .get().c;
    expect(legacyLeft).toBe(0);

    // --- hideContact: services docs only, ALL their rows -------------------
    const hideContactOf = (slug) =>
      check.prepare(`SELECT id, hide_contact FROM listings WHERE slug = ? ORDER BY id`).all(slug).map((r) => r.hide_contact);
    expect(hideContactOf('artesanias-andrea')).toEqual([1, 1, 1]); // es pub, es draft, en
    expect(hideContactOf('artesanias-joyas-del-mar')).toEqual([1, 1]);
    for (const slug of ['museo-la-concha', 'hospedaje-playa', 'restaurante-brisa-del-mar', 'restaurante-puerto-bello', 'cocina-de-dona-chencha', 'mystery-place']) {
      expect(hideContactOf(slug)).not.toContain(1);
    }

    // --- Communities --------------------------------------------------------
    const pavEs = check.prepare(`SELECT *, "order" AS ord FROM communities WHERE slug = 'puerto-agua-verde' AND locale = 'es-MX'`).get();
    const pavEn = check.prepare(`SELECT *, "order" AS ord FROM communities WHERE slug = 'puerto-agua-verde' AND locale = 'en'`).get();
    const rscEs = check.prepare(`SELECT *, "order" AS ord FROM communities WHERE slug = 'rancho-san-cosme' AND locale = 'es-MX'`).get();
    const rscEn = check.prepare(`SELECT *, "order" AS ord FROM communities WHERE slug = 'rancho-san-cosme' AND locale = 'en'`).get();
    expect([pavEs.name, pavEs.ord, pavEs.color, pavEs.text_color, pavEs.published_at, pavEs.tagline, pavEs.google_maps_url]).toEqual([
      'Puerto Agua Verde', 1, '#0CA58C', '#08806D', expect.any(String), null, null,
    ]);
    expect(pavEs.document_id).toBe(pavEn.document_id);
    expect(pavEs.document_id).toMatch(/^[0-9a-z]{25}$/);
    expect([rscEs.name, rscEs.ord, rscEs.color, rscEs.text_color]).toEqual(['Rancho San Cosme', 2, '#EC6E0B', '#B85206']);
    expect(rscEs.document_id).toBe(rscEn.document_id);

    const geoPointOf = (communityId) => {
      const row = check
        .prepare(
          `SELECT gp.geo_point FROM communities_cmps cc JOIN components_location_geo_points gp ON gp.id = cc.cmp_id
            WHERE cc.entity_id = ? AND cc.field = 'location' AND cc.component_type = 'location.geo-point'`
        )
        .get(communityId);
      return row ? JSON.parse(row.geo_point) : null;
    };
    expect(geoPointOf(pavEs.id)).toEqual({ lat: 25.51204, lng: -111.07577 });
    expect(geoPointOf(pavEn.id)).toEqual({ lat: 25.51204, lng: -111.07577 });
    expect(geoPointOf(rscEs.id)).toEqual({ lat: 25.5784138, lng: -111.1694027 });
    expect(geoPointOf(rscEn.id)).toEqual({ lat: 25.5784138, lng: -111.1694027 });

    // History starting content copied per locale, components DUPLICATED (new rows).
    expect([pavEs.history_text, pavEn.history_text, rscEs.history_text]).toEqual([
      'Historia de las comunidades ES', 'Historia de las comunidades EN', 'Historia de las comunidades ES',
    ]);
    const historyHeaderOf = (communityId) =>
      check
        .prepare(
          `SELECT sh.id, sh.title, sh.subtitle FROM communities_cmps cc JOIN components_section_section_headers sh ON sh.id = cc.cmp_id
            WHERE cc.entity_id = ? AND cc.field = 'historyHeader' AND cc.component_type = 'section.section-header'`
        )
        .get(communityId);
    const pavEsHeader = historyHeaderOf(pavEs.id);
    expect(pavEsHeader.title).toBe('Nuestra historia ES');
    expect(pavEsHeader.id).not.toBe(ids.guide.cmps['es-MX'].historyHeader); // duplicated, not shared
    const milestonesOf = (communityId) =>
      check
        .prepare(
          `SELECT cc."order" AS ord, m.year, m.text FROM communities_cmps cc JOIN components_guide_milestones m ON m.id = cc.cmp_id
            WHERE cc.entity_id = ? AND cc.field = 'historyMilestones' AND cc.component_type = 'guide.milestone' ORDER BY cc."order"`
        )
        .all(communityId);
    expect(milestonesOf(pavEs.id)).toEqual([
      { ord: 1, year: '1920', text: 'Llegada ES' },
      { ord: 2, year: '1985', text: 'Escuela ES' },
    ]);
    expect(milestonesOf(rscEn.id)).toEqual([
      { ord: 1, year: '1920', text: 'Llegada EN' },
      { ord: 2, year: '1985', text: 'Escuela EN' },
    ]);
    // Guide page sources untouched (13 links per locale seeded).
    expect(check.prepare(`SELECT COUNT(*) AS c FROM guide_pages_cmps`).get().c).toBe(26);

    // --- Listings -> community (same-locale targets) -----------------------
    const communityIdOfListing = (listingId) =>
      check
        .prepare(`SELECT community_id FROM listings_community_lnk WHERE listing_id = ?`)
        .all(listingId)
        .map((r) => r.community_id);
    expect(communityIdOfListing(ids.listings['restaurante-brisa-del-mar']['es-MX'])).toEqual([pavEs.id]);
    expect(communityIdOfListing(ids.listings['restaurante-brisa-del-mar'].en)).toEqual([pavEn.id]);
    expect(communityIdOfListing(ids.listings['restaurante-puerto-bello']['es-MX'])).toEqual([pavEs.id]);
    expect(communityIdOfListing(ids.listings['museo-la-concha']['es-MX'])).toEqual([rscEs.id]);
    expect(communityIdOfListing(ids.listings['museo-la-concha'].en)).toEqual([rscEn.id]);
    expect(communityIdOfListing(ids.listings['artesanias-andrea']['es-MX'])).toEqual([rscEs.id]);
    expect(communityIdOfListing(ids.listings['artesanias-andrea']['es-MX-draft'])).toEqual([rscEs.id]);
    // cocina-de-dona-chencha has no map entry: resolved via linked member locality.
    expect(communityIdOfListing(ids.listings['cocina-de-dona-chencha'].en)).toEqual([pavEn.id]);
    // Unresolved listings get NO community link.
    expect(communityIdOfListing(ids.listings['mystery-place']['es-MX'])).toEqual([]);
    expect(communityIdOfListing(ids.listings['hospedaje-playa'].en)).toEqual([]);

    // --- Members -> community ----------------------------------------------
    const communityIdOfMember = (memberId) =>
      check
        .prepare(`SELECT community_id FROM community_members_community_lnk WHERE community_member_id = ?`)
        .all(memberId)
        .map((r) => r.community_id);
    expect(communityIdOfMember(ids.members['leonor-gonzalez-cota']['es-MX'])).toEqual([pavEs.id]);
    expect(communityIdOfMember(ids.members['leonor-gonzalez-cota'].en)).toEqual([pavEn.id]);
    expect(communityIdOfMember(ids.members['dona-chencha']['es-MX'])).toEqual([pavEs.id]);
    expect(communityIdOfMember(ids.members['miembro-sin-localidad']['es-MX'])).toEqual([]);
    // locality column untouched.
    expect(check.prepare(`SELECT locality FROM community_members WHERE id = ?`).get(ids.members['leonor-gonzalez-cota'].en).locality).toBe('agua-verde');

    // --- Artisans group listing (draft) -------------------------------------
    const artisanRows = check.prepare(`SELECT * FROM listings WHERE slug = 'artesanas-de-puerto-agua-verde' ORDER BY locale`).all();
    expect(artisanRows).toHaveLength(2);
    const artisanEs = artisanRows.find((r) => r.locale === 'es-MX');
    const artisanEn = artisanRows.find((r) => r.locale === 'en');
    expect([artisanEs.title, artisanEs.published_at, artisanEs.hide_contact, artisanEs.is_featured]).toEqual([
      'Artesanas de Puerto Agua Verde', null, 0, 0,
    ]);
    expect([artisanEn.title, artisanEn.published_at]).toEqual(['Artisans of Puerto Agua Verde', null]);
    expect(artisanEs.document_id).toBe(artisanEn.document_id);
    expect(listingCategorySlugs(artisanEs.id)).toEqual(['crafts']);
    expect(listingCategorySlugs(artisanEn.id)).toEqual(['crafts']);
    expect(communityIdOfListing(artisanEs.id)).toEqual([pavEs.id]);
    expect(communityIdOfListing(artisanEn.id)).toEqual([pavEn.id]);
    // Only artisan members (role match) are linked; the cook is not.
    const artisanListingIds = new Set(artisanRows.map((r) => r.id));
    const memberListingPairs = check
      .prepare(`SELECT community_member_id, listing_id FROM community_members_listings_lnk`)
      .all()
      .filter((r) => artisanListingIds.has(r.listing_id));
    expect(memberListingPairs).toEqual([
      { community_member_id: ids.members['leonor-gonzalez-cota']['es-MX'], listing_id: artisanEs.id },
      { community_member_id: ids.members['leonor-gonzalez-cota'].en, listing_id: artisanEn.id },
    ]);
    expect(res.out).toContain('leonor-gonzalez-cota');

    // --- Good-practices page (draft, copied from guide-page) -----------------
    const gpRows = check.prepare(`SELECT * FROM good_practices_pages ORDER BY locale`).all();
    expect(gpRows).toHaveLength(2);
    const gpEs = gpRows.find((r) => r.locale === 'es-MX');
    const gpEn = gpRows.find((r) => r.locale === 'en');
    expect([gpEs.internal_label, gpEs.published_at, gpEs.influence_text, gpEs.fishing_text, gpEs.conanp_url]).toEqual([
      'Good Practices Page', null, 'Texto de influencia ES', 'Texto de pesca ES', null,
    ]);
    expect([gpEn.influence_text, gpEn.fishing_text]).toEqual(['Texto de influencia EN', 'Texto de pesca EN']);
    expect(gpEs.document_id).toBe(gpEn.document_id);

    const gpField = (gpId, field, cmpTable, cmpCols) =>
      check
        .prepare(
          `SELECT gc."order" AS ord, ${cmpCols.map((c) => `t.${c}`).join(', ')} FROM ${'good_practices_pages_cmps'} gc
            JOIN ${cmpTable} t ON t.id = gc.cmp_id
            WHERE gc.entity_id = ? AND gc.field = ? ORDER BY gc."order"`
        )
        .all(gpId, field);
    expect(gpField(gpEs.id, 'protectedArea', 'components_guide_protected_links', ['title', 'link_label'])).toEqual([
      { ord: 1, title: 'Área protegida ES', link_label: 'Ver CONANP ES' },
    ]);
    expect(gpField(gpEs.id, 'fishingRules', 'components_guide_text_list_items', ['text'])).toEqual([
      { ord: 1, text: 'Regla 1 ES' },
      { ord: 2, text: 'Regla 2 ES' },
    ]);
    expect(gpField(gpEs.id, 'recommendations', 'components_guide_text_list_items', ['text'])).toEqual([
      { ord: 1, text: 'Recomendación 1 ES' },
      { ord: 2, text: 'Recomendación 2 ES' },
    ]);
    expect(gpField(gpEs.id, 'tips', 'components_guide_text_list_items', ['text'])).toEqual([
      { ord: 1, text: 'Tip 1 ES' },
      { ord: 2, text: 'Tip 2 ES' },
    ]);
    expect(gpField(gpEs.id, 'tipsHeader', 'components_section_section_headers', ['title', 'subtitle'])).toEqual([
      { ord: 1, title: 'Consejos para conducir ES', subtitle: null },
    ]);
    expect(gpField(gpEn.id, 'tipsHeader', 'components_section_section_headers', ['title', 'subtitle'])).toEqual([
      { ord: 1, title: 'Consejos para conducir EN', subtitle: null },
    ]);
    expect(gpField(gpEs.id, 'influenceHeader', 'components_section_section_headers', ['title'])).toEqual([
      { ord: 1, title: 'Influencia ES' },
    ]);
    // Empty fields stay empty.
    expect(check.prepare(`SELECT COUNT(*) AS c FROM good_practices_pages_cmps WHERE entity_id = ? AND field NOT IN ('protectedArea','influenceHeader','fishingHeader','fishingRules','recommendationsHeader','recommendations','tipsHeader','tips')`).get(gpEs.id).c).toBe(0);

    // --- Manual review report ------------------------------------------------
    expect(res.out).toContain('Needs manual review');
    expect(res.out).toContain('mystery-place');
    expect(res.out).toContain('hospedaje-playa');
    expect(res.out).toContain('[crafts-candidate] artesanias-andrea');
    expect(res.out).toContain('[crafts-candidate] artesanias-joyas-del-mar');
    expect(res.out).toContain('[crafts-color]');
    expect(res.out).toContain('[member-locality] miembro-sin-localidad');

    check.close();

    // --- Second --apply run: no-op -------------------------------------------
    const countsAfterFirst = countRows(dbPath);
    const res2 = runCli(dbPath, '--apply');
    expect(res2.code).toBe(0);
    expect(res2.out).toContain('Nothing to migrate');
    expect(countRows(dbPath)).toEqual(countsAfterFirst);
    // Still exactly one snapshot (the no-op apply exits before writing one).
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('migrate-redesign-snapshot-'))).toHaveLength(1);
  });

  it('writes a pre-state snapshot next to the DB on --apply only', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    seedFixtureDb(dbPath);

    const dry = runCli(dbPath);
    expect(dry.code).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('migrate-redesign-snapshot-'))).toHaveLength(0);

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    const snapshots = fs.readdirSync(dir).filter((f) => f.startsWith('migrate-redesign-snapshot-'));
    expect(snapshots).toHaveLength(1);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, snapshots[0]), 'utf8'));
    // Pre-state of rows the script touches: old category labels and the
    // legacy category links that will be deleted.
    const expEs = snap.preState.categoriesToUpdate.find((r) => r.slug === 'experiences' && r.locale === 'es-MX');
    expect(expEs).toMatchObject({ name: 'Experiencias', ord: 5 });
    const svcEn = snap.preState.categoriesToUpdate.find((r) => r.slug === 'services' && r.locale === 'en');
    expect(svcEn).toMatchObject({ name: 'Extra services', ord: 7 });
    expect(snap.preState.categoryLinksToDelete.length).toBeGreaterThanOrEqual(12);
    expect(snap.preState.categoryLinksToDelete.some((r) => r.category_slug === 'sites' && r.listing_slug === 'museo-la-concha')).toBe(true);
    expect([...new Set(snap.preState.listingsToHideContact.map((r) => r.slug))].sort()).toEqual(['artesanias-andrea', 'artesanias-joyas-del-mar']);
  });

  it('--crafts= moves the given services listing into crafts (no hideContact)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const ids = seedFixtureDb(dbPath);

    const res = runCli(dbPath, '--apply', '--crafts=artesanias-andrea');
    expect(res.code).toBe(0);
    const check = new Database(dbPath);

    const craftsEs = check.prepare(`SELECT id FROM categories WHERE slug = 'crafts' AND locale = 'es-MX'`).get().id;
    const catSlugs = (listingId) =>
      check
        .prepare(`SELECT c.slug FROM listings_category_lnk lc JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id = ?`)
        .all(listingId)
        .map((r) => r.slug);
    expect(catSlugs(ids.listings['artesanias-andrea']['es-MX'])).toEqual(['crafts']);
    expect(catSlugs(ids.listings['artesanias-andrea']['es-MX-draft'])).toEqual(['crafts']);
    expect(catSlugs(ids.listings['artesanias-andrea'].en)).toEqual(['crafts']);
    expect(craftsEs).toBeTruthy();
    // hideContact only on the listing that stayed in services.
    expect(check.prepare(`SELECT hide_contact FROM listings WHERE slug = 'artesanias-andrea' ORDER BY id`).all().map((r) => r.hide_contact)).toEqual([0, 0, 0]);
    expect(check.prepare(`SELECT hide_contact FROM listings WHERE slug = 'artesanias-joyas-del-mar' ORDER BY id`).all().map((r) => r.hide_contact)).toEqual([1, 1]);
    // Moved listing is no longer a crafts candidate; the other one still is.
    expect(res.out).toContain('[crafts-candidate] artesanias-joyas-del-mar');
    expect(res.out).not.toContain('[crafts-candidate] artesanias-andrea');
    check.close();
  });

  it('--map CSV override wins over the embedded table', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const ids = seedFixtureDb(dbPath);
    const mapPath = path.join(dir, 'overrides.csv');
    fs.writeFileSync(mapPath, 'restaurante-brisa-del-mar,rancho-san-cosme\nmystery-place,puerto-agua-verde\n');

    const res = runCli(dbPath, '--apply', `--map=${mapPath}`);
    expect(res.code).toBe(0);
    const check = new Database(dbPath);
    const rscEs = check.prepare(`SELECT id FROM communities WHERE slug = 'rancho-san-cosme' AND locale = 'es-MX'`).get().id;
    const pavEn = check.prepare(`SELECT id FROM communities WHERE slug = 'puerto-agua-verde' AND locale = 'en'`).get().id;
    const communityOf = (listingId) =>
      check.prepare(`SELECT community_id FROM listings_community_lnk WHERE listing_id = ?`).all(listingId).map((r) => r.community_id);
    // Embedded table said puerto-agua-verde; the CSV wins.
    expect(communityOf(ids.listings['restaurante-brisa-del-mar']['es-MX'])).toEqual([rscEs]);
    // The unresolved listing is resolved by the CSV.
    expect(communityOf(ids.listings['mystery-place'].en)).toEqual([pavEn]);
    // mystery-place is not reported anymore.
    expect(res.out).not.toContain('[listing->community] mystery-place');
    check.close();
  });

  it('exposes the contract coordinates as constants (guards against RSC_COORDS reuse)', () => {
    const mod = require_(SCRIPT_PATH);
    expect(mod.PAV_COORDS).toEqual({ lat: 25.51204, lng: -111.07577 });
    expect(mod.RSC_COORDS).toEqual({ lat: 25.5784138, lng: -111.1694027 });
  });
});

function matchDoc(expected) {
  return expect.objectContaining({
    name: expected.name,
    color: expected.color,
    ord: expected.ord,
    published_at: expected.published_at,
  });
}
