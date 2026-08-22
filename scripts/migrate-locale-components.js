#!/usr/bin/env node
/**
 * migrate-locale-components.js
 *
 * Phase 2 of the dual-field → single localized field migration for listing
 * components. Run it with Strapi STOPPED, after the Phase 1 "expand" boot
 * (new single columns + new component tables exist) and before the Phase 3
 * "contract" boot (dual columns dropped).
 *
 * What it does (in one transaction):
 *   1. Junk cleanup — deletes *_cmps links whose component row no longer
 *      exists or whose entity row no longer exists (stale import debris).
 *   2. tags / schedule / localized-text (in-place) — fills the new single
 *      column (label/text) per link locale: 'en' wants label_en || label_es,
 *      anything else wants label_es. Component rows SHARED by links that
 *      need different values are UNSHARED: the row keeps one value and is
 *      cloned for every other value, with the conflicting links repointed
 *      to the clone (entity/field/order preserved).
 *   3. amenities swap — every live amenities link (tag.tag-item) becomes a
 *      new amenity.amenity-item row {label: per-locale tag value, content: ''}
 *      with a new link (same entity/order). The OLD link is KEPT during the
 *      apply phase so the still-active expand schema keeps serving it; it is
 *      deleted by --cleanup after the contract deploy. Tag rows that still
 *      have tags links are NEVER deleted; tag rows left with zero links
 *      anywhere are pruned by --cleanup.
 *   4. recommendations swap — every live recommendations link
 *      (recommendation.visit-info) expands into up to 4
 *      recommendation.recommendation-item rows, skipping empty fields, in
 *      order: bestTime, bring, accessibilityNotes, connectivityNotes.
 *      Labels are fixed per owning entry locale ("Mejor época para
 *      visitar" / "Qué llevar" / "Accesibilidad" / "Conectividad" for ES,
 *      "Best time to visit" / "What to bring" / "Accessibility" /
 *      "Connectivity" for EN); descriptions come from the matching locale
 *      column (bring keeps its raw \n text). Old links are kept until
 *      --cleanup; orphaned visit-info rows are pruned by --cleanup.
 *
 * Works directly on the database (SQLite via better-sqlite3, PostgreSQL
 * via pg) — no Strapi instance or admin token required.
 *
 * Two-phase deploy (zero downtime window):
 *   apply   (--apply)  — run BEFORE the contract deploy. Fills columns and
 *                        creates new rows/links, but KEEPS the old links so
 *                        the expand schema keeps serving them.
 *   cleanup (--cleanup) — run AFTER the contract deploy is live. Deletes the
 *                        kept old links and prunes orphaned rows.
 *
 * Safety:
 *   - Dry-run by default (prints the plan, writes nothing); exits 1 when
 *     there is pending work, 0 when clean (parity with unify-locale-slugs).
 *   - --apply writes a JSON snapshot of the pre-write state BEFORE touching
 *     anything: affected component rows (old columns), affected/created
 *     links, junk deletions — enough for a manual restore.
 *   - Idempotent: re-running --apply after it completed finds no apply work;
 *     entities that already carry new-type links are never re-created. If
 *     the dual columns are already gone (contract ran), affected steps are
 *     skipped instead of crashing. --cleanup refuses to run while apply work
 *     is still pending.
 *
 * Usage:
 *   node scripts/migrate-locale-components.js                    # dry-run, sqlite .tmp/data.db
 *   node scripts/migrate-locale-components.js --apply            # phase 1 + snapshot
 *   node scripts/migrate-locale-components.js --cleanup          # phase 2 (post contract deploy)
 *   node scripts/migrate-locale-components.js --db /path/data.db # another sqlite db
 *   # PostgreSQL (production): set DATABASE_CLIENT=postgres and DATABASE_URL,
 *   # or pass --db "postgres://user:pass@host/db"
 *
 * Module exports (require-safe, no side effects on import):
 *   - planMigration(state)     -> migration plan (pure)
 *   - fetchState(db, dialect)  -> tables/links/rows needed by the planner
 *   - applyPlan(db, dialect, plan, opts) -> executes the plan + snapshot
 *   - main()                   -> CLI entry (require.main-guarded)
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCALE = 'es-MX';
const EN_LOCALE = 'en';

// Component types migrated in place: dual columns -> one localized column.
const IN_PLACE = [
  {
    componentType: 'tag.tag-item',
    table: 'components_tag_tag_items',
    column: 'label',
    es: 'label_es',
    en: 'label_en',
  },
  {
    componentType: 'schedule.hours',
    table: 'components_schedule_hours',
    column: 'text',
    es: 'text_es',
    en: 'text_en',
  },
  {
    componentType: 'common.localized-text',
    table: 'components_common_localized_texts',
    column: 'text',
    es: 'text_es',
    en: 'text_en',
  },
];

const AMENITY = {
  componentType: 'amenity.amenity-item',
  table: 'components_amenity_amenity_items',
  fromType: 'tag.tag-item',
  field: 'amenities',
};

const RECOMMENDATION = {
  componentType: 'recommendation.recommendation-item',
  table: 'components_recommendation_recommendation_items',
  fromType: 'recommendation.visit-info',
  fromTable: 'components_recommendation_visit_infos',
  field: 'recommendations',
};

// Fixed labels per owning entry locale, in field order.
const REC_FIELDS = [
  { key: 'bestTime', es: 'best_time_es', en: 'best_time_en' },
  { key: 'bring', es: 'bring_es', en: 'bring_en' },
  { key: 'accessibilityNotes', es: 'accessibility_notes_es', en: 'accessibility_notes_en' },
  { key: 'connectivityNotes', es: 'connectivity_notes_es', en: 'connectivity_notes_en' },
];
const REC_LABELS = {
  [DEFAULT_LOCALE]: {
    bestTime: 'Mejor época para visitar',
    bring: 'Qué llevar',
    accessibilityNotes: 'Accesibilidad',
    connectivityNotes: 'Conectividad',
  },
  [EN_LOCALE]: {
    bestTime: 'Best time to visit',
    bring: 'What to bring',
    accessibilityNotes: 'Accessibility',
    connectivityNotes: 'Connectivity',
  },
};

const isBlank = (v) => v === null || v === undefined || String(v) === '';

// ---------------------------------------------------------------------------
// Pure planning logic — unit-testable without any database
// ---------------------------------------------------------------------------

/**
 * Build the migration plan from a fetched state.
 *
 * state: {
 *   linkTables:   [{ table, entityTable, entityHasLocale }],
 *   links:        { [table]: [{ id, entity_id, cmp_id, component_type, field, order }] },
 *   entityIds:    { [entityTable]: Set<number> },
 *   entityLocale: { [entityTable]: Map<id, locale> },   // empty map when no locale column
 *   componentIds: { [componentTable]: Set<number> },
 *   cmpTableByType: { [componentType]: table },          // from src/components schemas
 *   rows:         { [componentTable]: Map<id, row> },    // full rows for IN_PLACE + visit-info
 *   columns:      { [componentTable]: string[] },        // to detect already-dropped duals
 * }
 *
 * Returns {
 *   junkLinks, unknownTypes, noLocaleTables, skippedTables,
 *   inPlace: { [componentType]: { updates, clones } },
 *   amenities: { creations, deleteLinks },
 *   recommendations: { creations, deleteLinks },
 *   prunes: { tagRowIds, visitRowIds },
 *   warnings, totals
 * }
 */
