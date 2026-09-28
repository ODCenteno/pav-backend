#!/usr/bin/env node
/**
 * cleanup-redesign.js
 *
 * One-shot data cleanup for the A5 contract phase
 * (docs/contracts/redesign-data-contract.md §10/§11, brief
 * docs/redesign/briefs/A5-contract-cleanup.md). Runs inside a loaded
 * Strapi instance, mirroring the retired migrate-redesign.js harness
 * (git history keeps the original).
 *
 * The A5 boot check proved Strapi 5.39 never drops removed tables or
 * columns on boot — it leaves every old artifact in place. This script
 * removes them explicitly, in one transaction:
 *
 *   1. Legacy categories: every row of `sites`, `accommodation` and
 *      `restaurants` (any locale, draft + published). SAFETY GATE: if any
 *      listing still links to one of them the whole run aborts with a
 *      listing-by-listing report and writes nothing.
 *   2. Corrupt rows: listing and community-member rows whose `locale` is
 *      NULL (production had listing row #99). Their link-table rows
 *      (lnk + cmps) and their unshared component rows are deleted with
 *      them; component rows still referenced by a surviving entity are
 *      kept and reported.
 *   3. Orphan contact components: components_contact_contact_infos rows
 *      referenced by no *_cmps link table (checked across ALL of them,
 *      discovered from the schema).
 *   4. Schema-removal leftovers Strapi leaves behind: the tables of the
 *      deleted content types (guide-page, experiences-page, about-page,
 *      team-member, organization — matched by table-name prefix, covering
 *      their _cmps and lnk tables) and of the deleted components, the
 *      homepages_cmps rows of the removed destinations fields, and the
 *      removed columns (community_members.locality,
 *      components_contact_contact_infos.phone / .whatsapp). Every drop is
 *      existence-guarded for both SQLite and PostgreSQL, so re-runs and
 *      partially-cleaned databases are safe no-ops.
 *
 * Safety (same contract as the old migration script):
 *   - Dry-run by default (prints the plan, writes nothing); exits 0.
 *   - --apply writes a JSON snapshot of the pre-write state BEFORE any
 *     write, then writes inside a single `strapi.db.transaction`
 *     (raw knex DDL joins it via .transacting(trx)). Exits 0 on success,
 *     non-zero on failure or abort.
 *   - Idempotent: a second run reports "Nothing to clean".
 *   - Post-commit shutdown warnings (pooled connections dropping on
 *     destroy) are reported once, never as a failure.
 *
 * Usage:
 *   node scripts/cleanup-redesign.js                        # dry-run
 *   node scripts/cleanup-redesign.js --apply                # writes
 *   node scripts/cleanup-redesign.js --db /path/to/data.db  # sqlite target
 *   node scripts/cleanup-redesign.js --db=sqlite:////path    # same
 *   # PostgreSQL: DATABASE_CLIENT=postgres DATABASE_URL=... (as usual for this app)
 */

const fs = require('node:fs');
const path = require('node:path');

const UID = {
  category: 'api::category.category',
  listing: 'api::listing.listing',
  member: 'api::community-member.community-member',
  homepage: 'api::homepage.homepage',
};

// Physical table names of the two content types whose corrupt rows are
// cleaned (from their schema.json collectionName).
const ENTITY_TABLES = {
  [UID.listing]: 'listings',
  [UID.member]: 'community_members',
};

const LEGACY_CATEGORY_SLUGS = ['sites', 'accommodation', 'restaurants'];

// Component-link tables of the corrupt-entity content types (per-table
// entity id column is discovered from db metadata at plan time).
const CMPS_TABLES = {
  [UID.listing]: 'listings_cmps',
  [UID.member]: 'community_members_cmps',
};

const CONTACT_INFO_TABLE = 'components_contact_contact_infos';
const CONTACT_INFO_UID = 'contact.contact-info';
const HOMEPAGE_TABLE = 'homepages';
const HOMEPAGE_CMPS = 'homepages_cmps';

// Removed homepage fields (contract §10 lists them as one deprecated pair).
const REMOVED_HOMEPAGE_FIELDS = ['destinations', 'destinationsHeader'];

