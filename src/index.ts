import type { Core } from '@strapi/strapi';
import { subscribeSharedSlugSync } from './sync-shared-slug';

const PUBLIC_PERMISSIONS = [
  'api::category.category.find',
  'api::category.category.findOne',
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::community-member.community-member.find',
  'api::community-member.community-member.findOne',
  'api::team-member.team-member.find',
  'api::team-member.team-member.findOne',
  'api::organization.organization.find',
  'api::organization.organization.findOne',
  'api::site-content.site-content.find',
  'api::site-content.site-content.findOne',
  'api::legal-page.legal-page.find',
  'api::legal-page.legal-page.findOne',
  'api::site-global.site-global.find',
  'api::homepage.homepage.find',
  'api::experiences-page.experiences-page.find',
  'api::about-page.about-page.find',
  'api::guide-page.guide-page.find',
];

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    subscribeSharedSlugSync(strapi);
    await seedPublicPermissions(strapi);
    await migrateSocialToContact(strapi);
  },
};

async function seedPublicPermissions(strapi: Core.Strapi) {
  const publicRole = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    strapi.log.warn('Public role not found; skipping permission bootstrap');
    return;
  }

  for (const action of PUBLIC_PERMISSIONS) {
    const existing = await strapi.db
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });

    if (!existing) {
      await strapi.db
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
      strapi.log.info(`Granted public permission: ${action}`);
    }
  }
}

/**
 * One-time migration: consolidate social-links component data into contact-info.
 *
 * - Listings: backfill any explicit social-links data (instagram handles, etc.)
 *   into the listing's contact-info component if the field is empty there.
 * - Community members: copy native phone/whatsapp fields into the new
 *   contact-info component.
 *
 * Guarded by a core-store flag so it only runs once.
 */
async function migrateSocialToContact(strapi: Core.Strapi) {
  const STORE_KEY = 'migration_social_to_contact_v1';
  const coreStore = strapi.store({ type: 'core', name: '' });
  const alreadyRun = await coreStore.get({ key: STORE_KEY });

  if (alreadyRun) {
    return;
  }

  strapi.log.info('[migration] Starting social→contact consolidation...');

  // 1. Migrate listing social-links → contact-info
  try {
    const listings = await strapi.db.query('api::listing.listing').findMany({
      select: ['id', 'documentId'],
      populate: { contact: true, social: true },
    });

    let listingCount = 0;
    for (const listing of listings) {
      const explicitSocial = (listing as any).social;
      const contact = (listing as any).contact;

      if (!explicitSocial || !Array.isArray(explicitSocial) || explicitSocial.length === 0) {
        continue;
      }

      // Find the first non-empty social entry with an instagram handle
      const igEntry = explicitSocial.find(
        (s: any) => s?.platform === 'instagram' && (s?.handle?.trim() || s?.url?.trim())
      );

      if (igEntry && contact && !contact.instagram) {
        const handle = (igEntry.handle || '').replace(/^@/, '').trim()
          || (igEntry.url || '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');

        if (handle) {
          await strapi.db.query('components_contact_contact_infos').update({
            where: { id: contact.id },
            data: { instagram: handle },
          });
          listingCount++;
        }
      }
    }
    strapi.log.info(`[migration] Migrated ${listingCount} listing social entries → contact-info`);
  } catch (err) {
    strapi.log.warn('[migration] Listing social→contact migration failed (non-fatal):', err);
  }

  // 2. Migrate community-member phone/whatsapp → contact-info
  try {
    const members = await strapi.db.query('api::community-member.community-member').findMany({
      select: ['id'],
      populate: { contact: true },
    });

    let memberCount = 0;
    for (const member of members) {
      const phone = (member as any).phone;
      const whatsapp = (member as any).whatsapp;
      const existingContact = (member as any).contact;

      if (!phone && !whatsapp) continue;
      if (existingContact) continue; // already has a contact component

      // Create a new contact-info component and link it
      const newContact = await strapi.db.query('components_contact_contact_infos').create({
        data: {
          phone: phone || null,
          whatsapp: whatsapp || null,
        },
      });

      await strapi.db.query('api::community-member.community-member').update({
        where: { id: member.id },
        data: { contact: newContact.id },
      });
      memberCount++;
    }
    strapi.log.info(`[migration] Migrated ${memberCount} community-member phone/whatsapp → contact-info`);
  } catch (err) {
    strapi.log.warn('[migration] Community-member contact migration failed (non-fatal):', err);
  }

  await coreStore.set({ key: STORE_KEY, value: true });
  strapi.log.info('[migration] social→contact consolidation complete.');
}
