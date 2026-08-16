import { describe, it, expect, vi, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import validateTransfer from '../scripts/validate-transfer.js';

const { discoverLnkTables, foreignKeysOf, uniqueIndexesOf, runChecks, applyFixes, main } =
  validateTransfer;

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'validate-transfer.js');

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pav-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Strapi-style lnk DDL: id PK, FK columns with FK constraints,
// `<table>_uq` UNIQUE INDEX over the join pair, plus parent tables.
const LNK_DDL = `
  CREATE TABLE listings (id INTEGER PRIMARY KEY, title TEXT);
  CREATE TABLE community_members (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE community_members_listings_lnk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_member_id INTEGER,
    listing_id INTEGER,
    FOREIGN KEY (community_member_id) REFERENCES community_members(id),
    FOREIGN KEY (listing_id) REFERENCES listings(id)
  );
  CREATE UNIQUE INDEX community_members_listings_lnk_uq
    ON community_members_listings_lnk (community_member_id, listing_id);
`;

// Same shape but the community_member FK is declared twice, mirroring the
// production schema drift that motivated the dedupe logic in foreignKeysOf.
const DOUBLE_FK_DDL = `
  CREATE TABLE a (id INTEGER PRIMARY KEY);
  CREATE TABLE b (id INTEGER PRIMARY KEY);
  CREATE TABLE a_b_lnk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a_id INTEGER,
    b_id INTEGER,
    FOREIGN KEY (a_id) REFERENCES a(id),
    FOREIGN KEY (a_id) REFERENCES a(id),
    FOREIGN KEY (b_id) REFERENCES b(id)
  );
  CREATE UNIQUE INDEX a_b_lnk_uq ON a_b_lnk (a_id, b_id);
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('busy_timeout = 5000');
  return db;
}

function seedParents(db) {
  db.prepare('INSERT INTO listings (id, title) VALUES (?, ?)').run(1, 'L1');
  db.prepare('INSERT INTO community_members (id, name) VALUES (?, ?)').run(1, 'M1');
  db.prepare('INSERT INTO community_members (id, name) VALUES (?, ?)').run(2, 'M2');
}

function insertLnk(db, memberId, listingId) {
  // better-sqlite3 enables PRAGMA foreign_keys = ON by default. The production
  // orphan rows were written by external SQL scripts with the pragma OFF, so
  // reproduce that here to be able to insert dangling references at all.
  db.pragma('foreign_keys = OFF');
  return Number(
    db
      .prepare('INSERT INTO community_members_listings_lnk (community_member_id, listing_id) VALUES (?, ?)')
      .run(memberId, listingId).lastInsertRowid
  );
}

describe('UNIT: validate-transfer module', () => {
  it('is importable with no CLI side effects', () => {
    expect(typeof runChecks).toBe('function');
    expect(typeof applyFixes).toBe('function');
    expect(typeof discoverLnkTables).toBe('function');
  });

  it('reports no findings on a clean database', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'clean.db'));
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);

    const findings = runChecks(db);
    expect(findings).toEqual([]);
    db.close();
  });

  it('reports orphan FK references in both directions with table, kind and row', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'orphans.db'));
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1); // valid
    const orphanListingRow = insertLnk(db, 1, 99); // listing 99 does not exist
    const orphanMemberRow = insertLnk(db, 77, 1); // member 77 does not exist

    const findings = runChecks(db);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.table).toBe('community_members_listings_lnk');
      expect(f.kind).toBe('orphan');
    }

    const listingOrphan = findings.find((f) => f.fk.from === 'listing_id');
    expect(listingOrphan.fk).toEqual({ refTable: 'listings', from: 'listing_id', to: 'id' });
    expect(listingOrphan.rows.map((r) => r.id)).toEqual([orphanListingRow]);

    const memberOrphan = findings.find((f) => f.fk.from === 'community_member_id');
    expect(memberOrphan.fk).toEqual({ refTable: 'community_members', from: 'community_member_id', to: 'id' });
    expect(memberOrphan.rows.map((r) => r.id)).toEqual([orphanMemberRow]);
    db.close();
  });

  it('reports duplicate unique-index pairs', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'dup.db'));
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    // SQLite UNIQUE treats NULLs as distinct, so two (2, NULL) rows satisfy the
    // unique index while the GROUP BY check still counts them as a duplicate
    // pair. This is the reachable production case for the duplicate branch.
    insertLnk(db, 2, null);
    insertLnk(db, 2, null);

    const findings = runChecks(db);

    expect(findings).toHaveLength(1);
    const dup = findings[0];
    expect(dup.table).toBe('community_members_listings_lnk');
    expect(dup.kind).toBe('duplicate');
    expect(dup.index.name).toBe('community_members_listings_lnk_uq');
    expect(dup.index.columns).toEqual(['community_member_id', 'listing_id']);
    expect(dup.rows).toEqual([{ community_member_id: 2, listing_id: null, n: 2 }]);
    db.close();
  });

  it('dedupes foreign keys declared twice into a single finding', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'doublefk.db'));
    db.exec(DOUBLE_FK_DDL);
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO b (id) VALUES (1)').run();
    db.prepare('INSERT INTO a_b_lnk (a_id, b_id) VALUES (99, 1)').run(); // a 99 missing

    const fks = foreignKeysOf(db, 'a_b_lnk');
    expect(fks).toHaveLength(2); // a(id)<-a_id declared twice collapses to one
    expect(fks.find((fk) => fk.from === 'a_id')).toEqual({ refTable: 'a', from: 'a_id', to: 'id' });

    const findings = runChecks(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('orphan');
    expect(findings[0].fk.from).toBe('a_id');
    db.close();
  });

  it('exposes discovery helpers and returns no findings when no lnk tables exist', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'nolnk.db'));
    db.exec('CREATE TABLE listings (id INTEGER PRIMARY KEY, title TEXT)');

    expect(discoverLnkTables(db)).toEqual([]);
    expect(runChecks(db)).toEqual([]);
    expect(uniqueIndexesOf(db, 'listings')).toEqual([]);
    db.close();
  });

  it('applyFixes deletes only orphans, keeps duplicates, and writes the backup before deleting', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'mixed.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1); // valid row, must survive
    insertLnk(db, 1, 99); // orphan -> delete
    insertLnk(db, 77, 1); // orphan -> delete
    insertLnk(db, 2, null); // duplicate pair -> keep
    insertLnk(db, 2, null);

    const findings = runChecks(db);
    expect(findings).toHaveLength(3);

    const logs = [];
    const { orphansDeleted, backupPath } = applyFixes(db, dbFile, findings, (line) => logs.push(line));

    expect(orphansDeleted).toBe(2);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(path.basename(backupPath)).toMatch(/^mixed\.db\.bak-validate-\d{4}-\d{2}-\d{2}T/);
    expect(logs.some((l) => l.includes('Backup written:'))).toBe(true);
    expect(logs.filter((l) => l.includes('Deleted 1 orphan row(s)'))).toHaveLength(2);

    // The backup was written BEFORE the delete, so it still contains the orphans.
    const backupDb = new Database(backupPath, { readonly: true });
    const backupCount = backupDb.prepare('SELECT COUNT(*) AS n FROM community_members_listings_lnk').get();
    expect(backupCount.n).toBe(5);
    backupDb.close();

    // After the fix: only the valid row and the duplicate pair remain.
    const remaining = db.prepare('SELECT id, community_member_id, listing_id FROM community_members_listings_lnk ORDER BY id').all();
    expect(remaining).toEqual([
      { id: 1, community_member_id: 1, listing_id: 1 },
      { id: 4, community_member_id: 2, listing_id: null },
      { id: 5, community_member_id: 2, listing_id: null },
    ]);

    // Duplicates are intentionally NOT auto-deleted: they must still be reported.
    const findingsAfter = runChecks(db);
    expect(findingsAfter).toHaveLength(1);
    expect(findingsAfter[0].kind).toBe('duplicate');
    db.close();
  });
});

describe('UNIT: main() CLI logic in-process (exit codes and report output)', () => {
  // Runs main() with process.exit / console / argv mocked so the exact
  // reporting branches and exit codes can be asserted without a subprocess.
  function runMain(argv) {
    const exitCodes = [];
    const logs = [];
    const errors = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        exitCodes.push(code ?? 0);
        throw new Error('__process_exit__');
      });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'validate-transfer.js', ...argv]);
    try {
      main();
    } catch (e) {
      if (e?.message !== '__process_exit__') throw e;
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      argvSpy.mockRestore();
    }
    return { exitCode: exitCodes[0], logs, errors };
  }

  it('prints the OK line and exits 0 on a clean db', () => {
    const dir = makeTmpDir();
    const db = openDb(path.join(dir, 'm-clean.db'));
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    db.close();

    const { exitCode, logs, errors } = runMain([path.join(dir, 'm-clean.db')]);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('OK: no orphan links, no duplicate join pairs. Safe to export.'))).toBe(true);
    expect(logs.some((l) => l.includes('Join tables: 1 (community_members_listings_lnk)'))).toBe(true);
    expect(logs.some((l) => l.includes('Mode: CHECK ONLY'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('prints ORPHAN detail lines, truncates after 10 rows, and exits 1', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'm-many.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    for (let i = 0; i < 11; i++) insertLnk(db, 1, 500 + i); // 11 orphans, same direction
    db.close();

    const { exitCode, errors } = runMain([dbFile]);
    expect(exitCode).toBe(1);
    expect(errors.some((l) => l.includes('[ORPHAN] community_members_listings_lnk: 11 row(s) reference missing listings.id via listing_id'))).toBe(true);
    expect(errors.filter((l) => l.includes('id=') && l.includes('listing_id=5'))).toHaveLength(10);
    expect(errors.some((l) => l.includes('... and 1 more'))).toBe(true);
    expect(errors.some((l) => l.includes('Found 1 problem group(s). Re-run with --apply'))).toBe(true);
  });

  it('exits 1 after --apply when only duplicates remain (nothing fixable)', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'm-duponly.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    insertLnk(db, 2, null);
    insertLnk(db, 2, null);
    db.close();

    const { exitCode, errors } = runMain([dbFile, '--apply']);
    expect(exitCode).toBe(1);
    expect(errors.some((l) => l.includes('[DUPLICATE] community_members_listings_lnk: 1 duplicate group(s)'))).toBe(true);
    expect(errors.some((l) => l.includes('Applied: 0 orphan link(s) removed.'))).toBe(true);
    // No orphan fixable -> no backup is written.
    expect(errors.some((l) => l.includes('Backup written:'))).toBe(false);
    expect(errors.some((l) => l.includes('Duplicate pairs remain and need a MANUAL decision.'))).toBe(true);
  });

  it('exits 0 after --apply removes orphans and leaves no duplicates', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'm-apply.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    insertLnk(db, 1, 99);
    db.close();

    const { exitCode, errors } = runMain([dbFile, '--apply']);
    expect(exitCode).toBe(0);
    expect(errors.some((l) => l.includes('Backup written:'))).toBe(true);
    expect(errors.some((l) => l.includes('Applied: 1 orphan link(s) removed.'))).toBe(true);
    expect(errors.some((l) => l.includes('Database is now clean. Safe to export.'))).toBe(true);

    const after = new Database(dbFile, { readonly: true });
    expect(after.prepare('SELECT COUNT(*) AS n FROM community_members_listings_lnk').get().n).toBe(1);
    after.close();
  });

  it('exits 2 when the database file is missing', () => {
    const dir = makeTmpDir();
    const { exitCode, errors } = runMain([path.join(dir, 'nope.db')]);
    expect(exitCode).toBe(2);
    expect(errors[0]).toContain('Database not found:');
  });
});

describe('CLI: scripts/validate-transfer.js (subprocess)', () => {
  function runCli(args, cwd) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', cwd });
  }

  it('exits 0 with the OK line on a clean database', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'clean.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    db.close();

    const res = runCli([dbFile]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('OK: no orphan links, no duplicate join pairs. Safe to export.');
    expect(res.stderr).toBe('');
  });

  it('exits 1 and prints [ORPHAN] with the offending id to stderr', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'orphan.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    insertLnk(db, 1, 404); // orphan listing ref
    db.close();

    const res = runCli([dbFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ORPHAN]');
    expect(res.stderr).toContain('listing_id=404');
    expect(res.stderr).toContain('reference missing listings.id via listing_id');
    expect(res.stderr).toContain('Re-run with --apply to delete orphan rows');
  });

  it('--apply: creates a backup next to the db, removes orphans, exits 0, re-run exits 0', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'apply.db');
    const db = openDb(dbFile);
    db.exec(LNK_DDL);
    seedParents(db);
    insertLnk(db, 1, 1);
    insertLnk(db, 1, 99); // orphan
    db.close();

    const res = runCli([dbFile, '--apply']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('Backup written:');
    expect(res.stderr).toContain('Applied: 1 orphan link(s) removed.');
    expect(res.stderr).toContain('Database is now clean. Safe to export.');

    const backups = fs.readdirSync(dir).filter((f) => /^apply\.db\.bak-validate-/.test(f));
    expect(backups).toHaveLength(1);

    // The backup preserves the pre-fix state (orphan row still present).
    const backupDb = new Database(path.join(dir, backups[0]), { readonly: true });
    expect(backupDb.prepare('SELECT COUNT(*) AS n FROM community_members_listings_lnk').get().n).toBe(2);
    backupDb.close();

    // Orphan is gone; only the valid link remains.
    const after = new Database(dbFile, { readonly: true });
    expect(after.prepare('SELECT COUNT(*) AS n FROM community_members_listings_lnk').get().n).toBe(1);
    after.close();

    const rerun = runCli([dbFile]);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain('OK: no orphan links');
  });

  it('exits 2 with an error when the database file does not exist', () => {
    const dir = makeTmpDir();
    const res = runCli([path.join(dir, 'missing.db')]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Database not found:');
  });

  it('exits 0 early when no *_lnk tables exist', () => {
    const dir = makeTmpDir();
    const dbFile = path.join(dir, 'nolnk.db');
    const db = openDb(dbFile);
    db.exec('CREATE TABLE listings (id INTEGER PRIMARY KEY)');
    db.close();

    const res = runCli([dbFile]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No *_lnk join tables found. Nothing to validate.');
  });
});
