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

// Load .env file manually (Node.js doesn't auto-load .env)
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

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
const { introData, valuesData, communityMessageData, collaborationData } =
  aboutData;
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
    method: "PUT",
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

async function strapiPut(pathname, data, locale) {
  const url = new URL(`${STRAPI_URL}/api${pathname}`);
  if (locale) url.searchParams.set("locale", locale);
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STRAPI_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PUT ${pathname} failed: ${res.status} ${body}`);
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
  ];
}

function buildFooterEntries() {
  return [
    {
      key: "footer-about",
      title: {
        es: "Puerto Agua Verde y Rancho San Cosme",
        en: "Puerto Agua Verde y Rancho San Cosme",
      },
      text: {
        es: "Guía comunitaria oficial de Puerto Agua Verde y Rancho San Cosme, Baja California Sur. Descubre, explora y vive el destino de manera responsable.",
        en: "An official community guide to Puerto Agua Verde & Rancho San Cosme, Baja California Sur. Discover, explore, and experience responsibly.",
      },
      extraData: {
        thanks: {
          es: "Gracias por visitar y por ayudar a mantener este lugar especial. Viaja con respeto, apoya lo local y deja solo huellas.",
          en: "Thank you for visiting and for helping keep this place special. Travel with care, support local, and leave only footprints.",
        },
        rights: {
          es: "Todos los derechos reservados.",
          en: "All rights reserved.",
        },
        legal: {
          es: "Aviso de Privacidad · Términos y Condiciones",
          en: "Privacy Notice · Terms & Conditions",
        },
      },
    },
    {
      key: "footer-contact",
      title: { es: "Contáctanos", en: "Contact Us" },
      extraData: {
        note: {
          es: "Para avisos sobre clima, caminos y novedades locales, síguenos en redes sociales.",
          en: "For updates on weather, road conditions, and local notices, follow our social channels.",
        },
      },
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

// ---------- homepage single type ----------

async function seedHomepage() {
  console.log("\n=== Seeding homepage ===");

  // Check if homepage already has content for any locale
  let existing;
  try {
    existing = await strapiGet("/homepage", {});
  } catch {
    existing = null;
  }

  const homepageDataEs = {
    internalLabel: "Homepage",
    hero: {
      title: "Puerto Agua Verde &",
      titleHighlight: "Rancho San Cosme",
      description:
        "Un destino natural en Baja California Sur donde la tranquilidad, la tradición y los paisajes espectaculares se encuentran con la auténtica vida costera. Explora playas, experiencias locales, senderos y servicios para planear tu visita.",
      ctaLabel: "Explorar el destino",
      ctaLink: "/sitios",
    },
    destinationsHeader: {
      title: "Conoce el destino",
      subtitle: "Descubre la historia y cultura de estos lugares únicos",
    },
    destinations: [
      {
        title: "Puerto Agua Verde",
        text: "Puerto Agua Verde es un pequeño rincón de Baja California Sur conocido por sus aguas color turquesa, su ambiente comunitario y su naturaleza intacta. Aquí se combinan la pesca tradicional, las playas tranquilas y las actividades al aire libre que atraen a viajeros en busca de autenticidad y paz.",
      },
      {
        title: "Rancho San Cosme",
        text: "Rancho San Cosme es un espacio histórico y cultural donde la vida rural se mantiene viva. Rodeado de montañas y vegetación desértica, es un punto de encuentro para visitantes que buscan experiencias locales, senderos, actividades guiadas y conexión con la naturaleza.",
      },
    ],
    highlightsHeader: {
      title: "Lo más destacado",
      subtitle: "Descubre las mejores opciones para tu visita",
    },
    highlights: [
      {
        title: "Experiencias para disfrutar",
        description:
          "Descubre actividades únicas para conectar con la naturaleza, la cultura local y la hospitalidad de la comunidad.",
        link: "/experiencias",
      },
      {
        title: "Hospédate con nosotros",
        description:
          "Encuentra opciones de alojamiento que combinan comodidad, naturaleza y una vista privilegiada del paisaje.",
        link: "/sitios?category=accommodation",
      },
      {
        title: "Sabores de la región",
        description:
          "Desde mariscos frescos hasta cocina tradicional, conoce los lugares donde podrás disfrutar la gastronomía local.",
        link: "/sitios?category=restaurants",
      },
    ],
    quickFactsHeader: {
      title: "Lo esencial de un vistazo",
      subtitle:
        "Datos rápidos para entender por qué Puerto Agua Verde y Rancho San Cosme merecen el viaje.",
    },
    quickFacts: [
      {
        title: "A ~2 horas de Loreto",
        value: "98 km",
        description:
          "Puerto Agua Verde se encuentra a unos 98 km de Loreto, con un trayecto aproximado de 2 horas en auto.",
      },
      {
        title: "A ~5 horas de La Paz",
        value: "360 km",
        description:
          "Desde La Paz, el recorrido es de alrededor de 360 km, con un tiempo estimado de casi 5 horas por carretera.",
      },
      {
        title: "Mejor época",
        value: "Mayo–junio",
        description:
          "La mejor ventana para actividades al aire libre va de principios de mayo a mediados de junio. Octubre también destaca.",
      },
      {
        title: "Naturaleza cercana",
        value: "5 islas",
        description:
          "El Parque Nacional Bahía de Loreto reúne cinco islas principales, uno de los grandes atractivos naturales de la región.",
      },
      {
        title: "Biodiversidad",
        value: "1,300+ especies",
        description:
          "En el Parque Nacional Bahía de Loreto se han registrado más de 1,300 especies de plantas y animales.",
      },
      {
        title: "Qué hacer",
        value: "Snorkel · Kayak · Hiking",
        description:
          "La región destaca por actividades como kayak, snorkel, senderismo, campamento y observación de fauna.",
      },
    ],
    mapSection: {
      title: "Mapa del Destino",
      description:
        "Explora los puntos clave de Puerto Agua Verde y Rancho San Cosme. Encuentra rutas, servicios, playas y actividades cerca de ti.",
      buttonLabel: "Ver Mapa en OpenStreetMap",
      buttonUrl:
        "https://www.openstreetmap.org/?#map=15/25.51204/-111.07577&layers=C",
    },
    finalCta: {
      title: "Tu viaje comienza aquí",
      description:
        "Puerto Agua Verde y Rancho San Cosme no son solo puntos en el mapa, son paisajes vivos de mar, desierto y tradición. Planea tu estancia, explora experiencias locales y descubre el ritmo auténtico de la vida en Baja.",
      buttonLabel: "Comenzar a planear mi visita",
      buttonLink: "/sitios",
    },
  };

  const homepageDataEn = {
    internalLabel: "Homepage",
    hero: {
      title: "Puerto Agua Verde &",
      titleHighlight: "Rancho San Cosme",
      description:
        "A natural destination in Baja California Sur where tranquility, tradition, and spectacular landscapes meet authentic coastal life. Explore beaches, local experiences, trails, and services to plan your visit.",
      ctaLabel: "Explore the destination",
      ctaLink: "/en/sitios",
    },
    destinationsHeader: {
      title: "Discover the destination",
      subtitle: "Learn about the history and culture of these unique places",
    },
    destinations: [
      {
        title: "Puerto Agua Verde",
        text: "Puerto Agua Verde is a small corner of Baja California Sur known for its turquoise waters, community atmosphere, and untouched nature. Here, traditional fishing, quiet beaches, and outdoor activities combine to attract travelers in search of authenticity and peace.",
      },
      {
        title: "Rancho San Cosme",
        text: "Rancho San Cosme is a historical and cultural space where rural life remains alive. Surrounded by mountains and desert vegetation, it is a meeting point for visitors seeking local experiences, trails, guided activities, and connection with nature.",
      },
    ],
    highlightsHeader: {
      title: "Highlights",
      subtitle: "Discover the best options for your visit",
    },
    highlights: [
      {
        title: "Experiences to enjoy",
        description:
          "Discover unique activities to connect with nature, local culture, and community hospitality.",
        link: "/en/experiences",
      },
      {
        title: "Stay with us",
        description:
          "Find accommodation options that combine comfort, nature, and a privileged view of the landscape.",
        link: "/en/sitios?category=accommodation",
      },
      {
        title: "Flavors of the region",
        description:
          "From fresh seafood to traditional cuisine, discover the places where you can enjoy local gastronomy.",
        link: "/en/sitios?category=restaurants",
      },
    ],
    quickFactsHeader: {
      title: "At a glance",
      subtitle:
        "A few facts that make Puerto Agua Verde & Rancho San Cosme worth the trip.",
    },
    quickFacts: [
      {
        title: "~2 hours from Loreto",
        value: "98 km",
        description:
          "Puerto Agua Verde is about 98 km from Loreto, with a driving time of roughly 2 hours.",
      },
      {
        title: "~5 hours from La Paz",
        value: "360 km",
        description:
          "From La Paz, the route is about 360 km, with an estimated drive of around 5 hours.",
      },
      {
        title: "Best season",
        value: "May–June",
        description:
          "The best window for outdoor activities runs from early May to mid-June. October is also a strong option.",
      },
      {
        title: "Protected nature nearby",
        value: "5 islands",
        description:
          "Loreto Bay National Park includes five major islands, one of the region's standout natural treasures.",
      },
      {
        title: "Biodiversity",
        value: "1,300+ species",
        description:
          "More than 1,300 plant and animal species have been recorded in Loreto Bay National Park.",
      },
      {
        title: "What to do",
        value: "Snorkel · Kayak · Hiking",
        description:
          "The area is ideal for kayaking, snorkeling, hiking, camping, and wildlife-focused activities.",
      },
    ],
    mapSection: {
      title: "Destination Map",
      description:
        "Explore key points of Puerto Agua Verde and Rancho San Cosme. Find routes, services, beaches, and activities near you.",
      buttonLabel: "View Map on OpenStreetMap",
      buttonUrl:
        "https://www.openstreetmap.org/?#map=15/25.51204/-111.07577&layers=C",
    },
    finalCta: {
      title: "Your journey begins here",
      description:
        "Puerto Agua Verde and Rancho San Cosme are more than places on the map, they are living landscapes of sea, desert, and tradition. Plan your stay, explore local experiences, and discover the rhythm of authentic Baja life.",
      buttonLabel: "Start planning your visit",
      buttonLink: "/en/sitios",
    },
  };

  // Single type: POST to create, PUT to update. Check existence first.
  // Note: strapiGet throws on 404, but for empty singleTypes 404 means "no entry yet"
  let existingHomepage = null;
  try {
    existingHomepage = await strapiGet("/homepage", {});
  } catch (err) {
    if (!err.message.includes("404")) throw err;
  }
  if (existingHomepage && existingHomepage.id) {
    console.log("  homepage entry exists, updating (es)...");
    await strapiPut("/homepage", homepageDataEs, "es");
    await strapiPut("/homepage", homepageDataEn, "en");
    console.log("  + updated homepage (es + en)");
  } else {
    console.log("  creating homepage entry (es)...");
    await strapiPost("/homepage", homepageDataEs, "es");
    console.log("  creating homepage entry (en)...");
    await strapiPost("/homepage", homepageDataEn, "en");
    console.log("  + created homepage (es + en)");
  }
}

// ---------- run ----------

(async () => {
  try {
    await seedCategories();
    await seedListings();
    await seedSiteContent(buildAboutEntries());
    await seedSiteContent(buildFooterEntries());
    await seedSiteContent(buildGuideEntries());
    await seedHomepage();
    console.log("\nSeed complete.");
  } catch (e) {
    console.error("Seed failed:", e);
    process.exit(1);
  }
})();
