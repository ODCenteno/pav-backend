import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'migrate-locale-components.js'
);

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pav-migrate-locales-'));
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
 * Minimal Strapi-shaped schema: listings with draft/published rows per
 * (document, locale), the morph link table with the same unique index as
 * production, and the component tables this migration touches (dual fields
 * + the new single fields, mirroring the post-Phase-1 expand state).
 */
function seedDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), locale VARCHAR(255), slug VARCHAR(255),
      published_at TEXT
    );
    CREATE TABLE listings_cmps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER, cmp_id INTEGER,
      component_type VARCHAR(255), field VARCHAR(255), "order" FLOAT
    );
    CREATE UNIQUE INDEX listings_uq ON listings_cmps (entity_id, cmp_id, field, component_type);
    CREATE TABLE components_tag_tag_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label_es VARCHAR(255), label_en VARCHAR(255), label VARCHAR(255)
    );
    CREATE TABLE components_schedule_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text_es TEXT, text_en TEXT, text TEXT
    );
    CREATE TABLE components_common_localized_texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text_es TEXT, text_en TEXT, text TEXT
    );
    CREATE TABLE components_recommendation_visit_infos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      best_time_es TEXT, best_time_en TEXT, bring_es TEXT, bring_en TEXT,
      accessibility_notes_es TEXT, accessibility_notes_en TEXT,
      connectivity_notes_es TEXT, connectivity_notes_en TEXT
    );
    CREATE TABLE components_amenity_amenity_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label VARCHAR(255), content TEXT
    );
    CREATE TABLE components_recommendation_recommendation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label VARCHAR(255), description TEXT
    );
    CREATE TABLE components_contact_social_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label VARCHAR(255), url VARCHAR(255)
    );
  `);
  return db;
}

const link = (db, entityId, cmpId, type, field, order = null) =>
  db
    .prepare('INSERT INTO listings_cmps (entity_id, cmp_id, component_type, field, "order") VALUES (?, ?, ?, ?, ?)')
    .run(entityId, cmpId, type, field, order).lastInsertRowid;

describe('migrate-locale-components CLI (sqlite)', () => {
  it('dry-run reports pending work and exits 1 without writing', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db
      .prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')")
      .run().lastInsertRowid;
    const tagId = db
      .prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Aventura', 'Adventure')")
      .run().lastInsertRowid;
    link(db, esPub, tagId, 'tag.tag-item', 'tags');
    db.close();

    const { code, out } = runCli(dbPath);
    expect(code).toBe(1);
    expect(out).toContain('[MIGRATE] tag.tag-item: 1 row(s) set label');
    expect(out).toContain('Dry-run complete. Re-run with --apply');

    const check = new Database(dbPath);
    const tag = check.prepare('SELECT label FROM components_tag_tag_items').get();
    const links = check.prepare('SELECT COUNT(*) AS n FROM listings_cmps').get();
    check.close();
    expect(tag.label).toBeNull(); // untouched in dry-run
    expect(links.n).toBe(1);
  });

  it('--apply unshares a tag row shared by ES and EN entities (clone), keeps same-locale draft/publish sharing uncloned', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    // docA: ES draft + published (same locale, shared row must NOT clone)
    const esDraft = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera',NULL)").run().lastInsertRowid;
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    // docA: EN published — shares the SAME tag row with the ES entities (needs clone)
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','en','cantera','2026-01-01')").run().lastInsertRowid;

    const tagId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Aventura', 'Adventure')").run().lastInsertRowid;
    link(db, esDraft, tagId, 'tag.tag-item', 'tags');
    link(db, esPub, tagId, 'tag.tag-item', 'tags');
    link(db, enPub, tagId, 'tag.tag-item', 'tags');
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('1 clone(s) for shared rows');

    const check = new Database(dbPath);
    const rows = check.prepare('SELECT id, label FROM components_tag_tag_items ORDER BY id').all();
    const links = check
      .prepare(
        `SELECT e.locale, t.label FROM listings_cmps l
           JOIN listings e ON e.id = l.entity_id
           JOIN components_tag_tag_items t ON t.id = l.cmp_id
          WHERE l.field = 'tags' ORDER BY e.locale, e.id`
      )
      .all();
    check.close();

    // Row cloned exactly once: original + clone.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.label))).toEqual(new Set(['Aventura', 'Adventure']));
    // Every entity sees its locale's value; unique index never violated
    // (the apply completed without SQLITE_CONSTRAINT).
    expect(links).toHaveLength(3);
    for (const l of links.filter((x) => x.locale === 'es-MX')) expect(l.label).toBe('Aventura');
    expect(links.find((x) => x.locale === 'en').label).toBe('Adventure');
  });

  it('falls back to label_es for EN links when label_en is empty (no clone needed)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','en','cantera','2026-01-01')").run().lastInsertRowid;
    const tagId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Mar', '')").run().lastInsertRowid;
    link(db, esPub, tagId, 'tag.tag-item', 'tags');
    link(db, enPub, tagId, 'tag.tag-item', 'tags');
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('0 clone(s)');

    const check = new Database(dbPath);
    const rows = check.prepare('SELECT COUNT(*) AS n, SUM(label = \'Mar\') AS mar FROM components_tag_tag_items').get();
    check.close();
    expect(rows.n).toBe(1); // no clone
    expect(rows.mar).toBe(1);
  });

  it('swaps amenities in two phases: apply creates + keeps old links, cleanup deletes + prunes', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','en','cantera','2026-01-01')").run().lastInsertRowid;

    const keepId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Familia', 'Family')").run().lastInsertRowid;
    const swapEsId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Baños', 'Restrooms')").run().lastInsertRowid;
    const swapOnlyId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Wifi', 'Wifi')").run().lastInsertRowid;

    // keepId: used by tags (ES) AND amenities (EN) — must survive, never deleted.
    link(db, esPub, keepId, 'tag.tag-item', 'tags');
    link(db, enPub, keepId, 'tag.tag-item', 'amenities', 1);
    // swapEsId: amenities for ES entity.
    link(db, esPub, swapEsId, 'tag.tag-item', 'amenities', 3);
    // swapOnlyId: amenities only (EN entity) — becomes orphaned after the swap.
    link(db, enPub, swapOnlyId, 'tag.tag-item', 'amenities', 2);
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('amenities: 3 new amenity-item row(s)');

    const mid = new Database(dbPath);
    const amenityLinks = mid
      .prepare(
        `SELECT l.entity_id, l."order", a.label, a.content FROM listings_cmps l
           JOIN components_amenity_amenity_items a ON a.id = l.cmp_id
          WHERE l.field = 'amenities' AND l.component_type = 'amenity.amenity-item'
          ORDER BY l.entity_id, l."order"`
      )
      .all();
    const oldAmenityLinksAfterApply = mid
      .prepare("SELECT COUNT(*) AS n FROM listings_cmps WHERE field = 'amenities' AND component_type = 'tag.tag-item'")
      .get();
    const tagRowsAfterApply = mid.prepare('SELECT COUNT(*) AS n FROM components_tag_tag_items').get();
    mid.close();

    expect(amenityLinks).toHaveLength(3);
    // Per-locale values, order preserved per entity.
    expect(amenityLinks.find((l) => l.entity_id === esPub)).toMatchObject({ order: 3, label: 'Baños', content: '' });
    const en = amenityLinks.filter((l) => l.entity_id === enPub);
    expect(en.map((l) => [l.order, l.label])).toEqual([[1, 'Family'], [2, 'Wifi']]);
    // Expand/contract window: old links KEPT and nothing pruned yet. No
    // unshare clone: swap-consumed links don't take part in clone grouping
    // (their value lives on in the new amenity rows).
    expect(oldAmenityLinksAfterApply.n).toBe(3);
    expect(tagRowsAfterApply.n).toBe(3);

    // Dry-run now reports only cleanup work.
    const midDry = runCli(dbPath);
    expect(midDry.code).toBe(1);
    expect(midDry.out).toContain('apply phase complete');
    expect(midDry.out).toContain('cleanup phase HAS WORK');

    const clean = runCli(dbPath, '--cleanup');
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('Cleanup complete');

    const check = new Database(dbPath);
    const oldAmenityLinks = check
      .prepare("SELECT COUNT(*) AS n FROM listings_cmps WHERE field = 'amenities' AND component_type = 'tag.tag-item'")
      .get();
    const tagRows = check.prepare('SELECT id, label FROM components_tag_tag_items ORDER BY id').all();
    check.close();

    expect(oldAmenityLinks.n).toBe(0);
    // keepId survives (still used by tags); its clone + the amenities-only rows
    // were pruned once their kept links were deleted.
    expect(tagRows).toHaveLength(1);
    expect(tagRows[0].label).toBe('Familia');

    const recheck = runCli(dbPath);
    expect(recheck.code).toBe(0);
    expect(recheck.out).toContain('Nothing to migrate');
  });

  it('swaps recommendations per locale, skips empty fields, zero items for all-empty rows, keeps bring newlines', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','en','cantera','2026-01-01')").run().lastInsertRowid;
    const esDraft = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docB','es-MX','bahia',NULL)").run().lastInsertRowid;

    // Full row, SHARED by the ES and EN entities of docA (per-locale sets).
    const fullId = db
      .prepare(
        `INSERT INTO components_recommendation_visit_infos
           (best_time_es, best_time_en, bring_es, bring_en,
            accessibility_notes_es, accessibility_notes_en, connectivity_notes_es, connectivity_notes_en)
         VALUES ('Mañana', 'Morning', 'Protector solar\nToalla', 'Sunscreen\nTowel', 'Terracería', 'Dirt road', NULL, NULL)`
      )
      .run().lastInsertRowid;
    // Partial row: only best_time present.
    const partialId = db
      .prepare("INSERT INTO components_recommendation_visit_infos (best_time_es, best_time_en) VALUES ('Tarde', 'Afternoon')")
      .run().lastInsertRowid;
    // All-empty row: must produce ZERO items (and be pruned).
    const emptyId = db.prepare('INSERT INTO components_recommendation_visit_infos DEFAULT VALUES').run().lastInsertRowid;

    link(db, esPub, fullId, 'recommendation.visit-info', 'recommendations');
    link(db, enPub, fullId, 'recommendation.visit-info', 'recommendations');
    link(db, esDraft, partialId, 'recommendation.visit-info', 'recommendations');
    link(db, esPub, emptyId, 'recommendation.visit-info', 'recommendations');
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('recommendations: 7 new recommendation-item row(s)'); // 3 ES(docA) + 3 EN(docA) + 1 ES(docB)

    const mid = new Database(dbPath);
    const oldLinksAfterApply = mid
      .prepare("SELECT COUNT(*) AS n FROM listings_cmps WHERE component_type = 'recommendation.visit-info'")
      .get();
    const visitRowsAfterApply = mid.prepare('SELECT COUNT(*) AS n FROM components_recommendation_visit_infos').get();
    mid.close();
    // Window discipline: old links and visit-info rows kept until --cleanup.
    expect(oldLinksAfterApply.n).toBe(4);
    expect(visitRowsAfterApply.n).toBe(3);

    const clean = runCli(dbPath, '--cleanup');
    expect(clean.code).toBe(0);

    const check = new Database(dbPath);
    const items = check
      .prepare(
        `SELECT l.entity_id, l."order", r.label, r.description FROM listings_cmps l
           JOIN components_recommendation_recommendation_items r ON r.id = l.cmp_id
          WHERE l.field = 'recommendations'
          ORDER BY l.entity_id, l."order"`
      )
      .all();
    const oldLinks = check
      .prepare("SELECT COUNT(*) AS n FROM listings_cmps WHERE component_type = 'recommendation.visit-info'")
      .get();
    const visitRows = check.prepare('SELECT COUNT(*) AS n FROM components_recommendation_visit_infos').get();
    check.close();

    const esItems = items.filter((i) => i.entity_id === esPub);
    expect(esItems.map((i) => [i.order, i.label, i.description])).toEqual([
      [0, 'Mejor época para visitar', 'Mañana'],
      [1, 'Qué llevar', 'Protector solar\nToalla'], // raw \n preserved
      [2, 'Accesibilidad', 'Terracería'],
    ]);
    const enItems = items.filter((i) => i.entity_id === enPub);
    expect(enItems.map((i) => [i.order, i.label, i.description])).toEqual([
      [0, 'Best time to visit', 'Morning'],
      [1, 'What to bring', 'Sunscreen\nTowel'],
      [2, 'Accessibility', 'Dirt road'],
    ]);
    const partial = items.filter((i) => i.entity_id === esDraft);
    expect(partial.map((i) => [i.order, i.label])).toEqual([[0, 'Mejor época para visitar']]); // empty fields skipped
    expect(items.filter((i) => i.description === '' || i.description === null)).toHaveLength(0);
    expect(oldLinks.n).toBe(0);
    expect(visitRows.n).toBe(0); // all visit-info rows orphaned + pruned
  });

  it('deletes dangling component links and dead social links, keeps live ones; localized-text table empty is fine', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;

    const tagId = db.prepare("INSERT INTO components_tag_tag_items (label_es) VALUES ('Aventura')").run().lastInsertRowid;
    link(db, esPub, tagId, 'tag.tag-item', 'tags'); // live
    link(db, esPub, 9999, 'tag.tag-item', 'tags'); // dangling component row
    link(db, 4242, tagId, 'tag.tag-item', 'tags'); // dead entity row

    const socialLive = db.prepare("INSERT INTO components_contact_social_links (label, url) VALUES ('IG', 'https://ig.example')").run().lastInsertRowid;
    link(db, esPub, socialLive, 'contact.social-links', 'social'); // live social
    link(db, esPub, 7777, 'contact.social-links', 'social'); // dead social link (component row gone)
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('junk=3');

    const check = new Database(dbPath);
    const remaining = check
      .prepare('SELECT field, component_type, cmp_id FROM listings_cmps ORDER BY id')
      .all();
    check.close();
    expect(remaining).toEqual([
      { field: 'tags', component_type: 'tag.tag-item', cmp_id: tagId },
      { field: 'social', component_type: 'contact.social-links', cmp_id: socialLive },
    ]);
  });

  it('writes a snapshot next to the sqlite db and a re-run after --apply exits 0 clean', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const hoursId = db.prepare("INSERT INTO components_schedule_hours (text_es, text_en) VALUES ('L-V 8-17', 'M-F 8-5')").run().lastInsertRowid;
    link(db, esPub, hoursId, 'schedule.hours', 'schedule');
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);

    const snapshots = fs.readdirSync(dir).filter((f) => f.startsWith('locale-components-snapshot-'));
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, snapshots[0]), 'utf8'));
    expect(snapshot.inPlace['schedule.hours'].rowsBefore[0]).toMatchObject({
      id: hoursId,
      text_es: 'L-V 8-17',
      text_en: 'M-F 8-5',
    });
    expect(snapshot.junkDeleted).toEqual([]);
    expect(snapshot.inPlace['schedule.hours'].updates[0]).toMatchObject({ id: hoursId, value: 'L-V 8-17' });

    const check = new Database(dbPath);
    const hours = check.prepare('SELECT text FROM components_schedule_hours').get();
    check.close();
    expect(hours.text).toBe('L-V 8-17');

    const recheck = runCli(dbPath);
    expect(recheck.code).toBe(0);
    expect(recheck.out).toContain('Nothing to migrate');
  });

  it('--cleanup refuses to run while the apply phase still has pending work', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const tagId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Aventura', 'Adventure')").run().lastInsertRowid;
    link(db, esPub, tagId, 'tag.tag-item', 'tags');
    db.close();

    const res = runCli(dbPath, '--cleanup');
    expect(res.code).toBe(1);
    expect(res.out).toContain('Refusing --cleanup');

    const check = new Database(dbPath);
    const tag = check.prepare('SELECT label FROM components_tag_tag_items').get();
    check.close();
    expect(tag.label).toBeNull(); // nothing written
  });

  it('never erases already-filled single columns when the dual columns are empty (erasure guard)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    // Migrated row: single column filled, dual columns empty (e.g. re-added
    // by a schema sync after the contract). The planner must plan NOTHING.
    const tagId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en, label) VALUES ('', '', 'Aventura')").run().lastInsertRowid;
    const hoursId = db.prepare("INSERT INTO components_schedule_hours (text_es, text_en, text) VALUES ('', '', 'L-V 8-17')").run().lastInsertRowid;
    const amenitySrcId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en, label) VALUES ('', '', 'Wifi')").run().lastInsertRowid;
    link(db, esPub, tagId, 'tag.tag-item', 'tags');
    link(db, esPub, hoursId, 'schedule.hours', 'schedule');
    link(db, esPub, amenitySrcId, 'tag.tag-item', 'amenities', 0);
    db.close();

    const dry = runCli(dbPath);
    expect(dry.out).toContain('updates=0');
    expect(dry.out).toContain('amenityRows=0');

    // --apply must not blank the filled columns or create empty amenity rows.
    expect(runCli(dbPath, '--apply').code).toBe(0);
    const check = new Database(dbPath);
    expect(check.prepare('SELECT label FROM components_tag_tag_items WHERE id = ?').get(tagId).label).toBe('Aventura');
    expect(check.prepare('SELECT text FROM components_schedule_hours WHERE id = ?').get(hoursId).text).toBe('L-V 8-17');
    expect(check.prepare('SELECT COUNT(*) AS n FROM components_amenity_amenity_items').get().n).toBe(0);
    check.close();
  });

  it('re-running --apply before --cleanup never duplicates created rows (idempotent)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','cantera','2026-01-01')").run().lastInsertRowid;
    const swapId = db.prepare("INSERT INTO components_tag_tag_items (label_es, label_en) VALUES ('Wifi', 'Wifi')").run().lastInsertRowid;
    const visitId = db.prepare("INSERT INTO components_recommendation_visit_infos (best_time_es, best_time_en) VALUES ('Mañana', 'Morning')").run().lastInsertRowid;
    link(db, esPub, swapId, 'tag.tag-item', 'amenities', 0);
    link(db, esPub, visitId, 'recommendation.visit-info', 'recommendations');
    db.close();

    expect(runCli(dbPath, '--apply').code).toBe(0);
    const rerun = runCli(dbPath, '--apply');
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('Apply phase already complete');

    const check = new Database(dbPath);
    const amenityRows = check.prepare('SELECT COUNT(*) AS n FROM components_amenity_amenity_items').get();
    const recRows = check.prepare('SELECT COUNT(*) AS n FROM components_recommendation_recommendation_items').get();
    const newLinks = check
      .prepare("SELECT COUNT(*) AS n FROM listings_cmps WHERE component_type IN ('amenity.amenity-item','recommendation.recommendation-item')")
      .get();
    check.close();
    expect(amenityRows.n).toBe(1); // no duplicates
    expect(recRows.n).toBe(1);
    expect(newLinks.n).toBe(2);

    expect(runCli(dbPath, '--cleanup').code).toBe(0);
    const done = runCli(dbPath);
    expect(done.code).toBe(0);
    expect(done.out).toContain('Nothing to migrate');
  });
});
