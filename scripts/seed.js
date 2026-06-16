#!/usr/bin/env node
/**
 * Strapi seed script (CommonJS).
 *
 * Run AFTER `npm run develop` is up:
 *   STRAPI_URL=http://localhost:1337 \
 *   STRAPI_ADMIN_TOKEN=<admin-jwt-or-rw-api-token> \
 *   node scripts/seed.js
 *
 * Idempotent: skips categories/listings/site-content entries whose key/slug
 * already exists. Safe to re-run.
 *
 * Sources:
 *   - pav-frontend/src/data/categoryData.js  -> categories + listings
 *   - pav-frontend/src/data/aboutData.js     -> site-content (about-*)
 *   - pav-frontend/src/data/guideData.js     -> site-content (guide-*)
 */

const fs = require("node:fs");
const path = require("node:path");

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN || "";

if (!STRAPI_ADMIN_TOKEN) {
  console.error(
    "STRAPI_ADMIN_TOKEN is required (an admin JWT or a token with create/update on the content types).",
  );
  process.exit(1);
}

const FE_PATH = path.resolve(__dirname, "../../pav-frontend/src/data");

if (!fs.existsSync(FE_PATH)) {
  console.error(`Frontend data path not found: ${FE_PATH}`);
  console.error("Please ensure pav-frontend exists at the expected location.");
  process.exit(1);
}

const categoryDataRaw = fs.readFileSync(
  path.join(FE_PATH, "categoryData.js"),
  "utf8",
);
const aboutDataRaw = fs.readFileSync(
  path.join(FE_PATH, "aboutData.js"),
  "utf8",
);
const guideDataRaw = fs.readFileSync(
  path.join(FE_PATH, "guideData.js"),
  "utf8",
);

// Strip ESM `export` keywords so the file can be `eval`d in a CJS context.
function toCjs(source) {
  return source
    .replace(/^export\s+const\s+(\w+)\s*=/gm, "module.exports.$1 =")
    .replace(/^export\s+let\s+(\w+)\s*=/gm, "module.exports.$1 =")
    .replace(/^export\s+var\s+(\w+)\s*=/gm, "module.exports.$1 =")
    .replace(/^export\s+default\s+/gm, "module.exports.default =")
    .replace(/^export\s+/gm, "");
}

function loadModule(source) {
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function("module", "exports", toCjs(source));
  fn(m, m.exports);
  return m.exports;
}

const categoryData = loadModule(categoryDataRaw);
const aboutData = loadModule(aboutDataRaw);
const guideData = loadModule(guideDataRaw);

const listings = categoryData.categoryData;
const {
  introData,
  valuesData,
  communityMessageData,
  collaborationData,
} = aboutData;
const {
  heroData,
  introData: guideIntro,
  historyData,
  fishingData,
  protectedAreaData,
  influenceData,
  recommendationsData,
  directionsData,
  amenitiesData,
  touristMapData,
  ctaData,
} = guideData;

// ---------- helpers ----------

async function strapiGet(pathname, params) {
  const url = new URL(`${STRAPI_URL}/api${pathname}`);
  if (params)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${STRAPI_ADMIN_TOKEN}` },
  });
  if (!res.ok)
    throw new Error(
      `GET ${pathname} failed: ${res.status} ${await res.text()}`,
    );
  const json = await res.json();
  return json.data || [];
}

async function strapiPost(pathname, data, locale) {
  const url = new URL(`${STRAPI_URL}/api${pathname}`);
  if (locale) url.searchParams.set("locale", locale);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STRAPI_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${pathname} failed: ${res.status} ${body}`);
  }
  return res.json();
}

// ---------- categories ----------

