import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type FieldSpec = {
  type: 'string' | 'text' | 'uid' | 'integer' | 'boolean' | 'media' | 'component' | 'relation';
  localized?: boolean;
  required?: boolean;
  component?: string;
  repeatable?: boolean;
  multiple?: boolean;
  allowedTypes?: string[];
  targetField?: string;
  default?: unknown;
  relation?: string;
  target?: string;
  mappedBy?: string;
  inversedBy?: string;
  maxLength?: number;
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

function isLocalized(attr: any): boolean {
  return attr?.pluginOptions?.i18n?.localized === true;
}

function expectFieldMatches(label: string, attr: any, spec: FieldSpec): void {
  expect(attr, `${label} attribute must exist`).toBeDefined();
  expect(attr.type, `${label} type`).toBe(spec.type);

  // Localization: true means pluginOptions.i18n.localized === true; false means
  // the flag (or the whole pluginOptions block) is absent.
  expect(isLocalized(attr), `${label} localization`).toBe(spec.localized === true);

  if (spec.required !== undefined) {
    expect(attr.required, `${label} required`).toBe(spec.required);
  }
  if (spec.targetField !== undefined) {
    expect(attr.targetField, `${label} targetField`).toBe(spec.targetField);
  }
  if (spec.default !== undefined) {
    expect(attr.default, `${label} default`).toBe(spec.default);
  }
  if (spec.maxLength !== undefined) {
    expect(attr.maxLength, `${label} maxLength`).toBe(spec.maxLength);
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
  if (spec.type === 'relation') {
    expect(attr.relation, `${label} relation`).toBe(spec.relation);
    expect(attr.target, `${label} target`).toBe(spec.target);
    if (spec.mappedBy !== undefined) {
      expect(attr.mappedBy, `${label} mappedBy`).toBe(spec.mappedBy);
    }
    if (spec.inversedBy !== undefined) {
      expect(attr.inversedBy, `${label} inversedBy`).toBe(spec.inversedBy);
    }
    // Relations never carry i18n pluginOptions.
    expect(attr.pluginOptions, `${label} carries no i18n pluginOptions`).toBeUndefined();
  }
}

const COMMUNITY_FIELDS: Record<string, FieldSpec> = {
  name: { type: 'string', required: true, localized: true },
  slug: { type: 'uid', targetField: 'name', required: true, localized: false },
  tagline: { type: 'string', localized: true },
  description: { type: 'text', localized: true },
  order: { type: 'integer', default: 0, localized: false },
  color: { type: 'string', localized: false },
  textColor: { type: 'string', localized: false },
  badgeIcon: {
    type: 'media',
    multiple: false,
    allowedTypes: ['images'],
    localized: false,
  },
  heroImage: {
    type: 'media',
    multiple: false,
    allowedTypes: ['images'],
    localized: false,
  },
  location: {
    type: 'component',
    component: 'location.geo-point',
    repeatable: false,
    localized: true,
  },
  googleMapsUrl: { type: 'string', localized: false },
  historyHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  historyMilestones: {
    type: 'component',
    component: 'guide.milestone',
    repeatable: true,
    localized: true,
  },
  historyText: { type: 'text', localized: true },
  touristMapImage: {
    type: 'media',
    multiple: false,
    allowedTypes: ['images'],
    localized: false,
  },
  touristMapCaption: { type: 'string', localized: true },
  highlightsHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  highlights: {
    type: 'component',
    component: 'highlight.highlight-card',
    repeatable: true,
    localized: true,
  },
  quickFactsHeader: {
    type: 'component',
    component: 'section.section-header',
    repeatable: false,
    localized: true,
  },
  quickFacts: {
    type: 'component',
    component: 'quickfact.quick-fact',
    repeatable: true,
    localized: true,
  },
  gallery: {
    type: 'media',
    multiple: true,
    allowedTypes: ['images'],
    localized: false,
  },
  finalCta: {
    type: 'component',
    component: 'cta.cta-section',
    repeatable: false,
    localized: true,
  },
  listings: {
    type: 'relation',
    relation: 'oneToMany',
    target: 'api::listing.listing',
    mappedBy: 'community',
    localized: false,
  },
  members: {
    type: 'relation',
    relation: 'oneToMany',
    target: 'api::community-member.community-member',
    mappedBy: 'community',
    localized: false,
  },
};

const COMMUNITY_ATTRIBUTE_KEYS = Object.keys(COMMUNITY_FIELDS).sort();

describe('redesign contract section 4: community collection type', () => {
  const schema = loadSchema('community');

  it('is a localized collection type with draft and publish', () => {
    expect(schema.kind).toBe('collectionType');
    expect(schema.collectionName).toBe('communities');
    expect(schema.options.draftAndPublish).toBe(true);
    expect(schema.pluginOptions.i18n.localized).toBe(true);
    expect(schema.info.singularName).toBe('community');
    expect(schema.info.pluralName).toBe('communities');
  });

  it('has exactly the 24 contract attributes', () => {
    expect(COMMUNITY_ATTRIBUTE_KEYS).toHaveLength(24);
    expect(Object.keys(schema.attributes).sort()).toEqual(COMMUNITY_ATTRIBUTE_KEYS);
  });

  it('does not carry member-only fields (shortDescription lives on community-member)', () => {
    expect(schema.attributes.shortDescription).toBeUndefined();
    expect(schema.attributes.hideContact).toBeUndefined();
  });

  it('matches the contract field by field', () => {
    for (const [fieldName, spec] of Object.entries(COMMUNITY_FIELDS)) {
      expectFieldMatches(`community.${fieldName}`, schema.attributes[fieldName], spec);
    }
  });
});

describe('redesign contract section 5: listing additions', () => {
  const schema = loadSchema('listing');

  it('adds the community relation (manyToOne, inverse listings)', () => {
    expectFieldMatches('listing.community', schema.attributes.community, {
      type: 'relation',
      relation: 'manyToOne',
      target: 'api::community.community',
      inversedBy: 'listings',
      localized: false,
    });
  });

  it('adds hideContact: boolean, default false, not localized', () => {
    expectFieldMatches('listing.hideContact', schema.attributes.hideContact, {
      type: 'boolean',
      default: false,
      localized: false,
    });
  });
});

describe('redesign contract section 6: community-member additions', () => {
  const schema = loadSchema('community-member');

  it('adds the community relation (manyToOne, inverse members)', () => {
    expectFieldMatches('community-member.community', schema.attributes.community, {
      type: 'relation',
      relation: 'manyToOne',
      target: 'api::community.community',
      inversedBy: 'members',
      localized: false,
    });
  });

  it('adds shortDescription: text, maxLength 200, localized', () => {
    expectFieldMatches('community-member.shortDescription', schema.attributes.shortDescription, {
      type: 'text',
      maxLength: 200,
      localized: true,
    });
  });
});

describe('redesign contract-phase cleanup invariants', () => {
  it('community-member no longer has the locality attribute', () => {
    const attributes = loadSchema('community-member').attributes;
    expect(attributes.locality).toBeUndefined();
  });

  it('listing keeps category, slug and isFeatured', () => {
    const attributes = loadSchema('listing').attributes;
    expect(attributes.category.target).toBe('api::category.category');
    expect(attributes.slug.type).toBe('uid');
    expect(attributes.isFeatured.type).toBe('boolean');
  });

  it('homepage no longer has destinations or destinationsHeader', () => {
    const attributes = loadSchema('homepage').attributes;
    expect(attributes.destinations).toBeUndefined();
    expect(attributes.destinationsHeader).toBeUndefined();
  });

  it('guide-page content type no longer exists', () => {
    const schemaPath = path.join(
      __dirname,
      '..',
      'src',
      'api',
      'guide-page',
      'content-types',
      'guide-page',
      'schema.json'
    );
    expect(fs.existsSync(schemaPath)).toBe(false);
  });

  it('the other removed content types no longer exist', () => {
    for (const ct of ['experiences-page', 'about-page', 'team-member', 'organization']) {
      const schemaPath = path.join(__dirname, '..', 'src', 'api', ct, 'content-types', ct, 'schema.json');
      expect(fs.existsSync(schemaPath), `${ct} schema must be gone`).toBe(false);
    }
  });
});
