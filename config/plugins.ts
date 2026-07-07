import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  i18n: {
    enabled: true,
    config: {
      locales: ['es-MX', 'en'],
      defaultLocale: 'es-MX',
    },
  },
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        endpoint: env('R2_ENDPOINT'),
        baseUrl: env('R2_PUBLIC_BASE_URL'),
        params: {
          Bucket: env('R2_BUCKET'),
          ACL: undefined, // No public read access by default; use signed URLs for access
        },
        s3Options: {
          credentials: {
            accessKeyId: env('R2_ACCESS_KEY_ID'),
            secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
          },
          region: 'auto',
        },
        providerConfig: {
          checksumAlgorithm: 'CRC32', // Options: 'CRC32', 'CRC32C', 'SHA1', 'SHA256', 'CRC64NVME'
          preventOverwrite: true,
        },
        forcePathStyle: true,
      },
      sizeLimit: 3 * 1024 * 1024, // 3 MB
      security: {
        allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    },
  },
});

export default config;

