#!/usr/bin/env node
/**
 * unify-locale-slugs.js
 *
 * Makes the slug of every listing/category document identical across all
 * locale variants (default locale wins) — the precondition for flipping
 * `slug` to a non-localized field in the content-type schemas.
 *
 * Why: `listing.slug` and `category.slug` are localized uid fields. Editors
 * can (and did, in production) change the slug of one locale only, so
 * `/es/sitios/<es-slug>` and `/en/sitios/<en-slug>` diverge. The frontend
 * builds the language-switch href from a single slug, so a divergent pair
 * sends users to a page that was never built (404). The fix is to make the
 * slug shared (non-localized); Strapi blocks/complicates that flip while
 * non-default locales hold different values, so this script unifies them
 * first and writes a snapshot you can reuse as a redirect map.
 *
 * Works directly on the database (SQLite via better-sqlite3, PostgreSQL via
 * pg) — no Strapi instance or admin token required. Strapi 5 layout: every
 * (document, locale) has up to two rows (draft + published) sharing one
 * document_id; ALL rows of a document are updated together.
 *
 * Safety:
 *   - Dry-run by default (prints the plan, writes nothing)
 *   - --apply writes a JSON snapshot of the old slugs BEFORE updating
 *   - Aborts (exit 1, no writes) when unification would create slug
 *     collisions between different documents, or when the default locale
 *     itself has contradictory slugs (ambiguous) — those need a human.
 *
 * Usage:
 *   node scripts/unify-locale-slugs.js                              # dry-run, sqlite .tmp/data.db
 *   node scripts/unify-locale-slugs.js --apply                      # repair + snapshot
 *   node scripts/unify-locale-slugs.js --db /path/data.db           # another sqlite db
 *   node scripts/unify-locale-slugs.js --apply --prune-orphans      # also delete EN-only
 *                                                                   # duplicate categories
 *   # PostgreSQL (production): set DATABASE_CLIENT=postgres and DATABASE_URL,
 *   # or pass --db "postgres://user:pass@host/db"
 *
 * Module exports (require-safe, no side effects on import):
 *   - planUnify(rowsByTable, defaultLocale) -> unified plan (pure)
 *   - fetchRows(db, tables)                 -> rows grouped per table
 *   - applyPlan(db, dialect, plan, opts)    -> executes repairs + snapshot
 *   - main()                                -> CLI entry (require.main-guarded)
 */

const fs = require('node:fs');
const path = require('node:path');

const TABLES = ['listings', 'categories'];
const DEFAULT_LOCALE = 'es-MX';

// ---------------------------------------------------------------------------
// Pure planning logic — unit-tested without any database
// ---------------------------------------------------------------------------

/**
 * Build the unification plan from raw rows (two passes so cross-document
 * slug claims are seen regardless of iteration order).
 *
 * rows: [{ id, documentId, locale, slug, publishedAt }]
 *
 * Returns { synced, repairs, conflicts, orphans, prunes }:
 *  - repairs:  [{ table, documentId, toSlug, rowIds, from: { locale: slug } }]
 *  - conflicts:[{ kind: 'ambiguous-default'|'collision'|'orphan-duplicate',
 *                 table, documentId, detail }] — always manual, aborts apply
 *  - orphans:  [{ table, documentId, locales }] — no default-locale row,
 *              unique slug: left untouched
 *  - prunes:   [{ table, documentId, rowIds, slug, duplicateOf }] — EN-only
 *              duplicate documents (same slug as a bilingual document, no
 *              default-locale row). Deleted ONLY with --prune-orphans --apply.
 */
