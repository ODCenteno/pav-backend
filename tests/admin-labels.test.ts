import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIELD_LABELS } from '../src/admin-labels';
import { applyFieldMetadata, syncAdminLabels } from '../src/sync-admin-labels';

type Attributes = Record<string, { description?: string }>;

const repoRoot = process.cwd();

// Every content type and component schema in the repo, keyed by the UID the
// Content Manager uses for its configuration.
function loadSchemas(): Record<string, Attributes> {
  const schemas: Record<string, Attributes> = {};

  const apiDir = path.join(repoRoot, 'src/api');
  for (const name of fs.readdirSync(apiDir)) {
    const file = path.join(apiDir, name, 'content-types', name, 'schema.json');
    if (fs.existsSync(file)) {
      schemas[`api::${name}.${name}`] = JSON.parse(fs.readFileSync(file, 'utf8')).attributes;
    }
  }

  const componentsDir = path.join(repoRoot, 'src/components');
  for (const category of fs.readdirSync(componentsDir)) {
    for (const file of fs.readdirSync(path.join(componentsDir, category))) {
      if (!file.endsWith('.json')) continue;
      const uid = `${category}.${file.replace(/\.json$/, '')}`;
      schemas[uid] = JSON.parse(fs.readFileSync(path.join(componentsDir, category, file), 'utf8')).attributes;
    }
  }

  return schemas;
}

const schemas = loadSchemas();

describe('FIELD_LABELS coverage', () => {
  it('covers exactly the content types and components in the repo', () => {
    expect(Object.keys(FIELD_LABELS).sort()).toEqual(Object.keys(schemas).sort());
  });

  it('has a label for every attribute and none for removed ones', () => {
    for (const [uid, attributes] of Object.entries(schemas)) {
      expect(Object.keys(FIELD_LABELS[uid]).sort(), uid).toEqual(Object.keys(attributes).sort());
    }
  });

  it('uses readable labels, never the raw field name', () => {
    for (const [uid, labels] of Object.entries(FIELD_LABELS)) {
      for (const [field, label] of Object.entries(labels)) {
        expect(label.trim(), `${uid}.${field}`).not.toBe('');
        expect(label, `${uid}.${field}`).not.toBe(field);
      }
    }
  });

  it('gives every attribute a non-empty description', () => {
    for (const [uid, attributes] of Object.entries(schemas)) {
      for (const [field, attribute] of Object.entries(attributes)) {
        expect(attribute.description?.trim(), `${uid}.${field}`).toBeTruthy();
      }
    }
  });

  it('keeps descriptions free of removed routes and site-content keys', () => {
    const stale = /incluyos|\/experiencias|about-|guide-/;
    for (const [uid, attributes] of Object.entries(schemas)) {
      for (const [field, attribute] of Object.entries(attributes)) {
        expect(attribute.description ?? '', `${uid}.${field}`).not.toMatch(stale);
      }
    }
  });
});

function makeConfiguration() {
  return {
    settings: { mainField: 'title' },
    layouts: { edit: [], list: ['id', 'title'] },
    metadatas: {
      title: {
        edit: { label: 'title', description: '', placeholder: 'Ej: Kayak', visible: true, editable: true },
        list: { label: 'title', searchable: true, sortable: true },
      },
      category: {
        edit: { label: 'category', description: '', placeholder: '', visible: true, editable: true, mainField: 'name' },
        list: { label: 'category', searchable: false, sortable: false },
      },
    },
  };
}

describe('applyFieldMetadata', () => {
  const attributes = {
    title: { description: 'Nombre del lugar.' },
    category: { description: 'Categoría del lugar.' },
  };
  const labels = { title: 'Nombre', category: 'Categoría' };

  it('sets the edit label, list label and edit description of each field', () => {
    const { configuration, changed } = applyFieldMetadata(makeConfiguration(), attributes, labels);

    expect(changed).toBe(true);
    expect(configuration.metadatas.title.edit.label).toBe('Nombre');
    expect(configuration.metadatas.title.list.label).toBe('Nombre');
    expect(configuration.metadatas.title.edit.description).toBe('Nombre del lugar.');
    expect(configuration.metadatas.category.edit.label).toBe('Categoría');
    expect(configuration.metadatas.category.edit.description).toBe('Categoría del lugar.');
  });

  it('keeps every other metadata value and the settings and layouts', () => {
    const original = makeConfiguration();
    const { configuration } = applyFieldMetadata(original, attributes, labels);

    expect(configuration.metadatas.title.edit.placeholder).toBe('Ej: Kayak');
    expect(configuration.metadatas.category.edit.mainField).toBe('name');
    expect(configuration.metadatas.title.list.searchable).toBe(true);
    expect(configuration.settings).toEqual(original.settings);
    expect(configuration.layouts).toEqual(original.layouts);
  });

  it('does not mutate its input', () => {
    const original = makeConfiguration();
    applyFieldMetadata(original, attributes, labels);

    expect(original.metadatas.title.edit.label).toBe('title');
  });

  it('reports no change when the labels are already applied', () => {
    const { configuration } = applyFieldMetadata(makeConfiguration(), attributes, labels);
    const second = applyFieldMetadata(configuration, attributes, labels);

    expect(second.changed).toBe(false);
  });

  it('keeps an existing description when the schema has none', () => {
    const configuration = makeConfiguration();
    configuration.metadatas.title.edit.description = 'Texto cargado a mano';

    const result = applyFieldMetadata(configuration, { title: {} }, { title: 'Nombre' });

    expect(result.configuration.metadatas.title.edit.description).toBe('Texto cargado a mano');
  });

  it('skips fields that have no metadata entry', () => {
    const { configuration } = applyFieldMetadata(makeConfiguration(), attributes, { ...labels, ghost: 'Fantasma' });

    expect(configuration.metadatas).not.toHaveProperty('ghost');
  });
});

