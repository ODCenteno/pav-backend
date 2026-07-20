import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Middlewares => {
  const frontendUrl = env('FRONTEND_URL', 'http://localhost:4321');
  const r2PublicUrl = env('R2_PUBLIC_BASE_URL', '');
  const r2Origin = r2PublicUrl ? new URL(r2PublicUrl).origin : '';

  return [
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
              frontendUrl,
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
              r2Origin,
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
              r2Origin,
            ],
          },
        },
      },
    },
    {
      name: 'strapi::cors',
      config: {
        headers: '*',
        origin: [frontendUrl, 'http://localhost:4321'],
      },
    },
    'strapi::poweredBy',
    'strapi::query',
    'strapi::body',
    'strapi::session',
    'strapi::favicon',
    'strapi::public',
  ];
};

export default config;