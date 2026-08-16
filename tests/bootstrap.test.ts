import { describe, it, expect, vi } from 'vitest';
import bootstrapModule from '../src/index';

const { bootstrap } = bootstrapModule;

// Must match PUBLIC_PERMISSIONS in src/index.ts (the constant is not exported,
// so the expected list is duplicated here to pin the full seeded set).
const EXPECTED_PUBLIC_PERMISSIONS = [
  'api::category.category.find',
  'api::category.category.findOne',
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::community-member.community-member.find',
  'api::community-member.community-member.findOne',
  'api::team-member.team-member.find',
  'api::team-member.team-member.findOne',
  'api::organization.organization.find',
  'api::organization.organization.findOne',
  'api::site-content.site-content.find',
  'api::site-content.site-content.findOne',
  'api::legal-page.legal-page.find',
  'api::legal-page.legal-page.findOne',
  'api::site-global.site-global.find',
  'api::homepage.homepage.find',
  'api::experiences-page.experiences-page.find',
  'api::about-page.about-page.find',
  'api::guide-page.guide-page.find',
];

function makeStrapi(opts: { listings?: any[]; members?: any[]; listingError?: Error } = {}) {
  const createdPermissions: any[] = [];

  const roleFindOne = vi.fn(async () => ({ id: 42, type: 'public' }));
  const permissionFindOne = vi.fn(async ({ where }: any) =>
    createdPermissions.find((p) => p.action === where.action && p.role === where.role) ?? null
  );
  const permissionCreate = vi.fn(async ({ data }: any) => {
    createdPermissions.push({ ...data });
    return { id: createdPermissions.length, ...data };
  });

  const listingFindMany = vi.fn(async (args: any) => {
    if (opts.listingError) throw opts.listingError;
    return opts.listings ?? [];
  });
  const memberFindMany = vi.fn(async () => opts.members ?? []);
  const memberUpdate = vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data }));
  const contactUpdate = vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data }));
  const contactCreate = vi.fn(async ({ data }: any) => ({ id: 55, ...data }));

  const storeState = new Map<string, unknown>();
  const storeGet = vi.fn(async ({ key }: any) => storeState.get(key));
  const storeSet = vi.fn(async ({ key, value }: any) => {
    storeState.set(key, value);
  });

  const strapi: any = {
    db: {
      query: vi.fn((uid: string) => {
        switch (uid) {
          case 'plugin::users-permissions.role':
            return { findOne: roleFindOne };
          case 'plugin::users-permissions.permission':
            return { findOne: permissionFindOne, create: permissionCreate };
          case 'api::listing.listing':
            return { findMany: listingFindMany };
          case 'api::community-member.community-member':
            return { findMany: memberFindMany, update: memberUpdate };
          case 'components_contact_contact_infos':
            return { update: contactUpdate, create: contactCreate };
          default:
            throw new Error(`unexpected db.query uid: ${uid}`);
        }
      }),
    },
    store: vi.fn(() => ({ get: storeGet, set: storeSet })),
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };

  return {
    strapi,
    createdPermissions,
    roleFindOne,
    permissionCreate,
    listingFindMany,
    memberFindMany,
    memberUpdate,
    contactUpdate,
    contactCreate,
    storeGet,
    storeSet,
    storeState,
  };
}

describe('bootstrap: public permission seeding', () => {
  it('seeds the full public permission list against the public role', async () => {
    const fake = makeStrapi();
    await bootstrap({ strapi: fake.strapi });

    expect(fake.createdPermissions.map((p) => p.action)).toEqual(EXPECTED_PUBLIC_PERMISSIONS);
    for (const p of fake.createdPermissions) {
      expect(p.role).toBe(42);
    }
    // Seeding checks for existence before creating: one findOne per action.
    expect(fake.permissionCreate).toHaveBeenCalledTimes(EXPECTED_PUBLIC_PERMISSIONS.length);
    expect(fake.strapi.log.info).toHaveBeenCalledWith(
      `Granted public permission: ${EXPECTED_PUBLIC_PERMISSIONS[0]}`
    );
  });

  it('is idempotent: a second bootstrap run creates no duplicate permissions', async () => {
    const fake = makeStrapi();
    await bootstrap({ strapi: fake.strapi });
    expect(fake.createdPermissions).toHaveLength(EXPECTED_PUBLIC_PERMISSIONS.length);

    // Second run against the same state: findOne now resolves every action.
    await bootstrap({ strapi: fake.strapi });
    expect(fake.createdPermissions).toHaveLength(EXPECTED_PUBLIC_PERMISSIONS.length);
  });

  it('skips seeding with a warning when the public role is missing', async () => {
    const fake = makeStrapi();
    fake.roleFindOne.mockResolvedValue(null);

    await bootstrap({ strapi: fake.strapi });

    expect(fake.strapi.log.warn).toHaveBeenCalledWith('Public role not found; skipping permission bootstrap');
    expect(fake.createdPermissions).toHaveLength(0);
  });
});

