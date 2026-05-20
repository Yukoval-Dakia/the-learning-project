import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { buildLocalDevEnv } from './local-db-env';

config({ path: '.env', override: false });

const localEnv = buildLocalDevEnv(process.env);

const child = spawn(
  'next',
  ['dev', '--hostname', '127.0.0.1', '--port', localEnv.LOCAL_NEXT_PORT],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: localEnv.DATABASE_URL,
      NEXT_PUBLIC_BASE_URL: localEnv.NEXT_PUBLIC_BASE_URL,
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
