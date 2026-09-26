'use strict';

/**
 * migrate-redesign.test.js
 *
 * Runs the redesign migration against a REAL Strapi instance booted on a
 * throwaway SQLite database, seeded through the Document Service with a
 * small but realistic dataset (legacy categories, listings with a pending
 * draft edit, community members, a guide-page). Assertions read back
 * through the Document Service, exactly like the frontend and the admin
 * panel would.
 *
 * CI runs `pnpm test` BEFORE `pnpm build`, so `dist/` may not exist yet:
 * this suite compiles it once (compileStrapi) if missing, then boots
 * (createStrapi().load()) a single Strapi instance shared by every test in
 * this file (booting Strapi is expensive; re-seeding per test is not).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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

import migrate from '../scripts/migrate-redesign.js';

const { UID, LOCALES, ARTISAN_LISTING, COMMUNITY_CONTRACT } = migrate;
const [ES, EN] = LOCALES;

function tmpPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

let strapi;
let dbPath;

/** Create a document in both locales through the Document Service. */
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

const CATEGORY_SEEDS = [
  { slug: 'sites', order: 10, es: 'Sitios (legado)', en: 'Sites (legacy)', color: '#111111' },
  { slug: 'accommodation', order: 20, es: 'Hospedaje (legado)', en: 'Accommodation (legacy)', color: '#222222' },
  { slug: 'restaurants', order: 30, es: 'Restaurantes (legado)', en: 'Restaurants (legacy)', color: '#B5651D' },
  { slug: 'services', order: 40, es: 'Servicios (legado)', en: 'Services (legacy)', color: '#333333' },
  { slug: 'experiences', order: 5, es: 'Experiencias (legado)', en: 'Legacy Experiences', color: '#444444' },
];

const LISTING_SEEDS = [
  {
    slug: 'restaurante-brisa-del-mar',
    titleEs: 'Restaurante Brisa del Mar',
    titleEn: 'Brisa del Mar Restaurant',
    categorySlug: 'restaurants',
    shortEs: 'Comida frente al mar.',
    shortEn: 'Seaside dining.',
    enMissingCategory: true,
    contact: { phone: '5216131234567', whatsapp: '526131234567' },
  },
  {
    slug: 'museo-la-concha',
    titleEs: 'Museo La Concha',
    titleEn: 'La Concha Museum',
    categorySlug: 'sites',
    shortEs: 'Museo de conchas.',
    shortEn: 'Shell museum.',
    pendingDraftEdit: true,
    contact: { phone: '613-123-4567' },
  },
  {
    slug: 'casa-huespedes',
    titleEs: 'Casa Huéspedes',
    titleEn: 'Guest House',
    categorySlug: 'accommodation',
    shortEs: 'Habitaciones cómodas.',
    shortEn: 'Comfortable rooms.',
    // Pre-filled phone pair: the migration must NEVER touch it. Its whatsapp
    // is absent, and it deliberately has no community source (expected to
    // appear in unresolved listing manual review — do not "fix" it).
    contact: { phone: '5216123456789', phoneCountryCode: '+52', phoneNumber: '6123456789' },
    unresolvedCommunity: true,
  },
  {
    slug: 'servicios-de-panga',
    titleEs: 'Servicios de Panga',
    titleEn: 'Panga Services',
    categorySlug: 'services',
    shortEs: 'Transporte en panga.',
    shortEn: 'Panga transport.',
  },
  {
    slug: 'artesanias-andrea',
    titleEs: 'Artesanías Andrea',
    titleEn: 'Andrea Crafts',
    categorySlug: 'services',
    shortEs: 'Artesanías de concha.',
    shortEn: 'Shell crafts.',
  },
];

const MEMBER_SEEDS = [
  {
    slug: 'juana-perez',
    name: 'Juana Pérez',
    locality: 'agua-verde',
    role: 'Artesana de Concha',
    contact: { whatsapp: '+52 613 123 4567' },
  },
  {
    slug: 'esther-romero',
    name: 'Esther Romero',
    locality: 'rancho-san-cosme',
    role: 'Artesana y Curadora de Museo',
    contact: { phone: '12345' }, // unparseable -> manual review
  },
  { slug: 'don-alejo-romero', name: 'Don Alejo Romero', locality: 'rancho-san-cosme', role: 'Guía de Panga', listingSlug: 'servicios-de-panga' },
];