describe('bootstrap: social-to-contact migration', () => {
  const listingWithSocial = [
    {
      id: 10,
      documentId: 'doc-10',
      contact: { id: 7, instagram: null },
      social: [{ platform: 'instagram', handle: '@pav_tours' }],
    },
    {
      id: 11,
      documentId: 'doc-11',
      contact: { id: 8, instagram: 'already-set' },
      social: [{ platform: 'instagram', handle: '@ignored' }],
    },
    {
      id: 12,
      documentId: 'doc-12',
      contact: { id: 9, instagram: null },
      social: [{ platform: 'facebook', handle: 'not-instagram' }],
    },
  ];

  const memberWithPhone = [{ id: 3, phone: '6121112222', whatsapp: null, contact: null }];

  it('backfills instagram handles from social into contact-info once, then sets the core-store flag', async () => {
    const fake = makeStrapi({ listings: listingWithSocial, members: memberWithPhone });

    await bootstrap({ strapi: fake.strapi });

    // Only listing 10 qualifies (11 already has instagram, 12 has no ig entry).
    expect(fake.contactUpdate).toHaveBeenCalledTimes(1);
    expect(fake.contactUpdate).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { instagram: 'pav_tours' }, // leading @ stripped
    });

    // Member path: new contact component created and linked.
    expect(fake.contactCreate).toHaveBeenCalledWith({ data: { phone: '6121112222', whatsapp: null } });
    expect(fake.memberUpdate).toHaveBeenCalledWith({ where: { id: 3 }, data: { contact: 55 } });

    // Migration flag written via the core store.
    expect(fake.strapi.store).toHaveBeenCalledWith({ type: 'core', name: '' });
    expect(fake.storeSet).toHaveBeenCalledWith({ key: 'migration_social_to_contact_v1', value: true });
  });

  it('skips the migration entirely when the core-store flag is already set', async () => {
    const fake = makeStrapi({ listings: listingWithSocial, members: memberWithPhone });
    fake.storeState.set('migration_social_to_contact_v1', true);

    await bootstrap({ strapi: fake.strapi });

    expect(fake.listingFindMany).not.toHaveBeenCalled();
    expect(fake.memberFindMany).not.toHaveBeenCalled();
    expect(fake.storeSet).not.toHaveBeenCalled();
  });

  it('documents current (known-defective) behavior; fix scheduled separately: populates the removed `social` field', async () => {
    const fake = makeStrapi({ listings: listingWithSocial });

    await bootstrap({ strapi: fake.strapi });

    expect(fake.listingFindMany).toHaveBeenCalledWith({
      select: ['id', 'documentId'],
      // `social` no longer exists on the listing schema; the migration still
      // requests it, which against a real database yields no social data
      // (or a rejected populate swallowed by the try/catch).
      populate: { contact: true, social: true },
    });
  });

  it('documents current (known-defective) behavior; fix scheduled separately: sets the migration flag even when a step fails', async () => {
    const fake = makeStrapi({ listingError: new Error('populate social failed') });

    await bootstrap({ strapi: fake.strapi });

    // The failure is logged as non-fatal...
    expect(fake.strapi.log.warn).toHaveBeenCalledWith(
      '[migration] Listing social→contact migration failed (non-fatal):',
      expect.any(Error)
    );
    // ...but the flag is still written, so the migration never re-runs.
    expect(fake.storeSet).toHaveBeenCalledWith({ key: 'migration_social_to_contact_v1', value: true });
  });

  it('documents current (known-defective) behavior; fix scheduled separately: reads phone/whatsapp although members are fetched with select: [id]', async () => {
    const fake = makeStrapi({ members: memberWithPhone });

    await bootstrap({ strapi: fake.strapi });

    const memberCall = fake.memberFindMany.mock.calls[0][0];
    expect(memberCall.select).toEqual(['id']);
    // Against a real database the selected columns do not include phone or
    // whatsapp, so this branch never migrates anything; pinned as-is.
    expect(memberCall.populate).toEqual({ contact: true });
    expect(fake.contactCreate).toHaveBeenCalledTimes(1);
  });
});
