/**
 * scripts/migrate-site-content-to-pages.ts
 *
 * One-time migration: reads existing site-content rows (about-*, guide-*) and
 * populates the new single types (about-page, guide-page, experiences-page).
 *
 * Run AFTER:
 *   1. Schema files created (new components + new single types registered)
 *   2. Strapi has started at least once (tables created in DB)
 *
 * Usage:
 *   # Set env pointing to the target DB (Neon or local SQLite)
 *   export DATABASE_CLIENT=sqlite
 *   export DATABASE_FILENAME=.tmp/data.db
 *   # OR for Neon:
 *   export DATABASE_CLIENT=postgres
 *   export DATABASE_URL="postgresql://..."
 *   export DATABASE_SSL=true
 *
 *   npx tsx scripts/migrate-site-content-to-pages.ts
 */

import path from 'node:path';

interface SiteContent {
  id: number;
  key: string;
  title: string;
  text: string;
  extraData: Record<string, any>;
}

interface AboutPage {
  id: number;
  introTitle: string;
  introText: string;
  values: {
    missionTitle: string;
    missionText: string;
    visionTitle: string;
    visionText: string;
    valuesTitle: string;
    valuesItems: string[];
  };
  communityTitle: string;
  communityText: string;
  collaboration: {
    title: string;
    description: string;
    primaryButtonLabel: string;
    primaryButtonLink: string;
    secondaryButtonLabel: string;
    secondaryButtonLink: string;
  };
  finalCta: {
    title: string;
    description: string;
    buttonLabel: string;
    buttonLink: string;
  };
}

interface GuidePage {
  id: number;
  hero: { image: string };
  intro: {
    ranchTitle: string;
    ranchText: string;
    portTitle: string;
    portText: string;
  };
  historyHeader: { title: string; subtitle: string };
  historyMilestones: Array<{ year: string; text: string }>;
  historyText: string;
  fishingHeader: { title: string; subtitle: string };
  fishingText: string;
  fishingRules: Array<{ text: string }>;
  protectedArea: { title: string; text: string; linkLabel: string; linkHref: string };
  influenceHeader: { title: string; subtitle: string };
  influenceText: string;
  recommendationsHeader: { title: string; subtitle: string };
  recommendations: Array<{ text: string }>;
  directionsHeader: { title: string; subtitle: string };
  directions: Array<{ label: string; description: string; distance: string; time: string; image: string }>;
  drivingTipsHeader: string;
  drivingTips: Array<{ text: string }>;
  amenitiesHeader: { title: string; subtitle: string };
  amenities: Array<{ icon: string; title: string; text: string }>;
  touristMapHeader: { title: string; subtitle: string };
  touristMapImage: string;
  touristMapCaption: string;
  finalCta: { title: string; description: string; buttonLabel: string; buttonLink: string };
}

