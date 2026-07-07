#!/usr/bin/env node
/**
 * Migrate JSON fields to structured components.
 *
 * Phase 1 (--phase=backup): Read all listings from SQLite, save JSON data to .tmp/json-backup.json
 * Phase 2 (--phase=restore): Read backup, transform to component shapes, PUT each listing via Strapi API
 *
 * Usage:
 *   node scripts/migrate-json-to-components.js --phase=backup
 *   node scripts/migrate-json-to-components.js --phase=restore
 */

const fs = require('node:fs');
const path = require('node:path');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN || '';
const BACKUP_FILE = path.resolve(__dirname, '../.tmp/json-backup.json');
const DB_PATH = path.resolve(__dirname, '../.tmp/data.db');

const phase = process.argv.find(a => a.startsWith('--phase='))?.split('=')[1];

function parseJsonField(val) {
  if (val == null || val === '') return null;
  try { return JSON.parse(val); } catch { return null; }
}

function phaseBackup() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT document_id, locale, title, slug,
           tags, contact, location, schedule, amenities, recommendations
    FROM listings
    ORDER BY document_id, locale
  `).all();

  const records = rows.map(r => ({
    documentId: r.document_id,
    locale: r.locale,
    title: r.title,
    slug: r.slug,
    tags: parseJsonField(r.tags),
    contact: parseJsonField(r.contact),
    location: parseJsonField(r.location),
    schedule: parseJsonField(r.schedule),
    amenities: parseJsonField(r.amenities),
    recommendations: parseJsonField(r.recommendations),
  }));

  fs.writeFileSync(BACKUP_FILE, JSON.stringify(records, null, 2));
  console.log(`✅ Respaldo completado: ${records.length} registros guardados en ${BACKUP_FILE}`);
  db.close();
}

function escapePipe(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|');
}

function transformTags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (typeof item === 'string') return { label_es: item, label_en: '' };
    return { label_es: item.es || '', label_en: item.en || '' };
  });
}

function transformContact(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    whatsapp: obj.whatsapp || '',
    phone: obj.phone || '',
    email: obj.email || '',
    website: obj.website || '',
    instagram: obj.instagram || '',
    facebook: obj.facebook || '',
  };
}

function transformLocation(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let lat = obj.lat;
  let lng = obj.lng;
  if (Array.isArray(obj) && obj.length >= 2) {
    lat = obj[0]; lng = obj[1];
  }
  const locality = ['agua-verde', 'rancho-san-cosme'].includes(obj.locality) ? obj.locality : null;
  return {
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    name_es: obj.name_es || (obj.name && obj.name.es) || '',
    name_en: obj.name_en || (obj.name && obj.name.en) || '',
    locality,
    googleMapsUrl: obj.googleMapsUrl || '',
  };
}

function transformSchedule(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    isAlwaysOpen: obj.isAlwaysOpen === true,
    text_es: obj.text_es || (obj.text && obj.text.es) || '',
    text_en: obj.text_en || (obj.text && obj.text.en) || '',
  };
}

function transformAmenities(arr) {
  return transformTags(arr);
}

function arrayToTextLines(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.filter(x => typeof x === 'string').join('\n');
}

function transformRecommendations(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    bestTime_es: obj.bestTime_es || '',
    bestTime_en: obj.bestTime_en || '',
    bring_es: arrayToTextLines(obj.bring_es),
    bring_en: arrayToTextLines(obj.bring_en),
    accessibilityNotes_es: obj.accessibilityNotes_es || '',
    accessibilityNotes_en: obj.accessibilityNotes_en || '',
    connectivityNotes_es: obj.connectivityNotes_es || '',
    connectivityNotes_en: obj.connectivityNotes_en || '',
  };
}

async function fetchExisting(documentId, locale) {
  const url = `${STRAPI_URL}/api/listings/${documentId}?locale=${encodeURIComponent(locale)}&populate=*`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${STRAPI_ADMIN_TOKEN}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data || null;
}

async function phaseRestore() {
  if (!STRAPI_ADMIN_TOKEN) {
    console.error('❌ STRAPI_ADMIN_TOKEN es requerido para la fase restore');
    process.exit(1);
  }
  if (!fs.existsSync(BACKUP_FILE)) {
    console.error(`❌ Archivo de respaldo no encontrado: ${BACKUP_FILE}`);
    process.exit(1);
  }

  const records = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  console.log(`📦 Cargados ${records.length} registros del respaldo`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const rec of records) {
    const componentPayload = {};

    if (rec.tags) componentPayload.tags = transformTags(rec.tags);
    if (rec.contact) componentPayload.contact = transformContact(rec.contact);
    if (rec.location) componentPayload.location = transformLocation(rec.location);
    if (rec.schedule) componentPayload.schedule = transformSchedule(rec.schedule);
    if (rec.amenities) componentPayload.amenities = transformAmenities(rec.amenities);
    if (rec.recommendations) componentPayload.recommendations = transformRecommendations(rec.recommendations);

    if (Object.keys(componentPayload).length === 0) {
      skipped++;
      continue;
    }

    try {
      const existing = await fetchExisting(rec.documentId, rec.locale);
      const existingData = existing || {};
      delete existingData.id;
      delete existingData.documentId;
      delete existingData.createdAt;
      delete existingData.updatedAt;
      delete existingData.publishedAt;
      delete existingData.createdBy;
      delete existingData.updatedBy;
      delete existingData.locale;
      delete existingData.localizations;
      delete existingData.stories;
      delete existingData.products;
      delete existingData.social;
      const payload = {
        ...existingData,
        ...componentPayload,
      };

      if (!payload.locationURL) {
        payload.locationURL = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d14403.163961446739!2d-111.09047551279198!3d25.5120162622849!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x86b155de44ae9997%3A0xe1b49d6494f6ba5c!2s23897%20Puerto%20Agua%20Verde%2C%20B.C.S.!5e0!3m2!1ses!2smx!4v1782002747458!5e2!1ses!2smx';
      }

      const url = `${STRAPI_URL}/api/listings/${rec.documentId}?locale=${encodeURIComponent(rec.locale)}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${STRAPI_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ data: payload }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`❌ ${rec.documentId} (${rec.locale}): ${res.status} ${body.substring(0, 200)}`);
        failed++;
      } else {
        success++;
        if (success % 10 === 0) console.log(`   ${success} registros migrados...`);
      }
    } catch (err) {
      console.error(`❌ ${rec.documentId} (${rec.locale}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ Migración completada: ${success} exitosos, ${skipped} sin cambios, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

(async () => {
  if (phase === 'backup') {
    phaseBackup();
  } else if (phase === 'restore') {
    await phaseRestore();
  } else {
    console.error('Uso: node scripts/migrate-json-to-components.js --phase=backup|restore');
    process.exit(1);
  }
})();