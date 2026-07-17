#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', '.tmp', 'data.db');
const outputPath = path.join(__dirname, 'location-backup.json');

const db = new Database(dbPath, Database.OPEN_READONLY);

const rows = db.prepare(`
  SELECT
    l.id,
    l.lat,
    l.lng,
    l.name_es,
    l.name_en,
    l.locality,
    l.google_maps_url
  FROM components_location_geo_points l
  ORDER BY l.id ASC
`).all();

db.close();

const data = rows.map(row => ({
  id: row.id,
  lat: row.lat,
  lng: row.lng,
  name_es: row.name_es || '',
  name_en: row.name_en || '',
  locality: row.locality || '',
  googleMapsUrl: row.google_maps_url || '',
}));

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');

console.log(`✅ Backed up ${data.length} location records to ${outputPath}`);
console.log(`   Sample record:`, JSON.stringify(data[0], null, 2));
