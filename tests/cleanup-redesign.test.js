'use strict';

/**
 * cleanup-redesign.test.js
 *
 * Runs the A5 contract-phase data cleanup against a REAL Strapi instance
 * booted on a throwaway SQLite database (same harness as the deleted
 * migrate-redesign suite: one boot shared by every test, seeds through the
 * Document Service / Query Engine).
 *
 * Seed mirrors the post-migration production shape plus the dirt the
 * cleanup exists for: legacy categories (one linked to a listing, two
 * unlinked), a corrupt NULL-locale listing row with its own link and
 * component rows, orphan contact components, and the removed columns /
 * homepages_cmps leftovers Strapi never drops on its own.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

const TIMEOUT = 180_000;

// Throwaway secrets so config/admin.ts + config/server.ts + the
// users-permissions plugin can boot without a real .env file. Never read
// from or written to an actual .env* file.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.APP_KEYS = process.env.APP_KEYS || 'test-app-key-a,test-app-key-b';
process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'test-api-token-salt';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret';
process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'test-transfer-token-salt';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
process.env.R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.invalid';
process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://example.invalid';
process.env.R2_BUCKET = process.env.R2_BUCKET || 'test-bucket';
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'test-secret-key';
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-google-maps-key';

import cleanup from '../scripts/cleanup-redesign.js';

const { UID } = cleanup;
const ES = 'es-MX';
const EN = 'en';

const LEGACY_SLUGS = ['sites', 'accommodation', 'restaurants'];
const CONTRACT_SLUG = 'experiences';
const LISTING_SLUG = 'museo-la-concha';
const NULL_LOCALE_SLUG = 'fila-corrupta';

function tmpPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

let strapi;
let dbPath;

// Ids captured while seeding so assertions can be surgical.
let nullLocaleRowId;
let corruptContactComponentId;
let orphanContactIds = [];
let museoContactComponentId;

function sqlite() {
  return new Database(dbPath);
}

function columnNames(table) {
  return sqlite()
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function tableCount(table, where = '1=1') {
  return sqlite().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
}

async function createBothLocales(uid, esData, enData, { publish = false } = {}) {
  const es = await strapi.documents(uid).create({
    data: esData,
    locale: ES,
    ...(publish ? { status: 'published' } : {}),
  });
  await strapi.documents(uid).update({
    documentId: es.documentId,
    locale: EN,
    data: enData,
    ...(publish ? { status: 'published' } : {}),
  });
  return es.documentId;
}

async function categoryRowId(slug, locale, { draft = true } = {}) {
  const rows = await strapi.db.query(UID.category).findMany({
    where: { slug, locale },
    select: ['id', 'publishedAt'],
  });
  const hit = rows.find((r) => (draft ? r.publishedAt == null : r.publishedAt != null)) || rows[0];
  return hit.id;
}

async function seedDatabase() {
  // Legacy categories (sites/accommodation/restaurants) + one contract
  // category, all published in both locales.
  const categorySeeds = [
    { slug: CONTRACT_SLUG, es: 'Experiencias', en: 'Experiences', color: '#444444' },
    { slug: 'sites', es: 'Sitios (legado)', en: 'Sites (legacy)', color: '#111111' },
    { slug: 'accommodation', es: 'Hospedaje (legado)', en: 'Accommodation (legacy)', color: '#222222' },
    { slug: 'restaurants', es: 'Restaurantes (legado)', en: 'Restaurants (legacy)', color: '#B5651D' },
  ];
  for (const c of categorySeeds) {
    await createBothLocales(
      UID.category,
      { name: c.es, slug: c.slug, order: 1, color: c.color },
      { name: c.en, slug: c.slug, order: 1, color: c.color },
      { publish: true }
    );
  }

  // One healthy listing linked to the LINKED legacy category (sites): the
  // safety-gate scenario. Carries its own contact component.
  const sitesEsDraft = await categoryRowId('sites', ES, { draft: true });
  const sitesEnDraft = await categoryRowId('sites', EN, { draft: true });
  await createBothLocales(
    UID.listing,
    {
      title: 'Museo La Concha',
      slug: LISTING_SLUG,
      category: sitesEsDraft,
      hideContact: false,
      isFeatured: false,
      order: 0,
      contact: { email: 'museo@example.com' },
    },
    {
      title: 'La Concha Museum',
      slug: LISTING_SLUG,
      category: sitesEnDraft,
      hideContact: false,
      isFeatured: false,
      order: 0,
      contact: { email: 'museo@example.com' },
    },
    { publish: true }
  );

  // Corrupt listing row with locale NULL (production row #99 shape).
  const nullRow = await strapi.db.query(UID.listing).create({
    data: { documentId: 'corrupt-null-doc', title: 'Fila corrupta', slug: NULL_LOCALE_SLUG, locale: null },
  });
  nullLocaleRowId = nullRow.id;

  // Its own contact component, linked through listings_cmps exactly like
  // Strapi would store it.
  const corruptContact = await strapi.db
    .query('contact.contact-info')
    .create({ data: { email: 'corrupt@example.com' } });
  corruptContactComponentId = corruptContact.id;
  await strapi.db.connection('listings_cmps').insert({
    entity_id: nullLocaleRowId,
    cmp_id: corruptContactComponentId,
    component_type: 'contact.contact-info',
    field: 'contact',
    order: null,
  });

  // And a category link row (to the contract category): the corrupt-row
  // cleanup must delete link rows in every link table it owns.
  const expEsDraft = await categoryRowId(CONTRACT_SLUG, ES, { draft: true });
  await strapi.db.connection('listings_category_lnk').insert({
    listing_id: nullLocaleRowId,
    category_id: expEsDraft,
  });

  // Orphan contact components: rows no *_cmps table references.
  for (let i = 1; i <= 3; i++) {
    const orphan = await strapi.db
      .query('contact.contact-info')
      .create({ data: { email: `orphan-${i}@example.com` } });
    orphanContactIds.push(orphan.id);
  }

  // The healthy listing's contact component id (referenced via cmps).
  const museoCmps = await strapi.db
    .connection('listings_cmps')
    .where({ component_type: 'contact.contact-info', field: 'contact' })
    .select('entity_id', 'cmp_id');
  const museoRows = await strapi.db
    .query(UID.listing)
    .findMany({ where: { slug: LISTING_SLUG }, select: ['id'] });
  const museoIds = new Set(museoRows.map((r) => r.id));
  const museoLink = museoCmps.find((l) => museoIds.has(l.entity_id));
  museoContactComponentId = museoLink.cmp_id;

  // Removed columns + homepage leftovers that Strapi never drops itself
  // (verified by the A5 boot check): inject them straight into SQLite.
  // FK enforcement is disabled for this injection only: the production
  // equivalents were FK-valid rows pointing at the destination-story
  // component table, which no longer exists in this new-schema database.
  const db = sqlite();
  db.pragma('foreign_keys = OFF');
  db.exec('ALTER TABLE community_members ADD COLUMN locality VARCHAR(255)');
  db.exec('ALTER TABLE components_contact_contact_infos ADD COLUMN phone VARCHAR(255)');
  db.exec('ALTER TABLE components_contact_contact_infos ADD COLUMN whatsapp VARCHAR(255)');
  db.prepare(
    `INSERT INTO homepages_cmps (entity_id, cmp_id, component_type, field, "order") VALUES (1, 1, 'destination.destination-story', 'destinations', 0)`
  ).run();
  db.close();
}

describe('cleanup-redesign (Strapi-backed)', () => {
  beforeAll(async () => {
    dbPath = tmpPath('cleanup-redesign-test', 'db');
    strapi = await cleanup.loadStrapiInstance({ dbPath });
    await seedDatabase();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.closeStrapiInstance(strapi);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // best-effort cleanup
    }
  }, TIMEOUT);

  it('dry-run reports the plan (including the gate violation) and writes nothing', async () => {
    const countsBefore = {
      legacyCategories: tableCount('categories', `slug IN ('sites','accommodation','restaurants')`),
      nullLocaleListings: tableCount('listings', 'locale IS NULL'),
      contactComponents: tableCount('components_contact_contact_infos'),
      destinationsLinks: tableCount('homepages_cmps', `field IN ('destinations','destinationsHeader')`),
    };
    expect(countsBefore.legacyCategories).toBeGreaterThan(0);
    expect(countsBefore.nullLocaleListings).toBe(1);
    expect(countsBefore.destinationsLinks).toBe(1);

    const plan = await cleanup.planCleanup(strapi);

    // The linked legacy category trips the safety gate...
    expect(plan.aborted).toBeTruthy();
    expect(plan.aborted.reason).toBe('listings still linked to legacy categories');
    expect(plan.aborted.listings.map((l) => l.slug)).toContain(LISTING_SLUG);
    // ...but the plan still reports every other section's work (each legacy
    // category has draft+published rows in both locales).
    expect([...new Set(plan.legacyCategories.rows.map((r) => r.slug))].sort()).toEqual([...LEGACY_SLUGS].sort());
    expect(plan.legacyCategories.rows.length).toBe(LEGACY_SLUGS.length * 4);
    expect(plan.corruptRows.map((r) => r.slug)).toEqual([NULL_LOCALE_SLUG]);
    expect(plan.corruptRows[0].componentRows.map((c) => c.id)).toEqual([corruptContactComponentId]);
    expect(plan.orphans.contactInfos.map((c) => c.id).sort()).toEqual([...orphanContactIds].sort());
    expect(plan.drops.columns.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
      'community_members.locality',
      'components_contact_contact_infos.phone',
      'components_contact_contact_infos.whatsapp',
    ]);
    expect(plan.drops.homepagesFields).toEqual(['destinations', 'destinationsHeader']);
    // Deleted-type tables do not exist in this NEW-schema database: the
    // guarded drops must record them as absent, never schedule them.
    expect(plan.drops.tables).toEqual([]);
    expect(plan.drops.tablesAbsent).toContain('guide_pages');
    expect(plan.drops.tablesAbsent).toContain('components_contact_social_links');
    expect(cleanup.planHasWork(plan)).toBe(true);

    // Nothing was written.
    expect(tableCount('categories', `slug IN ('sites','accommodation','restaurants')`)).toBe(
      countsBefore.legacyCategories
    );
    expect(tableCount('listings', 'locale IS NULL')).toBe(1);
    expect(tableCount('components_contact_contact_infos')).toBe(countsBefore.contactComponents);
    expect(tableCount('homepages_cmps', `field IN ('destinations','destinationsHeader')`)).toBe(1);
  }, TIMEOUT);

  it('--apply with a linked legacy category aborts and deletes NOTHING', async () => {
    const result = await cleanup.applyCleanup(strapi, await cleanup.planCleanup(strapi), {
      snapshotPath: tmpPath('must-not-exist', 'json'),
    });

    expect(result.aborted).toBe(true);

    // Even the unlinked legacy categories, the corrupt row and the orphans
    // stay: the whole run is aborted, not partially applied.
    expect(tableCount('categories', `slug IN ('sites','accommodation','restaurants')`)).toBeGreaterThan(0);
    expect(tableCount('listings', 'locale IS NULL')).toBe(1);
    expect(tableCount('components_contact_contact_infos', `id IN (${orphanContactIds.join(',')})`)).toBe(3);
    expect(columnNames('community_members')).toContain('locality');
    expect(columnNames('components_contact_contact_infos')).toContain('phone');
    expect(columnNames('components_contact_contact_infos')).toContain('whatsapp');
  }, TIMEOUT);

  it('--apply after relinking deletes exactly the planned rows and leftovers', async () => {
    // Remove the gate violation: point every museo row at the contract
    // category row of the same locale and status.
    const museoRows = await strapi.db.query(UID.listing).findMany({
      where: { slug: LISTING_SLUG },
      select: ['id', 'locale', 'publishedAt'],
    });
    for (const row of museoRows) {
      const target = await categoryRowId(CONTRACT_SLUG, row.locale, { draft: row.publishedAt == null });
      await strapi.db.query(UID.listing).update({ where: { id: row.id }, data: { category: target } });
    }

    const plan = await cleanup.planCleanup(strapi);
    expect(plan.aborted).toBeFalsy();
    const snapshotPath = tmpPath('cleanup-redesign-snapshot', 'json');
    const result = await cleanup.applyCleanup(strapi, plan, { snapshotPath });
    expect(result.aborted).toBeFalsy();

    // Legacy categories: every row of all three slugs is gone; the contract
    // category survives untouched.
    for (const slug of LEGACY_SLUGS) {
      expect(await strapi.db.query(UID.category).count({ where: { slug } })).toBe(0);
    }
    expect(await strapi.db.query(UID.category).count({ where: { slug: CONTRACT_SLUG } })).toBeGreaterThan(0);

    // Corrupt row: entity row, its link rows and its component row deleted.
    expect(tableCount('listings', 'locale IS NULL')).toBe(0);
    expect(tableCount('listings_category_lnk', `listing_id = ${nullLocaleRowId}`)).toBe(0);
    expect(tableCount('listings_cmps', `entity_id = ${nullLocaleRowId}`)).toBe(0);
    expect(tableCount('components_contact_contact_infos', `id = ${corruptContactComponentId}`)).toBe(0);

    // Orphans deleted; the healthy listing's contact component survives.
    expect(tableCount('components_contact_contact_infos', `id IN (${orphanContactIds.join(',')})`)).toBe(0);
    expect(tableCount('components_contact_contact_infos', `id = ${museoContactComponentId}`)).toBe(1);

    // Step-4 leftovers dropped in the same transaction.
    expect(columnNames('community_members')).not.toContain('locality');
    expect(columnNames('components_contact_contact_infos')).not.toContain('phone');
    expect(columnNames('components_contact_contact_infos')).not.toContain('whatsapp');
    expect(tableCount('homepages_cmps', `field IN ('destinations','destinationsHeader')`)).toBe(0);

    // Snapshot written before any write, valid JSON.
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(snap.script).toBe('cleanup-redesign.js');
    expect(snap.planned.legacyCategoryRows).toBe(plan.legacyCategories.rows.length);
  }, TIMEOUT);

  it('a second run finds nothing to clean', async () => {
    const plan = await cleanup.planCleanup(strapi);
    expect(plan.aborted).toBeFalsy();
    expect(cleanup.planHasWork(plan)).toBe(false);
  }, TIMEOUT);
});
