#!/usr/bin/env node
/**
 * enrich-recommendations-from-es.js
 *
 * One-shot enrichment for EN listing entities whose recommendations array is
 * empty after the migration of `recommendation.visit-info` -> flexible
 * `recommendation.recommendation-item` rows. For each candidate:
 *
 *   1. Find the best ES sibling entity of the same `document_id` (published
 *      preferred; ties broken by published_at desc).
 *   2. For each of its `recommendation.recommendation-item` rows (in `order`):
 *      create a new row with `label` mapped to an English title by `order`
 *      position ("Best time to visit", "What to bring", "Accessibility",
 *      "Connectivity"; for items beyond the standard 4, the source label is
 *      preserved). The description is copied verbatim from the ES source as
 *      a Spanish placeholder for editors to translate later.
 *   3. Link the new row under `field='recommendations'` with the new
 *      `recommendation.recommendation-item` component type, at the source
 *      row's `order`.
 *
 * Idempotent: an EN entity that already has any recommendation-item links is
 * skipped entirely (won't duplicate, won't overwrite editor content).
 *
 * Safety:
 *   - Dry-run by default (prints the plan, writes nothing); exits 1 with
 *     pending work, 0 when clean. Parity with `unify-locale-slugs.js`.
 *   - --apply writes a JSON snapshot of the pre-write state BEFORE any
 *     write: enough for manual restore (target ids + planned content).
 *   - All writes happen in ONE transaction (sqlite) / BEGIN..COMMIT (pg).
 *   - Skip the rest if the dual-column components are absent (already
 *     contracted -> nothing to enrich).
 *
 * Usage:
 *   node scripts/enrich-recommendations-from-es.js                 # dry-run
 *   node scripts/enrich-recommendations-from-es.js --apply         # writes
 *   node scripts/enrich-recommendations-from-es.js --db /path.db  # sqlite
 *   # PostgreSQL: DATABASE_CLIENT=postgres DATABASE_URL=...
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCALE = 'es-MX';
const TARGET_LOCALE = 'en';

// English titles by source row `order` position. Mirrors the EN labels the
// migration script emits for visit-info fields (best time / what to bring /
// accessibility / connectivity). Items beyond index 3 keep the source label
// (editor-driven custom items).
const EN_LABELS_BY_ORDER = [
  'Best time to visit',
  'What to bring',
  'Accessibility',
  'Connectivity',
];

const EN_LABEL_FOR_ORDER = (i, sourceLabel) =>
  i < EN_LABELS_BY_ORDER.length ? EN_LABELS_BY_ORDER[i] : sourceLabel;

const RECOMMENDATION = {
  table: 'components_recommendation_recommendation_items',
  componentType: 'recommendation.recommendation-item',
  field: 'recommendations',
};

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

// ---- Planner ----------------------------------------------------------------

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

async function planEnrichment(db, dialect) {
  const q = async (sql, params = []) => {
    if (dialect === 'sqlite') {
      const { sql: s, params: p } = adaptForSqlite(sql, params);
      return db.prepare(s).all(...p);
    }
    return (await db.query(sql, params)).rows;
  };

  // Table existence check. Without the new component table there's nothing
  // to enrich. (Columns are statically known to the script; no need to
  // introspect them — `INSERT INTO ... label, description` is constant.)
  let tableExists = false;
  try {
    if (dialect === 'sqlite') {
      // `PRAGMA table_info(?)` does not accept bound parameters in sqlite,
      // so use sqlite_master instead.
      const r = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(RECOMMENDATION.table);
      tableExists = Boolean(r);
    } else {
      const r = await db.query(
        'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [RECOMMENDATION.table]
      );
      tableExists = r.rows.length > 0;
    }
  } catch {
    tableExists = false;
  }
  if (!tableExists) return { candidates: [], skipped: ['recommendation tables absent'] };

  const candidates = (
    await q(
      `WITH en_empty AS (
         SELECT l.id, l.document_id, l.slug, l.published_at IS NOT NULL AS pub
         FROM listings l
         WHERE l.locale = 'en'
           AND NOT EXISTS (
             SELECT 1 FROM listings_cmps lc
             WHERE lc.entity_id = l.id
               AND lc.field = $1
               AND lc.component_type = $2
           )
       ),
       es_ranked AS (
         SELECT l.document_id, l.id, l.published_at,
                (SELECT COUNT(*) FROM listings_cmps lc
                   WHERE lc.entity_id = l.id AND lc.field = $1 AND lc.component_type = $2) AS rec_count,
                ROW_NUMBER() OVER (
                  PARTITION BY l.document_id
                  ORDER BY (CASE WHEN l.published_at IS NOT NULL THEN 0 ELSE 1 END),
                           l.published_at DESC NULLS LAST
                ) AS rn
         FROM listings l
         WHERE l.locale = 'es-MX'
       )
       SELECT e.id AS en_id, e.document_id, e.slug, e.pub AS en_pub,
              er.id AS es_id, er.rec_count AS es_rec_count, er.published_at AS es_pub
       FROM en_empty e
       LEFT JOIN es_ranked er ON er.document_id = e.document_id AND er.rn = 1`,
      [RECOMMENDATION.field, RECOMMENDATION.componentType]
    )
  ).map((r) => ({
    en_id: r.en_id,
    document_id: r.document_id,
    slug: r.slug,
    en_pub: 'en_pub' in r ? Boolean(r.en_pub) : null,
    es_id: r.es_id,
    es_rec_count: r.es_rec_count,
    es_pub: r.es_pub,
  }));

  const plan = { candidates: [], skipped: [] };
  for (const c of candidates) {
    if (!c.es_id || !c.es_rec_count || c.es_rec_count === '0') continue;
    const items = (
      await q(
        `SELECT lc."order" AS "order", ri.label, ri.description
           FROM listings_cmps lc
           JOIN components_recommendation_recommendation_items ri ON ri.id = lc.cmp_id
          WHERE lc.entity_id = $1
            AND lc.field = $2
            AND lc.component_type = $3
          ORDER BY lc."order"`,
        [c.es_id, RECOMMENDATION.field, RECOMMENDATION.componentType]
      )
    ).map((r) => ({
      order: r.order,
      sourceLabel: r.label,
      label: EN_LABEL_FOR_ORDER(r.order, r.label),
      description: r.description == null ? '' : String(r.description),
    }));

    plan.candidates.push({
      en_id: c.en_id,
      slug: c.slug,
      document_id: c.document_id,
      es_source_id: c.es_id,
      es_published_at: c.es_pub,
      items,
    });
  }
  return plan;
}

const planHasWork = (plan) => plan.candidates.length > 0;

// ---- Snapshot --------------------------------------------------------------

function buildSnapshot(dialect, target, plan) {
  return {
    generatedAt: new Date().toISOString(),
    dialect,
    target: dialect === 'postgres' ? '<redacted>' : target,
    defaultLocale: DEFAULT_LOCALE,
    targetLocale: TARGET_LOCALE,
    planned: plan.candidates.map((c) => ({
      en_id: c.en_id,
      slug: c.slug,
      document_id: c.document_id,
      es_source_id: c.es_source_id,
      items: c.items.map((i) => ({ order: i.order, label: i.label, description: i.description })),
    })),
  };
}

// ---- Apply -----------------------------------------------------------------

async function applyPlan(db, dialect, plan, opts = {}) {
  const { snapshotPath, target } = opts;
  if (snapshotPath) {
    const snap = buildSnapshot(dialect, target, plan);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snap, null, 2)}\n`);
  }

  const x = (sql, params) =>
    dialect === 'sqlite'
      ? db.prepare(sql).run(...params)
      : db.query(sql, params);
  const insertReturningId = async (cols, values) => {
    const params = [];
    const phs = values.map((v) => {
      params.push(v);
      return dialect === 'sqlite' ? '?' : `$${params.length}`;
    });
    const colList = cols.map(quoteIdent).join(', ');
    if (dialect === 'sqlite') {
      const res = x(`INSERT INTO ${RECOMMENDATION.table} (${colList}) VALUES (${phs.join(', ')})`, params);
      return Number(res.lastInsertRowid);
    }
    const res = await db.query(
      `INSERT INTO ${RECOMMENDATION.table} (${colList}) VALUES (${phs.join(', ')}) RETURNING id`,
      params
    );
    return res.rows[0].id;
  };
  const insertLink = (entity_id, cmp_id, order) => {
    const cols = ['entity_id', 'cmp_id', 'field', 'component_type', quoteIdent('order')];
    const params = [entity_id, cmp_id, RECOMMENDATION.field, RECOMMENDATION.componentType, order];
    const phs = params.map((_, i) => (dialect === 'sqlite' ? '?' : `$${i + 1}`));
    return x(`INSERT INTO listings_cmps (${cols.join(', ')}) VALUES (${phs.join(', ')})`, params);
  };

  const run = async () => {
    for (const c of plan.candidates) {
      for (const it of c.items) {
        const newId = await insertReturningId(['label', 'description'], [it.label, it.description]);
        insertLink(c.en_id, newId, it.order);
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
  return { enrichedEntities: plan.candidates.length, enrichedItems: plan.candidates.reduce((n, c) => n + c.items.length, 0) };
}

// ---- CLI --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
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

  console.log(`Dialect:    ${dialect}`);
  console.log(`Target:     ${dialect === 'postgres' ? '<connection string redacted>' : loc}`);
  console.log(`Mode:       ${APPLY ? 'APPLY (enrich + snapshot written)' : 'DRY-RUN (no writes)'}\n`);

  const db = await openDb(dialect, loc);
  const plan = await planEnrichment(db, dialect);

  for (const s of plan.skipped) console.log(`[SKIP] ${s}`);
  for (const c of plan.candidates) {
    console.log(
      `[ENRICH] slug=${c.slug} | document=${(c.document_id || '').slice(0, 8)} | ` +
      `from es-source entity #${c.es_source_id} | ${c.items.length} item(s)`
    );
    for (const i of c.items) console.log(`         order=${i.order} label=${JSON.stringify(i.label)}`);
  }
  const noSource = plan.candidates.length === 0
    ? ''
    : `\nNote: ${plan.candidates.length} EN entity(ies) have an ES source. EN entities with no ES sibling were skipped (orphan data).`;
  if (!planHasWork(plan)) {
    console.log('Nothing to enrich — every EN entity either has recommendations or no ES sibling.');
    await closeDb(db, dialect);
    process.exit(0);
  }
  console.log(
    `\nTotal: ${plan.candidates.length} listing(s) -> ${plan.candidates.reduce((n, c) => n + c.items.length, 0)} new EN item(s)${noSource}`
  );

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to execute.');
    await closeDb(db, dialect);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(
    dialect === 'sqlite' ? path.dirname(loc) : process.cwd(),
    `enrich-recommendations-snapshot-${stamp}.json`
  );
  const totals = await applyPlan(db, dialect, plan, { snapshotPath, target: loc });
  console.log(`\nEnrichment complete: ${totals.enrichedEntities} listing(s), ${totals.enrichedItems} new EN item(s). Snapshot: ${snapshotPath}`);
  console.log('Re-run without --apply to confirm there is nothing left to do.');
  await closeDb(db, dialect);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('enrich-recommendations failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  planEnrichment,
  planHasWork,
  applyPlan,
  EN_LABELS_BY_ORDER,
  RECOMMENDATION,
};
