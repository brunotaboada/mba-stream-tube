import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Endpoint baked into presigned URLs. It must be reachable by whoever
  // follows the URL, which inside Docker is the Compose service name. A real
  // deployment points this at the public S3/CDN hostname.
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT ||
    process.env.STORAGE_ENDPOINT ||
    'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY || '',
  secretKey: process.env.STORAGE_SECRET_KEY || '',
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.STORAGE_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  urlExpirationSeconds: parseInt(
    process.env.STORAGE_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