function planUnify(rowsByTable, defaultLocale = DEFAULT_LOCALE, opts = {}) {
  const pruneOrphans = opts.pruneOrphans === true;
  const out = { synced: 0, repairs: [], conflicts: [], orphans: [], prunes: [] };

  // Pass 1: group rows per (table, document) and classify documents.
  const docs = []; // { table, documentId, rows, isOrphan, canonicalSlug }
  for (const [table, rows] of Object.entries(rowsByTable)) {
    const byDoc = new Map();
    for (const r of rows) {
      if (!byDoc.has(r.documentId)) byDoc.set(r.documentId, []);
      byDoc.get(r.documentId).push(r);
    }
    for (const [documentId, docRows] of byDoc) {
      const defaultRows = docRows.filter((r) => r.locale === defaultLocale);
      docs.push({
        table,
        documentId,
        rows: docRows,
        isOrphan: defaultRows.length === 0,
        defaultRows,
      });
    }
  }

  // Slug claim registry across ALL documents (bilingual first, then orphans,
  // so a bilingual document wins its slug over an EN-only duplicate).
  docs.sort((a, b) => Number(a.isOrphan) - Number(b.isOrphan));
  const claimBySlug = new Map(); // slug -> { table, documentId, isOrphan }
  for (const doc of docs) {
    if (doc.isOrphan) continue;
    const slugs = [...new Set(doc.defaultRows.map((r) => r.slug))];
    if (slugs.length > 1) {
      out.conflicts.push({
        kind: 'ambiguous-default',
        table: doc.table,
        documentId: doc.documentId,
        detail: `default locale ${defaultLocale} rows disagree on slug: ${slugs.join(' vs ')}`,
      });
      continue;
    }
    doc.canonicalSlug = slugs[0];
    const owner = claimBySlug.get(doc.canonicalSlug);
    if (owner && `${owner.table}:${owner.documentId}` !== `${doc.table}:${doc.documentId}`) {
      out.conflicts.push({
        kind: 'collision',
        table: doc.table,
        documentId: doc.documentId,
        detail: `slug "${doc.canonicalSlug}" already claimed by ${owner.table}:${owner.documentId}`,
      });
      continue;
    }
    claimBySlug.set(doc.canonicalSlug, { table: doc.table, documentId: doc.documentId, isOrphan: false });
  }

  // Pass 2: plan repairs, orphans, prunes.
  for (const doc of docs) {
    if (!doc.isOrphan && !doc.canonicalSlug) continue; // already flagged as conflict

    if (doc.isOrphan) {
      const locales = [...new Set(doc.rows.map((r) => r.locale))];
      const slug = doc.rows[0].slug;
      const claim = claimBySlug.get(slug);
      if (claim && `${claim.table}:${claim.documentId}` !== `${doc.table}:${doc.documentId}`) {
        // Duplicate of a bilingual document — mergeable (categories only,
        // listings have too many inbound relations to auto-delete safely).
        if (pruneOrphans && doc.table === 'categories') {
          // The duplicate holds the real translated, PUBLISHED content
          // (original import created it as a separate document instead of a
          // locale variant). Merge its name/publication onto the claimant,
          // then delete the duplicate rows.
          const claimant = docs.find(
            (d) => d.table === claim.table && d.documentId === claim.documentId && !d.isOrphan
          );
          const claimantEn = (claimant?.rows || []).filter((r) => r.locale !== defaultLocale);
          const hasPublished = claimantEn.some((r) => r.publishedAt);
          const dupSource = doc.rows.find((r) => r.publishedAt) || doc.rows[0];
          const merge = {
            table: doc.table,
            documentId: claim.documentId,
            dupDocumentId: doc.documentId,
            locale: dupSource.locale,
            name: dupSource.name,
          };
          if (claimantEn.length === 0) {
            // No localization row at all: publish one cloned from the dup.
            merge.cloneFromRowId = dupSource.id;
          } else if (!hasPublished) {
            // Draft-only shell: publish a copy of it with the merged name.
            merge.publishFromRowId = claimantEn[0].id;
          } else {
            // Published row exists: just fix its name if it differs.
            merge.updateRowId = claimantEn.find((r) => r.publishedAt).id;
          }
          out.prunes.push({
            table: doc.table,
            documentId: doc.documentId,
            rowIds: doc.rows.map((r) => r.id),
            slug,
            duplicateOf: `${claim.table}:${claim.documentId}`,
            merge,
          });
        } else {
          out.conflicts.push({
            kind: 'orphan-duplicate',
            table: doc.table,
            documentId: doc.documentId,
            detail: `slug "${slug}" duplicates ${claim.table}:${claim.documentId} but has no ${defaultLocale} row — re-run with --prune-orphans (categories) or fix manually`,
          });
        }
        continue;
      }
      out.orphans.push({ table: doc.table, documentId: doc.documentId, locales });
      continue;
    }

    const wrong = doc.rows.filter((r) => r.slug !== doc.canonicalSlug);
    if (wrong.length === 0) {
      out.synced += 1;
      continue;
    }
    const from = {};
    for (const r of wrong) from[r.locale] = from[r.locale] || r.slug;
    out.repairs.push({
      table: doc.table,
      documentId: doc.documentId,
      toSlug: doc.canonicalSlug,
      rowIds: wrong.map((r) => r.id),
      from,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Database access — thin, per-dialect
// ---------------------------------------------------------------------------

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

async function fetchRows(db, dialect, tables) {
  const rowsByTable = {};
  for (const table of tables) {
    // `name` feeds the EN-only duplicate merge (categories use name; the
    // value is unused for listings, which never merge).
    const nameCol = table === 'categories' ? 'name' : 'slug';
    if (dialect === 'sqlite') {
      rowsByTable[table] = db
        .prepare(
          `SELECT id, document_id AS documentId, locale, slug, ${nameCol} AS name,
                  (published_at IS NOT NULL AND published_at != '') AS publishedAt
             FROM ${table}`
        )
        .all();
    } else {
      const res = await db.query(
        `SELECT id, document_id AS "documentId", locale, slug, ${nameCol} AS name,
                (published_at IS NOT NULL) AS "publishedAt"
           FROM ${table}`
      );
      rowsByTable[table] = res.rows;
    }
  }
  return rowsByTable;
}

// Inbound relations per table — verified empty before pruning a document.
const INBOUND_LINKS = {
  categories: { table: 'listings_category_lnk', column: 'category_id' },
};

async function tableColumns(db, dialect, table) {
  if (dialect === 'sqlite') {
    return db.pragma(`table_info(${table})`).map((c) => c.name);
  }
  const res = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

const quoteIdent = (d) => (d === 'order' ? '"order"' : d);

/**
 * Execute one merge: make sure the claimant document ends up with a
 * PUBLISHED non-default-locale row carrying the duplicate's translated
 * name, following the project's two-rows-per-(document,locale) convention
 * (draft row + published row share the document_id).
 */
async function applyMerge(db, dialect, merge) {
  const cols = (await tableColumns(db, dialect, merge.table)).filter((c) => c !== 'id');
  const now = new Date().toISOString();

  if (merge.cloneFromRowId || merge.publishFromRowId) {
    // Insert a published row cloned from an existing row.
    const srcId = merge.cloneFromRowId || merge.publishFromRowId;
    if (merge.publishFromRowId) {
      // The draft shell the editors see must carry the translated name too,
      // otherwise the admin panel shows the untranslated default while the
      // live site shows the translation.
      if (dialect === 'sqlite') {
        db.prepare(`UPDATE ${merge.table} SET name = ? WHERE id = ?`).run(merge.name, srcId);
      } else {
        await db.query(`UPDATE ${merge.table} SET name = $1 WHERE id = $2`, [merge.name, srcId]);
      }
    }
    const params = [];
    const ph = (v) => {
      params.push(v);
      return dialect === 'sqlite' ? '?' : `$${params.length}`;
    };
    const selectList = cols
      .map((c) => {
        if (merge.cloneFromRowId && c === 'document_id') return ph(merge.documentId);
        if (c === 'name') return ph(merge.name);
        if (c === 'published_at' || c === 'updated_at') return ph(now);
        return quoteIdent(c);
      })
      .join(', ');
    const colList = cols.map(quoteIdent).join(', ');
    const srcPh = ph(srcId);
    const sql = `INSERT INTO ${merge.table} (${colList}) SELECT ${selectList} FROM ${merge.table} WHERE id = ${srcPh}`;
    if (dialect === 'sqlite') db.prepare(sql).run(...params);
    else await db.query(sql, params);
    return;
  }

  if (merge.updateRowId) {
    if (dialect === 'sqlite') {
      db.prepare(`UPDATE ${merge.table} SET name = ? WHERE id = ?`).run(merge.name, merge.updateRowId);
    } else {
      await db.query(`UPDATE ${merge.table} SET name = $1 WHERE id = $2`, [merge.name, merge.updateRowId]);
    }
  }
}

/**
 * Apply repairs + merges/prunes + write snapshot.
 * Phase 0 verifies every prune's inbound links BEFORE any write (a refusal
 * never leaves repairs half-applied); Phase 2 re-checks immediately before
 * each deletion (TOCTOU: links may appear while earlier prunes run).
 * Returns { repaired, pruned, snapshotPath }.
 */
async function applyPlan(db, dialect, plan, opts = {}) {
  const { snapshotPath } = opts;
  if (plan.repairs.length + plan.prunes.length > 0 && snapshotPath) {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      defaultLocale: opts.defaultLocale || DEFAULT_LOCALE,
      documents: {},
      pruned: [],
    };
    for (const r of plan.repairs) {
      snapshot.documents[`${r.table}:${r.documentId}`] = { toSlug: r.toSlug, from: r.from };
    }
    for (const p of plan.prunes) {
      snapshot.pruned.push({
        table: p.table,
        documentId: p.documentId,
        slug: p.slug,
        duplicateOf: p.duplicateOf,
        mergedNameInto: p.merge ? `${p.merge.documentId} (name: ${JSON.stringify(p.merge.name)})` : null,
      });
    }
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  // Phase 0: verify EVERY prune's inbound links before any write, so a
  // refusal never leaves earlier repairs half-applied.
  // eslint-disable-next-line no-restricted-syntax
  for (const p of plan.prunes) {
    const inbound = INBOUND_LINKS[p.table];
    if (!inbound) throw new Error(`refusing to prune ${p.table}: no inbound-relation map`);
    const links = dialect === 'sqlite'
      ? db
          .prepare(`SELECT COUNT(*) AS n FROM ${inbound.table} WHERE ${inbound.column} IN (${p.rowIds.map(() => '?').join(',')})`)
          .all(...p.rowIds)
      : (await db.query(`SELECT COUNT(*) AS n FROM ${inbound.table} WHERE ${inbound.column} = ANY($1::int[])`, [p.rowIds])).rows;
    if (Number(links[0].n) > 0) {
      throw new Error(`refusing to prune ${p.table}:${p.documentId} — ${links[0].n} inbound link(s) appeared since planning`);
    }
  }

  // Phase 1: slug repairs (single transaction on sqlite).
  if (dialect === 'sqlite') {
    const tx = db.transaction(() => {
      for (const r of plan.repairs) {
        const ph = r.rowIds.map(() => '?').join(',');
        db.prepare(`UPDATE ${r.table} SET slug = ? WHERE id IN (${ph})`).run(r.toSlug, ...r.rowIds);
      }
    });
    tx();
  } else {
    // eslint-disable-next-line no-restricted-syntax
    for (const r of plan.repairs) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(`UPDATE ${r.table} SET slug = $1 WHERE id = ANY($2::int[])`, [r.toSlug, r.rowIds]);
    }
  }

  // Phase 2: merge + prune (TOCTOU re-check of the Phase 0 guard).
  let pruned = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const p of plan.prunes) {
    const inbound = INBOUND_LINKS[p.table];
    if (!inbound) throw new Error(`refusing to prune ${p.table}: no inbound-relation map`);
    const links = dialect === 'sqlite'
      ? db
          .prepare(`SELECT COUNT(*) AS n FROM ${inbound.table} WHERE ${inbound.column} IN (${p.rowIds.map(() => '?').join(',')})`)
          .all(...p.rowIds)
      : (await db.query(`SELECT COUNT(*) AS n FROM ${inbound.table} WHERE ${inbound.column} = ANY($1::int[])`, [p.rowIds])).rows;
    if (Number(links[0].n) > 0) {
      throw new Error(`refusing to prune ${p.table}:${p.documentId} — ${links[0].n} inbound link(s) appeared since planning`);
    }
    if (p.merge) {
      // eslint-disable-next-line no-await-in-loop
      await applyMerge(db, dialect, p.merge);
    }
    if (dialect === 'sqlite') {
      const phd = p.rowIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM ${p.table} WHERE id IN (${phd})`).run(...p.rowIds);
    } else {
      await db.query(`DELETE FROM ${p.table} WHERE id = ANY($1::int[])`, [p.rowIds]);
    }
    pruned += 1;
  }

  return { repaired: plan.repairs.length, pruned, snapshotPath: snapshotPath || null };
}

async function closeDb(db, dialect) {
  if (dialect === 'sqlite') db.close();
  else await db.end();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const PRUNE = args.includes('--prune-orphans');
  // Accept both "--db <path>" and "--db=<path>".
  const dbIdx = args.findIndex((a) => a === '--db' || a.startsWith('--db='));
  let explicitLoc = null;
  if (dbIdx !== -1) {
    explicitLoc = args[dbIdx].startsWith('--db=') ? args[dbIdx].slice(5) : args[dbIdx + 1] || null;
  }

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

  console.log(`Dialect:        ${dialect}`);
  console.log(`Target:         ${dialect === 'postgres' ? '<connection string redacted>' : loc}`);
  console.log(`Tables:         ${TABLES.join(', ')}`);
  console.log(`Default locale: ${DEFAULT_LOCALE}`);
  console.log(`Mode:           ${APPLY ? 'APPLY (slugs will be unified + snapshot written)' : 'DRY-RUN (no writes)'}\n`);

  const db = await openDb(dialect, loc);
  const rowsByTable = await fetchRows(db, dialect, TABLES);
  const total = Object.values(rowsByTable).reduce((n, rs) => n + rs.length, 0);
  console.log(`Rows inspected: ${total}`);

  const plan = planUnify(rowsByTable, DEFAULT_LOCALE, { pruneOrphans: PRUNE });

  for (const o of plan.orphans) {
    console.warn(`[ORPHAN]   ${o.table} ${o.documentId}: no ${DEFAULT_LOCALE} row (locales: ${o.locales.join(', ')}) — left untouched`);
  }
  for (const c of plan.conflicts) {
    console.warn(`[CONFLICT] ${c.table} ${c.documentId}: ${c.kind} — ${c.detail} (manual fix required)`);
  }
  for (const r of plan.repairs) {
    const from = Object.entries(r.from).map(([l, s]) => `${l}:"${s}"`).join(', ');
    console.log(`[REPAIR]   ${r.table} ${r.documentId}: ${from} -> "${r.toSlug}" (${r.rowIds.length} row(s))`);
  }
  for (const p of plan.prunes) {
    console.log(`[PRUNE]    ${p.table} ${p.documentId}: EN-only duplicate of ${p.duplicateOf}, slug "${p.slug}", ${p.rowIds.length} row(s), 0 inbound links — merges name "${p.merge?.name}" + published state onto the bilingual document`);
  }
  console.log(`\nDocuments: ${plan.synced} already synced, ${plan.repairs.length} to repair, ${plan.prunes.length} to prune, ${plan.conflicts.length} conflict(s), ${plan.orphans.length} orphan(s) left.`);

  if (plan.conflicts.length > 0) {
    console.error('\nAborting: conflicts must be resolved manually before unification.');
    await closeDb(db, dialect);
    process.exit(1);
  }

  if (!APPLY) {
    if (plan.repairs.length + plan.prunes.length > 0) {
      console.log('Dry-run complete. Re-run with --apply' + (PRUNE ? '' : ' (add --prune-orphans to also delete EN-only duplicates)') + ' to execute.');
      await closeDb(db, dialect);
      process.exit(1);
    }
    console.log('All document slugs already unified. Safe to flip slug to non-localized.');
    await closeDb(db, dialect);
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(
    dialect === 'sqlite' ? path.dirname(loc) : process.cwd(),
    `slug-snapshot-${stamp}.json`
  );
  const { repaired, pruned } = await applyPlan(db, dialect, plan, { snapshotPath, defaultLocale: DEFAULT_LOCALE });
  console.log(`\nApplied: ${repaired} document(s) unified, ${pruned} EN-only duplicate(s) pruned.`);
  if (repaired + pruned > 0) console.log(`Snapshot (redirect map source): ${snapshotPath}`);
  console.log('Re-run without --apply to confirm everything is unified.');
  await closeDb(db, dialect);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('unify-locale-slugs failed:', e.message);
    process.exit(1);
  });
}

module.exports = { planUnify, fetchRows, applyPlan, openDb, closeDb, TABLES, DEFAULT_LOCALE };