const CATEGORIES = [
  {
    slug: "experiences",
    icon: "adventure",
    color: "#E87A5D",
    order: 1,
    es: "Experiencias",
    en: "Experiences",
  },
  {
    slug: "accommodation",
    icon: "home",
    color: "#4A90E2",
    order: 2,
    es: "Hospedaje",
    en: "Accommodation",
  },
  {
    slug: "restaurants",
    icon: "restaurant",
    color: "#F5A623",
    order: 3,
    es: "Restaurantes",
    en: "Restaurants",
  },
  {
    slug: "sites",
    icon: "location",
    color: "#7ED321",
    order: 4,
    es: "Sitios",
    en: "Sites",
  },
  {
    slug: "services",
    icon: "service",
    color: "#9013FE",
    order: 5,
    es: "Servicios",
    en: "Services",
  },
];

async function seedCategories() {
  console.log("\n=== Seeding categories ===");
  for (const cat of CATEGORIES) {
    const existing = await strapiGet("/categories", {
      "filters[slug][$eq]": cat.slug,
    });
    if (existing.length > 0) {
      console.log(`  skip: category ${cat.slug} exists`);
      continue;
    }
    for (const loc of ["es", "en"]) {
      await strapiPost(
        "/categories",
        {
          name: cat[loc],
          slug: cat.slug,
          icon: cat.icon,
          color: cat.color,
          order: cat.order,
          isActive: true,
        },
        loc,
      );
    }
    console.log(`  + created category ${cat.slug}`);
  }
}

async function getCategoryMap() {
  const cats = await strapiGet("/categories", {
    "pagination[pageSize]": "100",
  });
  const map = {};
  for (const c of cats) {
    const slug = c.attributes?.slug || c.slug;
    if (slug) map[slug] = c.id;
  }
  return map;
}

// ---------- listings ----------

async function seedListings() {
  console.log("\n=== Seeding listings ===");
  const categoryMap = await getCategoryMap();
  for (const item of listings) {
    const slug = item.slug;
    const existing = await strapiGet("/listings", {
      "filters[slug][$eq]": slug,
    });
    if (existing.length > 0) {
      console.log(`  skip: listing ${slug} exists`);
      continue;
    }
    for (const loc of ["es", "en"]) {
      const title = item[`name_${loc}`] || item.name_es;
      const shortDescription =
        item[`short_desc_${loc}`] || (item.description_es || "").slice(0, 200);
      const description =
        item[`long_desc_${loc}`] ||
        item[`description_${loc}`] ||
        item.description_es;
      const tags = (item[`tags_${loc}`] || []).filter(Boolean);
      const amenities = (item[`amenities_${loc}`] || []).filter(Boolean);

      const data = {
        title,
        slug,
        shortDescription,
        description,
        price: item.price,
        isFeatured: !!item.isFeatured,
        order: item.order || 0,
        category: categoryMap[item.categoryId] || undefined,
        tags,
        contact: item.contact,
        location: item.location,
        schedule: item.schedule,
        amenities,
        recommendations: item.recommendations,
        publishedAt: new Date().toISOString(),
      };
      await strapiPost("/listings", data, loc);
    }
    console.log(`  + created listing ${slug}`);
  }
}

// ---------- site-content ----------

async function seedSiteContent(entries) {
  console.log(`\n=== Seeding site-content (${entries.length} entries) ===`);
  for (const entry of entries) {
    const existing = await strapiGet("/site-contents", {
      "filters[key][$eq]": entry.key,
    });
    if (existing.length > 0) {
      console.log(`  skip: ${entry.key} exists`);
      continue;
    }
    for (const loc of ["es", "en"]) {
      const data = {
        key: entry.key,
        order: entry.order || 0,
        title: entry.title?.[loc] || "",
        text: entry.text?.[loc] || "",
      };
      if (entry.extraData) data.extraData = entry.extraData;
      await strapiPost("/site-contents", data, loc);
    }
    console.log(`  + created ${entry.key}`);
  }
}

