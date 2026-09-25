import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type FieldSpec = {
  type: 'string' | 'text' | 'media' | 'component';
  localized?: boolean;
  required?: boolean;
  component?: string;
  repeatable?: boolean;
  multiple?: boolean;
  allowedTypes?: string[];
};

function loadSchema(ct: string): any {
  const schemaPath = path.join(
    __dirname,
    '..',
    'src',
    'api',
    ct,
    'content-types',
    ct,
    'schema.json'
  );
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function loadComponent(group: string, name: string): any {
  const componentPath = path.join(__dirname, '..', 'src', 'components', group, `${name}.json`);
  return JSON.parse(fs.readFileSync(componentPath, 'utf8'));
}

function isLocalized(attr: any): boolean {
  return attr?.pluginOptions?.i18n?.localized === true;
}

function expectFieldMatches(label: string, attr: any, spec: FieldSpec): void {
  expect(attr, `${label} attribute must exist`).toBeDefined();
  expect(attr.type, `${label} type`).toBe(spec.type);
  expect(isLocalized(attr), `${label} localization`).toBe(spec.localized === true);

  if (spec.required !== undefined) {
    expect(attr.required, `${label} required`).toBe(spec.required);
  }
  if (spec.type === 'component') {
    expect(attr.component, `${label} component`).toBe(spec.component);
    expect(attr.repeatable, `${label} repeatable`).toBe(spec.repeatable);
  }
  if (spec.type === 'media') {
    expect(attr.multiple, `${label} multiple`).toBe(spec.multiple);
    expect(attr.required, `${label} media is optional`).toBe(false);
    expect(attr.allowedTypes, `${label} allowedTypes`).toEqual(spec.allowedTypes);
  }
}

const GOOD_PRACTICES_FIELDS: Record<string, FieldSpec> = {
  internalLabel: { type: 'string', localized: false },
  hero: {
    type: 'component',
    component: 'hero.hero-section',
    repeatable: false,
    localized: true,
  },
  intro: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  protectedArea: {
    type: 'component',
    component: 'guide.protected-link',
    repeatable: false,
    localized: true,
  },
  anpMapImage: {
    type: 'media',
    multiple: false,
    allowedTypes: ['images'],
    localized: false,
  },
  conanpUrl: { type: 'string', localized: false },
  influenceHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  influenceText: { type: 'text', localized: true },
  fishingHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  fishingText: { type: 'text', localized: true },
  fishingRules: {
    type: 'component',
    component: 'guide.text-list-item',
    repeatable: true,
    localized: true,
  },
  fishingRefugeMapImage: {
    type: 'media',
    multiple: false,
    allowedTypes: ['images'],
    localized: false,
  },
  recommendationsHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  recommendations: {
    type: 'component',
    component: 'guide.text-list-item',
    repeatable: true,
    localized: true,
  },
  tipsHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  tips: {
    type: 'component',
    component: 'guide.text-list-item',
    repeatable: true,
    localized: true,
  },
  campaign: {
    type: 'component',
    component: 'campaign.campaign-block',
    repeatable: false,
    localized: true,
  },
  finalCta: {
    type: 'component',
    component: 'cta.cta-section',
    repeatable: false,
    localized: true,
  },
};

const GOOD_PRACTICES_ATTRIBUTE_KEYS = Object.keys(GOOD_PRACTICES_FIELDS).sort();

describe('redesign contract section 7: good-practices-page single type', () => {
  const schema = loadSchema('good-practices-page');

  it('is a localized single type with draft and publish', () => {
    expect(schema.kind).toBe('singleType');
    expect(schema.collectionName).toBe('good_practices_pages');
    expect(schema.options.draftAndPublish).toBe(true);
    expect(schema.pluginOptions.i18n.localized).toBe(true);
    expect(schema.info.singularName).toBe('good-practices-page');
    expect(schema.info.pluralName).toBe('good-practices-pages');
  });

  it('has exactly the 18 contract attributes (internalLabel included)', () => {
    expect(GOOD_PRACTICES_ATTRIBUTE_KEYS).toHaveLength(18);
    expect(Object.keys(schema.attributes).sort()).toEqual(GOOD_PRACTICES_ATTRIBUTE_KEYS);
    expect(schema.attributes.internalLabel.default).toBe('Good Practices Page');
  });

  it('matches the contract field by field', () => {
    for (const [fieldName, spec] of Object.entries(GOOD_PRACTICES_FIELDS)) {
      expectFieldMatches(
        `good-practices-page.${fieldName}`,
        schema.attributes[fieldName],
        spec
      );
    }
  });
});

describe('redesign contract section 7: campaign.campaign-block component', () => {
  const component = loadComponent('campaign', 'campaign-block');

  it('has a displayName and the exact 5-attribute contract set', () => {
    expect(typeof component.info.displayName).toBe('string');
    expect(component.info.displayName.length).toBeGreaterThan(0);
    expect(Object.keys(component.attributes).sort()).toEqual([
      'description',
      'linkLabel',
      'logo',
      'title',
      'url',
    ]);
  });

  it('matches the contract field by field', () => {
    const attributes = component.attributes;
    expectFieldMatches('campaign-block.title', attributes.title, {
      type: 'string',
      required: true,
      localized: true,
    });
    expectFieldMatches('campaign-block.description', attributes.description, {
      type: 'text',
      localized: true,
    });
    expectFieldMatches('campaign-block.logo', attributes.logo, {
      type: 'media',
      multiple: false,
      allowedTypes: ['images'],
      localized: false,
    });
    expectFieldMatches('campaign-block.url', attributes.url, {
      type: 'string',
      localized: false,
    });
    expectFieldMatches('campaign-block.linkLabel', attributes.linkLabel, {
      type: 'string',
      localized: true,
    });
  });
});

describe('redesign contract section 8: homepage additions', () => {
  const schema = loadSchema('homepage');

  it('adds regionMapImage: media single images, not localized', () => {
    expectFieldMatches('homepage.regionMapImage', schema.attributes.regionMapImage, {
      type: 'media',
      multiple: false,
      allowedTypes: ['images'],
      localized: false,
    });
  });

  it('keeps the full expand-only attribute set (previous fields plus regionMapImage)', () => {
    expect(Object.keys(schema.attributes).sort()).toEqual([
      'destinations',
      'destinationsHeader',
      'finalCta',
      'hero',
      'highlights',
      'highlightsHeader',
      'internalLabel',
      'mapSection',
      'quickFacts',
      'quickFactsHeader',
      'quickFactsImage1',
      'quickFactsImage2',
      'regionMapImage',
    ]);
  });
});