async function migrate() {
  let strapi = require(path.resolve(__dirname, '../dist/server'))?.default
    ?? require(path.resolve(__dirname, '../../dist/server'))?.default;

  if (!strapi) {
    // Fallback: boot a minimal Strapi instance
    console.log('[migrate] Booting temporary Strapi instance...');
    const Strapi = require('@strapi/strapi').default;
    strapi = await Strapi({ distDir: path.resolve(__dirname, '../dist') }).load();
    await strapi.start();
  }

  const siteContentService = strapi.db.query('api::site-content.site-content');
  const aboutPageService = strapi.db.query('api::about-page.about-page');
  const guidePageService = strapi.db.query('api::guide-page.guide-page');

  async function findContent(key: string): Promise<SiteContent | null> {
    return siteContentService.findOne({ where: { key } }) as Promise<SiteContent | null>;
  }

  // ─── About page ────────────────────────────────────────────────────────────
  console.log('\n[migrate] Processing about-page...');

  const [aboutIntro, aboutValues, aboutCommunity, aboutCollaboration, aboutCta] = await Promise.all([
    findContent('about-intro'),
    findContent('about-values'),
    findContent('about-community'),
    findContent('about-collaboration'),
    findContent('about-cta'),
  ]);

  const existingAbout = await aboutPageService.find();

  const aboutData: Partial<AboutPage> = {};
  if (aboutIntro) {
    aboutData.introTitle = aboutIntro.title;
    aboutData.introText = aboutIntro.text;
  }
  if (aboutValues?.extraData) {
    const ed = aboutValues.extraData;
    aboutData.values = {
      missionTitle: ed.missionTitle ?? '',
      missionText: ed.missionText ?? '',
      visionTitle: ed.visionTitle ?? '',
      visionText: ed.visionText ?? '',
      valuesTitle: ed.valuesTitle ?? '',
      valuesItems: Array.isArray(ed.values) ? ed.values : [],
    };
  }
  if (aboutCommunity) {
    aboutData.communityTitle = aboutCommunity.title;
    aboutData.communityText = aboutCommunity.text;
  }
  if (aboutCollaboration?.extraData) {
    const ed = aboutCollaboration.extraData;
    aboutData.collaboration = {
      title: ed.title ?? aboutCollaboration.title ?? '',
      description: ed.description ?? '',
      primaryButtonLabel: ed.btnPrimary?.label ?? '',
      primaryButtonLink: ed.btnPrimary?.href ?? '',
      secondaryButtonLabel: ed.btnSecondary?.label ?? '',
      secondaryButtonLink: ed.btnSecondary?.href ?? '',
    };
  }
  if (aboutCta?.extraData || aboutCta) {
    const ed = aboutCta?.extraData ?? {};
    aboutData.finalCta = {
      title: ed.title ?? aboutCta?.title ?? '',
      description: ed.description ?? aboutCta?.text ?? '',
      buttonLabel: ed.buttonLabel ?? '',
      buttonLink: ed.buttonLink ?? '',
    };
  }

  if (Object.keys(aboutData).length > 0) {
    if (existingAbout) {
      await aboutPageService.update({
        where: { id: existingAbout.id },
        data: aboutData,
      });
      console.log(`[migrate] Updated about-page (id=${existingAbout.id})`);
    } else {
      const created = await aboutPageService.create({ data: aboutData });
      console.log(`[migrate] Created about-page (id=${created.id})`);
    }
  } else {
    console.log('[migrate] No about-content found — about-page left empty (populate manually in admin)');
  }

  // ─── Guide page ──────────────────────────────────────────────────────────
  console.log('\n[migrate] Processing guide-page...');

  const [
    guideHero,
    guideBay,
    guideHistory,
    guideFishing,
    guideConap,
    guideInfluence,
    guideRecommendations,
    guideDirections,
    guideAmenities,
    guideTouristMap,
    guideCta,
  ] = await Promise.all([
    findContent('guide-hero'),
    findContent('guide-bay'),
    findContent('guide-history'),
    findContent('guide-fishing'),
    findContent('guide-conap'),
    findContent('guide-influence'),
    findContent('guide-recommendations'),
    findContent('guide-directions'),
    findContent('guide-amenities'),
    findContent('guide-tourist-map'),
    findContent('guide-cta'),
  ]);

  const existingGuide = await guidePageService.find();

  const guideData: Partial<GuidePage> = {};

  if (guideHero?.extraData) {
    guideData.hero = { image: guideHero.extraData.image ?? '' };
  }
  if (guideBay?.extraData) {
    const ed = guideBay.extraData;
    guideData.intro = {
      ranchTitle: ed.ranchTitle ?? '',
      ranchText: ed.ranchText ?? '',
      portTitle: ed.portTitle ?? '',
      portText: ed.portText ?? '',
    };
  }
  if (guideHistory?.extraData) {
    const ed = guideHistory.extraData;
    guideData.historyHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.historyText = ed.text ?? '';
    guideData.historyMilestones = Array.isArray(ed.milestones)
      ? ed.milestones.map((m: any) => ({ year: m.year ?? '', text: m.text ?? '' }))
      : [];
  }
  if (guideFishing?.extraData) {
    const ed = guideFishing.extraData;
    guideData.fishingHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.fishingText = ed.text ?? '';
    guideData.fishingRules = Array.isArray(ed.rules)
      ? ed.rules.map((r: any) => ({ text: typeof r === 'string' ? r : r.text ?? '' }))
      : [];
  }
  if (guideConap?.extraData) {
    const ed = guideConap.extraData;
    guideData.protectedArea = {
      title: ed.title ?? '',
      text: ed.text ?? '',
      linkLabel: ed.link?.label ?? '',
      linkHref: ed.link?.href ?? '',
    };
  }
  if (guideInfluence) {
    guideData.influenceHeader = { title: '', subtitle: '' };
    guideData.influenceText = guideInfluence.text ?? '';
  }
  if (guideRecommendations?.extraData) {
    const ed = guideRecommendations.extraData;
    guideData.recommendationsHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.recommendations = Array.isArray(ed.items)
      ? ed.items.map((i: any) => ({ text: typeof i === 'string' ? i : i.text ?? '' }))
      : [];
  }
  if (guideDirections?.extraData) {
    const ed = guideDirections.extraData;
    guideData.directionsHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.drivingTipsHeader = ed.drivingTipsTitle ?? '';
    const routes = [];
    if (ed.loreto) routes.push({
      label: ed.loreto.label ?? 'Desde Loreto',
      description: ed.loreto.desc ?? '',
      distance: ed.loreto.distance ?? '',
      time: ed.loreto.time ?? '',
      image: ed.loreto.image ?? '',
    });
    if (ed.laPaz) routes.push({
      label: ed.laPaz.label ?? 'Desde La Paz',
      description: ed.laPaz.desc ?? '',
      distance: ed.laPaz.distance ?? '',
      time: ed.laPaz.time ?? '',
      image: ed.laPaz.image ?? '',
    });
    guideData.directions = routes;
    guideData.drivingTips = Array.isArray(ed.drivingTips)
      ? ed.drivingTips.map((t: any) => ({ text: typeof t === 'string' ? t : t.text ?? '' }))
      : [];
  }
  if (guideAmenities?.extraData) {
    const ed = guideAmenities.extraData;
    guideData.amenitiesHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.amenities = Array.isArray(ed.items)
      ? ed.items.map((i: any) => ({
          icon: i.icon ?? 'wifi',
          title: i.title ?? '',
          text: i.text ?? '',
        }))
      : [];
  }
  if (guideTouristMap?.extraData) {
    const ed = guideTouristMap.extraData;
    guideData.touristMapHeader = { title: ed.title ?? '', subtitle: '' };
    guideData.touristMapImage = ed.image ?? '';
    guideData.touristMapCaption = ed.caption ?? '';
  }
  if (guideCta?.extraData || guideCta) {
    const ed = guideCta?.extraData ?? {};
    guideData.finalCta = {
      title: ed.title ?? guideCta?.title ?? '',
      description: ed.description ?? guideCta?.text ?? '',
      buttonLabel: ed.buttonLabel ?? '',
      buttonLink: ed.buttonLink ?? '',
    };
  }

  if (Object.keys(guideData).length > 0) {
    if (existingGuide) {
      await guidePageService.update({
        where: { id: existingGuide.id },
        data: guideData,
      });
      console.log(`[migrate] Updated guide-page (id=${existingGuide.id})`);
    } else {
      const created = await guidePageService.create({ data: guideData });
      console.log(`[migrate] Created guide-page (id=${created.id})`);
    }
  } else {
    console.log('[migrate] No guide-content found — guide-page left empty (populate manually in admin)');
  }

  // ─── Experiences page ──────────────────────────────────────────────────────
  console.log('\n[migrate] Checking experiences-page...');
  console.log('[migrate] experiences-page has no existing site-content data to migrate.');
  console.log('[migrate] Populate hero/intro/CTA manually in Strapi admin after migration.');

  console.log('\n[migrate] Done.');
  console.log('  Review the populated single types in Strapi admin:');
  console.log('    Settings > Experiences Page > about-page > guide-page');
  console.log('  Publish each entry when ready.');
}

migrate().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
