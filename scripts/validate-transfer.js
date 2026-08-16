#!/usr/bin/env node
/**
 * validate-transfer.js
 *
 * Preflight check before `strapi export` / `strapi import` (SQLite source).
 *
 * On 2026-07-20 three `strapi import` runs into Postgres failed with
 * "current transaction is aborted" on community_members_listings_lnk and
 * silently rolled back the ENTIRE destination database while reporting
 * success. Root cause: the export contained a link row referencing a
 * community_member/listing id that no longer existed (an "orphan link").
 * SQLite tolerates dangling rows when they are written outside Strapi
 * (external SQL scripts run without PRAGMA foreign_keys = ON), but
 * PostgreSQL rejects the INSERT and poisons the import transaction.
 *
 * This script inspects EVERY `*_lnk` join table in the source database and
 * reports:
 *   1. Orphan links      - rows whose FK columns reference missing entities.
 *   2. Duplicate pairs   - rows that violate the table's `<table>_uq`
 *                          unique index (duplicate join-column pairs).
 *
 * Safety:
 *   - Check-only by default (exit code 1 when problems are found)
 *   - `--apply` deletes ORPHAN rows only (after creating a timestamped
 *     backup); duplicate pairs are never auto-deleted, they need a manual
 *     decision about which side to keep.
 *
 * Usage:
 *   node scripts/validate-transfer.js                      # check .tmp/data.db
 *   node scripts/validate-transfer.js path/to/data.db      # check another db
 *   node scripts/validate-transfer.js --apply              # fix orphans
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbPathArg = args.find((a) => !a.startsWith('--'));
const DB_PATH = path.resolve(
  process.cwd(),
  dbPathArg || path.join(__dirname, '..', '.tmp', 'data.db')
);

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(2);
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

// ---------------------------------------------------------------------------
// Discover every join table and its constraints
// ---------------------------------------------------------------------------

function q(ident) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

const lnkTables = db
  .prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '%\\_lnk' ESCAPE '\\'
      ORDER BY name`
  )
  .all()
  .map((r) => r.name);

if (lnkTables.length === 0) {
  console.log('No *_lnk join tables found. Nothing to validate.');
  db.close();
  process.exit(0);
}

/**
 * Foreign keys of a table: [{ refTable, from, to }]
 */
function foreignKeysOf(table) {
  const seen = new Set();
  return db
    .pragma(`foreign_key_list(${q(table)})`)
    .map((fk) => ({
      refTable: fk.table,
      from: fk.from,
      to: fk.to,
    }))
    // Some tables declare the same FK constraint twice; dedupe by target.
    .filter((fk) => {
      const key = `${fk.refTable}.${fk.to}<-${fk.from}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Unique indexes and their columns: [{ name, columns: [...] }]
 */
function uniqueIndexesOf(table) {
  return db
    .pragma(`index_list(${q(table)})`)
    .filter((ix) => ix.unique)
    .map((ix) => ({
      name: ix.name,
      columns: db.pragma(`index_info(${q(ix.name)})`).map((c) => c.name),
    }))
    .filter((ix) => ix.columns.length > 0 && ix.columns.every(Boolean));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const findings = [];

console.log(`Database:  ${DB_PATH}`);
console.log(`Join tables: ${lnkTables.length} (${lnkTables.join(', ')})`);
console.log(`Mode: ${APPLY ? 'APPLY (orphans will be deleted)' : 'CHECK ONLY'}\n`);

for (const table of lnkTables) {
  const fks = foreignKeysOf(table);

  // --- orphan links ---
  for (const fk of fks) {
    const rows = db
      .prepare(
        `SELECT * FROM ${q(table)} t
          WHERE t.${q(fk.from)} IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${q(fk.refTable)} r WHERE r.${q(fk.to)} = t.${q(fk.from)}
            )`
      )
      .all();
    if (rows.length > 0) {
      findings.push({ table, kind: 'orphan', fk, rows });
    }
  }

  // --- duplicate unique-index pairs ---
  for (const ix of uniqueIndexesOf(table)) {
    const cols = ix.columns.map(q).join(', ');
    const rows = db
      .prepare(
        `SELECT ${cols}, COUNT(*) AS n FROM ${q(table)}
          GROUP BY ${cols} HAVING COUNT(*) > 1`
      )
      .all();
    if (rows.length > 0) {
      findings.push({ table, kind: 'duplicate', index: ix, rows });
    }
  }
}

// ---------------------------------------------------------------------------
// Report / fix
// ---------------------------------------------------------------------------

if (findings.length === 0) {
  console.log('OK: no orphan links, no duplicate join pairs. Safe to export.');
  db.close();
  process.exit(0);
}

let orphansDeleted = 0;

for (const f of findings) {
  if (f.kind === 'orphan') {
    console.error(
      `[ORPHAN] ${f.table}: ${f.rows.length} row(s) reference missing ${f.fk.refTable}.${f.fk.to} via ${f.fk.from}`
    );
    for (const row of f.rows.slice(0, 10)) {
      console.error(`        id=${row.id} ${f.fk.from}=${row[f.fk.from]}`);
    }
    if (f.rows.length > 10) console.error(`        ... and ${f.rows.length - 10} more`);
  } else {
    const cols = f.index.columns.join(', ');
    console.error(
      `[DUPLICATE] ${f.table}: ${f.rows.length} duplicate group(s) on unique index ${f.index.name} (${cols}) — manual fix required, not auto-deleted`
    );
    for (const row of f.rows.slice(0, 10)) {
      console.error(`        ${cols} = ${f.index.columns.map((c) => row[c]).join(', ')} (x${row.n})`);
    }
  }
}

if (APPLY) {
  const fixable = findings.filter((f) => f.kind === 'orphan');
  const hasDuplicates = findings.some((f) => f.kind === 'duplicate');

  if (fixable.length > 0) {
    const backup = `${DB_PATH}.bak-validate-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(DB_PATH, backup);
    console.error(`\nBackup written: ${backup}`);

    const tx = db.transaction(() => {
      for (const f of fixable) {
        const ids = f.rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const res = db
          .prepare(`DELETE FROM ${q(f.table)} WHERE id IN (${placeholders})`)
          .run(...ids);
        orphansDeleted += res.changes;
        console.error(`Deleted ${res.changes} orphan row(s) from ${f.table} (${f.fk.from} -> ${f.fk.refTable}.${f.fk.to})`);
      }
    });
    tx();
  }

  console.error(`\nApplied: ${orphansDeleted} orphan link(s) removed.`);
  if (hasDuplicates) {
    console.error('Duplicate pairs remain and need a MANUAL decision. Re-run without --apply to review them.');
    db.close();
    process.exit(1);
  }
  console.error('Database is now clean. Safe to export.');
  db.close();
  process.exit(0);
}

console.error(
  `\nFound ${findings.length} problem group(s). Re-run with --apply to delete orphan rows (duplicates are never auto-deleted).`
);
db.close();
process.exit(1);
