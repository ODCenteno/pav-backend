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
  'enrich-recommendations-from-es.js'
);

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pav-enrich-recommendations-'));
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
 * Minimal Strapi-shaped schema: listings with locale + draft/publish rows
 * per (document, locale); the recommendations cmps link table; the new
 * `recommendation.recommendation-item` component table populated ONLY for
 * `es-MX` entities (the source) and EMPTY for `en` entities (the targets).
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
    CREATE TABLE components_recommendation_recommendation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label VARCHAR(255), description TEXT
    );
  `);
  return db;
}

const link = (db, entityId, cmpId, type, field, order = null) =>
  db
    .prepare('INSERT INTO listings_cmps (entity_id, cmp_id, component_type, field, "order") VALUES (?, ?, ?, ?, ?)')
    .run(entityId, cmpId, type, field, order).lastInsertRowid;

describe('enrich-recommendations-from-es CLI (sqlite)', () => {
  it('enriches an EN entity that has an ES sibling with content', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);

    // ES source: docA, es-MX, published; 2 items in order 0,1
    const esPub = db
      .prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','lugar','2026-01-01')")
      .run().lastInsertRowid;
    const ri1 = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('Mejor época para visitar','Year-round Spanish desc')").run().lastInsertRowid;
    const ri2 = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('Qué llevar','Bring X; Bring Y')").run().lastInsertRowid;
    link(db, esPub, ri1, 'recommendation.recommendation-item', 'recommendations', 0);
    link(db, esPub, ri2, 'recommendation.recommendation-item', 'recommendations', 1);

    // EN target: docA, en, published; no rec items
    const enPub = db
      .prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','en','lugar','2026-01-01')")
      .run().lastInsertRowid;
    db.close();

    const dry = runCli(dbPath);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('[ENRICH] slug=lugar');
    expect(dry.out).toContain('order=0 label="Best time to visit"');
    expect(dry.out).toContain('order=1 label="What to bring"');

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('Enrichment complete: 1 listing(s), 2 new EN item(s)');

    const check = new Database(dbPath);
    const enItems = check
      .prepare(
        `SELECT ri.label, ri.description
           FROM listings_cmps lc
           JOIN components_recommendation_recommendation_items ri ON ri.id = lc.cmp_id
          WHERE lc.entity_id = ? AND lc.field = 'recommendations' AND lc.component_type = 'recommendation.recommendation-item'
          ORDER BY lc."order"`
      )
      .all(enPub);
    expect(enItems).toEqual([
      { label: 'Best time to visit', description: 'Year-round Spanish desc' },
      { label: 'What to bring', description: 'Bring X; Bring Y' },
    ]);
    check.close();
  });

  it('skips EN entities that already have any recommendations (won\'t duplicate/overwrite editor content)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docB','es-MX','sitio','2026-01-01')").run().lastInsertRowid;
    const esItem = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('Mejor época para visitar','X')").run().lastInsertRowid;
    link(db, esPub, esItem, 'recommendation.recommendation-item', 'recommendations', 0);
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docB','en','sitio','2026-01-01')").run().lastInsertRowid;
    const enExisting = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('Editor-custom title','Editor content')").run().lastInsertRowid;
    link(db, enPub, enExisting, 'recommendation.recommendation-item', 'recommendations', 0);
    db.close();

    const dry = runCli(dbPath);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Nothing to enrich');

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);
    expect(res.out).toContain('Nothing to enrich');

    const check = new Database(dbPath);
    const items = check
      .prepare(
        `SELECT ri.label, ri.description FROM listings_cmps lc
           JOIN components_recommendation_recommendation_items ri ON ri.id = lc.cmp_id
          WHERE lc.entity_id = ? AND lc.field = 'recommendations' AND lc.component_type = 'recommendation.recommendation-item'`
      )
      .all(enPub);
    expect(items).toEqual([{ label: 'Editor-custom title', description: 'Editor content' }]);
    check.close();
  });

  it('skips EN entities with no ES sibling (orphan) — logged as not having a source', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    // EN with no ES sibling
    db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('orphan-doc','en','huerfano','2026-01-01')").run();
    db.close();

    const dry = runCli(dbPath);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Nothing to enrich');
  });

  it('skips EN entities when no ES sibling exists, even if ES rows are present for other documents', () => {
    // verify scoped by document_id: a candidate for docX only sees ES items of docX
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    // ES for docX (target's sibling)
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docX','es-MX','x','2026-01-01')").run().lastInsertRowid;
    const esA = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('ES A','a')").run().lastInsertRowid;
    link(db, esPub, esA, 'recommendation.recommendation-item', 'recommendations', 0);
    // ES for docY (other document, unrelated) — should NOT be used
    const esPubY = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docY','es-MX','y','2026-01-01')").run().lastInsertRowid;
    const esB = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('ES B (other doc)','b')").run().lastInsertRowid;
    link(db, esPubY, esB, 'recommendation.recommendation-item', 'recommendations', 0);
    // EN target for docX
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docX','en','x','2026-01-01')").run().lastInsertRowid;
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);

    const check = new Database(dbPath);
    const enLabels = check
      .prepare(
        `SELECT ri.label FROM listings_cmps lc
           JOIN components_recommendation_recommendation_items ri ON ri.id = lc.cmp_id
          WHERE lc.entity_id = ? AND lc.field = 'recommendations' AND lc.component_type = 'recommendation.recommendation-item'
          ORDER BY lc."order"`
      )
      .all(enPub)
      .map((r) => r.label);
    expect(enLabels).toEqual(['Best time to visit']); // mapped from 'ES A' (order 0) — NOT 'ES B (other doc)'
    check.close();
  });

  it('writes a snapshot next to the sqlite db and re-runs clean after --apply', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const esPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docC','es-MX','lugar','2026-01-01')").run().lastInsertRowid;
    const ri = db.prepare("INSERT INTO components_recommendation_recommendation_items (label, description) VALUES ('Mejor época','X')").run().lastInsertRowid;
    link(db, esPub, ri, 'recommendation.recommendation-item', 'recommendations', 0);
    const enPub = db.prepare("INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docC','en','lugar','2026-01-01')").run().lastInsertRowid;
    db.close();

    const res = runCli(dbPath, '--apply');
    expect(res.code).toBe(0);

    const snapshots = fs.readdirSync(dir).filter((f) => f.startsWith('enrich-recommendations-snapshot-'));
    expect(snapshots).toHaveLength(1);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, snapshots[0]), 'utf8'));
    expect(snap.planned).toHaveLength(1);
    expect(snap.planned[0].items[0]).toMatchObject({ order: 0, label: 'Best time to visit' });

    const recheck = runCli(dbPath);
    expect(recheck.code).toBe(0);
    expect(recheck.out).toContain('Nothing to enrich');
  });
});
