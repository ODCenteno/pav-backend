/**
 * generate-secrets.ts
 *
 * Generates cryptographically random secrets for Strapi production.
 * Run locally, then paste the output into your hosting provider's
 * environment variable dashboard (e.g. Koyeb).
 *
 * Usage:
 *   npx tsx scripts/generate-secrets.ts
 */

import { randomBytes } from 'node:crypto';

const b64 = () => randomBytes(32).toString('base64');
const hex = () => randomBytes(32).toString('hex');

const secrets = {
  APP_KEYS: `${b64()},${b64()}`,
  ADMIN_JWT_SECRET: b64(),
  API_TOKEN_SALT: b64(),
  TRANSFER_TOKEN_SALT: b64(),
  JWT_SECRET: b64(),
  ENCRYPTION_KEY: b64(),
  WEBHOOK_SECRET: hex(),
};

console.log('='.repeat(60));
console.log('  Production Secrets — copy to Koyeb dashboard');
console.log('  Mark each as SECRET type where applicable');
console.log('='.repeat(60));

for (const [key, value] of Object.entries(secrets)) {
  console.log(`${key}=${value}`);
}

console.log('='.repeat(60));
console.log('  Also set these non-secret env vars (not generated):');
console.log('='.repeat(60));
console.log('NODE_ENV=production');
console.log('HOST=0.0.0.0');
console.log('PORT=1337');
console.log('IS_BEHIND_PROXY=true');
console.log('STRAPI_TELEMETRY_DISABLED=true');
console.log('NODE_OPTIONS=--max-old-space-size=768');