// Tables owned by the removed content types (canonical names; every
// actually existing table matching a prefix is dropped, which also covers
// any lnk table shape changes across Strapi versions).
const REMOVED_TYPE_TABLE_PREFIXES = ['guide_page', 'experiences_page', 'about_page', 'team_member', 'organization'];
const REMOVED_TYPE_TABLES = [
  'guide_pages',
  'guide_pages_cmps',
  'experiences_pages',
  'experiences_pages_cmps',
  'about_pages',
  'about_pages_cmps',
  'team_members',
  'team_members_cmps',
  'organizations',
  'organizations_cmps',
];

// Tables of the removed components (A5 schema cleanup).
const REMOVED_COMPONENT_TABLES = [
  'components_about_collaboration_blocks',
  'components_about_values_blocks',
  'components_common_localized_texts',
  'components_contact_links',
  'components_contact_social_links',
  'components_destination_destination_stories',
  'components_experience_experience_blocks',
  'components_guide_amenity_items',
  'components_guide_intro_blocks',
  'components_guide_route_infos',
  'components_recommendation_visit_infos',
];

// Removed columns on surviving tables.
const REMOVED_COLUMNS = [
  { table: 'community_members', column: 'locality' },
  { table: CONTACT_INFO_TABLE, column: 'phone' },
  { table: CONTACT_INFO_TABLE, column: 'whatsapp' },
];

// Surviving components' dotted UID -> table, used when a corrupt row links
// a component that strapi.components cannot resolve. Keys are exactly the
// component types the surviving listing / community-member schemas use.
const COMPONENT_TABLE_FALLBACK = {
  'contact.contact-info': 'components_contact_contact_infos',
  'location.geo-point': 'components_location_geo_points',
  'schedule.hours': 'components_schedule_hours',
  'amenity.amenity-item': 'components_amenity_amenity_items',
  'recommendation.recommendation-item': 'components_recommendation_recommendation_items',
  'story.story-block': 'components_story_story_blocks',
  'product.item': 'components_product_items',
  'tag.tag-item': 'components_tag_tag_items',
};

// ---- Strapi runtime ---------------------------------------------------------

/**
 * Boot a loaded Strapi instance (register + bootstrap, no HTTP server),
 * mirroring the retired migrate-redesign.js harness.
 */
async function loadStrapiInstance({ dbPath, appDir = process.cwd() } = {}) {
  if (dbPath) process.env.DATABASE_FILENAME = dbPath;
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  let distDir = path.join(appDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'src'))) {
    const compiled = await compileStrapi({ appDir });
    distDir = compiled.distDir;
  }
  const app = await createStrapi({ appDir, distDir }).load();
  return app;
}

async function closeStrapiInstance(app) {
  if (!app) return;
  await app.destroy();
  // `createStrapi()` installs its own SIGTERM/SIGINT handlers that call
  // `strapi.destroy()` again and then `process.exit()`. When the caller
  // already destroyed this instance, a later signal would otherwise
  // trigger a double-destroy and an abrupt, unhandled exit.
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
}

// ---- Dialect-guarded schema inspection ---------------------------------------

function dialectOf(strapi) {
  const client = strapi?.db?.config?.connection?.client || strapi?.db?.connection?.client?.config?.client || '';
  return String(client);
}

/** All base-table names in the database (SQLite + Postgres). */
async function listTables(strapi) {
  const db = strapi.db;
  if (dialectOf(strapi).startsWith('sqlite')) {
    const rows = await db.connection.raw(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    );
    return rows.map((r) => r.name).sort();
  }
  const rows = await db.connection(
    'information_schema.tables'
  ).whereRaw(`table_schema = current_schema() AND table_type = 'BASE TABLE'`).select('table_name');
  return rows.map((r) => r.table_name).sort();
}

async function tableExists(strapi, name) {
  return (await listTables(strapi)).includes(name);
}

async function columnExists(strapi, table, column) {
  const db = strapi.db;
  if (dialectOf(strapi).startsWith('sqlite')) {
    const rows = await db.connection.raw(`PRAGMA table_info(${table})`);
    return rows.some((c) => c.name === column);
  }
  const rows = await db
    .connection('information_schema.columns')
    .whereRaw(`table_schema = current_schema() AND table_name = ?`, [table])
    .andWhere('column_name', column)
    .select('column_name');
  return rows.length > 0;
}

