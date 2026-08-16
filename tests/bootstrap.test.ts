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

function makeStrapi(opts: { listings?: any[]; members?: any[]; memberError?: Error } = {}) {
  const createdPermissions: any[] = [];
  const lifecycleSubscribe = vi.fn();

  const roleFindOne = vi.fn(async () => ({ id: 42, type: 'public' }));
  const permissionFindOne = vi.fn(async ({ where }: any) =>
    createdPermissions.find((p) => p.action === where.action && p.role === where.role) ?? null
  );
  const permissionCreate = vi.fn(async ({ data }: any) => {
    createdPermissions.push({ ...data });
    return { id: createdPermissions.length, ...data };
  });

  const listingFindMany = vi.fn(async () => opts.listings ?? []);
  const memberFindMany = vi.fn(async () => {
    if (opts.memberError) throw opts.memberError;
    return opts.members ?? [];
  });
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
      lifecycles: { subscribe: lifecycleSubscribe },
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
    lifecycleSubscribe,
  };
}

describe('bootstrap: shared-slug subscriber registration', () => {
  it('registers exactly one db-lifecycle subscriber', async () => {
    const fake = makeStrapi();
    await bootstrap({ strapi: fake.strapi });
    expect(fake.lifecycleSubscribe).toHaveBeenCalledTimes(1);
  });
});

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

  it('migrates community-member phone/whatsapp into contact-info, then sets the core-store flag', async () => {
    const fake = makeStrapi({ members: memberWithPhone });

    await bootstrap({ strapi: fake.strapi });

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

  it('no longer queries the listing content type (dead social branch removed)', async () => {
    const fake = makeStrapi({ listings: listingWithSocial, members: memberWithPhone });

    await bootstrap({ strapi: fake.strapi });

    // The migration is community-member-only: no listing query, no social
    // populate, and no contact-info backfill via the listing branch.
    const queriedUids = fake.strapi.db.query.mock.calls.map((call: any[]) => call[0]);
    expect(queriedUids).not.toContain('api::listing.listing');
    expect(fake.listingFindMany).not.toHaveBeenCalled();
    expect(fake.contactUpdate).not.toHaveBeenCalled();
  });

  it('does not set the migration flag when a step fails, so the next boot retries', async () => {
    const fake = makeStrapi({ memberError: new Error('community-member query failed') });

    await bootstrap({ strapi: fake.strapi });

    // The failure is logged as non-fatal, with a retry notice.
    expect(fake.strapi.log.warn).toHaveBeenCalledWith(
      '[migration] Community-member contact migration failed (non-fatal):',
      expect.any(Error)
    );
    expect(fake.strapi.log.warn).toHaveBeenCalledWith(
      '[migration] social→contact consolidation incomplete; will retry on next boot.'
    );

    // The flag is NOT written, so the migration is not marked as done.
    expect(fake.storeSet).not.toHaveBeenCalled();

    // A second boot retries the migration.
    await bootstrap({ strapi: fake.strapi });
    expect(fake.memberFindMany).toHaveBeenCalledTimes(2);
    expect(fake.storeSet).not.toHaveBeenCalled();
  });

  it('fetches community members with phone and whatsapp selected so they can be migrated', async () => {
    const fake = makeStrapi({ members: memberWithPhone });

    await bootstrap({ strapi: fake.strapi });

    const memberCall = fake.memberFindMany.mock.calls[0][0];
    expect(memberCall.select).toEqual(['id', 'phone', 'whatsapp']);
    expect(memberCall.populate).toEqual({ contact: true });

    // phone/whatsapp are now actually read and migrated.
    expect(fake.contactCreate).toHaveBeenCalledWith({ data: { phone: '6121112222', whatsapp: null } });
  });
});
