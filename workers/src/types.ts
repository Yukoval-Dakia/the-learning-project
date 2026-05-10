import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export type Bindings = {
  ANTHROPIC_API_KEY: string;
  INTERNAL_TOKEN: string;
  TENCENT_SECRET_ID: string;
  TENCENT_SECRET_KEY: string;
  TENCENT_OCR_REGION: string;
  DB: D1Database;
  IMAGES: R2Bucket;
};

export type AppEnv = { Bindings: Bindings };