/** Every component-link table (*_cmps) present in the database. */
async function listCmpsTables(strapi) {
  return (await listTables(strapi)).filter((t) => t.endsWith('_cmps'));
}

/** Resolve a dotted component UID to its physical table name, or null. */
function componentTableName(strapi, uid) {
  const fromRegistry = strapi?.components?.[uid]?.collectionName;
  if (fromRegistry) return fromRegistry;
  return COMPONENT_TABLE_FALLBACK[uid] || null;
}

/**
 * Join tables + the column of each that references the given entity table,
 * derived from db metadata of BOTH corrupt-entity content types. Covers
 * self-joins (relatedListings / relatedMembers match on either column) and
 * join tables the entity does not own (community_members_listings_lnk).
 */
function joinTableColumnsFor(strapi, entityTable) {
  const out = [];
  const seen = new Set();
  for (const [uid, selfTable] of Object.entries(ENTITY_TABLES)) {
    const meta = strapi.db.metadata.get(uid);
    for (const attr of Object.values(meta.attributes || {})) {
      if (attr.type !== 'relation' || !attr.joinTable) continue;
      const jt = attr.joinTable;
      if (!jt.joinColumn || !jt.inverseJoinColumn) continue;
      const push = (col) => {
        const key = `${jt.name}.${col}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ table: jt.name, column: col });
        }
      };
      if (selfTable === entityTable) push(jt.joinColumn.name);
      const targetUid = attr.target;
      if (targetUid && ENTITY_TABLES[targetUid] === entityTable) push(jt.inverseJoinColumn.name);
    }
  }
  return out;
}

// ---- Planner -----------------------------------------------------------------

async function planCleanup(strapi) {
  const plan = {
    now: new Date().toISOString(),
    aborted: null,
    legacyCategories: { rows: [] },
    corruptRows: [],
    orphans: { contactInfos: [] },
    drops: {
      tables: [],
      tablesAbsent: [],
      columns: [],
      columnsAbsent: [],
      homepagesFields: [...REMOVED_HOMEPAGE_FIELDS],
      homepagesFieldRows: 0,
    },
    warnings: [],
    snapshot: { touches: [] },
  };

  // ---- 1 · Legacy categories + safety gate ---------------------------------
  const legacyRows = await strapi.db.query(UID.category).findMany({
    where: { slug: { $in: LEGACY_CATEGORY_SLUGS } },
    select: ['id', 'documentId', 'slug', 'name', 'locale', 'publishedAt'],
    orderBy: { id: 'asc' },
  });
  plan.legacyCategories.rows = legacyRows;

  if (legacyRows.length > 0) {
    const legacyIds = legacyRows.map((r) => r.id);
    const categoryJoin = strapi.db.metadata.get(UID.listing).attributes.category.joinTable;
    const linkedRows = await strapi.db
      .connection(categoryJoin.name)
      .whereIn(categoryJoin.inverseJoinColumn.name, legacyIds)
      .join('listings', 'listings.id', `${categoryJoin.name}.${categoryJoin.joinColumn.name}`)
      .select('listings.id as listing_id', 'listings.slug as listing_slug', 'listings.locale as listing_locale', `${categoryJoin.name}.${categoryJoin.inverseJoinColumn.name} as category_id`);

    const categoryById = new Map(legacyRows.map((r) => [r.id, r]));
    if (linkedRows.length > 0) {
      plan.aborted = {
        reason: 'listings still linked to legacy categories',
        listings: linkedRows.map((l) => ({
          id: l.listing_id,
          slug: l.listing_slug,
          locale: l.listing_locale ?? null,
          categorySlug: (categoryById.get(l.category_id) || {}).slug ?? null,
        })),
      };
    }
  }

  // ---- 2 · Corrupt NULL-locale rows ----------------------------------------
  const corruptEntityIds = { listings: [], community_members: [] };
  for (const [uid, table] of Object.entries(ENTITY_TABLES)) {
    const rows = await strapi.db.query(uid).findMany({
      where: { locale: { $null: true } },
      select: ['id', 'documentId', 'slug', 'publishedAt'],
      orderBy: { id: 'asc' },
    });
    corruptEntityIds[table] = rows.map((r) => r.id);

    const allCmps = await listCmpsTables(strapi);
    for (const row of rows) {
      const entry = {
        uid,
        table,
        id: row.id,
        documentId: row.documentId,
        slug: row.slug,
        linkRows: [],
        cmpsRows: [],
        componentRows: [],
      };

      for (const { table: jt, column } of joinTableColumnsFor(strapi, table)) {
        const n = await strapi.db.connection(jt).where(column, row.id).count('* as n').first();
        if (Number(n?.n || 0) > 0) entry.linkRows.push({ table: jt, column, count: Number(n.n) });
      }

      const cmpsTable = CMPS_TABLES[uid];
      if (cmpsTable && (await tableExists(strapi, cmpsTable))) {
        const links = await strapi.db.connection(cmpsTable).where('entity_id', row.id);
        for (const link of links) {
          entry.cmpsRows.push({ table: cmpsTable, id: link.id, cmpId: link.cmp_id, componentType: link.component_type, field: link.field });
        }
      }
      plan.corruptRows.push(entry);
    }
  }

  // Component rows owned by corrupt rows (deleted only when no surviving
  // entity still references them — draft/published variants can share a
  // row through the cmps unique index).
  for (const entry of plan.corruptRows) {
    for (const link of entry.cmpsRows) {
      const cmpTable = componentTableName(strapi, link.componentType);
      if (!cmpTable || !(await tableExists(strapi, cmpTable))) {
        plan.warnings.push(
          `corrupt ${entry.table} row #${entry.id} links unknown component type '${link.componentType}'; component row kept`
        );
        continue;
      }
      const stillReferenced = (
        await Promise.all(
          (await listCmpsTables(strapi)).map((t) =>
            strapi.db
              .connection(t)
              .where('cmp_id', link.cmpId)
              .where('component_type', link.componentType)
              .whereNot('entity_id', entry.id)
              .count('* as n')
              .first()
          )
        )
      ).some((n) => Number(n?.n || 0) > 0);
      if (stillReferenced) {
        plan.warnings.push(
          `component row #${link.cmpId} (${link.componentType}) of corrupt row #${entry.id} is still referenced by another entity; kept`
        );
        continue;
      }
      entry.componentRows.push({ id: link.cmpId, table: cmpTable, componentType: link.componentType });
    }
  }

  // ---- 3 · Orphan contact components ---------------------------------------
  if (await tableExists(strapi, CONTACT_INFO_TABLE)) {
    const allContacts = (await strapi.db.connection(CONTACT_INFO_TABLE).select('id')).map((r) => r.id);
    const referenced = new Set();
    for (const t of await listCmpsTables(strapi)) {
      const rows = await strapi.db
        .connection(t)
        .where('component_type', CONTACT_INFO_UID)
        .distinct('cmp_id');
      for (const r of rows) referenced.add(r.cmp_id);
    }
    plan.orphans.contactInfos = allContacts
      .filter((id) => !referenced.has(id))
      .map((id) => ({ id }));
  }

  // ---- 4 · Schema-removal leftovers -----------------------------------------
  const existingTables = await listTables(strapi);
  const canonical = [...REMOVED_TYPE_TABLES, ...REMOVED_COMPONENT_TABLES];
  const scheduled = new Set();
  for (const t of existingTables) {
    if (REMOVED_TYPE_TABLE_PREFIXES.some((p) => t.startsWith(p)) || canonical.includes(t)) {
      scheduled.add(t);
    }
  }
  plan.drops.tables = [...scheduled].sort();
  plan.drops.tablesAbsent = canonical.filter((t) => !existingTables.includes(t)).sort();

  if (await tableExists(strapi, HOMEPAGE_CMPS)) {
    const n = await strapi.db
      .connection(HOMEPAGE_CMPS)
      .whereIn('field', REMOVED_HOMEPAGE_FIELDS)
      .count('* as n')
      .first();
    plan.drops.homepagesFieldRows = Number(n?.n || 0);
  }

  for (const { table, column } of REMOVED_COLUMNS) {
    if (await tableExists(strapi, table)) {
      if (await columnExists(strapi, table, column)) {
        plan.drops.columns.push({ table, column });
      } else {
        plan.drops.columnsAbsent.push(`${table}.${column}`);
      }
    } else {
      plan.drops.columnsAbsent.push(`${table}.${column} (table absent)`);
    }
  }

  for (const entry of plan.corruptRows) {
    plan.snapshot.touches.push({ kind: 'corrupt-row', table: entry.table, id: entry.id, slug: entry.slug });
  }
  for (const r of plan.legacyCategories.rows) {
    plan.snapshot.touches.push({ kind: 'legacy-category', table: 'categories', id: r.id, slug: r.slug, locale: r.locale });
  }
  for (const c of plan.orphans.contactInfos) {
    plan.snapshot.touches.push({ kind: 'orphan-contact', table: CONTACT_INFO_TABLE, id: c.id });
  }

  return plan;
}

