import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { buildLocalDatabaseUrl } from './local-db-env';

config({ path: '.env', override: false });

const child = spawn('drizzle-kit', ['migrate'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: buildLocalDatabaseUrl(process.env),
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
