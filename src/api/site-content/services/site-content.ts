import { factories } from '@strapi/strapi';

export default factories.createCoreService(
  'api::site-content.site-content',
  ({ strapi }) => ({
    async findByKey(key: string, locale?: string) {
      const results = await strapi.db
        .query('api::site-content.site-content')
        .findMany({
          where: { key },
          populate: {},
        });

      if (!locale) {
        return results;
      }

      const filtered = results.filter((r: { locale?: string }) => r.locale === locale);
      return filtered.length > 0 ? filtered : results;
    },
  }),
);