function makeStrapi(configurations: Record<string, any>) {
  const models: Record<string, any> = {
    'api::listing.listing': { uid: 'api::listing.listing', attributes: { title: { description: 'Nombre del lugar.' } } },
  };
  const components: Record<string, any> = {
    'tag.tag-item': { uid: 'tag.tag-item', category: 'tag', attributes: { label: { description: 'Texto.' } } },
  };

  const makeService = () => ({
    findConfiguration: vi.fn(async (model: any) => ({ uid: model.uid, ...configurations[model.uid] })),
    updateConfiguration: vi.fn(async (model: any, input: any) => {
      configurations[model.uid] = input;
    }),
  });
  const contentTypesService = makeService();
  const componentsService = makeService();

  const strapi: any = {
    contentTypes: models,
    components,
    log: { info: vi.fn(), warn: vi.fn() },
    plugin: vi.fn(() => ({
      service: vi.fn((name: string) => (name === 'components' ? componentsService : contentTypesService)),
    })),
  };

  return { strapi, contentTypesService, componentsService };
}

function metadatasFor(field: string) {
  return {
    settings: {},
    layouts: { edit: [], list: [] },
    metadatas: { [field]: { edit: { label: field, description: '' }, list: { label: field } } },
  };
}

describe('syncAdminLabels', () => {
  const labels = {
    'api::listing.listing': { title: 'Nombre' },
    'tag.tag-item': { label: 'Texto de la etiqueta' },
  };

  it('writes the labels of content types and components through the Content Manager', async () => {
    const configurations = {
      'api::listing.listing': metadatasFor('title'),
      'tag.tag-item': metadatasFor('label'),
    };
    const { strapi, contentTypesService, componentsService } = makeStrapi(configurations);

    await syncAdminLabels(strapi, labels);

    expect(contentTypesService.updateConfiguration).toHaveBeenCalledTimes(1);
    expect(componentsService.updateConfiguration).toHaveBeenCalledTimes(1);
    expect(configurations['api::listing.listing'].metadatas.title.edit.label).toBe('Nombre');
    expect(configurations['api::listing.listing'].metadatas.title.edit.description).toBe('Nombre del lugar.');
    expect(configurations['tag.tag-item'].metadatas.label.edit.label).toBe('Texto de la etiqueta');
  });

  it('passes only settings, layouts and metadatas to updateConfiguration', async () => {
    const { strapi, contentTypesService } = makeStrapi({
      'api::listing.listing': metadatasFor('title'),
      'tag.tag-item': metadatasFor('label'),
    });

    await syncAdminLabels(strapi, labels);

    const input = contentTypesService.updateConfiguration.mock.calls[0][1];
    expect(Object.keys(input).sort()).toEqual(['layouts', 'metadatas', 'settings']);
  });

  it('does not write when nothing changed', async () => {
    const { strapi, contentTypesService, componentsService } = makeStrapi({
      'api::listing.listing': metadatasFor('title'),
      'tag.tag-item': metadatasFor('label'),
    });

    await syncAdminLabels(strapi, labels);
    contentTypesService.updateConfiguration.mockClear();
    componentsService.updateConfiguration.mockClear();
    await syncAdminLabels(strapi, labels);

    expect(contentTypesService.updateConfiguration).not.toHaveBeenCalled();
    expect(componentsService.updateConfiguration).not.toHaveBeenCalled();
  });

  it('warns about a UID that is not loaded and keeps going', async () => {
    const { strapi, componentsService } = makeStrapi({
      'api::listing.listing': metadatasFor('title'),
      'tag.tag-item': metadatasFor('label'),
    });

    await syncAdminLabels(strapi, { 'api::ghost.ghost': { name: 'Nombre' }, ...labels });

    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('api::ghost.ghost'));
    expect(componentsService.updateConfiguration).toHaveBeenCalledTimes(1);
  });
});