function planMigration(state) {
  const warnings = [];
  const skippedTables = [];
  const seenLocales = new Set();

  const localeOf = (lt, link) => {
    const map = state.entityLocale[lt.entityTable];
    if (!map || !map.has(link.entity_id)) return null;
    return map.get(link.entity_id);
  };

  // ---- Pass 1: junk detection + live link classification ------------------
  const junkLinks = [];
  const unknownTypes = new Map(); // componentType -> link count
  const liveLinks = []; // [{ lt, link, locale }]
  for (const lt of state.linkTables) {
    for (const link of state.links[lt.table] || []) {
      const entityOk = (state.entityIds[lt.entityTable] || new Set()).has(link.entity_id);
      const cmpTable = state.cmpTableByType[link.component_type];
      if (!cmpTable) {
        unknownTypes.set(link.component_type, (unknownTypes.get(link.component_type) || 0) + 1);
        continue; // cannot verify component row existence — keep untouched
      }
      const cmpOk = (state.componentIds[cmpTable] || new Set()).has(link.cmp_id);
      if (!entityOk || !cmpOk) {
        junkLinks.push({ table: lt.table, reason: !entityOk ? 'missing-entity' : 'missing-component', link });
        continue;
      }
      const locale = localeOf(lt, link);
      if (locale !== null) seenLocales.add(locale);
      liveLinks.push({ lt, link, locale });
    }
  }

  const byType = (type, field) =>
    liveLinks.filter((l) => l.link.component_type === type && (field === undefined || l.link.field === field));

  // Resolve the value a link's entity locale wants from a dual-field row.
  const desiredValue = (row, spec, locale) => {
    const es = isBlank(row[spec.es]) ? '' : String(row[spec.es]);
    const en = isBlank(row[spec.en]) ? '' : String(row[spec.en]);
    if (locale === EN_LOCALE) return en || es;
    if (locale !== null && locale !== DEFAULT_LOCALE && !warnings.some((w) => w.kind === 'locale' && w.locale === locale)) {
      warnings.push({
        kind: 'locale',
        locale,
        message: `unexpected locale "${locale}" — treating it as ${DEFAULT_LOCALE} (es column)`,
      });
    }
    return es;
  };

  // ---- Pass 2: amenities swap (tag.tag-item#amenities -> amenity.amenity-item)
  // Planned BEFORE the in-place pass: links consumed by a swap must not take
  // part in unshare grouping/repointing (their value lives on in the new
  // amenity rows, and repointing them would smuggle a tag link past the swap).
  //
  // Expand/contract window: --apply CREATES the new rows/links but keeps the
  // old links so the still-active expand schema keeps serving them; --cleanup
  // (run after the contract deploy) deletes the old links + orphaned rows.
  // Entities that already carry new-type links are never re-created.
  const tagRows = state.rows[IN_PLACE[0].table] || new Map();
  const amenities = { creations: [], deleteLinks: [] };
  const amenityDone = new Set(
    byType(AMENITY.componentType, AMENITY.field).map((l) => l.link.entity_id)
  );
  for (const l of byType(AMENITY.fromType, AMENITY.field)) {
    if (!amenityDone.has(l.link.entity_id)) {
      const row = tagRows.get(l.link.cmp_id);
      if (row) {
        const label = desiredValue(row, IN_PLACE[0], l.locale);
        // Never create an amenity row from a blank source value (erasure
        // guard — empty dual columns mean "nothing to copy from").
        if (!isBlank(label)) {
          amenities.creations.push({
            table: AMENITY.table,
            label,
            content: '',
            link: {
              table: l.lt.table,
              entity_id: l.link.entity_id,
              field: AMENITY.field,
              component_type: AMENITY.componentType,
              order: l.link.order,
            },
          });
        }
      }
    }
    amenities.deleteLinks.push({ table: l.lt.table, id: l.link.id });
  }

  // ---- Pass 3: recommendations swap (visit-info -> up to 4 items) ---------
  const visitCols = state.columns[RECOMMENDATION.fromTable] || [];
  const recommendations = { creations: [], deleteLinks: [] };
  const visitRows = state.rows[RECOMMENDATION.fromTable] || new Map();
  const recDone = new Set(
    byType(RECOMMENDATION.componentType, RECOMMENDATION.field).map((l) => l.link.entity_id)
  );
  if (!REC_FIELDS.every((f) => visitCols.includes(f.es) && visitCols.includes(f.en))) {
    skippedTables.push(`${RECOMMENDATION.fromTable}: dual columns gone — already contracted?`);
  } else {
    for (const l of byType(RECOMMENDATION.fromType, RECOMMENDATION.field)) {
      if (!recDone.has(l.link.entity_id)) {
        const row = visitRows.get(l.link.cmp_id);
        if (row) {
          const labels = l.locale === EN_LOCALE ? REC_LABELS[EN_LOCALE] : REC_LABELS[DEFAULT_LOCALE];
          const col = (f) => (l.locale === EN_LOCALE ? f.en : f.es);
          let order = 0;
          for (const f of REC_FIELDS) {
            const value = isBlank(row[col(f)]) ? '' : String(row[col(f)]);
            if (value === '') continue; // skip NULL/empty fields
            recommendations.creations.push({
              table: RECOMMENDATION.table,
              label: labels[f.key],
              description: value, // bring keeps its raw \n text
              link: {
                table: l.lt.table,
                entity_id: l.link.entity_id,
                field: RECOMMENDATION.field,
                component_type: RECOMMENDATION.componentType,
                order,
              },
            });
            order += 1;
          }
        }
      }
      recommendations.deleteLinks.push({ table: l.lt.table, id: l.link.id });
    }
  }

  const swapDoomedIds = new Set(
    [...amenities.deleteLinks, ...recommendations.deleteLinks].map((d) => `${d.table}:${d.id}`)
  );

  // ---- Pass 4: in-place single-column fills (with unshare cloning) --------
  const inPlace = {};
  for (const spec of IN_PLACE) {
    inPlace[spec.componentType] = { updates: [], clones: [] };
    const cols = state.columns[spec.table] || [];
    if (!cols.includes(spec.es) || !cols.includes(spec.en)) {
      skippedTables.push(`${spec.table}: dual columns gone — already contracted?`);
      continue;
    }
    const rows = state.rows[spec.table] || new Map();
    const links = byType(spec.componentType).filter((l) => !swapDoomedIds.has(`${l.lt.table}:${l.link.id}`));
    const byCmp = new Map();
    for (const l of links) {
      if (!byCmp.has(l.link.cmp_id)) byCmp.set(l.link.cmp_id, []);
      byCmp.get(l.link.cmp_id).push(l);
    }
    for (const [cmpId, cmpLinks] of byCmp) {
      const row = rows.get(cmpId);
      if (!row) continue; // covered by junk pass in apply-time DBs; defensive here
      // Group this row's live links by the value their entity locale wants.
      const groups = new Map(); // value -> [{ lt, link }]
      for (const l of cmpLinks) {
        const v = desiredValue(row, spec, l.locale);
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(l);
      }
      const entries = [...groups.entries()];
      const [keepValue] = entries[0];
      // Never plan a write whose desired value is blank: an empty dual column
      // means "nothing to copy from", and the migration must never erase an
      // already-filled single column.
      if (!isBlank(keepValue)
        && String(isBlank(row[spec.column]) ? '' : row[spec.column]) !== keepValue) {
        inPlace[spec.componentType].updates.push({
          table: spec.table,
          id: cmpId,
          column: spec.column,
          value: keepValue,
        });
      }
      // Unshare: every other distinct value gets a cloned row + repointed links.
      for (const [v, ls] of entries.slice(1)) {
        if (isBlank(v)) continue; // same erasure guard as above
        inPlace[spec.componentType].clones.push({
          table: spec.table,
          sourceId: cmpId,
          column: spec.column,
          value: v,
          links: ls.map((l) => ({
            table: l.lt.table,
            id: l.link.id,
            entity_id: l.link.entity_id,
            field: l.link.field,
            component_type: l.link.component_type,
            order: l.link.order,
          })),
        });
      }
    }
  }

  // ---- Pass 5: prunes (rows left with zero live links anywhere) -----------
  const deletedLinkIds = new Set(
    [
      ...amenities.deleteLinks.map((d) => `${d.table}:${d.id}`),
      ...recommendations.deleteLinks.map((d) => `${d.table}:${d.id}`),
      ...Object.values(inPlace).flatMap((s) => s.clones.flatMap((c) => c.links.map((l) => `${l.table}:${l.id}`))),
    ]
  );
  const refsByTable = new Map(); // componentTable -> Set<cmp_id> still referenced
  for (const l of liveLinks) {
    if (deletedLinkIds.has(`${l.lt.table}:${l.link.id}`)) continue;
    const t = state.cmpTableByType[l.link.component_type];
    if (!t) continue;
    if (!refsByTable.has(t)) refsByTable.set(t, new Set());
    refsByTable.get(t).add(l.link.cmp_id);
  }
  const prunes = { tagRowIds: [], visitRowIds: [] };
  for (const [id] of tagRows) {
    if (!(refsByTable.get(IN_PLACE[0].table) || new Set()).has(id)) prunes.tagRowIds.push(id);
  }
  for (const [id] of visitRows) {
    if (!(refsByTable.get(RECOMMENDATION.fromTable) || new Set()).has(id)) prunes.visitRowIds.push(id);
  }

  const totals = {
    junk: junkLinks.length,
    updates: Object.values(inPlace).flatMap((s) => s.updates).length,
    clones: Object.values(inPlace).flatMap((s) => s.clones).length,
    amenityCreations: amenities.creations.length,
    recommendationCreations: recommendations.creations.length,
    prunedTagRows: prunes.tagRowIds.length,
    prunedVisitRows: prunes.visitRowIds.length,
  };

  return {
    junkLinks,
    unknownTypes: [...unknownTypes.entries()].map(([type, n]) => ({ type, links: n })),
    skippedTables,
    inPlace,
    amenities,
    recommendations,
    prunes,
    warnings,
    totals,
  };
}

