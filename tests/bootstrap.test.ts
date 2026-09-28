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
  'api::community.community.find',
  'api::community.community.findOne',
  'api::site-content.site-content.find',
  'api::site-content.site-content.findOne',
  'api::legal-page.legal-page.find',
  'api::legal-page.legal-page.findOne',
  'api::site-global.site-global.find',
  'api::homepage.homepage.find',
  'api::good-practices-page.good-practices-page.find',
];

// Removed with the A5 contract cleanup: none of these actions may come back.
const REMOVED_PUBLIC_PERMISSIONS = [
  'api::team-member.team-member.find',
  'api::team-member.team-member.findOne',
  'api::organization.organization.find',
  'api::organization.organization.findOne',
  'api::experiences-page.experiences-page.find',
  'api::about-page.about-page.find',
  'api::guide-page.guide-page.find',
];

function makeStrapi() {
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

  const strapi: any = {
    db: {
      query: vi.fn((uid: string) => {
        switch (uid) {
          case 'plugin::users-permissions.role':
            return { findOne: roleFindOne };
          case 'plugin::users-permissions.permission':
            return { findOne: permissionFindOne, create: permissionCreate };
          default:
            throw new Error(`unexpected db.query uid: ${uid}`);
        }
      }),
      lifecycles: { subscribe: lifecycleSubscribe },
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };

  return {
    strapi,
    createdPermissions,
    roleFindOne,
    permissionCreate,
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

  it('never seeds permissions of the removed content types', async () => {
    const fake = makeStrapi();
    await bootstrap({ strapi: fake.strapi });

    const seeded = fake.createdPermissions.map((p) => p.action);
    for (const action of REMOVED_PUBLIC_PERMISSIONS) {
      expect(seeded).not.toContain(action);
    }
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

describe('bootstrap: social-to-contact migration removal', () => {
  it('does not touch the core store or the contact component anymore', async () => {
    const fake = makeStrapi();
    await bootstrap({ strapi: fake.strapi });

    // The one-time migration is gone: no core-store access, no component or
    // community-member queries — only the permission seeding remains.
    expect(fake.strapi.store).toBeUndefined();
    const queriedUids = fake.strapi.db.query.mock.calls.map((call: any[]) => call[0]);
    expect(queriedUids).not.toContain('api::community-member.community-member');
    expect(queriedUids).not.toContain('components_contact_contact_infos');
  });
});