const planHasWork = (plan) =>
  plan.legacyCategories.rows.length > 0 ||
  plan.corruptRows.length > 0 ||
  plan.orphans.contactInfos.length > 0 ||
  plan.drops.tables.length > 0 ||
  plan.drops.columns.length > 0 ||
  plan.drops.homepagesFieldRows > 0;

// ---- Snapshot ------------------------------------------------------------------

function buildSnapshot(plan) {
  return {
    generatedAt: new Date().toISOString(),
    script: 'cleanup-redesign.js',
    preState: plan.snapshot.touches,
    planned: {
      legacyCategoryRows: plan.legacyCategories.rows.length,
      corruptRows: plan.corruptRows.length,
      orphanContactInfos: plan.orphans.contactInfos.length,
      tablesDropped: plan.drops.tables.length,
      columnsDropped: plan.drops.columns.length,
      homepagesFieldRows: plan.drops.homepagesFieldRows,
    },
  };
}

// ---- Apply -----------------------------------------------------------------------

/**
 * Execute a (non-aborted) plan inside ONE transaction. The snapshot is
 * written before any database write. Returns the totals, or
 * { aborted: true } (writing nothing) when handed an aborted plan.
 */
async function applyCleanup(strapi, plan, opts = {}) {
  if (plan.aborted) {
    return { aborted: true };
  }
  const { snapshotPath } = opts;
  if (snapshotPath) {
    const snap = buildSnapshot(plan);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snap, null, 2)}\n`);
  }

  const totals = {
    legacyCategoryRows: plan.legacyCategories.rows.length,
    corruptRows: plan.corruptRows.length,
    orphanContactInfos: plan.orphans.contactInfos.length,
    tablesDropped: plan.drops.tables.length,
    tablesAlreadyAbsent: plan.drops.tablesAbsent.length,
    columnsDropped: plan.drops.columns.length,
    columnsAlreadyAbsent: plan.drops.columnsAbsent.length,
    homepagesFieldRowsDeleted: plan.drops.homepagesFieldRows,
    linkRowsDeleted: 0,
    cmpsRowsDeleted: 0,
    componentRowsDeleted: 0,
    snapshotPath: snapshotPath || null,
  };

  await strapi.db.transaction(async ({ trx }) => {
    const conn = (table) => strapi.db.connection(table).transacting(trx);

    // 1. Legacy categories.
    if (plan.legacyCategories.rows.length > 0) {
      await conn('categories')
        .whereIn('id', plan.legacyCategories.rows.map((r) => r.id))
        .del();
    }

    // 2. Corrupt rows: link rows, cmps rows, unshared component rows, then
    //    the entity rows themselves.
    for (const entry of plan.corruptRows) {
      for (const { table, column } of joinTableColumnsFor(strapi, entry.table)) {
        totals.linkRowsDeleted += await conn(table).where(column, entry.id).del();
      }
      const cmpsTable = CMPS_TABLES[entry.uid];
      if (cmpsTable) {
        totals.cmpsRowsDeleted += await conn(cmpsTable).where('entity_id', entry.id).del();
      }
      for (const cmp of entry.componentRows) {
        totals.componentRowsDeleted += await conn(cmp.table).where('id', cmp.id).del();
      }
      totals.corruptRows += 0; // counted once above
      await conn(entry.table).where('id', entry.id).del();
    }

    // 3. Orphan contact components.
    if (plan.orphans.contactInfos.length > 0) {
      await conn(CONTACT_INFO_TABLE)
        .whereIn('id', plan.orphans.contactInfos.map((c) => c.id))
        .del();
    }

    // 4a. homepages_cmps rows of the removed fields.
    if (plan.drops.homepagesFieldRows > 0) {
      totals.homepagesFieldRowsDeleted = await conn(HOMEPAGE_CMPS)
        .whereIn('field', REMOVED_HOMEPAGE_FIELDS)
        .del();
    }

    // 4b. Tables (guarded: existence verified at plan time, IF EXISTS as a
    //     belt-and-braces no-op for both dialects). CASCADE on Postgres so
    //     FKs between the dropped tables (e.g. *_cmps -> component tables)
    //     do not block the one-by-one drops; SQLite has no CASCADE and
    //     does not enforce FKs on DDL.
    const cascade = dialectOf(strapi).startsWith('sqlite') ? '' : ' CASCADE';
    for (const table of plan.drops.tables) {
      await strapi.db.connection.raw(`DROP TABLE IF EXISTS "${table}"${cascade}`).transacting(trx);
    }

    // 4c. Columns (SQLite >= 3.35 and PostgreSQL both support the plain form).
    for (const { table, column } of plan.drops.columns) {
      await strapi.db.connection.raw(`ALTER TABLE "${table}" DROP COLUMN "${column}"`).transacting(trx);
    }
  });

  return totals;
}

// ---- Plan printing -----------------------------------------------------------------

function printPlan(plan) {
  if (plan.aborted) {
    console.log('\n[ABORT] listings still linked to legacy categories:');
    for (const l of plan.aborted.listings) {
      console.log(`  listing #${l.id} (${l.slug}${l.locale ? `, ${l.locale}` : ''}) -> category '${l.categorySlug}'`);
    }
    console.log('  aborting: listings still linked to legacy categories');
    return;
  }

  for (const r of plan.legacyCategories.rows) {
    console.log(`[LEGACY-CATEGORY] #${r.id} ${r.slug} (${r.locale}${r.publishedAt == null ? ', draft' : ''})`);
  }
  for (const r of plan.corruptRows) {
    console.log(
      `[CORRUPT-ROW] ${r.table} #${r.id} (${r.slug}) — ${r.linkRows.reduce((n, l) => n + l.count, 0)} link row(s), ` +
        `${r.cmpsRows.length} component link(s), ${r.componentRows.length} component row(s)`
    );
  }
  console.log(`[ORPHAN-CONTACTS] ${plan.orphans.contactInfos.length} row(s)`);
  for (const t of plan.drops.tables) console.log(`[DROP-TABLE] ${t}`);
  for (const t of plan.drops.tablesAbsent) console.log(`[DROP-TABLE] ${t} (already absent)`);
  for (const c of plan.drops.columns) console.log(`[DROP-COLUMN] ${c.table}.${c.column}`);
  for (const c of plan.drops.columnsAbsent) console.log(`[DROP-COLUMN] ${c} (already absent)`);
  if (plan.drops.homepagesFieldRows > 0) {
    console.log(`[HOMEPAGE-FIELDS] ${plan.drops.homepagesFieldRows} link row(s) for ${plan.drops.homepagesFields.join(', ')}`);
  }
  for (const w of plan.warnings) console.log(`[WARN] ${w}`);

  console.log('\nSummary:');
  console.log('  section                      count');
  console.log(`  ${'legacy category rows'.padEnd(28)} ${String(plan.legacyCategories.rows.length).padStart(5)}`);
  console.log(`  ${'corrupt NULL-locale rows'.padEnd(28)} ${String(plan.corruptRows.length).padStart(5)}`);
  console.log(`  ${'orphan contact rows'.padEnd(28)} ${String(plan.orphans.contactInfos.length).padStart(5)}`);
  console.log(`  ${'tables to drop'.padEnd(28)} ${String(plan.drops.tables.length).padStart(5)} (${plan.drops.tablesAbsent.length} already absent)`);
  console.log(`  ${'columns to drop'.padEnd(28)} ${String(plan.drops.columns.length).padStart(5)} (${plan.drops.columnsAbsent.length} already absent)`);
  console.log(`  ${'homepage field link rows'.padEnd(28)} ${String(plan.drops.homepagesFieldRows).padStart(5)}`);
}

