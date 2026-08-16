import { describe, it, expect, vi } from 'vitest';
import serviceFactory from '../src/api/site-content/services/site-content';

// Minimal content-type stand-in: the real factories only read `kind` (to pick
// collection-type vs single-type base service) and `uid` when instantiating.
const contentType = {
  uid: 'api::site-content.site-content',
  kind: 'collectionType',
  modelName: 'site-content',
  attributes: {},
};

function makeService(results: unknown[]) {
  const findMany = vi.fn(async () => results);
  const strapi = {
    contentType: vi.fn(() => contentType),
    db: {
      query: vi.fn(() => ({ findMany })),
    },
  };
  const service = serviceFactory({ strapi } as any);
  return { service, findMany, strapi };
}

describe('site-content service findByKey', () => {
  it('queries by key with empty populate and maps the results through', async () => {
    const rows = [
      { id: 1, documentId: 'a', key: 'hero', locale: 'en' },
      { id: 2, documentId: 'b', key: 'hero', locale: 'es' },
    ];
    const { service, findMany } = makeService(rows);

    const result = await service.findByKey('hero', 'en');

    // Query construction: where only filters by key; no locale in SQL.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { key: 'hero' }, populate: {} });

    // Result mapping: only rows matching the requested locale are returned.
    expect(result).toEqual([{ id: 1, documentId: 'a', key: 'hero', locale: 'en' }]);
  });

  it('falls back to es-MX rows when the requested locale is missing', async () => {
    const rows = [
      { id: 1, documentId: 'a', key: 'hero', locale: 'en' },
      { id: 2, documentId: 'b', key: 'hero', locale: 'es-MX' },
    ];
    const { service } = makeService(rows);

    const result = await service.findByKey('hero', 'fr');

    expect(result).toEqual([{ id: 2, documentId: 'b', key: 'hero', locale: 'es-MX' }]);
  });

  it('falls back to all locales when neither the requested locale nor es-MX is present', async () => {
    const rows = [
      { id: 1, documentId: 'a', key: 'hero', locale: 'en' },
      { id: 2, documentId: 'b', key: 'hero', locale: 'es' },
    ];
    const { service } = makeService(rows);

    const result = await service.findByKey('hero', 'fr');

    expect(result).toEqual(rows);
  });

  it('returns the raw result set when no locale is given', async () => {
    const rows = [{ id: 1, documentId: 'a', key: 'hero', locale: 'en' }];
    const { service } = makeService(rows);

    const result = await service.findByKey('hero');

    expect(result).toBe(rows);
  });

  it('returns an empty array when nothing matches the key', async () => {
    const { service, findMany } = makeService([]);

    const result = await service.findByKey('does-not-exist', 'es');

    expect(findMany).toHaveBeenCalledWith({ where: { key: 'does-not-exist' }, populate: {} });
    expect(result).toEqual([]);
  });
});