/** Apply-phase work: junk removal, in-place fills, new rows/links. */
const planApplyWork = (plan) =>
  plan.totals.junk + plan.totals.updates + plan.totals.clones
    + plan.totals.amenityCreations + plan.totals.recommendationCreations > 0;

/**
 * Cleanup-phase work: old links kept during the expand/contract window +
 * rows orphaned by the swaps. Runs only after the contract deploy.
 */
const planCleanupWork = (plan) =>
  plan.amenities.deleteLinks.length + plan.recommendations.deleteLinks.length
    + plan.totals.prunedTagRows + plan.totals.prunedVisitRows > 0;

const planHasWork = (plan) => planApplyWork(plan) || planCleanupWork(plan);

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

async function closeDb(db, dialect) {
  if (dialect === 'sqlite') db.close();
  else await db.end();
}

const quoteIdent = (d) => (d === 'order' ? '"order"' : d);

async function tableColumns(db, dialect, table) {
  if (dialect === 'sqlite') {
    try {
      return db.pragma(`table_info(${table})`).map((c) => c.name);
    } catch {
      return [];
    }
  }
  const res = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

async function tableExists(db, dialect, table) {
  if (dialect === 'sqlite') {
    return Boolean(
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    );
  }
  const res = await db.query(
    `SELECT 1 AS ok FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return res.rows.length > 0;
}

/**
 * componentType UID -> collectionName, read from the repo's component
 * schemas next to this script. Only tables that exist in the DB are kept.
 */
async function componentTableMap(db, dialect) {
  const dir = path.resolve(__dirname, '..', 'src', 'components');
  const map = {};
  if (fs.existsSync(dir)) {
    for (const group of fs.readdirSync(dir)) {
      const groupDir = path.join(dir, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      for (const file of fs.readdirSync(groupDir)) {
        if (!file.endsWith('.json')) continue;
        let schema;
        try {
          schema = JSON.parse(fs.readFileSync(path.join(groupDir, file), 'utf8'));
        } catch {
          continue;
        }
        if (schema && schema.collectionName) {
          map[`${group}.${path.basename(file, '.json')}`] = schema.collectionName;
        }
      }
    }
  }
  const out = {};
  for (const [uid, table] of Object.entries(map)) {
    if (await tableExists(db, dialect, table)) out[uid] = table; // eslint-disable-line no-await-in-loop
  }
  return out;
}

/**
 * Fetch every table/row/set the pure planner needs.
 */
async function fetchState(db, dialect) {
  const q = (sql, params = []) => (dialect === 'sqlite'
    ? db.prepare(sql).all(...params)
    : db.query(sql, params).then((r) => r.rows));

  // 1) component type -> table (only existing tables).
  const cmpTableByType = await componentTableMap(db, dialect);

  // 2) link tables (*_cmps) + their entity tables.
  const cmpsTables = dialect === 'sqlite'
    ? (await q("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_cmps' ESCAPE '\\'")).map((r) => r.name)
    : (await q(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name LIKE '%\\_cmps'`
    )).map((r) => r.name);

  const linkTables = [];
  const links = {};
  const entityIds = {};
  const entityLocale = {};
  for (const table of cmpsTables) {
    const entityTable = table.slice(0, -'_cmps'.length);
    if (!(await tableExists(db, dialect, entityTable))) continue; // eslint-disable-line no-await-in-loop
    const eCols = await tableColumns(db, dialect, entityTable); // eslint-disable-line no-await-in-loop
    const entityHasLocale = eCols.includes('locale');
    linkTables.push({ table, entityTable, entityHasLocale });
    links[table] = await q( // eslint-disable-line no-await-in-loop
      `SELECT id, entity_id, cmp_id, component_type, field, ${quoteIdent('order')} AS "order" FROM ${table}`
    );
    const idRows = entityHasLocale
      ? await q(`SELECT id, locale FROM ${entityTable}`) // eslint-disable-line no-await-in-loop
      : await q(`SELECT id FROM ${entityTable}`); // eslint-disable-line no-await-in-loop
    entityIds[entityTable] = new Set(idRows.map((r) => r.id));
    entityLocale[entityTable] = new Map(entityHasLocale ? idRows.map((r) => [r.id, r.locale]) : []);
  }

  // 3) component row id sets (existence checks) for every mapped table.
  const componentIds = {};
  for (const table of new Set(Object.values(cmpTableByType))) {
    componentIds[table] = new Set((await q(`SELECT id FROM ${table}`)).map((r) => r.id)); // eslint-disable-line no-await-in-loop
  }

  // 4) full rows + columns for the tables this migration rewrites.
  const interesting = [
    ...IN_PLACE.map((s) => s.table),
    RECOMMENDATION.fromTable,
    AMENITY.table,
    RECOMMENDATION.table,
  ];
  const rows = {};
  const columns = {};
  for (const table of interesting) {
    columns[table] = await tableColumns(db, dialect, table); // eslint-disable-line no-await-in-loop
    rows[table] = new Map();
    if (columns[table].length > 0) {
      const all = await q(`SELECT * FROM ${table}`); // eslint-disable-line no-await-in-loop
      for (const r of all) rows[table].set(r.id, r);
    }
  }

  return { linkTables, links, entityIds, entityLocale, componentIds, cmpTableByType, rows, columns };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function buildSnapshot(dialect, loc, plan, state) {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    dialect,
    target: dialect === 'postgres' ? '<redacted>' : loc,
    defaultLocale: DEFAULT_LOCALE,
    junkDeleted: plan.junkLinks.map((j) => ({ table: j.table, reason: j.reason, link: j.link })),
    inPlace: {},
    amenities: {
      oldLinks: plan.amenities.deleteLinks,
      newRows: plan.amenities.creations.map((c) => ({ label: c.label, content: c.content })),
      newLinks: plan.amenities.creations.map((c) => c.link),
    },
    recommendations: {
      oldLinks: plan.recommendations.deleteLinks,
      newRows: plan.recommendations.creations.map((c) => ({ label: c.label, description: c.description })),
      newLinks: plan.recommendations.creations.map((c) => c.link),
    },
    prunedRows: {
      [IN_PLACE[0].table]: plan.prunes.tagRowIds,
      [RECOMMENDATION.fromTable]: plan.prunes.visitRowIds,
    },
  };
  // Pre-write copies of every affected component row (old columns included).
  for (const spec of IN_PLACE) {
    const affected = new Set([
      ...plan.inPlace[spec.componentType].updates.map((u) => u.id),
      ...plan.inPlace[spec.componentType].clones.map((c) => c.sourceId),
    ]);
    const rowMap = state.rows[spec.table] || new Map();
    const rowsOut = [];
    for (const id of affected) {
      const row = rowMap.get(id);
      if (row) rowsOut.push(row);
    }
    snapshot.inPlace[spec.componentType] = {
      updates: plan.inPlace[spec.componentType].updates,
      clones: plan.inPlace[spec.componentType].clones,
      rowsBefore: rowsOut,
    };
  }
  // Tag + visit-info rows consumed by the swaps (full pre-write state).
  const tagRowMap = state.rows[IN_PLACE[0].table] || new Map();
  const visitRowMap = state.rows[RECOMMENDATION.fromTable] || new Map();
  snapshot.amenities.tagRowsBefore = [...tagRowMap.values()];
  snapshot.recommendations.visitRowsBefore = [...visitRowMap.values()];
  return snapshot;
}

