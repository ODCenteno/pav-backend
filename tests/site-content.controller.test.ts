import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import controllerFactory from '../src/api/site-content/controllers/site-content';

// Minimal content-type stand-in for the real factory:
// createController reads `kind` and collection-type reads `uid`.
const contentType = {
  uid: 'api::site-content.site-content',
  kind: 'collectionType',
  modelName: 'site-content',
  attributes: {},
};

const UUID = '9a2f4c6e-1111-4222-8333-444455556666';

function makeController() {
  const findByKey = vi.fn();
  const coreServiceFindOne = vi.fn(async (id: string) => ({ id, documentId: 'core', title: 'core entity' }));
  const sanitizeOutput = vi.fn(async (data: unknown) => data);

  // Strapi core controllers resolve `strapi` through the Node global, not the
  // factory argument, so the fake must be installed globally for the
  // sanitize/validate/transform plumbing to use it.
  const strapi = {
    contentType: vi.fn(() => contentType),
    service: vi.fn(() => ({ findByKey, findOne: coreServiceFindOne })),
    contentAPI: {
      sanitize: {
        output: sanitizeOutput,
        query: vi.fn(async (q: unknown) => q),
      },
      validate: {
        query: vi.fn(async (q: unknown) => q),
      },
    },
    config: { get: vi.fn(() => undefined) },
  };

  (global as any).strapi = strapi;
  const controller = controllerFactory({ strapi } as any);
  return { controller, findByKey, coreServiceFindOne, sanitizeOutput, strapi };
}

function makeCtx(id: string, locale?: string) {
  return {
    params: { id },
    query: locale ? { locale } : {},
    state: { auth: {} },
    notFound: vi.fn(),
  } as any;
}

afterEach(() => {
  delete (global as any).strapi;
});

describe('site-content controller findOne routing', () => {
  it('routes a non-UUID id through findByKey and returns the sanitized first result', async () => {
    const { controller, findByKey, sanitizeOutput } = makeController();
    const rows = [
      { id: 1, documentId: 'a', key: 'hero-banner', locale: 'es' },
      { id: 2, documentId: 'b', key: 'hero-banner', locale: 'en' },
    ];
    findByKey.mockResolvedValue(rows);

    const ctx = makeCtx('hero-banner', 'es');
    const result = await controller.findOne(ctx);

    expect(findByKey).toHaveBeenCalledWith('hero-banner', 'es');

    // Sanitization path: real core sanitizeOutput extracts the auth from
    // ctx.state.auth and forwards (data, contentType, { auth }) to
    // strapi.contentAPI.sanitize.output with the first row.
    expect(sanitizeOutput).toHaveBeenCalledTimes(1);
    expect(sanitizeOutput).toHaveBeenCalledWith(rows[0], contentType, { auth: {} });

    // Serialization path: real core transformResponse wraps as { data, meta }.
    expect(result).toEqual({ data: rows[0], meta: {} });
    expect(ctx.notFound).not.toHaveBeenCalled();
  });

  it('passes locale=undefined to findByKey when no locale query is present', async () => {
    const { controller, findByKey } = makeController();
    findByKey.mockResolvedValue([{ id: 1, key: 'about' }]);

    await controller.findOne(makeCtx('about'));

    expect(findByKey).toHaveBeenCalledWith('about', undefined);
  });

  it('responds 404 via ctx.notFound when findByKey returns no rows', async () => {
    const { controller, findByKey } = makeController();
    findByKey.mockResolvedValue([]);

    const ctx = makeCtx('unknown-key');
    const result = await controller.findOne(ctx);

    expect(findByKey).toHaveBeenCalledWith('unknown-key', undefined);
    expect(ctx.notFound).toHaveBeenCalledWith('Site content not found');
    expect(result).toBeUndefined();
  });

  it('delegates a documentId (UUID) to the core findOne, bypassing findByKey', async () => {
    const { controller, findByKey, coreServiceFindOne } = makeController();

    const ctx = makeCtx(UUID, 'es');
    const result = await controller.findOne(ctx);

    expect(findByKey).not.toHaveBeenCalled();
    // Core findOne receives the raw documentId and the (sanitized) query.
    expect(coreServiceFindOne).toHaveBeenCalledWith(UUID, { locale: 'es' });
    expect(result).toEqual({ data: { id: UUID, documentId: 'core', title: 'core entity' }, meta: {} });
  });

  it('treats uppercase UUIDs as documentIds too (case-insensitive regex)', async () => {
    const { controller, findByKey, coreServiceFindOne } = makeController();

    await controller.findOne(makeCtx(UUID.toUpperCase()));

    expect(findByKey).not.toHaveBeenCalled();
    expect(coreServiceFindOne).toHaveBeenCalledTimes(1);
  });
});
