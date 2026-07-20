#!/usr/bin/env node
/**
 * Listings importer for PAV (CommonJS).
 *
 * Creates listings + community-member profiles from the RSC spreadsheet export.
 * Uses the Strapi content-manager API (admin JWT) so it can write to all
 * collections regardless of API-token scopes.
 *
 * Run AFTER `npm run develop` is up:
 *   STRAPI_URL=http://localhost:1337 \
 *   ADMIN_EMAIL=admin@pav.com \
 *   ADMIN_PASSWORD=Admin1234 \
 *   node scripts/import-csv-listings.js
 *
 * - Idempotent: skips listings/members whose slug already exists.
 * - Splits multi-venture rows from the CSV into individual listings.
 * - Reuses existing R2 media (ids 22-33) for hero + gallery.
 * - Creates both Spanish (es) and English (en) localizations via the
 *   content-manager collection-types endpoint.
 */

const fs = require("node:fs");
const path = require("node:path");

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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@pav.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin1234";

// ---------------------------------------------------------------------------
// admin auth
// ---------------------------------------------------------------------------

let JWT = null;

async function loginAdmin() {
  const res = await fetch(`${STRAPI_URL}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin login failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  JWT = json.data?.token;
  return JWT;
}

async function fetchWithRetry(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const wait = Math.min(1000 * 2 ** i, 30000);
    console.warn(`  429 on ${url.slice(0, 80)}… retrying in ${wait}ms (${i + 1}/${retries})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return fetch(url, opts);
}

async function cm(method, uid, body) {
  if (!JWT) await loginAdmin();
  const url = `${STRAPI_URL}/content-manager/collection-types/${uid}`;
  const res = await fetchWithRetry(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JWT}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${uid} -> ${res.status}: ${text}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return null;
  const json = await res.json();
  return json.data || json;
}

async function findBySlugCM(uid, slug) {
  if (!JWT) await loginAdmin();
  const url = new URL(`${STRAPI_URL}/content-manager/collection-types/${uid}`);
  url.searchParams.set("filters[slug][$eq]", slug);
  url.searchParams.set("pagination[pageSize]", "1");
  const res = await fetchWithRetry(url.toString(), {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const results = json.results || [];
  return results.length > 0 ? results[0] : null;
}

async function listCM(uid, extra = "") {
  if (!JWT) await loginAdmin();
  const url = new URL(`${STRAPI_URL}/content-manager/collection-types/${uid}${extra}`);
  const res = await fetchWithRetry(url.toString(), {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.results || [];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const PAV_COORDS = { lat: 25.51204, lng: -111.07577 };
const RSC_COORDS = { lat: 24.16315, lng: -110.3384 };

function buildLocation(coords) {
  return { geoPoint: { lat: coords.lat, lng: coords.lng } };
}

function buildSchedule(text_es, text_en) {
  return { text_es, text_en };
}

function buildTags(tags_es, tags_en) {
  const out = [];
  for (let i = 0; i < Math.max(tags_es.length, tags_en.length); i++) {
    out.push({
      label_es: tags_es[i] || tags_en[i] || "",
      label_en: tags_en[i] || tags_es[i] || "",
    });
  }
  return out;
}

function buildRecommendations(bestTime_es, bestTime_en, bring_es, bring_en, accessibility_es, accessibility_en, connectivity_es, connectivity_en) {
  return {
    bestTime_es: bestTime_es || null,
    bestTime_en: bestTime_en || null,
    bring_es: Array.isArray(bring_es) ? bring_es.join("\n") : (bring_es || null),
    bring_en: Array.isArray(bring_en) ? bring_en.join("\n") : (bring_en || null),
    accessibilityNotes_es: accessibility_es || null,
    accessibilityNotes_en: accessibility_en || null,
    connectivityNotes_es: connectivity_es || null,
    connectivityNotes_en: connectivity_en || null,
  };
}

function buildSocialLinks(social) {
  if (!social || social.length === 0) return [];
  return social.map((s) => ({
    platform: s.platform,
    handle: s.handle || null,
    url: s.url || null,
  }));
}

// ---------------------------------------------------------------------------
// COMMUNITY MEMBERS
// ---------------------------------------------------------------------------

const MEMBERS = [
  {
    name: "Leonor González Cota",
    slug: "leonor-gonzalez-cota",
    role_es: "Restaurantera y Artesana",
    role_en: "Restauranteer and Craftswoman",
    locality: "agua-verde",
    phone: "613 122 6237",
    whatsapp: "5216131226237",
    bio_es:
      "Mi nombre es Leonor González Cota. Vivo en la comunidad de Agua Verde. Aquí nací, crecí y formé mi familia. Hace 13 años que ofrecemos el servicio de alimentos al turista que llega a visitar nuestras playas y comunidad. También les ofrecemos hospedaje, servicios sanitarios y duchas, además de bordados artesanales. Mantenemos informados a los turistas sobre lo que tenemos en nuestra comunidad y lo que se puede hacer tanto en tierra como en el mar. A lo largo de este proyecto que hemos desarrollado, nos hemos encontrado con muchos retos, altibajos, pero eso me ha ayudado a fortalecerme y he aprendido muchas cosas. Hasta hoy me siento orgullosa de ver cómo hemos crecido, aunque lentamente, como pasitos de tortuga, pero esos pasos han sido muy seguros y firmes.",
    bio_en:
      "My name is Leonor González Cota. I live in the Agua Verde community. I was born here, grew up here, and raised my family here. For 13 years we have been offering food service to tourists who come to visit our beaches and community. We also offer lodging, restrooms and showers, as well as handcrafted embroidery. We keep visitors informed about what our community has to offer and what they can do both on land and at sea. Throughout this project we have faced many challenges and ups and downs, but they have helped me grow stronger and taught me many things. Today I feel proud to see how far we have come — slowly, like little turtle steps, but those steps have been very steady and firm.",
    pullQuote_es: "No te rindas, eres una mujer valiente y exitosa.",
    pullQuote_en: "Don't give up, you are a brave and successful woman.",
    isFeatured: true,
    order: 1,
  },
  {
    name: "Rosalba González",
    slug: "rosalba-gonzalez",
    role_es: "Restaurantera",
    role_en: "Restauranteer",
    locality: "agua-verde",
    phone: "613 125 5226",
    whatsapp: "5216131255226",
    bio_es:
      "Puerto Bello Restaurante es un establecimiento familiar especializado en gastronomía mexicana y delicias del mar. Ubicado en el paradisíaco Puerto de Agua Verde en Loreto, Baja California Sur, nuestro establecimiento se distingue por sus espectaculares vistas panorámicas a la bahía. Ofrecemos un ambiente casual, acogedor y sereno, diseñado especialmente para el disfrute de familias y turistas.",
    bio_en:
      "Puerto Bello Restaurant is a family-run establishment specialized in Mexican cuisine and seafood delicacies. Located in the paradisiacal Puerto Agua Verde in Loreto, Baja California Sur, our restaurant is known for its spectacular panoramic views of the bay. We offer a casual, cozy and serene atmosphere, designed especially for families and tourists to enjoy.",
    pullQuote_es: "Sabores de casa con la mejor vista de la bahía.",
    pullQuote_en: "Home-style flavors with the best bay view.",
    isFeatured: true,
    order: 2,
  },
  {
    name: "Sandra Rondero",
    slug: "sandra-rondero",
    role_es: "Restaurantera",
    role_en: "Restauranteer",
    locality: "agua-verde",
    phone: "613 109 7977",
    whatsapp: "5216131097977",
    bio_es:
      "Faro San Marcial es un restaurante creado para ofrecer una experiencia gastronómica auténtica, pensada tanto para visitantes como para la comunidad local. Nuestro propósito es brindar comida y botanas de calidad, con sabores que representan la esencia de la región, en un ambiente acogedor y familiar. Con una privilegiada vista al mar, buscamos ser un punto de encuentro donde turistas y habitantes disfruten de buenos momentos, atención cálida y platillos ideales para compartir, mientras se conectan con el encanto natural del lugar.",
    bio_en:
      "Faro San Marcial is a restaurant created to offer an authentic gastronomic experience, designed for both visitors and the local community. Our purpose is to provide quality food and snacks with flavors that represent the essence of the region, in a cozy family atmosphere. With a privileged view of the sea, we aim to be a meeting point where tourists and residents enjoy good moments, warm service and dishes ideal for sharing, while connecting with the natural charm of the place.",
    pullQuote_es: "Buena comida, mejor compañía y la vista al mar.",
    pullQuote_en: "Good food, better company, and a sea view.",
    isFeatured: true,
    order: 3,
  },
  {
    name: "Esther Romero",
    slug: "esther-romero",
    role_es: "Artesana y Curadora de Museo",
    role_en: "Craftswoman and Museum Curator",
    locality: "rancho-san-cosme",
    phone: "613 105 7844",
    whatsapp: "5216131057844",
    bio_es:
      "Esther Romero es artesana y curadora del Museo La Concha en Rancho San Cosme. Elabora piezas únicas con concha mano de león, madre perla, abulón y concha burra: aretes, collares, llaveros, además de piezas de piel como bolsas, pulseras y llaveros. En el museo exhibe una colección de conchas, caracoles y artefactos antiguos, desde utensilios de cocina hasta herramientas de pesca, puntas de flecha y metates — un acervo familiar y de la comunidad.",
    bio_en:
      "Esther Romero is a craftswoman and the curator of Museo La Concha in Rancho San Cosme. She creates unique pieces with lion's paw shell, mother-of-pearl, abalone and burro shell: earrings, necklaces, keychains, plus leather goods like bags, bracelets and keychains. At the museum she exhibits a collection of shells, snails and ancient artifacts — from kitchen utensils to fishing tools, arrowheads and metates — a family and community collection.",
    pullQuote_es: "Cada pieza lleva un pedacito de nuestra comunidad.",
    pullQuote_en: "Every piece carries a piece of our community.",
    isFeatured: true,
    order: 4,
  },
  {
    name: "Martín Rodríguez",
    slug: "martin-rodriguez",
    role_es: "Guía de Museo",
    role_en: "Museum Guide",
    locality: "rancho-san-cosme",
    bio_es:
      "Martín Rodríguez acompaña a los visitantes en el recorrido por el Museo La Concha, compartiendo la historia y los detalles de las piezas de la colección familiar: conchas, caracoles, utensilios de cocina, herramientas de pesca, puntas de flecha y metates.",
    bio_en:
      "Martín Rodríguez guides visitors through Museo La Concha, sharing the history and details of the family collection: shells, snails, kitchen utensils, fishing tools, arrowheads and metates.",
    pullQuote_es: "Cada artefacto cuenta una historia del rancho.",
    pullQuote_en: "Every artifact tells a story from the ranch.",
    isFeatured: true,
    order: 5,
  },
  {
    name: "Esther Rodríguez",
    slug: "esther-rodriguez",
    role_es: "Cocinera Tradicional",
    role_en: "Traditional Cook",
    locality: "rancho-san-cosme",
    phone: "613 105 7844",
    whatsapp: "5216131057844",
    bio_es:
      "Esther Rodríguez es cocinera del Restaurante El Arriero del Mar en Rancho San Cosme. Ofrece platillos mexicanos regionales como chiles rellenos, albóndigas de pescado, enmoladas, enchiladas y tacos de pescado. Como postre 'bien ranchero' prepara chimangos, gorditas, michas y empanadas de frijol.",
    bio_en:
      "Esther Rodríguez is the cook at Restaurante El Arriero del Mar in Rancho San Cosme. She prepares regional Mexican dishes such as chiles rellenos, fish meatballs, enmoladas, enchiladas and fish tacos. As 'ranchero' dessert she prepares chimangos, gorditas, michas and bean empanadas.",
    pullQuote_es: "Sabor de rancho, hecho en casa.",
    pullQuote_en: "Ranch-style flavor, homemade.",
    isFeatured: true,
    order: 6,
  },
  {
    name: "Andrea Joachin",
    slug: "andrea-joachin",
    role_es: "Artesana de Concha",
    role_en: "Shell Craftswoman",
    locality: "rancho-san-cosme",
    phone: "613 111 8628",
    whatsapp: "5216131118628",
    bio_es:
      "Las artesanías que yo realizo son únicas; cada artesano tiene ese toque especial al usar el talento que nos tocó. Las que yo realizo son de concha y caracol, con temática de naturaleza muerta. Con mis artesanías busco representar mi comunidad y la belleza que existe en ella, creando un hermoso recuerdo en las personas. Mi deseo es que, al momento de que alguien compre una pieza, se lleve un bonito recuerdo del lugar y vuelva. Cada pieza la realizo en mi casa, donde tengo una sombra que me sirve de taller. Desde pequeña empecé vendiendo conchas; después aprendí a elaborar figuras de concha. Pasaron algunos años y conocí a una persona y gran amigo que me impulsó a realizar este trabajo y arte. Algo que me gusta mucho de las piezas que realizo es que la mayoría de las personas —si no es que todas— sienten que llevan un pedacito de nuestra comunidad.",
    bio_en:
      "The crafts I make are unique; each artisan has their own special touch when using the talent they've been given. Mine are made from shell and snail, with a still-life theme. Through my crafts I seek to represent my community and the beauty within it, creating a beautiful memory for people. My wish is that when someone buys a piece, they take a lovely memory of the place and come back. I make each piece at home, where I have a shaded area that serves as my workshop. I started selling shells as a child; later I learned to craft shell figures. Years passed and I met someone who became a great friend and encouraged me to pursue this craft. One thing I love about my pieces is that most people — if not all — feel they carry a little piece of our community with them.",
    pullQuote_es: "Cada pieza lleva un pedacito de nuestra comunidad.",
    pullQuote_en: "Each piece carries a piece of our community.",
    isFeatured: true,
    order: 7,
  },
  {
    name: "Julio Romero",
    slug: "julio-romero",
    role_es: "Guía de Tours en Mula",
    role_en: "Mule Tour Guide",
    locality: "rancho-san-cosme",
    phone: "613 111 8628",
    whatsapp: "5216131118628",
    bio_es:
      "Julio Romero es guía de tours en mula en Rancho San Cosme. Creció en la familia de Alejo Romero, pionero de los tours desde 1985 partiendo de Agua Verde. Hoy Julio y su familia ofrecen tours de media jornada y de varios días recorriendo costa y sierra.",
    bio_en:
      "Julio Romero is a mule tour guide in Rancho San Cosme. He grew up in the family of Alejo Romero, pioneer of the tours since 1985 departing from Agua Verde. Today Julio and his family offer half-day and multi-day tours along the coast and the mountains.",
    pullQuote_es: "La naturaleza se disfruta mejor a paso de mula.",
    pullQuote_en: "Nature is best enjoyed at mule pace.",
    isFeatured: true,
    order: 8,
  },
  {
    name: "Alejo Romero",
    slug: "alejo-romero",
    role_es: "Fundador de los Tours en Mula",
    role_en: "Founder of the Mule Tours",
    locality: "rancho-san-cosme",
    phone: "613 111 8628",
    whatsapp: "5216131118628",
    bio_es:
      "El señor Alejo Romero empezó su primer viaje con una persona: lo llevó a las pinturas rupestres llamadas 'Los Pescaditos' en el año 1985, partiendo del poblado de Agua Verde. Años después, se cambió a Rancho San Cosme, donde consiguió dos mulas más y empezó a hacer tours de media jornada. Posteriormente, crecieron los hijos: Julio Romero, Justo Romero y Miguel Romero. Ellos empezaron a trabajar con más equipo y personas. Conforme pasaron los años, fuimos creciendo en este negocio, formando más equipo. En la actualidad, seguimos con los tours desde San Cosme hacia diferentes rutas, ya sea de unas horas o por varios días, recorriendo costa y sierra. Ahora somos más, porque los nietos de Alejo también son guías: Alejandro Romero, Víctor Romero, Roberto Romero... Son tours únicos, pues puedes observar la naturaleza singular que distingue este lugar y llevarte una bonita experiencia.",
    bio_en:
      "Don Alejo Romero started his first trip with one person: he took them to the rock paintings called 'Los Pescaditos' in 1985, departing from the town of Agua Verde. Years later he moved to Rancho San Cosme, where he got two more mules and began offering half-day tours. Later his sons grew up: Julio Romero, Justo Romero and Miguel Romero. They began working with more equipment and people. As the years went by we grew in this business, building more team. Today we continue the tours from San Cosme to different routes, from a few hours to several days, covering coast and mountains. Now there are more of us, because Alejo's grandchildren are also guides: Alejandro Romero, Víctor Romero, Roberto Romero... These are unique tours where you can observe the singular nature that distinguishes this place and take home a beautiful experience.",
    pullQuote_es: "Pionero de los tours en mula desde 1985.",
    pullQuote_en: "Pioneer of mule tours since 1985.",
    isFeatured: true,
    order: 9,
  },
  {
    name: "Guadalupe Amador",
    slug: "guadalupe-amador",
    role_es: "Restaurantera y Hospedaje",
    role_en: "Restauranteer and Lodging",
    locality: "rancho-san-cosme",
    phone: "613 105 7844",
    whatsapp: "5216131057844",
    bio_es:
      "Guadalupe Amador ofrece restaurante y hospedaje en el corazón de Rancho San Cosme. Sus servicios incluyen comidas regionales, así como alojamiento en bus y cabañita para visitantes que buscan una experiencia auténtica del rancho.",
    bio_en:
      "Guadalupe Amador offers restaurant and lodging services in the heart of Rancho San Cosme. Her services include regional meals, as well as lodging in a converted bus and a small cabin for visitors seeking an authentic ranch experience.",
    pullQuote_es: "Hospedaje rústico con sabor casero.",
    pullQuote_en: "Rustic lodging with home-cooked flavor.",
    isFeatured: true,
    order: 10,
  },
];

// ---------------------------------------------------------------------------
// LISTINGS
// ---------------------------------------------------------------------------

const LISTINGS = [
  {
    title_es: "Restaurante Brisa del Mar",
    title_en: "Brisa del Mar Restaurant",
    slug: "restaurante-brisa-del-mar",
    locality: "agua-verde",
    category: "restaurants",
    mainImage: 29,
    gallery: [22, 24, 28, 27],
    tags_es: ["Alimentos", "Hospedaje", "Artesanías"],
    tags_en: ["Food", "Lodging", "Crafts"],
    amenities_es: ["Sanitarios", "Duchas", "Vista al mar"],
    amenities_en: ["Restrooms", "Showers", "Sea view"],
    shortDescription_es: "Restaurante familiar con hospedaje y artesanías en Agua Verde. Example: experiencia local auténtica frente al mar.",
    shortDescription_en: "Family-run restaurant with lodging and crafts in Agua Verde. Example: authentic local experience by the sea.",
    description_es:
      "Mi nombre es Leonor González Cota. Vivo en la comunidad de Agua Verde. Aquí nací, crecí y formé mi familia. Restaurante Brisa del Mar: Hace 13 años que ofrecemos el servicio de alimentos al turista que llega a visitar nuestras playas y comunidad. También les ofrecemos hospedaje, servicios sanitarios y duchas, además de bordados artesanales. Mantenemos informados a los turistas sobre lo que tenemos en nuestra comunidad y lo que se puede hacer tanto en tierra como en el mar. A lo largo de este proyecto que hemos desarrollado, nos hemos encontrado con muchos retos, altibajos, pero eso me ha ayudado a fortalecerme y he aprendido muchas cosas. Hasta hoy me siento orgullosa de ver cómo hemos crecido, aunque lentamente, como pasitos de tortuga, pero esos pasos han sido muy seguros y firmes.",
    description_en:
      "My name is Leonor González Cota. I live in the Agua Verde community. I was born here, grew up here, and raised my family here. Brisa del Mar Restaurant: For 13 years we have been offering food service to tourists who come to visit our beaches and community. We also offer lodging, restrooms and showers, as well as handcrafted embroidery. We keep visitors informed about what our community has to offer and what they can do both on land and at sea.",
    products_es: [
      { name: "Platillos gastronómicos regionales" },
      { name: "Productos y artesanías locales (punto de venta de otras mujeres de la comunidad)" },
    ],
    products_en: [
      { name: "Regional gastronomic dishes" },
      { name: "Local products and crafts (sales point for other women in the community)" },
    ],
    contact_phone: "613 122 6237",
    contact_whatsapp: "5216131226237",
    social: [{ platform: "facebook" }],
    schedule_es: "Lunes a Domingo — comida al turista todo el día. Example: abierto de 8:00 am a 8:00 pm.",
    schedule_en: "Monday to Sunday — tourist meals served all day. Example: open 8:00 am to 8:00 pm.",
    bestTime_es: "Todo el año. Example: temporada ideal entre noviembre y junio.",
    bestTime_en: "Year-round. Example: ideal season from November to June.",
    bring_es: ["Traer protector solar", "Efectivo para artesanías"],
    bring_en: ["Bring sunscreen", "Cash for crafts"],
    price: "$$",
    member_slugs: ["leonor-gonzalez-cota"],
  },
  {
    title_es: "Restaurante Puerto Bello",
    title_en: "Puerto Bello Restaurant",
    slug: "restaurante-puerto-bello",
    locality: "agua-verde",
    category: "restaurants",
    mainImage: 29,
    gallery: [22, 24, 28, 25],
    tags_es: ["Alimentos", "Vista panorámica"],
    tags_en: ["Food", "Panoramic view"],
    amenities_es: ["Estacionamiento", "Vista a la bahía", "Terraza"],
    amenities_en: ["Parking", "Bay view", "Terrace"],
    shortDescription_es: "Restaurante familiar con vista panorámica a la bahía de Agua Verde.",
    shortDescription_en: "Family-run restaurant with a panoramic view of the Agua Verde bay.",
    description_es:
      "Puerto Bello Restaurante es un establecimiento familiar especializado en gastronomía mexicana y delicias del mar. Ubicado en el paradisíaco Puerto de Agua Verde en Loreto, Baja California Sur, nuestro establecimiento se distingue por sus espectaculares vistas panorámicas a la bahía. Ofrecemos un ambiente casual, acogedor y sereno, diseñado especialmente para el disfrute de familias y turistas.",
    description_en:
      "Puerto Bello Restaurant is a family-run establishment specialized in Mexican cuisine and seafood delicacies. Located in the paradisiacal Puerto Agua Verde in Loreto, Baja California Sur, our restaurant is known for its spectacular panoramic views of the bay. We offer a casual, cozy and serene atmosphere, designed especially for families and tourists to enjoy.",
    products_es: [{ name: "Platillos gastronómicos regionales" }],
    products_en: [{ name: "Regional gastronomic dishes" }],
    contact_phone: "613 125 5226",
    contact_whatsapp: "5216131255226",
    schedule_es: "Lunes a Domingo. Example: 7:00 am – 10:00 pm.",
    schedule_en: "Monday to Sunday. Example: 7:00 am – 10:00 pm.",
    bestTime_es: "Atardecer para disfrutar la vista. Example: cualquier época del año.",
    bestTime_en: "Sunset to enjoy the view. Example: any time of year.",
    bring_es: ["Ganas de comer mariscos frescos"],
    bring_en: ["Appetite for fresh seafood"],
    price: "$$$",
    member_slugs: ["rosalba-gonzalez"],
  },
  {
    title_es: "Restaurante Faro San Marcial",
    title_en: "Faro San Marcial Restaurant",
    slug: "restaurante-faro-san-marcial",
    locality: "agua-verde",
    category: "restaurants",
    mainImage: 29,
    gallery: [22, 28, 24, 25],
    tags_es: ["Alimentos", "Vista al mar", "Postres regionales"],
    tags_en: ["Food", "Sea view", "Regional desserts"],
    amenities_es: ["Vista al mar", "Ambiente familiar", "Terraza"],
    amenities_en: ["Sea view", "Family atmosphere", "Terrace"],
    shortDescription_es: "Cocina regional con vista privilegiada al mar en Agua Verde.",
    shortDescription_en: "Regional cuisine with a privileged sea view in Agua Verde.",
    description_es:
      "Faro San Marcial es un restaurante creado para ofrecer una experiencia gastronómica auténtica, pensada tanto para visitantes como para la comunidad local. Nuestro propósito es brindar comida y botanas de calidad, con sabores que representan la esencia de la región, en un ambiente acogedor y familiar. Con una privilegiada vista al mar, buscamos ser un punto de encuentro donde turistas y habitantes disfruten de buenos momentos, atención cálida y platillos ideales para compartir, mientras se conectan con el encanto natural del lugar.",
    description_en:
      "Faro San Marcial is a restaurant created to offer an authentic gastronomic experience, designed for both visitors and the local community. Our purpose is to provide quality food and snacks with flavors that represent the essence of the region, in a cozy family atmosphere. With a privileged view of the sea, we aim to be a meeting point where tourists and residents enjoy good moments, warm service and dishes ideal for sharing, while connecting with the natural charm of the place.",
    products_es: [
      { name: "Botanas y platillos gastronómicos regionales" },
      { name: "Postres y productos locales (Pan micha, chimangos, empanadas)" },
    ],
    products_en: [
      { name: "Regional snacks and dishes" },
      { name: "Local desserts and products (pan micha, chimangos, empanadas)" },
    ],
    contact_phone: "613 109 7977",
    contact_whatsapp: "5216131097977",
    social: [{ platform: "facebook" }],
    schedule_es: "Lunes a Domingo. Example: 8:00 am – 9:00 pm.",
    schedule_en: "Monday to Sunday. Example: 8:00 am – 8:00 pm.",
    bestTime_es: "Tardes para apreciar la vista. Example: todo el año.",
    bestTime_en: "Late afternoons for the view. Example: year-round.",
    bring_es: ["Ganas de probar postres regionales"],
    bring_en: ["Appetite for regional desserts"],
    price: "$$",
    member_slugs: ["sandra-rondero"],
  },
  {
    title_es: "Museo La Concha",
    title_en: "La Concha Museum",
    slug: "museo-la-concha",
    locality: "rancho-san-cosme",
    category: "sites",
    mainImage: 25,
    gallery: [26, 23, 24, 22],
    tags_es: ["Museo", "Cultura", "Historia local"],
    tags_en: ["Museum", "Culture", "Local history"],
    amenities_es: ["Visitas guiadas", "Tienda de artesanías"],
    amenities_en: ["Guided tours", "Crafts shop"],
    shortDescription_es: "Museo familiar con conchas, caracoles y artefactos antiguos en Rancho San Cosme.",
    shortDescription_en: "Family museum with shells, snails and ancient artifacts in Rancho San Cosme.",
    description_es:
      "Museo La Concha, Rancho San Cosme: es un lugar donde puedes encontrar una exhibición de conchas y caracoles, así como artefactos antiguos, desde utensilios de cocina hasta herramientas de pesca. Aquí encontrarás algunas puntas de flecha, metates y muchas cosas más. ¡Todo muy interesante!",
    description_en:
      "La Concha Museum, Rancho San Cosme: a place where you can find an exhibition of shells and snails, as well as ancient artifacts — from kitchen utensils to fishing tools. Here you'll find arrowheads, metates and much more. All very interesting!",
    products_es: [{ name: "Recorrido guiado por el museo" }],
    products_en: [{ name: "Guided museum tour" }],
    contact_phone: "613 105 7844",
    contact_whatsapp: "5216131057844",
    social: [{ platform: "facebook" }],
    schedule_es: "Lunes a Domingo. Example: 9:00 am – 5:00 pm.",
    schedule_en: "Monday to Sunday. Example: 9:00 am – 5:00 pm.",
    bestTime_es: "Mañanas frescas. Example: mejor entre octubre y mayo.",
    bestTime_en: "Cool mornings. Example: best between October and May.",
    bring_es: ["Cámara fotográfica", "Curiosidad por la historia local"],
    bring_en: ["Camera", "Curiosity for local history"],
    price: "$",
    member_slugs: ["esther-romero", "martin-rodriguez"],
  },
  {
    title_es: "Artesanías Joyas del Mar",
    title_en: "Joyas del Mar Crafts",
    slug: "artesanias-joyas-del-mar",
    locality: "rancho-san-cosme",
    category: "services",
    mainImage: 25,
    gallery: [26, 23, 24, 22],
    tags_es: ["Artesanías", "Concha", "Joyería"],
    tags_en: ["Crafts", "Shell", "Jewelry"],
    amenities_es: ["Piezas únicas hechas a mano", "Ventas en museo"],
    amenities_en: ["Unique handmade pieces", "Sales at the museum"],
    shortDescription_es: "Artesanías únicas con concha, madre perla y piel en Rancho San Cosme.",
    shortDescription_en: "Unique crafts with shell, mother-of-pearl and leather in Rancho San Cosme.",
    description_es:
      "Artesanías Joyas del Mar: tenemos piezas únicas elaboradas con concha mano de león, madre perla, abulón y concha burra: aretes, collares y llaveros. También contamos con piezas de piel, como bolsas, pulseras y llaveros.",
    description_en:
      "Joyas del Mar Crafts: we have unique pieces made with lion's paw shell, mother-of-pearl, abalone and burro shell: earrings, necklaces and keychains. We also offer leather goods like bags, bracelets and keychains.",
    products_es: [
      { name: "Aretes, collares y llaveros de concha" },
      { name: "Bolsas, pulseras y llaveros de piel" },
    ],
    products_en: [
      { name: "Shell earrings, necklaces and keychains" },
      { name: "Leather bags, bracelets and keychains" },
    ],
    contact_phone: "613 105 7844",
    contact_whatsapp: "5216131057844",
    social: [{ platform: "facebook" }],
    schedule_es: "Lunes a Domingo. Example: 9:00 am – 6:00 pm.",
    schedule_en: "Monday to Sunday. Example: 9:00 am – 6:00 pm.",
    bestTime_es: "Cualquier momento. Example: ideal combinar con visita al museo.",
    bestTime_en: "Anytime. Example: ideal combined with a museum visit.",
    bring_es: ["Efectivo para compra de piezas"],
    bring_en: ["Cash for purchases"],
    price: "$$",
    member_slugs: ["esther-romero"],
  },
  {
    title_es: "Restaurante El Arriero del Mar",
    title_en: "El Arriero del Mar Restaurant",
    slug: "restaurante-el-arriero-del-mar",
    locality: "rancho-san-cosme",
    category: "restaurants",
    mainImage: 29,
    gallery: [26, 24, 22, 28],
    tags_es: ["Alimentos", "Cocina regional", "Postres rancheros"],
    tags_en: ["Food", "Regional cuisine", "Ranch desserts"],
    amenities_es: ["Comida casera", "Postres típicos"],
    amenities_en: ["Home-cooked food", "Traditional desserts"],
    shortDescription_es: "Cocina regional mexicana en Rancho San Cosme con postres rancheros.",
    shortDescription_en: "Mexican regional cuisine in Rancho San Cosme with ranch-style desserts.",
    description_es:
      "Restaurante El Arriero del Mar: ofrecemos platillos mexicanos regionales: chiles rellenos, albóndigas de pescado, enmoladas, enchiladas y tacos de pescado. Como postre 'bien ranchero' tenemos: chimangos, gorditas, michas, empanadas de frijol, y muchas cosas más.",
    description_en:
      "El Arriero del Mar Restaurant: we offer regional Mexican dishes: chiles rellenos, fish meatballs, enmoladas, enchiladas and fish tacos. As 'ranchero' dessert we have: chimangos, gorditas, michas, bean empanadas, and much more.",
    products_es: [
      { name: "Platillos mexicanos regionales (chiles rellenos, albóndigas de pescado, enmoladas, enchiladas, tacos de pescado)" },
      { name: "Postres rancheros (chimangos, gorditas, michas, empanadas de frijol)" },
    ],
    products_en: [
      { name: "Regional Mexican dishes (chiles rellenos, fish meatballs, enmoladas, enchiladas, fish tacos)" },
      { name: "Ranchero desserts (chimangos, gorditas, michas, bean empanadas)" },
    ],
    contact_phone: "613 105 7844",
    contact_whatsapp: "5216131057844",
    social: [{ platform: "facebook" }],
    schedule_es: "Lunes a Domingo. Example: 8:00 am – 8:00 pm.",
    schedule_en: "Monday to Sunday. Example: 8:00 am – 8:00 pm.",
    bestTime_es: "Comida y cena. Example: la barbacoa de pescado es imperdible.",
    bestTime_en: "Lunch and dinner. Example: the fish barbacoa is a must.",
    bring_es: ["Ganas de probar sabores nuevos"],
    bring_en: ["Appetite for new flavors"],
    price: "$$",
    member_slugs: ["esther-rodriguez"],
  },
  {
    title_es: "Artesanías Andrea",
    title_en: "Andrea's Crafts",
    slug: "artesanias-andrea",
    locality: "rancho-san-cosme",
    category: "services",
    mainImage: 25,
    gallery: [26, 23, 24, 22],
    tags_es: ["Artesanías", "Concha", "Hecho a mano"],
    tags_en: ["Crafts", "Shell", "Handmade"],
    amenities_es: ["Taller a domicilio", "Encargos personalizados"],
    amenities_en: ["Home workshop", "Custom orders"],
    shortDescription_es: "Artesanías de concha y caracol hechas a mano en Rancho San Cosme.",
    shortDescription_en: "Handmade shell and snail crafts in Rancho San Cosme.",
    description_es:
      "Las artesanías que yo realizo son únicas; cada artesano tiene ese toque especial al usar el talento que nos tocó. Las que yo realizo son de concha y caracol, con temática de naturaleza muerta. Con mis artesanías busco representar mi comunidad y la belleza que existe en ella, creando un hermoso recuerdo en las personas. Mi deseo es que, al momento de que alguien compre una pieza, se lleve un bonito recuerdo del lugar y vuelva. Cada pieza la realizo en mi casa, donde tengo una sombra que me sirve de taller. Desde pequeña empecé vendiendo conchas; después aprendí a elaborar figuras de concha.",
    description_en:
      "The crafts I make are unique; each artisan has their own special touch when using the talent they've been given. Mine are made from shell and snail, with a still-life theme. Through my crafts I seek to represent my community and the beauty within it, creating a beautiful memory for people. My wish is that when someone buys a piece, they take a lovely memory of the place and come back. I make each piece at home, where I have a shaded area that serves as my workshop. I started selling shells as a child; later I learned to craft shell figures.",
    products_es: [{ name: "Figuras y piezas de concha y caracol" }],
    products_en: [{ name: "Shell and snail figures and pieces" }],
    contact_phone: "613 111 8628",
    contact_whatsapp: "5216131118628",
    schedule_es: "Lunes a Sábado. Example: 9:00 am – 6:00 pm.",
    schedule_en: "Monday to Saturday. Example: 9:00 am – 6:00 pm.",
    bestTime_es: "Todo el año. Example: ideal para llevar un recuerdo del rancho.",
    bestTime_en: "Year-round. Example: ideal for taking a memory of the ranch.",
    bring_es: ["Efectivo", "Bolsa resistente para llevar piezas"],
    bring_en: ["Cash", "A sturdy bag to carry your pieces"],
    price: "$",
    member_slugs: ["andrea-joachin"],
  },
  {
    title_es: "Romero Tours — Cabalgata en Mula",
    title_en: "Romero Tours — Mule Trek",
    slug: "romero-tours-cabalgata-en-mula",
    locality: "rancho-san-cosme",
    category: "experiences",
    mainImage: 23,
    gallery: [26, 24, 22, 25],
    tags_es: ["Tours", "Cabalgata", "Naturaleza", "Aventura"],
    tags_en: ["Tours", "Mule trek", "Nature", "Adventure"],
    amenities_es: ["Guía local", "Rutas de media jornada y día completo", "Costa y sierra"],
    amenities_en: ["Local guide", "Half-day and full-day routes", "Coast and mountains"],
    shortDescription_es: "Tours en mula desde 1985 — familia Romero en Rancho San Cosme.",
    shortDescription_en: "Mule tours since 1985 — the Romero family in Rancho San Cosme.",
    description_es:
      "El señor Alejo Romero empezó su primer viaje con una persona: lo llevó a las pinturas rupestres llamadas 'Los Pescaditos' en el año 1985, partiendo del poblado de Agua Verde. Años después, se cambió a Rancho San Cosme, donde consiguió dos mulas más y empezó a hacer tours de media jornada. Posteriormente, crecieron los hijos: Julio Romero, Justo Romero y Miguel Romero. Ellos empezaron a trabajar con más equipo y personas. Conforme pasaron los años, fuimos creciendo en este negocio, formando más equipo. En la actualidad, seguimos con los tours desde San Cosme hacia diferentes rutas, ya sea de unas horas o por varios días, recorriendo costa y sierra. Ahora somos más, porque los nietos de Alejo también son guías: Alejandro Romero, Víctor Romero, Roberto Romero... Son tours únicos, pues puedes observar la naturaleza singular que distingue este lugar y llevarte una bonita experiencia.",
    description_en:
      "Don Alejo Romero started his first trip with one person: he took them to the rock paintings called 'Los Pescaditos' in 1985, departing from the town of Agua Verde. Years later he moved to Rancho San Cosme, where he got two more mules and began offering half-day tours. Later his sons grew up: Julio Romero, Justo Romero and Miguel Romero. Today we continue the tours from San Cosme to different routes, from a few hours to several days, covering coast and mountains. Now there are more of us, because Alejo's grandchildren are also guides.",
    products_es: [
      { name: "Tour de media jornada" },
      { name: "Tour de día completo" },
      { name: "Tour de varios días (costa y sierra)" },
    ],
    products_en: [
      { name: "Half-day tour" },
      { name: "Full-day tour" },
      { name: "Multi-day tour (coast and mountains)" },
    ],
    contact_phone: "613 111 8628",
    contact_whatsapp: "5216131118628",
    schedule_es: "Lunes a Domingo con reservación. Example: salidas temprano por la mañana.",
    schedule_en: "Monday to Sunday by reservation. Example: departures early in the morning.",
    bestTime_es: "Temporada fresca. Example: octubre a mayo.",
    bestTime_en: "Cool season. Example: October to May.",
    bring_es: ["Sombrero", "Agua", "Calzado cerrado", "Cámara"],
    bring_en: ["Hat", "Water", "Closed-toe shoes", "Camera"],
    accessibility_es: "Example: terreno irregular; no apto para personas con movilidad reducida.",
    accessibility_en: "Example: uneven terrain; not suitable for people with reduced mobility.",
    price: "$$",
    member_slugs: ["julio-romero", "alejo-romero"],
  },
  {
    title_es: "Restaurante Rancho San Cosme",
    title_en: "Rancho San Cosme Restaurant",
    slug: "restaurante-rancho-san-cosme",
    locality: "rancho-san-cosme",
    category: "restaurants",
    mainImage: 29,
    gallery: [26, 24, 22, 28],
    tags_es: ["Alimentos", "Hospedaje", "Cocina casera"],
    tags_en: ["Food", "Lodging", "Home-style cooking"],
    amenities_es: ["Comida casera", "Hospedaje en bus", "Hospedaje en cabañita"],
    amenities_en: ["Home-cooked meals", "Bus lodging", "Small cabin lodging"],
    shortDescription_es: "Restaurante y hospedaje rústico en el corazón de Rancho San Cosme.",
    shortDescription_en: "Restaurant and rustic lodging in the heart of Rancho San Cosme.",
    description_es:
      "Restaurante Rancho San Cosme ofrece platillos regionales y hospedaje en el corazón del rancho. Hospedaje en bus y cabañita para visitantes que buscan una experiencia auténtica del rancho, rodeados de la naturaleza y la tranquilidad del lugar.",
    description_en:
      "Rancho San Cosme Restaurant offers regional dishes and lodging in the heart of the ranch. Lodging in a converted bus and a small cabin for visitors seeking an authentic ranch experience, surrounded by nature and tranquility.",
    products_es: [
      { name: "Platillos regionales" },
      { name: "Hospedaje en bus" },
      { name: "Hospedaje en cabañita" },
    ],
    products_en: [
      { name: "Regional dishes" },
      { name: "Bus lodging" },
      { name: "Small cabin lodging" },
    ],
    contact_phone: "613 105 7844",
    contact_whatsapp: "5216131057844",
    schedule_es: "Lunes a Domingo. Example: comidas y cenas con reservación.",
    schedule_en: "Monday to Sunday. Example: lunch and dinner by reservation.",
    bestTime_es: "Atardecer. Example: todo el año.",
    bestTime_en: "Sunset. Example: year-round.",
    bring_es: ["Ropa cómoda", "Linterna personal"],
    bring_en: ["Comfortable clothes", "Personal flashlight"],
    price: "$$",
    member_slugs: ["guadalupe-amador"],
  },
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nStrapi URL: ${STRAPI_URL}`);
  console.log(`Admin:      ${ADMIN_EMAIL}\n`);

  // Login test
  const token = await loginAdmin();
  console.log(`Logged in (JWT length: ${token.length})\n`);

  // Resolve categories
  const cats = await listCM("api::category.category");
  const categoryBySlug = {};
  for (const c of cats || []) {
    if (c.slug && !categoryBySlug[c.slug]) categoryBySlug[c.slug] = c.documentId;
  }
  console.log(`Categories: ${Object.keys(categoryBySlug).join(", ")}\n`);

  // ---------------------------------------------------------------------
  // PASS 1: Community members
  // ---------------------------------------------------------------------
  console.log("=== Community members ===");
  const memberBySlug = {};
  for (const m of MEMBERS) {
    const existing = await findBySlugCM("api::community-member.community-member", m.slug);
    if (existing) {
      memberBySlug[m.slug] = existing.documentId;
      console.log(`  skip: member ${m.slug} exists (${existing.documentId})`);
      continue;
    }

    const esPayload = {
      name: m.name,
      slug: m.slug,
      role: m.role_es,
      locality: m.locality,
      bio: m.bio_es,
      pullQuote: m.pullQuote_es,
      phone: m.phone || null,
      whatsapp: m.whatsapp || null,
      isFeatured: m.isFeatured,
      order: m.order,
      publishedAt: new Date().toISOString(),
    };
    const esResult = await cm("POST", "api::community-member.community-member", esPayload);
    const esDocId = esResult.documentId;
    memberBySlug[m.slug] = esDocId;
    console.log(`  + member ${m.slug} (ES, ${esDocId})`);

    // English locale via PUT to add localization
    const enPayload = {
      name: m.name,
      slug: m.slug,
      role: m.role_en,
      locality: m.locality,
      bio: m.bio_en,
      pullQuote: m.pullQuote_en,
      phone: m.phone || null,
      whatsapp: m.whatsapp || null,
      isFeatured: m.isFeatured,
      order: m.order,
      locale: "en",
      publishedAt: new Date().toISOString(),
    };
    try {
      await cm("PUT", `api::community-member.community-member/${esDocId}`, enPayload);
      console.log(`  + member ${m.slug} (EN)`);
    } catch (e) {
      console.warn(`  ! could not create EN for ${m.slug}: ${e.message.slice(0, 200)}`);
    }
  }

  // ---------------------------------------------------------------------
  // PASS 2: Listings
  // ---------------------------------------------------------------------
  console.log("\n=== Listings ===");
  let orderCounter = 100;
  for (const l of LISTINGS) {
    orderCounter += 1;
    const categoryDocId = categoryBySlug[l.category];
    if (!categoryDocId) {
      console.warn(`  ! category not found: ${l.category} for ${l.slug}`);
      continue;
    }

    const existing = await findBySlugCM("api::listing.listing", l.slug);
    if (existing) {
      console.log(`  skip: listing ${l.slug} exists (${existing.documentId})`);
      continue;
    }

    const coords = l.locality === "rancho-san-cosme" ? RSC_COORDS : PAV_COORDS;
    const memberDocIds = (l.member_slugs || []).map((s) => memberBySlug[s]).filter(Boolean);

    const esPayload = {
      title: l.title_es,
      slug: l.slug,
      shortDescription: l.shortDescription_es,
      description: l.description_es,
      category: categoryDocId,
      mainImage: l.mainImage,
      gallery: l.gallery,
      tags: buildTags(l.tags_es, l.tags_en),
      amenities: buildTags(l.amenities_es, l.amenities_en),
      location: buildLocation(coords),
      schedule: buildSchedule(l.schedule_es, l.schedule_en),
      contact: {
        whatsapp: l.contact_whatsapp || null,
        phone: l.contact_phone || null,
        email: null,
        instagram: null,
        facebook: l.social?.some((s) => s.platform === "facebook") ? "facebook" : null,
      },
      recommendations: buildRecommendations(
        l.bestTime_es, l.bestTime_en,
        l.bring_es, l.bring_en,
        l.accessibility_es, l.accessibility_en,
        null, null,
      ),
      products: l.products_es,
      social: buildSocialLinks(l.social),
      price: l.price,
      isFeatured: true,
      order: orderCounter,
      members: memberDocIds,
      publishedAt: new Date().toISOString(),
    };

    let esDocId;
    try {
      const esResult = await cm("POST", "api::listing.listing", esPayload);
      esDocId = esResult.documentId;
      console.log(`  + listing ${l.slug} (ES, ${esDocId})`);
    } catch (e) {
      console.error(`  ! failed ${l.slug}: ${e.message.slice(0, 300)}`);
      continue;
    }

    const enPayload = {
      title: l.title_en,
      slug: l.slug,
      shortDescription: l.shortDescription_en,
      description: l.description_en,
      category: categoryDocId,
      mainImage: l.mainImage,
      gallery: l.gallery,
      tags: buildTags(l.tags_en, l.tags_en),
      amenities: buildTags(l.amenities_en, l.amenities_en),
      location: buildLocation(coords),
      schedule: buildSchedule(l.schedule_en, l.schedule_en),
      contact: {
        whatsapp: l.contact_whatsapp || null,
        phone: l.contact_phone || null,
        email: null,
        instagram: null,
        facebook: l.social?.some((s) => s.platform === "facebook") ? "facebook" : null,
      },
      recommendations: buildRecommendations(
        l.bestTime_en, l.bestTime_en,
        l.bring_en, l.bring_en,
        l.accessibility_en, l.accessibility_en,
        null, null,
      ),
      products: l.products_en,
      social: buildSocialLinks(l.social),
      price: l.price,
      isFeatured: true,
      order: orderCounter,
      members: memberDocIds,
      locale: "en",
      publishedAt: new Date().toISOString(),
    };
    try {
      await cm("PUT", `api::listing.listing/${esDocId}`, enPayload);
      console.log(`  + listing ${l.slug} (EN)`);
    } catch (e) {
      console.warn(`  ! could not create EN for ${l.slug}: ${e.message.slice(0, 200)}`);
    }
  }

  console.log("\nImport complete.");
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