async function seedDatabase() {
  for (const c of CATEGORY_SEEDS) {
    await createBothLocales(
      UID.category,
      { name: c.es, slug: c.slug, order: c.order, color: c.color },
      { name: c.en, slug: c.slug, order: c.order, color: c.color },
      { publish: true }
    );
  }

  const catIdx = await migrate.reindexRows(strapi, UID.category);
  const catId = (slug, locale) => migrate.resolveRow(catIdx, slug, locale, true).id;

  for (const l of LISTING_SEEDS) {
    const documentId = await createBothLocales(
      UID.listing,
      {
        title: l.titleEs,
        slug: l.slug,
        shortDescription: l.shortEs,
        category: catId(l.categorySlug, ES),
        hideContact: false,
        isFeatured: false,
        order: 0,
        contact: l.contact,
      },
      {
        title: l.titleEn,
        slug: l.slug,
        shortDescription: l.shortEn,
        // Mirrors real data: some EN rows were never linked to a category.
        category: l.enMissingCategory ? null : catId(l.categorySlug, EN),
        hideContact: false,
        isFeatured: false,
        order: 0,
        contact: l.contact,
      },
      { publish: true }
    );
    l.documentId = documentId;
    if (l.pendingDraftEdit) {
      // A pending draft edit: update the DRAFT row only (no status), so the
      // published row keeps the original content.
      await strapi.documents(UID.listing).update({
        documentId,
        locale: ES,
        data: { shortDescription: 'PENDING EDIT — not yet published.' },
      });
    }
  }

  const listingIdx = await migrate.reindexRows(strapi, UID.listing);

  // Mirrors real data: the es-MX DRAFT row of artesanias-andrea points to the
  // PUBLISHED services row, which the Document Service cannot resolve for drafts.
  const andreaDraft = migrate.resolveRow(listingIdx, 'artesanias-andrea', ES, true);
  const servicesPublished = migrate.resolveRow(catIdx, 'services', ES, false);
  await strapi.db.query(UID.listing).update({ where: { id: andreaDraft.id }, data: { category: servicesPublished.id } });

  for (const m of MEMBER_SEEDS) {
    const data = { name: m.name, slug: m.slug, role: m.role, locality: m.locality, contact: m.contact };
    const dataEn = { slug: m.slug, role: m.role, locality: m.locality, contact: m.contact };
    if (m.listingSlug) {
      const target = migrate.resolveRow(listingIdx, m.listingSlug, ES, true);
      data.listings = target ? [target.id] : [];
    }
    const documentId = await createBothLocales(UID.member, data, dataEn, { publish: true });
    m.documentId = documentId;
  }

  const guideEs = {
    internalLabel: 'Guide Page',
    historyText: 'Historia en español.',
    historyHeader: { title: 'Nuestra historia', subtitle: 'Un vistazo al pasado' },
    historyMilestones: [
      { year: '1950', text: 'Fundación.' },
      { year: '1985', text: 'Primer tour.' },
    ],
    influenceText: 'Texto de área de influencia.',
    influenceHeader: { title: 'Área de influencia', subtitle: null },
    fishingText: 'Texto de zona de pesca.',
    fishingHeader: { title: 'Zona de refugio pesquero', subtitle: null },
    fishingRules: [{ text: 'No pescar con red.' }, { text: 'Respetar vedas.' }],
    protectedArea: {
      title: 'ANP',
      text: 'Área natural protegida.',
      linkLabel: 'Sitio CONANP',
      linkHref: 'https://conanp.gob.mx',
    },
    recommendationsHeader: { title: 'Recomendaciones', subtitle: null },
    recommendations: [{ text: 'Trae protector solar.' }, { text: 'Lleva agua.' }],
    drivingTipsHeader: 'Consejos para manejar',
    drivingTips: [{ text: 'Maneja despacio en terracería.' }],
  };
  const guideEn = {
    internalLabel: 'Guide Page',
    historyText: 'History in English.',
    historyHeader: { title: 'Our history', subtitle: 'A look at the past' },
    historyMilestones: [
      { year: '1950', text: 'Founding.' },
      { year: '1985', text: 'First tour.' },
    ],
    influenceText: 'Influence area text.',
    influenceHeader: { title: 'Influence area', subtitle: null },
    fishingText: 'Fishing refuge zone text.',
    fishingHeader: { title: 'Fishing refuge zone', subtitle: null },
    fishingRules: [{ text: 'No net fishing.' }, { text: 'Respect closed seasons.' }],
    protectedArea: {
      title: 'ANP',
      text: 'Protected natural area.',
      linkLabel: 'CONANP site',
      linkHref: 'https://conanp.gob.mx',
    },
    recommendationsHeader: { title: 'Recommendations', subtitle: null },
    recommendations: [{ text: 'Bring sunscreen.' }, { text: 'Bring water.' }],
    drivingTipsHeader: 'Driving tips',
    drivingTips: [{ text: 'Drive slowly on dirt roads.' }],
  };
  await createBothLocales(UID.guidePage, guideEs, guideEn, { publish: true });
}

