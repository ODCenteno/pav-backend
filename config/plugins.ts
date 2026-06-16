import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  i18n: {
    enabled: true,
    config: {
      locales: ['es-MX', 'en'],
      defaultLocale: 'es-MX',
    },
  },
});

export default config;

