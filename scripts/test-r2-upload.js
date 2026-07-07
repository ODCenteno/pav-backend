#!/usr/bin/env node
/**
 * R2 upload end-to-end test.
 *
 * Verifies that:
 *   1. A small WebP image can be uploaded to Strapi
 *   2. The returned URL points to the R2 public base URL
 *   3. The URL is publicly accessible (HTTP GET returns 200 + image content-type)
 *   4. The image can be attached to a new listing as mainImage
 *   5. Reading the listing back returns the same R2 URL on mainImage
 *   6. The listing and uploaded file can be cleaned up
 *
 * Prerequisites:
 *   - Strapi running on $STRAPI_URL (default http://localhost:1337)
 *   - $STRAPI_ADMIN_TOKEN set to a token with create/delete on listings + upload
 *   - R2 credentials in .env (R2_ENDPOINT, R2_BUCKET, R2_PUBLIC_BASE_URL)
 *
 * Usage:
 *   node scripts/test-r2-upload.js
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

const STRAPI_URL = (process.env.STRAPI_URL || 'http://localhost:1337').replace(/\/$/, '');
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN || '';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error('❌ ' + msg);
    process.exit(1);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${STRAPI_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${STRAPI_ADMIN_TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function makeTestWebp() {
  // 1x1 transparent WebP, 26 bytes
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
    0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0x08,
  ]);
}

async function main() {
  console.log('\n🧪 Prueba de subida a R2\n');
  assert(STRAPI_ADMIN_TOKEN, 'STRAPI_ADMIN_TOKEN es requerido');
  assert(R2_PUBLIC_BASE_URL, 'R2_PUBLIC_BASE_URL debe estar definido en .env');

  const buf = makeTestWebp();
  const form = new FormData();
  form.append('files', new Blob([buf], { type: 'image/webp' }), 'r2-test.webp');
  form.append('fileInfo', JSON.stringify({ name: 'r2-test', alternativeText: 'R2 test image', caption: 'Automated test' }));

  console.log('1️⃣  Subiendo imagen a /api/upload…');
  const uploadRes = await api('/api/upload', { method: 'POST', body: form });
  assert(uploadRes.ok, `Upload falló: ${uploadRes.status} ${uploadRes.text?.substring(0, 200)}`);

  const uploaded = Array.isArray(uploadRes.json) ? uploadRes.json[0] : uploadRes.json?.[0];
  assert(uploaded?.id, 'Upload no devolvió un archivo con id');
  const fileId = uploaded.id;
  const fileUrl = uploaded.url || '';

  check('Upload devuelve un archivo con id', !!fileId, `id=${fileId}`);
  check('Upload devuelve una URL', !!fileUrl, `url=${fileUrl}`);
  check(
    `URL apunta a R2 (${R2_PUBLIC_BASE_URL})`,
    fileUrl.startsWith(R2_PUBLIC_BASE_URL),
    fileUrl,
  );

  console.log('\n2️⃣  Verificando acceso público a la URL…');
  try {
    const headRes = await fetch(fileUrl, { method: 'HEAD' });
    check('GET/HEAD de la URL devuelve 200', headRes.ok, `status=${headRes.status}`);
    const ct = headRes.headers.get('content-type') || '';
    check('Content-Type es imagen', ct.startsWith('image/'), `content-type=${ct}`);
  } catch (err) {
    check('GET/HEAD de la URL', false, err.message);
  }

  console.log('\n3️⃣  Creando listing de prueba con mainImage…');
  const uniq = Date.now();
  const createRes = await api('/api/listings?locale=es', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: `R2 Test ${uniq}`,
        slug: `r2-test-${uniq}`,
        locationURL: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d14403.163961446739!2d-111.09047551279198!3d25.5120162622849!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x86b155de44ae9997%3A0xe1b49d6494f6ba5c!2s23897%20Puerto%20Agua%20Verde%2C%20B.C.S.!5e0!3m2!1ses!2smx!4v1782002747458!5e2!1ses!2smx',
        mainImage: fileId,
        tags: [{ label_es: 'Test', label_en: '' }],
        contact: { whatsapp: '+521234567890' },
        schedule: { isAlwaysOpen: false, text_es: 'Test schedule', text_en: 'Test schedule' },
        amenities: [{ label_es: 'Test amenity', label_en: '' }],
      },
    }),
  });
  assert(createRes.ok, `Creación de listing falló: ${createRes.status} ${createRes.text?.substring(0, 200)}`);
  const listing = createRes.json?.data;
  const listingId = listing?.documentId;
  check('Listing creado con documentId', !!listingId, `documentId=${listingId}`);

  console.log('\n4️⃣  Leyendo listing con populate[mainImage]=*…');
  const readRes = await api(
    `/api/listings/${listingId}?locale=es&populate[mainImage][populate]=*`,
  );
  assert(readRes.ok, `Lectura falló: ${readRes.status} ${readRes.text?.substring(0, 200)}`);
  const mainImage = readRes.json?.data?.mainImage;
  const mainImageUrl = mainImage?.url || '';
  check('mainImage presente', !!mainImage, `id=${mainImage?.id}`);
  check(
    `mainImage.url apunta a R2`,
    mainImageUrl.startsWith(R2_PUBLIC_BASE_URL),
    mainImageUrl,
  );
  check(
    'mainImage.url coincide con la URL del upload',
    mainImageUrl === fileUrl,
    `${mainImageUrl} vs ${fileUrl}`,
  );

  console.log('\n5️⃣  Limpiando…');
  const delListing = await api(`/api/listings/${listingId}?locale=es`, { method: 'DELETE' });
  check('Listing eliminado', delListing.ok, `status=${delListing.status}`);

  const delFile = await api(`/api/upload/files/${fileId}`, { method: 'DELETE' });
  check('Archivo eliminado', delFile.ok, `status=${delFile.status}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length === 0 ? '🎉' : '⚠️'}  Resultado: ${results.length - failed.length}/${results.length} verificaciones pasaron`);
  if (failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});