describe('contact-info schema (contract §5b)', () => {
  const schemaPath = fileURLToPath(new URL('../src/components/contact/contact-info.json', import.meta.url));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  it('has the exact 11-attribute key set', () => {
    expect(Object.keys(schema.attributes).sort()).toEqual([
      'email',
      'facebook',
      'instagram',
      'phone',
      'phoneCountryCode',
      'phoneNumber',
      'tiktok',
      'website',
      'whatsapp',
      'whatsappCountryCode',
      'whatsappNumber',
    ]);
  });

  it('defines the country-code fields with the §5b regex and +52 default', () => {
    for (const key of ['phoneCountryCode', 'whatsappCountryCode']) {
      expect(schema.attributes[key].type, key).toBe('string');
      expect(schema.attributes[key].regex, key).toBe('^\\+[1-9]\\d{0,2}$');
      expect(schema.attributes[key].default, key).toBe('+52');
    }
  });

  it('defines the national number fields with the 10-digit regex and no default', () => {
    for (const key of ['phoneNumber', 'whatsappNumber']) {
      expect(schema.attributes[key].type, key).toBe('string');
      expect(schema.attributes[key].regex, key).toBe('^\\d{10}$');
      expect(schema.attributes[key], key).not.toHaveProperty('default');
    }
  });

  it('marks the legacy phone and whatsapp descriptions as deprecated', () => {
    expect(schema.attributes.phone.description).toContain('Obsoleto');
    expect(schema.attributes.whatsapp.description).toContain('Obsoleto');
  });
});

describe('normalizeLegacyPhone (contract §5b)', () => {
  it.each(['5216131234567', '526131234567', '+52 613 123 4567', '613-123-4567'])(
    'normalizes %j to +52 6131234567',
    (raw) => {
      expect(migrate.normalizeLegacyPhone(raw)).toEqual({ countryCode: '+52', number: '6131234567' });
    }
  );

  it.each(['12345', '', null, undefined])('sends %j to manual review (null)', (raw) => {
    expect(migrate.normalizeLegacyPhone(raw)).toBeNull();
  });
});

