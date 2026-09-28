import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pins the post-cleanup contact-info component (contract §5b + §10): plain
 * JSON read, no Strapi boot. The legacy free-text phone/whatsapp pair was
 * removed by the A5 contract-phase cleanup; the country-code + number pairs
 * are the survivors and must keep their §5b validation.
 */

const schemaPath = path.join(__dirname, '..', 'src', 'components', 'contact', 'contact-info.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

describe('contact-info component (post-cleanup, contract §5b)', () => {
  it('has the exact 9-attribute key set', () => {
    expect(Object.keys(schema.attributes).sort()).toEqual([
      'email',
      'facebook',
      'instagram',
      'phoneCountryCode',
      'phoneNumber',
      'tiktok',
      'website',
      'whatsappCountryCode',
      'whatsappNumber',
    ]);
  });

  it('no longer has the legacy phone and whatsapp attributes', () => {
    expect(schema.attributes.phone).toBeUndefined();
    expect(schema.attributes.whatsapp).toBeUndefined();
  });

  it('keeps the country-code fields with the §5b regex and +52 default', () => {
    for (const key of ['phoneCountryCode', 'whatsappCountryCode']) {
      expect(schema.attributes[key].type, key).toBe('string');
      expect(schema.attributes[key].regex, key).toBe('^\\+[1-9]\\d{0,2}$');
      expect(schema.attributes[key].default, key).toBe('+52');
    }
  });

  it('keeps the national number fields with the 10-digit regex and no default', () => {
    for (const key of ['phoneNumber', 'whatsappNumber']) {
      expect(schema.attributes[key].type, key).toBe('string');
      expect(schema.attributes[key].regex, key).toBe('^\\d{10}$');
      expect(schema.attributes[key], key).not.toHaveProperty('default');
    }
  });
});
