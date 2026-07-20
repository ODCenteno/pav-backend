#!/usr/bin/env node
/**
 * restore-draft-rows.js
 *
 * Recreates draft rows (published_at = NULL) for listings and community_members
 * that currently only have published rows. Strapi's content-manager API (admin UI)
 * queries for draft rows, so entries without drafts are invisible in the admin panel.
 *
 * Two-phase approach (correct relation handling):
 *   Phase 1: Create draft rows for ALL published listings + members (track ID mappings)
 *   Phase 2: Copy components and relations using the mappings
 *            - Components: each draft gets its own copy (entity_id = draft id)
 *            - Relations: draft-to-draft links only (published-to-published stay untouched)
 *
 * Safety:
 *   - Dry-run mode by default (use --apply to write)
 *   - Wrapped in a transaction (all-or-nothing)
 *   - Only INSERTs, never DELETE or UPDATE existing rows
 *
 * Usage:
 *   node scripts/restore-draft-rows.js            # dry-run (no writes)
 *   node scripts/restore-draft-rows.js --apply    # execute
 */

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '../.tmp/data.db');
const APPLY = process.argv.includes('--apply');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  'order', 'group', 'where', 'select', 'from', 'index', 'table', 'join',
  'inner', 'left', 'right', 'outer', 'on', 'as', 'and', 'or', 'not',
  'null', 'true', 'false', 'between', 'in', 'like', 'asc', 'desc',
]);

function columnsOf(table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((r) => r.name);
}

function quoteIdent(name) {
  return RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

function duplicateRowAsDraft(table, sourceRow) {
  const cols = columnsOf(table);
  const insertCols = cols.filter((c) => c !== 'id'); // drop auto-increment id
  // published_at -> NULL literal (no value bound); other columns bind sourceRow value
  const placeholderList = [];
  const values = [];
  for (const c of insertCols) {
    if (c === 'published_at') {
      placeholderList.push('NULL');
    } else {
      placeholderList.push('?');
      values.push(sourceRow[c]);
    }
  }
  const colList = insertCols.map(quoteIdent).join(', ');
  const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholderList.join(', ')})`;
  const result = db.prepare(sql).run(...values);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Phase 1: Create draft rows and build ID mappings
// ---------------------------------------------------------------------------

function createDraftsFor(table) {
  const publishedRows = db
    .prepare(`SELECT * FROM ${table} WHERE published_at IS NOT NULL AND published_at != ''`)
    .all();

  const existingDrafts = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE published_at IS NULL OR published_at = ''`)
    .get().n;

  console.log(`\n=== ${table} ===`);
  console.log(`  published rows: ${publishedRows.length}`);
  console.log(`  existing drafts: ${existingDrafts}`);

  if (existingDrafts > 0) {
    console.log(`  WARNING: ${existingDrafts} drafts already exist. Proceeding may create duplicates.`);
  }

  // Map: published integer id -> draft integer id
  const idMap = new Map();
  let created = 0;

  for (const row of publishedRows) {
    if (APPLY) {
      const newId = duplicateRowAsDraft(table, row);
      idMap.set(row.id, newId);
      console.log(`  + draft for ${row.slug} (${row.locale}) id=${row.id} -> ${newId}`);
    } else {
      idMap.set(row.id, null); // placeholder for dry-run
    }
    created++;
  }

  console.log(`  ${APPLY ? 'Created' : 'Would create'} ${created} draft rows`);
  return { idMap, publishedRows };
}

// ---------------------------------------------------------------------------
// Phase 2: Copy components and relations using ID mappings
// ---------------------------------------------------------------------------

function copyComponents(table, cmpsTable, idMap) {
  let totalCopied = 0;
  for (const [pubId, draftId] of idMap) {
    const cols = columnsOf(cmpsTable);
    const insertCols = cols.filter((c) => c !== 'id'); // drop link table's own id
    // entity_id maps to draftId, everything else copied
    const selectCols = insertCols.map(quoteIdent).join(', ');
    const sourceLinks = db
      .prepare(`SELECT ${selectCols} FROM ${cmpsTable} WHERE entity_id = ?`)
      .all(pubId);

    if (APPLY) {
      const placeholders = insertCols.map(() => '?').join(', ');
      const colList = insertCols.map(quoteIdent).join(', ');
      const sql = `INSERT INTO ${cmpsTable} (${colList}) VALUES (${placeholders})`;
      for (const row of sourceLinks) {
        const values = insertCols.map((c) => (c === 'entity_id' ? draftId : row[c]));
        db.prepare(sql).run(...values);
      }
    }
    totalCopied += sourceLinks.length;
  }
  console.log(`  ${APPLY ? 'Copied' : 'Would copy'} ${totalCopied} component links (${cmpsTable})`);
  return totalCopied;
}

