import { config } from 'dotenv';
// Load .env before any module that reads env at import time (e.g. @/db/client,
// which throws on a missing DATABASE_URL at construction). ESM evaluates an
// imported module's side effects before the importing module's later imports.
config({ path: '.env', override: false });
