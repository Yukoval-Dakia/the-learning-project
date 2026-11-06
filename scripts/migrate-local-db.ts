import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { guardLocalDbTarget, localDatabaseUrl } from './local-db-env';

config({ path: '.env', override: false });

// Refuses TEST targets (ports 5433/5544 or database `loom`) before spawning.
const databaseUrl = localDatabaseUrl(guardLocalDbTarget('db:migrate:local'));

const child = spawn('drizzle-kit', ['migrate'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