function copyRelations(linkTable, listingIdMap, memberIdMap, listingCol, memberCol) {
  // For each link where BOTH endpoints have a draft copy, create a draft-to-draft link
  // Build condition: listingCol IN listingIdMap.keys() AND memberCol IN memberIdMap.keys()
  const listingPubIds = Array.from(listingIdMap.keys());
  const memberPubIds = Array.from(memberIdMap.keys());
  if (listingPubIds.length === 0 || memberPubIds.length === 0) {
    console.log(`  ${APPLY ? 'Copied' : 'Would copy'} 0 relation links (${linkTable}) - no mappings on one side`);
    return 0;
  }

  const placeholders1 = listingPubIds.map(() => '?').join(',');
  const placeholders2 = memberPubIds.map(() => '?').join(',');
  const cols = columnsOf(linkTable);
  const insertCols = cols.filter((c) => c !== 'id');
  const selectCols = insertCols.map(quoteIdent).join(', ');

  const sourceLinks = db
    .prepare(
      `SELECT ${selectCols} FROM ${linkTable} WHERE ${quoteIdent(listingCol)} IN (${placeholders1}) AND ${quoteIdent(memberCol)} IN (${placeholders2})`
    )
    .all(...listingPubIds, ...memberPubIds);

  if (APPLY) {
    const placeholders = insertCols.map(() => '?').join(', ');
    const colList = insertCols.map(quoteIdent).join(', ');
    const sql = `INSERT INTO ${linkTable} (${colList}) VALUES (${placeholders})`;
    for (const row of sourceLinks) {
      const values = insertCols.map((c) => {
        if (c === listingCol) return listingIdMap.get(row[listingCol]);
        if (c === memberCol) return memberIdMap.get(row[memberCol]);
        return row[c];
      });
      db.prepare(sql).run(...values);
    }
  }
  console.log(`  ${APPLY ? 'Copied' : 'Would copy'} ${sourceLinks.length} relation links (${linkTable})`);
  return sourceLinks.length;
}

function copyCategoryLinks(listingIdMap) {
  // Categories already have both draft+published rows; link draft listings to PUBLISHED categories
  // (Strapi's pattern: relations use the published-side id when one side has no draft counterpart in scope)
  const listingPubIds = Array.from(listingIdMap.keys());
  if (listingPubIds.length === 0) {
    console.log(`  Would copy 0 relation links (listings_category_lnk) - no listing mappings`);
    return 0;
  }
  const cols = columnsOf('listings_category_lnk');
  const insertCols = cols.filter((c) => c !== 'id');
  const selectCols = insertCols.map(quoteIdent).join(', ');
  const placeholders1 = listingPubIds.map(() => '?').join(',');
  const sourceLinks = db
    .prepare(`SELECT ${selectCols} FROM listings_category_lnk WHERE listing_id IN (${placeholders1})`)
    .all(...listingPubIds);

  if (APPLY) {
    const placeholders = insertCols.map(() => '?').join(', ');
    const colList = insertCols.map(quoteIdent).join(', ');
    const sql = `INSERT INTO listings_category_lnk (${colList}) VALUES (${placeholders})`;
    for (const row of sourceLinks) {
      const values = insertCols.map((c) => {
        if (c === 'listing_id') return listingIdMap.get(row.listing_id);
        return row[c];
      });
      db.prepare(sql).run(...values);
    }
  }
  console.log(`  ${APPLY ? 'Copied' : 'Would copy'} ${sourceLinks.length} relation links (listings_category_lnk)`);
  return sourceLinks.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  console.log(`Database: ${DB_PATH}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);

  // Phase 1: Create all draft rows, build ID mappings
  console.log('\n--- Phase 1: Create draft rows ---');
  const listingsResult = createDraftsFor('listings');
  const membersResult = createDraftsFor('community_members');

  // Phase 2: Copy components and relations
  console.log('\n--- Phase 2: Copy components and relations ---');

  console.log('\n[Listings components]');
  copyComponents('listings', 'listings_cmps', listingsResult.idMap);

  console.log('\n[Members components]');
  copyComponents('community_members', 'community_members_cmps', membersResult.idMap);

  console.log('\n[Listing <-> Category relations]');
  copyCategoryLinks(listingsResult.idMap);

  console.log('\n[Member <-> Listing relations]');
  copyRelations(
    'community_members_listings_lnk',
    listingsResult.idMap,
    membersResult.idMap,
    'listing_id',
    'community_member_id'
  );

  // Note: community_members_related_members_lnk — no current data per dry-run, skip

  console.log('\n=== DONE ===');
  if (!APPLY) {
    console.log('Dry-run complete. Run with --apply to execute.');
  } else {
    console.log('All draft rows + relations restored.');
  }
}

const tx = db.transaction(() => main());
try {
  tx();
  console.log('\nTransaction committed successfully.');
} catch (e) {
  console.error('\nTransaction FAILED (rolled back, no changes applied):', e.message);
  process.exit(1);
} finally {
  db.close();
}
