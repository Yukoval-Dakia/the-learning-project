import type { D1Database } from '@cloudflare/workers-types';

export type Bindings = {
  ANTHROPIC_API_KEY: string;
  INTERNAL_TOKEN: string;
  DB: D1Database;
};

export type AppEnv = { Bindings: Bindings };
