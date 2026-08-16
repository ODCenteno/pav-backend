#!/usr/bin/env node
/**
 * Community data importer for PAV (CommonJS).
 *
 * Loads real community-enterprise data from the RSC spreadsheet export into
 * Strapi: community-member (people) + listing (ventures), with stories,
 * products, social links and member↔listing relations.
 *
 * Run AFTER `npm run develop` is up:
 *   STRAPI_URL=http://localhost:1337 \
 *   STRAPI_ADMIN_TOKEN=<admin-jwt-or-rw-api-token> \
 *   COMMUNITY_CSV="/abs/path/to/Información RSC - PAV para materiales.xlsx - ASISTENTES.csv" \
 *   npm run import:community
 *
 * - Idempotent: skips members/listings whose slug already exists. Safe to re-run.
 * - Creates entries in the default locale (es-MX) only. The CSV source is
 *   Spanish; English localizations should be added via the admin panel.
 * - Splits multi-venture rows into individual listings and links every person
 *   in a row to every venture in the same row.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("csv-parse/sync");

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN || "";

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../Documentacion/Contenido/Información RSC - PAV para materiales.xlsx - ASISTENTES.csv",
);
const CSV_PATH = process.env.COMMUNITY_CSV || DEFAULT_CSV;

if (!STRAPI_ADMIN_TOKEN) {
  console.error(
    "STRAPI_ADMIN_TOKEN is required (an admin JWT or a token with create/update permissions).",
  );
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV not found: ${CSV_PATH}`);
  console.error("Set COMMUNITY_CSV to the absolute path of the export CSV.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// strapi helpers
// ---------------------------------------------------------------------------

async function apiRequest(method, pathname, { params, body } = {}) {
  const url = new URL(`${STRAPI_URL}/api${pathname}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STRAPI_ADMIN_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${pathname} -> ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.data;
}

const findList = (plural, filters) =>
  apiRequest("GET", `/${plural}`, {
    params: { "pagination[pageSize]": "100", ...filters },
  });

const findOneBySlug = async (plural, slug) => {
  const rows = await findList(plural, { "filters[slug][$eq]": slug });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
};

async function createEntry(plural, data) {
  return apiRequest("POST", `/${plural}`, {
    body: { data: { ...data, publishedAt: new Date().toISOString() } },
  });
}

async function updateEntry(plural, documentId, data) {
  return apiRequest("PUT", `/${plural}/${documentId}`, { body: { data } });
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const splitLines = (s) =>
  (s || "")
    .split(/\r?\n/)
    .map((x) => x.replace(/^["']|["']$/g, "").trim())
    .filter((x) => x.length > 0 && x !== "-");

const firstYear = (s) => {
  const m = (s || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
};

const extractQuote = (s) => {
  if (!s) return null;
  const m = s.match(/"([^"]{12,220})"/);
  if (m) return m[1].trim();
  const sentences = s.split(/(?<=[.!?])\s+/).filter((x) => x.length > 25);
  return sentences.length ? sentences[sentences.length - 1].trim() : null;
};

// Split a description into numbered sections (e.g. "1. Title\n...").
function splitNumberedSections(text) {
  if (!text) return [];
  const re = /(?:^|\n)\s*\d+\.\s+([^\n]+)\n([\s\S]*?)(?=\n\s*\d+\.\s+|$)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ title: m[1].trim(), body: m[2].trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// category inference
// ---------------------------------------------------------------------------

const CATEGORY_MAP = [
  { slug: "restaurants", keywords: ["restaurante", "faro", "alimento", "comida", "botana", "gastronom"] },
  { slug: "accommodation", keywords: ["hospedaje", "caba", "cabana", "bus ", "hotel", "alojamiento", "habitacion"] },
  { slug: "experiences", keywords: ["tour", "mula", "cabalgata", "experiencia", "guia", "guía", "senderismo"] },
  { slug: "sites", keywords: ["museo", "artesania", "artesanía", "joya", "joyas", "concha", "taller"] },
];

function inferCategorySlug(ventureName, typeStr) {
  const hay = `${ventureName} ${typeStr}`.toLowerCase();
  for (const c of CATEGORY_MAP) {
    if (c.keywords.some((k) => hay.includes(k))) return c.slug;
  }
  return "services";
}

const LOCALITY_MAP = {
  "puerto agua verde": "agua-verde",
  "agua verde": "agua-verde",
  "rancho san cosme": "rancho-san-cosme",
  "san cosme": "rancho-san-cosme",
};

function inferLocality(raw) {
  const key = (raw || "").trim().toLowerCase();
  for (const [k, v] of Object.entries(LOCALITY_MAP)) {
    if (key.includes(k)) return v;
  }
  return "agua-verde";
}

// ---------------------------------------------------------------------------
// social / phone parsing
// ---------------------------------------------------------------------------

/**
 * Builds the `contact.contact-info` component payload used by both
 * community-members and listings (the old top-level phone/whatsapp/social
 * attributes were removed from the schemas).
 */