// ---- CLI ------------------------------------------------------------------------------

function valueFlag(args, name) {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return null;
  const a = args[idx];
  if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  return args[idx + 1] || null;
}

async function main() {
  let committed = false;
  // A pooled connection can also reject asynchronously while shutting down.
  let shutdownWarnings = 0;
  process.on('unhandledRejection', (e) => {
    if (!committed) throw e;
    // Pooled connections dropping on shutdown reject once per connection;
    // report it a single time so a successful run does not look alarming.
    if (shutdownWarnings++ === 0) {
      console.warn(`[cleanup-redesign] shutdown warning (data already committed): ${e && e.message}`);
    }
  });

  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const explicitDb = valueFlag(args, '--db');

  console.log(`Mode:       ${APPLY ? 'APPLY (cleanup + snapshot written)' : 'DRY-RUN (no writes)'}\n`);

  let strapiApp;
  try {
    strapiApp = await loadStrapiInstance({ dbPath: explicitDb });
    const plan = await planCleanup(strapiApp);
    printPlan(plan);

    if (plan.aborted) {
      console.log('\nAborted before any write. Re-link the listings above to a contract category and re-run.');
      return 3;
    }
    if (!planHasWork(plan)) {
      console.log('\nNothing to clean — database already matches the post-cleanup contract.');
      return 0;
    }
    if (!APPLY) {
      console.log('\nDry-run complete. Re-run with --apply to execute.');
      return 0;
    }

    const dbFile = process.env.DATABASE_FILENAME;
    const snapshotDir =
      process.env.DATABASE_CLIENT === 'postgres' || !dbFile
        ? process.cwd()
        : path.dirname(path.resolve(process.cwd(), dbFile));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(snapshotDir, `cleanup-redesign-snapshot-${stamp}.json`);

    const totals = await applyCleanup(strapiApp, plan, { snapshotPath });
    committed = true;
    console.log(
      `\nCleanup complete: ${totals.legacyCategoryRows} legacy category row(s), ${totals.corruptRows} corrupt row(s) ` +
        `(+${totals.linkRowsDeleted} link row(s), ${totals.cmpsRowsDeleted} component link(s), ${totals.componentRowsDeleted} component row(s)), ` +
        `${totals.orphanContactInfos} orphan contact row(s), ${totals.tablesDropped} table(s) dropped ` +
        `(${totals.tablesAlreadyAbsent} already absent), ${totals.columnsDropped} column(s) dropped ` +
        `(${totals.columnsAlreadyAbsent} already absent), ${totals.homepagesFieldRowsDeleted} homepage field link row(s). ` +
        `Snapshot: ${snapshotPath}`
    );
    console.log('Re-run without --apply to confirm there is nothing left to do.');
    return 0;
  } finally {
    try {
      await closeStrapiInstance(strapiApp);
    } catch (e) {
      // After a committed transaction a dropped pooled connection (seen on Neon
      // after long runs) must not turn a successful cleanup into exit 1.
      if (!committed) throw e;
      console.warn(`[cleanup-redesign] shutdown warning (data already committed): ${e.message}`);
    }
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error('cleanup-redesign failed:', e.message);
      process.exit(1);
    });
}

module.exports = {
  loadStrapiInstance,
  closeStrapiInstance,
  planCleanup,
  planHasWork,
  applyCleanup,
  buildSnapshot,
  printPlan,
  UID,
  LEGACY_CATEGORY_SLUGS,
  ENTITY_TABLES,
  REMOVED_HOMEPAGE_FIELDS,
  REMOVED_TYPE_TABLES,
  REMOVED_COMPONENT_TABLES,
  REMOVED_COLUMNS,
  COMPONENT_TABLE_FALLBACK,
  CONTACT_INFO_UID,
  CONTACT_INFO_TABLE,
};
