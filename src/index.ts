import type { Core } from '@strapi/strapi';
import { subscribeSharedSlugSync } from './sync-shared-slug';

const PUBLIC_PERMISSIONS = [
  'api::category.category.find',
  'api::category.category.findOne',
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::community-member.community-member.find',
  'api::community-member.community-member.findOne',
  'api::community.community.find',
  'api::community.community.findOne',
  'api::site-content.site-content.find',
  'api::site-content.site-content.findOne',
  'api::legal-page.legal-page.find',
  'api::legal-page.legal-page.findOne',
  'api::site-global.site-global.find',
  'api::homepage.homepage.find',
  'api::good-practices-page.good-practices-page.find',
];

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    subscribeSharedSlugSync(strapi);
    await seedPublicPermissions(strapi);
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
