import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_VIDEOS_BUCKET: Joi.string().default('streamtube-videos'),
  STORAGE_THUMBNAILS_BUCKET: Joi.string().default('streamtube-thumbnails'),
  STORAGE_URL_EXPIRATION_SECONDS: Joi.number().positive().default(3600),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_MAX_SIZE_BYTES: Joi.number().positive().default(10737418240),
  VIDEO_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .min(5242880)
    .default(104857600),
  VIDEO_ALLOWED_MIME_TYPES: Joi.string().default(
    'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo',
  ),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().positive().default(3),
  VIDEO_FFMPEG_TIMEOUT_MS: Joi.number().positive().default(300000),
});
