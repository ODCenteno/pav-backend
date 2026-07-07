import { factories } from '@strapi/strapi';

export default factories.createCoreController(
  'api::site-content.site-content',
  ({ strapi }) => ({
    async findOne(ctx) {
      const { id } = ctx.params;
      const locale = ctx.query.locale as string | undefined;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!uuidRegex.test(id)) {
        const results = await strapi
          .service('api::site-content.site-content')
          .findByKey(id, locale);

        if (results && results.length > 0) {
          const sanitized = await this.sanitizeOutput(results[0], ctx);
          return this.transformResponse(sanitized);
        }
        return ctx.notFound('Site content not found');
      }

      return super.findOne(ctx);
    },
  }),
);