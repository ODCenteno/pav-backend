import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        directives: {
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://maps.googleapis.com',
          ],
          'connect-src': [
            "'self'",
            'https://maps.googleapis.com',
            'https://*.googleapis.com',
          ],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://market-assets.strapi.io',
            'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
            'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
            'https://pub-6774f1bb5b50447c89f09d4600081fc6.r2.dev',
            'https://maps.googleapis.com',
            'https://maps.gstatic.com',
            'https://*.googleapis.com',
            'https://*.ggpht.com',
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            'https://strapi-ai-staging.s3.us-east-1.amazonaws.com',
            'https://strapi-ai-production.s3.us-east-1.amazonaws.com',
            'https://pub-6774f1bb5b50447c89f09d4600081fc6.r2.dev',
          ],
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