/**
 * Execute one phase of the plan. All writes happen in ONE transaction
 * (sqlite) / one BEGIN..COMMIT block (pg).
 *
 * phase = 'apply'   -> junk removal, in-place fills, swap creations.
 *                      Old links are KEPT so the still-active expand schema
 *                      keeps serving them; a snapshot is written first.
 * phase = 'cleanup' -> deletes the old links kept during the window and
 *                      prunes rows orphaned by the swaps. Run this only
 *                      AFTER the contract deploy is live.
 */
async function applyPlan(db, dialect, plan, opts = {}) {
  const { snapshotPath, state, phase = 'apply' } = opts;

  if (phase === 'apply' && snapshotPath) {
    const snapshot = buildSnapshot(dialect, opts.loc || '', plan, state);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  const pl = (i) => (dialect === 'sqlite' ? '?' : `$${i}`);
  const x = (sql, params) => (dialect === 'sqlite'
    ? db.prepare(sql).run(...params)
    : db.query(sql, params));
  const insertReturningId = async (table, cols, values) => {
    const params = [];
    const ph = values.map((v) => {
      params.push(v);
      return dialect === 'sqlite' ? '?' : `$${params.length}`;
    });
    const colList = cols.map(quoteIdent).join(', ');
    if (dialect === 'sqlite') {
      const res = x(`INSERT INTO ${table} (${colList}) VALUES (${ph.join(', ')})`, params);
      return Number(res.lastInsertRowid);
    }
    const res = await db.query(
      `INSERT INTO ${table} (${colList}) VALUES (${ph.join(', ')}) RETURNING id`,
      params
    );
    return res.rows[0].id;
  };

  const deleteLink = (table, id) => x(`DELETE FROM ${table} WHERE id = ${pl(1)}`, [id]);
  const insertLink = (table, link) => {
    const params = [link.entity_id, link.cmp_id, link.field, link.component_type, link.order === undefined ? null : link.order];
    const cols = ['entity_id', 'cmp_id', 'field', 'component_type', quoteIdent('order')];
    const phs = params.map((_, i) => (dialect === 'sqlite' ? '?' : `$${i + 1}`));
    return x(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${phs.join(', ')})`, params);
  };

  const run = async () => {
    if (phase === 'apply') {
      // 1) junk
      for (const j of plan.junkLinks) {
        await deleteLink(j.table, j.link.id); // eslint-disable-line no-await-in-loop
      }

      // 2) in-place fills + unshare clones
      for (const spec of IN_PLACE) {
        const step = plan.inPlace[spec.componentType];
        for (const u of step.updates) {
          x(`UPDATE ${spec.table} SET ${quoteIdent(u.column)} = ${pl(1)} WHERE id = ${pl(2)}`, [u.value, u.id]);
        }
        for (const c of step.clones) {
          const newId = await insertReturningId(spec.table, [c.column], [c.value]); // eslint-disable-line no-await-in-loop
          for (const link of c.links) {
            await deleteLink(link.table, link.id); // eslint-disable-line no-await-in-loop
            await insertLink(link.table, { ...link, cmp_id: newId }); // eslint-disable-line no-await-in-loop
          }
        }
      }

      // 3) amenities swap — create new rows/links. Old links are KEPT so the
      // still-active expand schema keeps serving them until the contract
      // deploy goes live and --cleanup removes them.
      for (const c of plan.amenities.creations) {
        const newId = await insertReturningId(AMENITY.table, ['label', 'content'], [c.label, c.content]); // eslint-disable-line no-await-in-loop
        await insertLink(c.link.table, { ...c.link, cmp_id: newId }); // eslint-disable-line no-await-in-loop
      }

      // 4) recommendations swap — same window discipline as amenities
      for (const c of plan.recommendations.creations) {
        const newId = await insertReturningId(RECOMMENDATION.table, ['label', 'description'], [c.label, c.description]); // eslint-disable-line no-await-in-loop
        await insertLink(c.link.table, { ...c.link, cmp_id: newId }); // eslint-disable-line no-await-in-loop
      }
      return;
    }

    // phase === 'cleanup': remove the old links kept during the window, then
    // prune rows orphaned by the swaps. Only after the contract deploy.
    for (const d of plan.amenities.deleteLinks) {
      await deleteLink(d.table, d.id); // eslint-disable-line no-await-in-loop
    }
    for (const d of plan.recommendations.deleteLinks) {
      await deleteLink(d.table, d.id); // eslint-disable-line no-await-in-loop
    }
    for (const id of plan.prunes.tagRowIds) {
      x(`DELETE FROM ${IN_PLACE[0].table} WHERE id = ${pl(1)}`, [id]);
    }
    for (const id of plan.prunes.visitRowIds) {
      x(`DELETE FROM ${RECOMMENDATION.fromTable} WHERE id = ${pl(1)}`, [id]);
    }
  };

  if (dialect === 'sqlite') {
    // better-sqlite3 transactions cannot wrap async functions; an explicit
    // BEGIN/COMMIT gives the same all-or-nothing guarantee. The awaits below
    // resolve synchronously (sqlite helpers return values, not promises) and
    // the single connection serializes every statement inside the block.
    db.exec('BEGIN');
    try {
      await run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else {
    await x('BEGIN');
    try {
      await run();
      await x('COMMIT');
    } catch (e) {
      await x('ROLLBACK');
      throw e;
    }
  }

  return plan.totals;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const CLEANUP = args.includes('--cleanup');
  if (APPLY && CLEANUP) {
    console.error('Use either --apply or --cleanup, not both.');
    process.exit(2);
  }
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
  console.log(`Default locale: ${DEFAULT_LOCALE} (en falls back to es when empty)`);
  const modeLabel = APPLY
    ? 'APPLY (phase 1: migrate, keep old links + snapshot)'
    : CLEANUP
      ? 'CLEANUP (phase 2: delete kept old links + prune orphans)'
      : 'DRY-RUN (no writes)';
  console.log(`Mode:       ${modeLabel}\n`);

  const db = await openDb(dialect, loc);
  const state = await fetchState(db, dialect);
  const plan = planMigration(state);

  const linkTotal = Object.values(state.links).reduce((n, ls) => n + ls.length, 0);
  console.log(`Links inspected: ${linkTotal} across ${state.linkTables.length} *_cmps table(s)`);

  const byReason = {};
  for (const j of plan.junkLinks) byReason[j.reason] = (byReason[j.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason)) {
    console.log(`[JUNK]   ${n} link(s) with ${reason} row — will delete`);
  }
  for (const u of plan.unknownTypes) {
    console.warn(`[WARN]   ${u.links} link(s) of unknown component type "${u.type}" — left untouched (no table mapping)`);
  }
  for (const s of plan.skippedTables) {
    console.log(`[SKIP]   ${s}`);
  }
  for (const w of plan.warnings) {
    console.warn(`[WARN]   ${w.message}`);
  }
  for (const spec of IN_PLACE) {
    const step = plan.inPlace[spec.componentType];
    console.log(`[MIGRATE] ${spec.componentType}: ${step.updates.length} row(s) set ${spec.column}, ${step.clones.length} clone(s) for shared rows`);
  }
  console.log(`[SWAP]   amenities: ${plan.amenities.creations.length} new amenity-item row(s) + link(s) to create; ${plan.amenities.deleteLinks.length} old link(s) kept until --cleanup`);
  console.log(`[SWAP]   recommendations: ${plan.recommendations.creations.length} new recommendation-item row(s) to create; ${plan.recommendations.deleteLinks.length} old link(s) kept until --cleanup`);
  console.log(`[PRUNE]  ${plan.prunes.tagRowIds.length} orphaned tag row(s), ${plan.prunes.visitRowIds.length} orphaned visit-info row(s) — removed by --cleanup`);

  const t = plan.totals;
  console.log(
    `\nTotals: junk=${t.junk}, updates=${t.updates}, clones=${t.clones}, amenityRows=${t.amenityCreations}, `
    + `recommendationRows=${t.recommendationCreations}, oldLinks=${plan.amenities.deleteLinks.length + plan.recommendations.deleteLinks.length}, `
    + `prunedTags=${t.prunedTagRows}, prunedVisitInfos=${t.prunedVisitRows}`
  );

  if (!planHasWork(plan)) {
    console.log('Nothing to migrate. Database already in post-migration state.');
    await closeDb(db, dialect);
    process.exit(0);
  }

  if (!APPLY && !CLEANUP) {
    console.log(`\nPending: apply phase ${planApplyWork(plan) ? 'HAS WORK' : 'complete'}, cleanup phase ${planCleanupWork(plan) ? 'HAS WORK' : 'complete'}.`);
    console.log('Dry-run complete. Re-run with --apply (before the contract deploy) and later --cleanup (after it).');
    await closeDb(db, dialect);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (APPLY) {
    if (!planApplyWork(plan)) {
      console.log('\nApply phase already complete (no junk/fills/creations pending).');
      if (planCleanupWork(plan)) {
        console.log('Cleanup phase still pending: after the contract deploy, re-run with --cleanup.');
      }
      await closeDb(db, dialect);
      process.exit(0);
    }
    const snapshotPath = path.join(
      dialect === 'sqlite' ? path.dirname(loc) : process.cwd(),
      `locale-components-snapshot-${stamp}.json`
    );
    await applyPlan(db, dialect, plan, { snapshotPath, loc, state, phase: 'apply' });
    console.log(`\nApplied. Snapshot (pre-write state for manual restore): ${snapshotPath}`);
    console.log('Old links were KEPT. Deploy the contract schemas, then re-run with --cleanup.');
    await closeDb(db, dialect);
    process.exit(0);
  }

  // --cleanup
  if (planApplyWork(plan)) {
    console.error('\nRefusing --cleanup: the apply phase still has pending work. Run --apply first.');
    await closeDb(db, dialect);
    process.exit(1);
  }
  if (!planCleanupWork(plan)) {
    console.log('\nNothing to clean up. No kept old links or orphaned rows remain.');
    await closeDb(db, dialect);
    process.exit(0);
  }
  await applyPlan(db, dialect, plan, { loc, state, phase: 'cleanup' });
  console.log('\nCleanup complete: old links deleted, orphaned rows pruned. Migration fully done.');
  await closeDb(db, dialect);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('migrate-locale-components failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  planMigration,
  planHasWork,
  planApplyWork,
  planCleanupWork,
  fetchState,
  applyPlan,
  openDb,
  closeDb,
  buildSnapshot,
  IN_PLACE,
  AMENITY,
  RECOMMENDATION,
  REC_FIELDS,
  REC_LABELS,
  DEFAULT_LOCALE,
};
