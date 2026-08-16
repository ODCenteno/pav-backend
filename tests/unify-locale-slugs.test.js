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
  'unify-locale-slugs.js'
);

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pav-unify-test-'));
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
 * Minimal Strapi-shaped schema: listings/categories with document_id +
 * locale + draft/published pairs, join table for inbound-link checks.
 */
function seedDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), locale VARCHAR(255), slug VARCHAR(255),
      title VARCHAR(255), published_at TEXT
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id VARCHAR(255), locale VARCHAR(255), slug VARCHAR(255),
      name VARCHAR(255), published_at TEXT
    );
    CREATE TABLE listings_category_lnk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER, category_id INTEGER,
      listing_ord REAL, category_ord REAL
    );
  `);
  return db;
}

describe('unify-locale-slugs CLI (sqlite)', () => {
  it('dry-run reports divergence and exits 1 without writing', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    db.prepare(
      `INSERT INTO listings (document_id, locale, slug, published_at) VALUES
         ('docA','es-MX','cantera','2026-01-01'),
         ('docA','es-MX','cantera',NULL),
         ('docA','en','beach-quarry','2026-01-01')`
    ).run();
    db.close();

    const { code, out } = runCli(dbPath);
    expect(code).toBe(1);
    expect(out).toContain('[REPAIR]');
    expect(out).toContain('beach-quarry');
    expect(out).toContain('"cantera"');

    const check = new Database(dbPath);
    const en = check.prepare(`SELECT slug FROM listings WHERE locale='en'`).get();
    check.close();
    expect(en.slug).toBe('beach-quarry'); // untouched in dry-run
  });

  it('--apply unifies rows, writes a snapshot, and a re-run exits 0 clean', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    db.prepare(
      `INSERT INTO listings (document_id, locale, slug, published_at) VALUES
         ('docA','es-MX','cantera','2026-01-01'),
         ('docA','en','beach-quarry','2026-01-01')`
    ).run();
    db.close();

    const applied = runCli(dbPath, '--apply');
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('Applied: 1 document(s) unified');

    const snapshots = fs.readdirSync(dir).filter((f) => f.startsWith('slug-snapshot-'));
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, snapshots[0]), 'utf8'));
    expect(snapshot.documents['listings:docA']).toEqual({
      toSlug: 'cantera',
      from: { en: 'beach-quarry' },
    });

    const check = new Database(dbPath);
    const slugs = check.prepare(`SELECT slug FROM listings ORDER BY id`).all();
    check.close();
    expect(slugs.every((r) => r.slug === 'cantera')).toBe(true);

    const recheck = runCli(dbPath);
    expect(recheck.code).toBe(0);
    expect(recheck.out).toContain('already unified');
  });

  it('--prune-orphans --apply merges the EN duplicate onto the bilingual document', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    db.prepare(
      `INSERT INTO categories (document_id, locale, slug, name, published_at) VALUES
         ('catA','es-MX','restaurants','Restaurantes','2026-01-01'),
         ('catA','en','restaurants','Restaurantes',NULL),
         ('catB','en','restaurants','Restaurants','2026-01-01')`
    ).run();
    db.close();

    // Without --prune-orphans: conflict, exit 1.
    const plain = runCli(dbPath);
    expect(plain.code).toBe(1);
    expect(plain.out).toContain('orphan-duplicate');

    const pruned = runCli(dbPath, '--prune-orphans', '--apply');
    expect(pruned.code).toBe(0);
    expect(pruned.out).toContain('1 EN-only duplicate(s) pruned');

    const check = new Database(dbPath);
    const rows = check
      .prepare(`SELECT document_id, locale, slug, name, published_at IS NOT NULL AS pub FROM categories ORDER BY id`)
      .all();
    check.close();
    // catB gone; catA has ES published + EN draft + EN published (published
    // clone carries the translated name, draft shell renamed too).
    expect(rows.map((r) => r.document_id)).toEqual(['catA', 'catA', 'catA']);
    const enPublished = rows.find((r) => r.locale === 'en' && r.pub);
    expect(enPublished.name).toBe('Restaurants');
    const enDraft = rows.find((r) => r.locale === 'en' && !r.pub);
    expect(enDraft.name).toBe('Restaurants');

    const recheck = runCli(dbPath);
    expect(recheck.code).toBe(0);
  });

  it('refuses to prune when inbound links appear (apply-time guard)', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'work.db');
    const db = seedDb(dbPath);
    const ins = db.prepare(
      `INSERT INTO categories (document_id, locale, slug, name, published_at) VALUES
         ('catA','es-MX','restaurants','Restaurantes','2026-01-01'),
         ('catA','en','restaurants','Restaurantes',NULL),
         ('catB','en','restaurants','Restaurants','2026-01-01')`
    );
    ins.run();
    // Point a listing at the EN-only duplicate: pruning must be refused.
    db.prepare(
      `INSERT INTO listings (document_id, locale, slug, published_at) VALUES ('docA','es-MX','x','2026-01-01')`
    ).run();
    const catBId = db.prepare(`SELECT id FROM categories WHERE document_id='catB'`).get().id;
    const listingId = db.prepare(`SELECT id FROM listings`).get().id;
    db.prepare(`INSERT INTO listings_category_lnk (listing_id, category_id) VALUES (?, ?)`).run(
      listingId,
      catBId
    );
    db.close();

    const res = runCli(dbPath, '--prune-orphans', '--apply');
    expect(res.code).toBe(1);
    expect(res.out).toContain('inbound link');

    const check = new Database(dbPath);
    const count = check.prepare(`SELECT COUNT(*) AS n FROM categories WHERE document_id='catB'`).get();
    check.close();
    expect(count.n).toBe(1); // nothing deleted
  });
});
