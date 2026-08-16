import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { planUnify } from '../scripts/unify-locale-slugs.js';

const API_DIR = path.join(__dirname, '..', 'src', 'api');

function loadSchemas(): Array<{ ct: string; schema: any }> {
  const out: Array<{ ct: string; schema: any }> = [];
  for (const entry of fs.readdirSync(API_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const schemaPath = path.join(API_DIR, entry.name, 'content-types', entry.name, 'schema.json');
    if (fs.existsSync(schemaPath)) {
      out.push({ ct: entry.name, schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')) });
    }
  }
  return out;
}

describe('schema invariant: slugs are shared across locales', () => {
  const schemas = loadSchemas();
  const withSlug = schemas.filter(({ schema }) => 'slug' in schema.attributes);

  it('found the expected slug-bearing content types', () => {
    expect(withSlug.map(({ ct }) => ct).sort()).toEqual([
      'category',
      'community-member',
      'legal-page',
      'listing',
    ]);
  });

  it('no content type declares a localized slug', () => {
    // A localized slug allows one slug per locale variant, which lets
    // /sitios/<es-slug> and /en/sitios/<en-slug> diverge and breaks the
    // frontend language switch (404). Slug must be non-localized.
    const offenders = withSlug.filter(
      ({ schema }) => schema.attributes.slug?.pluginOptions?.i18n?.localized === true
    );
    expect(offenders.map(({ ct }) => ct)).toEqual([]);
  });

  it('listing and category slugs stay required uid fields', () => {
    for (const ct of ['listing', 'category']) {
      const { schema } = schemas.find((s) => s.ct === ct)!;
      expect(schema.attributes.slug.type).toBe('uid');
      expect(schema.attributes.slug.required).toBe(true);
    }
  });
});

describe('planUnify (slug unification planning)', () => {
  // [documentId, locale, slug, publishedAt, name?]
  const rows = (
    table: string,
    spec: Array<[string, string, string, boolean, string?]>
  ) =>
    spec.map(([documentId, locale, slug, publishedAt, name], i) => ({
      id: i + 1,
      table,
      documentId,
      locale,
      slug,
      publishedAt,
      ...(name !== undefined ? { name } : {}),
    }));

  it('reports synced documents and plans repairs from the default locale', () => {
    const plan = planUnify({
      listings: rows('listings', [
        ['docA', 'es-MX', 'cantera-de-la-playa', true],
        ['docA', 'es-MX', 'cantera-de-la-playa', false],
        ['docA', 'en', 'beach-quarry', true],
        ['docA', 'en', 'beach-quarry', false],
        ['docB', 'es-MX', 'museo', true],
        ['docB', 'en', 'museo', true],
      ]),
    });
    expect(plan.synced).toBe(1);
    expect(plan.repairs).toHaveLength(1);
    expect(plan.repairs[0].toSlug).toBe('cantera-de-la-playa');
    expect(plan.repairs[0].rowIds.sort((a: number, b: number) => a - b)).toEqual([3, 4]);
  });

  it('flags ambiguous default-locale slugs as conflicts', () => {
    const plan = planUnify({
      listings: rows('listings', [
        ['docA', 'es-MX', 'uno', true],
        ['docA', 'es-MX', 'otro', false],
        ['docA', 'en', 'uno', true],
      ]),
    });
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['ambiguous-default']);
    expect(plan.repairs).toHaveLength(0);
  });

  it('flags slug collisions between different documents', () => {
    const plan = planUnify({
      listings: rows('listings', [
        ['docA', 'es-MX', 'mismo-slug', true],
        ['docA', 'en', 'mismo-slug', true],
        ['docB', 'es-MX', 'mismo-slug', true],
        ['docB', 'en', 'mismo-slug', true],
      ]),
    });
    expect(plan.conflicts.map((c) => c.kind)).toContain('collision');
  });

  it('classifies an EN-only duplicate of a bilingual document as orphan-duplicate (prunable)', () => {
    const base = rows('categories', [
      ['catA', 'es-MX', 'restaurants', true, 'Restaurantes'],
      ['catA', 'en', 'restaurants', false, 'Restaurantes'],
      ['catB', 'en', 'restaurants', true, 'Restaurants'],
    ]);
    const plain = planUnify({ categories: base });
    expect(plain.conflicts.map((c) => c.kind)).toEqual(['orphan-duplicate']);
    expect(plain.prunes).toHaveLength(0);

    const withPrune = planUnify({ categories: base }, 'es-MX', { pruneOrphans: true });
    expect(withPrune.conflicts).toHaveLength(0);
    expect(withPrune.prunes).toHaveLength(1);
    const prune = withPrune.prunes[0];
    expect(prune.documentId).toBe('catB');
    expect(prune.duplicateOf).toBe('categories:catA');
    expect(prune.merge.name).toBe('Restaurants'); // translated name from the duplicate
    expect(prune.merge.needsPublishClone).toBe(true); // draft EN shell gets a published clone
    expect(prune.merge.dupDocumentId).toBe('catB');
  });

  it('leaves unique EN-only documents as orphans (untouched)', () => {
    const plan = planUnify({
      categories: rows('categories', [
        ['catA', 'es-MX', 'restaurants', true],
        ['catZ', 'en', 'future-category', true],
      ]),
    });
    expect(plan.orphans).toEqual([
      { table: 'categories', documentId: 'catZ', locales: ['en'] },
    ]);
    expect(plan.repairs).toHaveLength(0);
  });
});