function buildAboutEntries() {
  return [
    {
      key: "about-intro",
      title: { es: introData?.title, en: introData?.title },
      text: { es: introData?.text, en: introData?.text },
    },
    {
      key: "about-values",
      title: { es: "Valores", en: "Values" },
      text: { es: "", en: "" },
      extraData: valuesData,
    },
    {
      key: "about-community",
      title: {
        es: communityMessageData?.title,
        en: communityMessageData?.title,
      },
      text: { es: communityMessageData?.text, en: communityMessageData?.text },
    },
    {
      key: "about-collaboration",
      title: { es: collaborationData?.title, en: collaborationData?.title },
      text: { es: collaborationData?.desc, en: collaborationData?.desc },
      extraData: {
        btnPrimary: collaborationData?.btnPrimary,
        btnSecondary: collaborationData?.btnSecondary,
        links: collaborationData?.links,
      },
    },
    {
      key: "homepage-hero",
      title: { es: "Hero del Home", en: "Home Hero" },
      text: { es: "", en: "" },
    },
  ];
}

function buildGuideEntries() {
  return [
    {
      key: "guide-hero",
      title: { es: heroData?.title?.es, en: heroData?.title?.en },
      text: { es: heroData?.desc?.es, en: heroData?.desc?.en },
      extraData: { image: heroData?.image },
    },
    {
      key: "guide-bay",
      title: { es: "Bahía", en: "Bay" },
      text: { es: "", en: "" },
      extraData: guideIntro,
    },
    {
      key: "guide-history",
      title: { es: historyData?.title?.es, en: historyData?.title?.en },
      text: { es: historyData?.text?.es, en: historyData?.text?.en },
      extraData: { milestones: historyData?.milestones },
    },
    {
      key: "guide-fishing",
      title: { es: fishingData?.title?.es, en: fishingData?.title?.en },
      text: { es: fishingData?.text?.es, en: fishingData?.text?.en },
      extraData: { rules: fishingData?.rules },
    },
    {
      key: "guide-conap",
      title: {
        es: protectedAreaData?.title?.es,
        en: protectedAreaData?.title?.en,
      },
      text: {
        es: protectedAreaData?.text?.es,
        en: protectedAreaData?.text?.en,
      },
      extraData: { link: protectedAreaData?.link },
    },
    {
      key: "guide-influence",
      title: { es: influenceData?.title?.es, en: influenceData?.title?.en },
      text: { es: influenceData?.text?.es, en: influenceData?.text?.en },
    },
    {
      key: "guide-recommendations",
      title: {
        es: recommendationsData?.title?.es,
        en: recommendationsData?.title?.en,
      },
      text: { es: "", en: "" },
      extraData: { items: recommendationsData?.items },
    },
    {
      key: "guide-directions",
      title: { es: directionsData?.title?.es, en: directionsData?.title?.en },
      text: { es: "", en: "" },
      extraData: {
        loreto: directionsData?.loreto,
        laPaz: directionsData?.laPaz,
        drivingTipsTitle: directionsData?.drivingTipsTitle,
        drivingTips: directionsData?.drivingTips,
      },
    },
    {
      key: "guide-amenities",
      title: { es: amenitiesData?.title?.es, en: amenitiesData?.title?.en },
      text: { es: "", en: "" },
      extraData: { items: amenitiesData?.items },
    },
    {
      key: "guide-tourist-map",
      title: { es: touristMapData?.title?.es, en: touristMapData?.title?.en },
      text: {
        es: touristMapData?.caption?.es,
        en: touristMapData?.caption?.en,
      },
      extraData: { image: touristMapData?.image },
    },
    {
      key: "guide-cta",
      title: { es: ctaData?.title?.es, en: ctaData?.title?.en },
      text: { es: ctaData?.desc?.es, en: ctaData?.desc?.en },
      extraData: { btn: ctaData?.btn },
    },
  ];
}

// ---------- run ----------

(async () => {
  try {
    await seedCategories();
    await seedListings();
    await seedSiteContent(buildAboutEntries());
    await seedSiteContent(buildGuideEntries());
    console.log("\nSeed complete.");
  } catch (e) {
    console.error("Seed failed:", e);
    process.exit(1);
  }
})();