function buildContactInfo(row, phone, whatsapp) {
  const clean = (v) => {
    const t = (v || "").trim();
    return t && t !== "-" && t !== "Facebook" ? t : undefined;
  };
  const other = clean(row["Otro medio de contacto"]);
  const contact = {
    phone: phone || undefined,
    whatsapp: whatsapp || undefined,
    instagram: clean(row["Instagram"]),
    facebook: clean(row["Facebook"]),
    tiktok: clean(row["Tik tok"]),
    website: other && other.startsWith("http") ? other : undefined,
  };
  Object.keys(contact).forEach((k) => contact[k] === undefined && delete contact[k]);
  return Object.keys(contact).length ? contact : undefined;
}

function parsePhone(raw) {
  if (!raw) return { phone: undefined, whatsapp: undefined };
  const digits = (raw.match(/\d[\d\s().-]{6,}\d/) || [])[0];
  return { phone: (digits || raw).trim(), whatsapp: (digits || raw).trim() };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nCSV:        ${CSV_PATH}`);
  console.log(`Strapi URL: ${STRAPI_URL}\n`);

  const csv = fs.readFileSync(CSV_PATH, "utf8");
  const records = parse(csv, {
    columns: (h) => h.map((c) => (c || "").trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  // drop header-ish rows (those whose first cell is the literal header)
  const dataRows = records.filter(
    (r) => !/^Localidad/i.test(r["Localidad / Ubicación"] || "") && (r["Localidad / Ubicación"] || "").trim(),
  );
  console.log(`Parsed ${dataRows.length} data rows.\n`);

  // resolve categories (already seeded) -> slug : documentId
  const cats = await findList("/categories", {});
  const categoryBySlug = {};
  for (const c of cats || []) {
    const slug = c.slug || c.attributes?.slug;
    if (slug && !categoryBySlug[slug]) categoryBySlug[slug] = c.documentId || c.id;
  }
  console.log(`Resolved categories: ${Object.keys(categoryBySlug).join(", ")}\n`);

  // ----- pass 1: community members -----
  console.log("=== Community members ===");
  const memberBySlug = {}; // slug -> documentId
  const rowMembers = []; // { rowIndex, slugs: [..] } to wire listings later

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const locality = inferLocality(row["Localidad / Ubicación"]);
    const names = splitLines(row["Nombre de la persona / Tentativos"]);
    const { phone, whatsapp } = parsePhone(row["Teléfono / Whatsapp"]);
    const contact = buildContactInfo(row, phone, whatsapp);
    const slugs = [];

    for (const name of names) {
      const cleanName = name.replace(/^["']+|["']+$/g, "").trim();
      if (!cleanName) continue;
      const slug = slugify(cleanName);
      if (!slug) continue;
      slugs.push(slug);

      if (memberBySlug[slug]) continue;
      const existing = await findOneBySlug("/community-members", slug);
      if (existing) {
        memberBySlug[slug] = existing.documentId || existing.id;
        console.log(`  skip: member ${slug} exists`);
        continue;
      }

      const created = await createEntry("/community-members", {
        name: cleanName,
        slug,
        locality,
        contact,
      });
      memberBySlug[slug] = created.documentId || created.id;
      console.log(`  + member ${slug}`);
    }
    rowMembers.push({ rowIndex: i, locality, slugs });
  }

  // ----- pass 2: listings (ventures) -----
  console.log("\n=== Listings (ventures) ===");
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const typeStr = row["Tipo de emprendimiento"] || "";
    const ventures = splitLines(row["Nombre del emprendimiento"]);
    const fullDesc = (row["Descripción básica"] || "").trim();
    const sections = splitNumberedSections(fullDesc);
    const productLines = splitLines(row["Productos"]).map((p) => p.replace(/[)\s]+[A-Za-z]$/, "").trim());
    const memberNames = splitLines(row["Nombre de la persona / Tentativos"]);
    const memberDocIds = (rowMembers[i]?.slugs || [])
      .map((s) => memberBySlug[s])
      .filter(Boolean);
    const { phone, whatsapp } = parsePhone(row["Teléfono / Whatsapp"]);
    const contact = buildContactInfo(row, phone, whatsapp);

    for (let v = 0; v < ventures.length; v++) {
      const venture = ventures[v].replace(/^["']+|["']+$/g, "").trim();
      const slug = slugify(venture);
      if (!slug) continue;

      const existing = await findOneBySlug("/listings", slug);
      if (existing) {
        console.log(`  skip: listing ${slug} exists`);
        continue;
      }

      // pick the description section that best matches this venture
      const matched = sections.find((sec) => {
        const t = sec.title.toLowerCase();
        const hay = venture.toLowerCase();
        return (
          t.includes("artesania") && hay.includes("artesania") ||
          t.includes("museo") && hay.includes("museo") ||
          t.includes("restaurante") && (hay.includes("restaurante") || hay.includes("arriero")) ||
          t.includes("tour") && (hay.includes("tour") || hay.includes("mula")) ||
          t.includes("hospedaje") && hay.includes("hospedaje")
        );
      });
      const narrative = matched ? matched.body : (ventures.length === 1 ? fullDesc : null);
      const era = firstYear(narrative || fullDesc);
      const quote = extractQuote(narrative || fullDesc);

      const stories = narrative
        ? [
            {
              title: matched ? matched.title : "Historia",
              narrative,
              highlightQuote: quote,
              era: era || undefined,
              theme: "origin",
              storyteller: memberNames[0] || undefined,
            },
          ]
        : [];

      const products = productLines.map((p) => ({ name: p }));

      const data = {
        title: venture,
        slug,
        shortDescription: narrative ? narrative.slice(0, 180).replace(/\s+/g, " ").trim() : undefined,
        description: venture,
        category: inferCategorySlug(venture, typeStr)
          ? categoryBySlug[inferCategorySlug(venture, typeStr)]
          : undefined,
        members: memberDocIds,
        stories,
        products,
        contact,
      };
      // drop undefined values
      Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

      await createEntry("/listings", data);
      console.log(`  + listing ${slug} (cat: ${inferCategorySlug(venture, typeStr)})`);
    }
  }

  // ----- pass 3: family / co-venture relations -----
  console.log("\n=== Member relations (co-venture / family) ===");
  for (const rm of rowMembers) {
    if (rm.slugs.length < 2) continue;
    const docIds = rm.slugs.map((s) => memberBySlug[s]).filter(Boolean);
    for (const slug of rm.slugs) {
      const docId = memberBySlug[slug];
      if (!docId) continue;
      const others = docIds.filter((id) => id !== docId);
      if (!others.length) continue;
      try {
        await updateEntry("/community-members", docId, { relatedMembers: others });
        console.log(`  ~ linked ${slug} -> ${others.length} relative(s)`);
      } catch (e) {
        console.warn(`  ! could not link ${slug}: ${e.message}`);
      }
    }
  }

  console.log("\nImport complete.");
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
