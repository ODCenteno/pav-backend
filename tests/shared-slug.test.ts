import { describe, it, expect, vi } from 'vitest';
import {
  SHARED_SLUG_MODELS,
  isSharedSlugUpdate,
  syncSharedSlugFor,
  subscribeSharedSlugSync,
} from '../src/sync-shared-slug';

function makeDb(rowsByUid: Record<string, any[]>) {
  const findMany = vi.fn(async ({ where }: any) => {
    // Naive matcher good enough for the cases under test: match on
    // documentId and/or id filters.
    for (const [uid, rows] of Object.entries(rowsByUid)) {
      if (currentUid === uid) {
        return rows.filter((r) => {
          if (where?.documentId && r.documentId !== where.documentId) return false;
          if (where?.id && r.id !== where.id) return false;
          return true;
        });
      }
    }
    return [];
  });
  const updateMany = vi.fn(async ({ where, data }: any) => {
    let count = 0;
    for (const [uid, rows] of Object.entries(rowsByUid)) {
      if (currentUid !== uid) continue;
      for (const r of rows) {
        const docMatch = !where?.documentId || r.documentId === where.documentId;
        const neMatch = !where?.slug?.$ne || r.slug !== where.slug.$ne;
        if (docMatch && neMatch && r.slug !== data.slug) {
          r.slug = data.slug;
          count += 1;
        }
      }
    }
    return { count };
  });

  let currentUid = '';
  const handlers: Array<(e: any) => void> = [];
  const db = {
    query: vi.fn((uid: string) => {
      currentUid = uid;
      return { findMany, updateMany };
    }),
    lifecycles: {
      subscribe: vi.fn((h: (e: any) => void) => {
        handlers.push(h);
      }),
    },
  };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  return { strapi: { db, log } as any, findMany, updateMany, handlers };
}

const ROWS = [
  { id: 1, documentId: 'docA', slug: 'new-slug' }, // the edited row (EN draft)
  { id: 2, documentId: 'docA', slug: 'old-slug' }, // EN published
  { id: 3, documentId: 'docA', slug: 'old-slug' }, // ES draft
  { id: 4, documentId: 'docA', slug: 'old-slug' }, // ES published
  { id: 5, documentId: 'docB', slug: 'other-slug' }, // unrelated document
];

describe('isSharedSlugUpdate', () => {
  it('accepts afterUpdate for the four shared-slug models', () => {
    for (const uid of SHARED_SLUG_MODELS) {
      expect(isSharedSlugUpdate('afterUpdate', uid)).toBe(true);
    }
  });

  it('rejects other actions, unknown uids, and missing uid', () => {
    expect(isSharedSlugUpdate('afterCreate', 'api::listing.listing')).toBe(false);
    expect(isSharedSlugUpdate('afterUpdate', 'api::homepage.homepage')).toBe(false);
    expect(isSharedSlugUpdate('afterUpdate', undefined)).toBe(false);
  });
});

describe('syncSharedSlugFor', () => {
  it('propagates the edited row slug to every sibling of the same document', async () => {
    const rows = ROWS.map((r) => ({ ...r }));
    const { strapi, updateMany } = makeDb({ 'api::listing.listing': rows });
    const corrected = await syncSharedSlugFor(strapi, 'api::listing.listing', { id: 1 });
    expect(corrected).toBe(3); // rows 2, 3, 4 fixed
    expect(rows.filter((r) => r.documentId === 'docA').every((r) => r.slug === 'new-slug')).toBe(true);
    expect(rows.find((r) => r.documentId === 'docB')!.slug).toBe('other-slug');
    expect(updateMany).toHaveBeenCalledWith({
      where: { documentId: 'docA', slug: { $ne: 'new-slug' } },
      data: { slug: 'new-slug' },
    });
  });

  it('corrects zero rows when everything is already synced', async () => {
    const rows = ROWS.map((r) => ({ ...r, slug: 'same-slug' }));
    const { strapi, updateMany } = makeDb({ 'api::listing.listing': rows });
    const corrected = await syncSharedSlugFor(strapi, 'api::listing.listing', { id: 1 });
    // updateMany still runs (the DB-side $ne filter does the matching) but
    // must correct nothing.
    expect(corrected).toBe(0);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { documentId: 'docA', slug: { $ne: 'same-slug' } },
      data: { slug: 'same-slug' },
    });
  });

  it('returns 0 when the where clause matches nothing', async () => {
    const { strapi } = makeDb({ 'api::listing.listing': ROWS.map((r) => ({ ...r })) });
    const corrected = await syncSharedSlugFor(strapi, 'api::listing.listing', { id: 999 });
    expect(corrected).toBe(0);
  });

  it('skips rows without a usable documentId or slug', async () => {
    const rows = [
      { id: 1, documentId: null, slug: 'x' },
      { id: 2, documentId: 'docA', slug: '' },
    ];
    const { strapi, updateMany } = makeDb({ 'api::category.category': rows as any });
    const corrected = await syncSharedSlugFor(strapi, 'api::category.category', { id: 1 });
    expect(corrected).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('subscribeSharedSlugSync', () => {
  it('only reacts to afterUpdate events of shared-slug models', async () => {
    const rows = ROWS.map((r) => ({ ...r }));
    const { strapi, handlers } = makeDb({ 'api::listing.listing': rows });
    subscribeSharedSlugSync(strapi);
    expect(handlers).toHaveLength(1);
    const handler = handlers[0];

    await handler({ action: 'afterUpdate', model: { uid: 'api::listing.listing' }, params: { where: { id: 1 } } });
    await handler({ action: 'afterCreate', model: { uid: 'api::listing.listing' }, params: { where: { id: 1 } } });
    await handler({ action: 'afterUpdate', model: { uid: 'api::homepage.homepage' }, params: { where: { id: 1 } } });

    // One sync ran (docA fixed); the other two events were ignored.
    expect(rows.filter((r) => r.documentId === 'docA').every((r) => r.slug === 'new-slug')).toBe(true);
    expect(strapi.db.query).toHaveBeenCalledTimes(1 + 1); // findMany + updateMany
  });

  it('logs a warning instead of throwing when the sync fails', async () => {
    const { strapi, handlers } = makeDb({});
    strapi.db.query = vi.fn(() => {
      throw new Error('db down');
    });
    subscribeSharedSlugSync(strapi);
    // Must not reject: the handler swallows into a warning.
    await handlers[0]({ action: 'afterUpdate', model: { uid: 'api::listing.listing' }, params: { where: { id: 1 } } });
    await new Promise((r) => setTimeout(r, 10)); // let the async catch settle
    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('[shared-slug] sync failed'));
  });
});
