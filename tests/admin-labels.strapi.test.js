/**
 * Boots a real Strapi instance on a throwaway SQLite database and checks that
 * the bootstrap leaves the Spanish labels and help texts in the Content
 * Manager configuration, i.e. that it runs after the Content Manager syncs its
 * own configurations and that Strapi keeps the schema `description`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TIMEOUT = 180_000;

// Throwaway secrets so the app can boot without a real .env file. Never read
// from or written to an actual .env* file.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.APP_KEYS = process.env.APP_KEYS || 'test-app-key-a,test-app-key-b';
process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'test-api-token-salt';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret';
process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'test-transfer-token-salt';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
process.env.R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.invalid';
process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://example.invalid';
process.env.R2_BUCKET = process.env.R2_BUCKET || 'test-bucket';
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'test-secret-key';
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-google-maps-key';

import cleanup from '../scripts/cleanup-redesign.js';

let strapi;
let dbPath;

async function metadatasOf(serviceName, uid) {
  const service = strapi.plugin('content-manager').service(serviceName);
  const model = serviceName === 'components' ? strapi.components[uid] : strapi.contentTypes[uid];
  return (await service.findConfiguration(model)).metadatas;
}

describe('admin labels (Strapi-backed)', () => {
  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `admin-labels-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    strapi = await cleanup.loadStrapiInstance({ dbPath });
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.closeStrapiInstance(strapi);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // best-effort cleanup
    }
  }, TIMEOUT);

  it('shows Spanish labels and the schema help text on a content type', async () => {
    const metadatas = await metadatasOf('content-types', 'api::listing.listing');

    expect(metadatas.mainImage.edit.label).toBe('Imagen principal');
    expect(metadatas.mainImage.list.label).toBe('Imagen principal');
    expect(metadatas.mainImage.edit.description).toMatch(/^Imagen principal que se muestra/);
    expect(metadatas.isFeatured.edit.label).toBe('¿Es destacado?');
  });

  it('keeps the relation display field of a relation', async () => {
    const metadatas = await metadatasOf('content-types', 'api::listing.listing');

    expect(metadatas.category.edit.label).toBe('Categoría');
    expect(metadatas.category.edit.mainField).toBeTruthy();
  });

  it('labels the fields inside a component', async () => {
    const metadatas = await metadatasOf('components', 'contact.contact-info');

    expect(metadatas.phoneNumber.edit.label).toBe('Teléfono: número');
    expect(metadatas.phoneNumber.edit.description).toMatch(/10 dígitos/);
  });
});
