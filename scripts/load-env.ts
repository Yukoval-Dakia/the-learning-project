import { config } from 'dotenv';
// Load .env before any module that reads env at import time (e.g. @/db/client,
// which throws on a missing DATABASE_URL at construction). ESM evaluates an
// imported module's side effects before the importing module's later imports.
//
// dotenv v17 emits a human-readable banner to stdout when a TTY is attached.
// Suppress it when stdout is not a TTY (pipe / --json parse / CI capture) so
// machine consumers get clean output.  TTY interactive runs keep the banner.
config({ path: '.env', override: false, quiet: !process.stdout.isTTY });