describe('migrate-redesign (Strapi-backed)', () => {
  beforeAll(async () => {
    dbPath = tmpPath('migrate-redesign-test', 'db');
    strapi = await migrate.loadStrapiInstance({ dbPath });
    await seedDatabase();
  }, TIMEOUT);

  afterAll(async () => {
    await migrate.closeStrapiInstance(strapi);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // best-effort cleanup
    }
  }, TIMEOUT);

  describe('contact field validation (contract §5b)', () => {
    const VALIDATION_SLUG = 'validacion-telefono';

    async function createWithContact(contact) {
      // Published, not draft: Strapi only enforces attribute regexes on
      // non-draft validation, so the regex must be exercised via a
      // published create.
      return strapi.documents(UID.listing).create({
        data: {
          title: 'Validación Teléfono',
          slug: VALIDATION_SLUG,
          hideContact: false,
          isFeatured: false,
          order: 0,
          contact,
        },
        locale: ES,
        status: 'published',
      });
    }

    it('rejects a phoneNumber containing spaces', async () => {
      await expect(createWithContact({ phoneCountryCode: '+52', phoneNumber: '613 123 4567' })).rejects.toThrow(
        /phoneNumber/
      );
    }, TIMEOUT);

    it('rejects a 9-digit phoneNumber', async () => {
      await expect(createWithContact({ phoneCountryCode: '+52', phoneNumber: '61312345' })).rejects.toThrow(
        /phoneNumber/
      );
    }, TIMEOUT);

    it('accepts a valid phone pair (positive control) and cleans the row up', async () => {
      try {
        await createWithContact({ phoneCountryCode: '+52', phoneNumber: '6131234567' });
        const row = await strapi.documents(UID.listing).findFirst({
          filters: { slug: VALIDATION_SLUG },
          locale: ES,
          status: 'published',
          populate: ['contact'],
        });
        expect(row?.contact?.phoneCountryCode).toBe('+52');
        expect(row?.contact?.phoneNumber).toBe('6131234567');
      } finally {
        // Cleanup every physical row of this throwaway document so the plan
        // tests below are unaffected (both locales, draft and published).
        await strapi.db.query(UID.listing).deleteMany({ where: { slug: VALIDATION_SLUG } });
        const remaining = await strapi.db.query(UID.listing).findMany({ where: { slug: VALIDATION_SLUG }, select: ['id'] });
        expect(remaining).toHaveLength(0);
      }
    }, TIMEOUT);
  });

  it('dry-run plans the expected work and writes nothing', async () => {
    const before = await strapi.db.query(UID.community).findMany({});
    expect(before).toHaveLength(0);

    const plan = await migrate.planMigration(strapi, {});
    expect(migrate.planHasWork(plan)).toBe(true);
    expect(plan.categories.createDocs.map((d) => d.slug).sort()).toEqual(['crafts', 'gastronomy']);
    expect(plan.communities.createDocs.map((d) => d.slug).sort()).toEqual(['puerto-agua-verde', 'rancho-san-cosme']);
    expect(plan.artisan.create).toBeTruthy();
    expect(plan.goodPractices.create).toBeTruthy();
    expect(plan.craftsCandidates.map((c) => c.slug)).toContain('artesanias-andrea');

    // Phones (contract §5b): fillable pairs planned for both locales,
    // pre-filled pairs never planned, unparseable values flagged.
    expect(plan.phones.updates.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      expect(
        plan.phones.updates.some(
          (u) =>
            u.slug === 'restaurante-brisa-del-mar' &&
            u.kind === 'phone' &&
            u.locale === locale &&
            u.countryCode === '+52' &&
            u.number === '6131234567'
        ),
        `brisa phone pair planned for ${locale}`
      ).toBe(true);
    }
    expect(
      plan.phones.manualReview.some((m) => m.slug === 'esther-romero' && m.kind === 'phone' && m.value === '12345')
    ).toBe(true);
    expect(plan.phones.updates.every((u) => u.slug !== 'casa-huespedes')).toBe(true);

    const after = await strapi.db.query(UID.community).findMany({});
    expect(after).toHaveLength(0);
    const listingsAfter = await strapi.db.query(UID.listing).findMany({ where: { slug: ARTISAN_LISTING.slug } });
    expect(listingsAfter).toHaveLength(0);
  }, TIMEOUT);

  it('--apply produces the expected rows', async () => {
    const plan = await migrate.planMigration(strapi, {});
    const snapshotPath = tmpPath('migrate-redesign-snapshot', 'json');
    const totals = await migrate.applyMigration(strapi, plan, { snapshotPath });

    expect(totals.communitiesCreated).toBe(4); // 2 communities x 2 locales
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(snap.newDocuments.length).toBeGreaterThan(0);

    // 1. The 4 contract categories exist as draft and published, both locales.
    for (const slug of ['experiences', 'gastronomy', 'services', 'crafts']) {
      for (const locale of LOCALES) {
        const draft = await strapi.documents(UID.category).findFirst({ filters: { slug }, locale, status: 'draft' });
        const pub = await strapi.documents(UID.category).findFirst({ filters: { slug }, locale, status: 'published' });
        expect(draft, `${slug} ${locale} draft`).toBeTruthy();
        expect(pub, `${slug} ${locale} published`).toBeTruthy();
        if (slug === 'crafts') {
          // Contract §1: color chosen by RED.
          expect(draft.color).toBe('#B59BD9');
          expect(pub.color).toBe('#B59BD9');
        }
      }
    }

    // 2. Both communities exist draft+published, both locales, with
    //    location, milestones and contract colors; RSC at the contract coords.
    for (const c of COMMUNITY_CONTRACT) {
      for (const locale of LOCALES) {
        const draft = await strapi.documents(UID.community).findFirst({
          filters: { slug: c.slug },
          locale,
          status: 'draft',
          populate: ['location', 'historyMilestones', 'historyHeader'],
        });
        const pub = await strapi.documents(UID.community).findFirst({ filters: { slug: c.slug }, locale, status: 'published' });
        expect(draft, `${c.slug} ${locale} draft`).toBeTruthy();
        expect(pub, `${c.slug} ${locale} published`).toBeTruthy();
        expect(draft.color).toBe(c.color);
        expect(draft.textColor).toBe(c.textColor);
        expect(draft.historyMilestones.length).toBeGreaterThan(0);
        expect(draft.location).toBeTruthy();
      }
    }
    const rsc = await strapi.documents(UID.community).findFirst({
      filters: { slug: 'rancho-san-cosme' },
      locale: ES,
      status: 'draft',
      populate: ['location'],
    });
    expect(rsc.location.geoPoint.lat).toBeCloseTo(25.5784138, 5);
    expect(rsc.location.geoPoint.lng).toBeCloseTo(-111.1694027, 5);

    // 3. Listings resolve category and community, draft + published, both locales.
    //    casa-huespedes has no community source on purpose (expected to stay
    //    unresolved), so its community assertion is skipped.
    for (const l of LISTING_SEEDS) {
      for (const locale of LOCALES) {
        for (const status of ['draft', 'published']) {
          const row = await strapi.documents(UID.listing).findFirst({
            filters: { slug: l.slug },
            locale,
            status,
            populate: ['category', 'community'],
          });
          expect(row, `${l.slug} ${locale} ${status}`).toBeTruthy();
          expect(row.category, `${l.slug} ${locale} ${status} category`).toBeTruthy();
          if (!l.unresolvedCommunity) {
            expect(row.community, `${l.slug} ${locale} ${status} community`).toBeTruthy();
          }
        }
      }
    }

    // 3b. EN rows without a category inherit the mapped category of their es-MX sibling.
    for (const status of ['draft', 'published']) {
      const brisaEn = await strapi.documents(UID.listing).findFirst({
        filters: { slug: 'restaurante-brisa-del-mar' },
        locale: EN,
        status,
        populate: ['category'],
      });
      expect(brisaEn.category?.slug, `brisa en ${status}`).toBe('gastronomy');
    }

    // 4. hideContact true only for services listings.
    const panga = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'servicios-de-panga' }, locale: ES, status: 'published' });
    expect(panga.hideContact).toBe(true);
    const andrea = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'artesanias-andrea' }, locale: ES, status: 'published' });
    expect(andrea.hideContact).toBe(true);
    const brisa = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'restaurante-brisa-del-mar' }, locale: ES, status: 'published' });
    expect(brisa.hideContact).toBe(false);
    const museo = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'museo-la-concha' }, locale: ES, status: 'published' });
    expect(museo.hideContact).toBe(false);

    // 5. Member -> community is set.
    const juana = await strapi.documents(UID.member).findFirst({ filters: { slug: 'juana-perez' }, locale: ES, status: 'published', populate: ['community'] });
    expect(juana.community.slug).toBe('puerto-agua-verde');
    const esther = await strapi.documents(UID.member).findFirst({ filters: { slug: 'esther-romero' }, locale: ES, status: 'published', populate: ['community'] });
    expect(esther.community.slug).toBe('rancho-san-cosme');
    const alejo = await strapi.documents(UID.member).findFirst({ filters: { slug: 'don-alejo-romero' }, locale: ES, status: 'published', populate: ['community'] });
    expect(alejo.community.slug).toBe('rancho-san-cosme');

    // Listing -> community resolved via member locality for servicios-de-panga.
    const pangaCommunity = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'servicios-de-panga' }, locale: ES, status: 'published', populate: ['community'] });
    expect(pangaCommunity.community.slug).toBe('rancho-san-cosme');

    // 6. Artisan listing is a draft, linked to the artisan member (not the
    //    non-PAV artisan) and in category crafts / community PAV.
    const artisanDraft = await strapi.documents(UID.listing).findFirst({
      filters: { slug: ARTISAN_LISTING.slug },
      locale: ES,
      status: 'draft',
      populate: ['members', 'category', 'community'],
    });
    expect(artisanDraft).toBeTruthy();
    const artisanPub = await strapi.documents(UID.listing).findFirst({ filters: { slug: ARTISAN_LISTING.slug }, locale: ES, status: 'published' });
    expect(artisanPub).toBeFalsy();
    expect(artisanDraft.members.map((m) => m.slug)).toContain('juana-perez');
    expect(artisanDraft.members.map((m) => m.slug)).not.toContain('esther-romero');
    expect(artisanDraft.category.slug).toBe('crafts');
    expect(artisanDraft.community.slug).toBe('puerto-agua-verde');

    // 7. good-practices-page is a draft.
    const gpDraft = await strapi.documents(UID.goodPractices).findFirst({ locale: ES, status: 'draft', populate: ['protectedArea', 'recommendations', 'tips'] });
    const gpPub = await strapi.documents(UID.goodPractices).findFirst({ locale: ES, status: 'published' });
    expect(gpDraft).toBeTruthy();
    expect(gpPub).toBeFalsy();
    expect(gpDraft.protectedArea.title).toBe('ANP');
    expect(gpDraft.recommendations.length).toBeGreaterThan(0);

    // 8. The listing's pending draft edit is not published.
    const museoPub = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'museo-la-concha' }, locale: ES, status: 'published' });
    const museoDraft = await strapi.documents(UID.listing).findFirst({ filters: { slug: 'museo-la-concha' }, locale: ES, status: 'draft' });
    expect(museoPub.shortDescription).not.toContain('PENDING EDIT');
    expect(museoDraft.shortDescription).toContain('PENDING EDIT');

    // 9. Phones: new contact fields filled from legacy values on EVERY
    //    physical row (draft + published, both locales); pre-filled pairs
    //    never touched.
    const brisaPhonePub = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'restaurante-brisa-del-mar' },
      locale: ES,
      status: 'published',
      populate: ['contact'],
    });
    expect(brisaPhonePub.contact.phoneCountryCode).toBe('+52');
    expect(brisaPhonePub.contact.phoneNumber).toBe('6131234567');
    expect(brisaPhonePub.contact.whatsappCountryCode).toBe('+52');
    expect(brisaPhonePub.contact.whatsappNumber).toBe('6131234567');

    const brisaPhoneDraft = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'restaurante-brisa-del-mar' },
      locale: ES,
      status: 'draft',
      populate: ['contact'],
    });
    expect(brisaPhoneDraft.contact.phoneNumber).toBe('6131234567');
    expect(brisaPhoneDraft.contact.whatsappNumber).toBe('6131234567');

    const brisaPhoneEn = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'restaurante-brisa-del-mar' },
      locale: EN,
      status: 'published',
      populate: ['contact'],
    });
    expect(brisaPhoneEn.contact.phoneNumber).toBe('6131234567');

    const museoPhone = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'museo-la-concha' },
      locale: ES,
      status: 'published',
      populate: ['contact'],
    });
    expect(museoPhone.contact.phoneNumber).toBe('6131234567');

    const juanaWhatsapp = await strapi.documents(UID.member).findFirst({
      filters: { slug: 'juana-perez' },
      locale: ES,
      status: 'published',
      populate: ['contact'],
    });
    expect(juanaWhatsapp.contact.whatsappCountryCode).toBe('+52');
    expect(juanaWhatsapp.contact.whatsappNumber).toBe('6131234567');

    // casa-huespedes came with a pre-filled phone pair: NEVER overwritten.
    const casaPhone = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'casa-huespedes' },
      locale: ES,
      status: 'published',
      populate: ['contact'],
    });
    expect(casaPhone.contact.phoneCountryCode).toBe('+52');
    expect(casaPhone.contact.phoneNumber).toBe('6123456789');
  }, TIMEOUT);

  it('a second run is a no-op', async () => {
    const plan = await migrate.planMigration(strapi, {});
    expect(migrate.planHasWork(plan)).toBe(false);
    expect(plan.categories.createDocs).toHaveLength(0);
    expect(plan.categories.updateRows).toHaveLength(0);
    expect(plan.communities.createDocs).toHaveLength(0);
    expect(plan.listingCommunity.links).toHaveLength(0);
    expect(plan.memberCommunity.links).toHaveLength(0);
    expect(plan.artisan.skipped).toBe(true);
    expect(plan.goodPractices.skipped).toBe(true);
    // Phones: nothing left to fill; manual review is informational only, so
    // esther's unparseable legacy phone is still listed (and not blocking).
    expect(plan.phones.updates).toHaveLength(0);
    expect(plan.phones.manualReview.some((m) => m.slug === 'esther-romero')).toBe(true);
  }, TIMEOUT);

  it('--map and --crafts overrides still work, applied writes and the plan converges', async () => {
    const catIdx = await migrate.reindexRows(strapi, UID.category);
    const servicesId = migrate.resolveRow(catIdx, 'services', ES, true).id;
    const servicesIdEn = migrate.resolveRow(catIdx, 'services', EN, true).id;

    await createBothLocales(
      UID.listing,
      { title: 'Taller Nuevo', slug: 'taller-nuevo', category: servicesId, hideContact: false },
      { title: 'New Workshop', slug: 'taller-nuevo', category: servicesIdEn, hideContact: false },
      { publish: true }
    );

    const plainPlan = await migrate.planMigration(strapi, {});
    expect(plainPlan.listingCommunity.unresolved.map((u) => u.slug)).toContain('taller-nuevo');
    expect(plainPlan.craftsCandidates.map((c) => c.slug)).toContain('taller-nuevo');

    const mapPath = tmpPath('migrate-redesign-map', 'csv');
    fs.writeFileSync(mapPath, 'taller-nuevo,rancho-san-cosme\n');
    const overrides = migrate.parseMapFile(mapPath, migrate.COMMUNITY_CONTRACT.map((c) => c.slug));

    const overridePlan = await migrate.planMigration(strapi, { mapOverrides: overrides, craftsSlugs: ['taller-nuevo'] });
    expect(overridePlan.listingCategory.moves.some((m) => m.slug === 'taller-nuevo' && m.targetSlug === 'crafts')).toBe(true);
    expect(overridePlan.listingCommunity.links.some((l) => l.slug === 'taller-nuevo' && l.communitySlug === 'rancho-san-cosme')).toBe(true);

    const snapshotPath = tmpPath('migrate-redesign-snapshot-override', 'json');
    await migrate.applyMigration(strapi, overridePlan, { snapshotPath });
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const tallerEs = await strapi.documents(UID.listing).findFirst({
      filters: { slug: 'taller-nuevo' },
      locale: ES,
      status: 'published',
      populate: ['category', 'community'],
    });
    expect(tallerEs.category.slug).toBe('crafts');
    expect(tallerEs.community.slug).toBe('rancho-san-cosme');

    const finalPlan = await migrate.planMigration(strapi, {});
    expect(migrate.planHasWork(finalPlan)).toBe(false);
  }, TIMEOUT);
});
