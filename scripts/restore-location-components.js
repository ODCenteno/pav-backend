#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', '.tmp', 'data.db');
const backupPath = path.join(__dirname, 'location-backup.json');

if (!fs.existsSync(backupPath)) {
  console.error(`❌ Backup file not found: ${backupPath}`);
  console.error('   Run `node scripts/backup-location-components.js` first.');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
console.log(`📋 Loaded ${backup.length} backup records`);

const db = new Database(dbPath);

let updated = 0;
let skipped = 0;

const updateStmt = db.prepare(`
  UPDATE components_location_geo_points
  SET geo_point = ?
  WHERE id = ?
`);

const transaction = db.transaction(() => {
  for (const row of backup) {
    if (row.lat == null || row.lng == null) {
      console.warn(`   ⚠️  Skipping id=${row.id}: lat or lng is null`);
      skipped++;
      continue;
    }

    const geoPoint = JSON.stringify({ lat: row.lat, lng: row.lng });
    updateStmt.run(geoPoint, row.id);
    updated++;
    console.log(`   ✅ id=${row.id}: geoPoint=${geoPoint}`);
  }
});

transaction();

db.close();

console.log(`\n✅ Migration complete: ${updated} updated, ${skipped} skipped`);
