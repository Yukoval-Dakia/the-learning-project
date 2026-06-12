import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { buildLocalDevEnv } from './local-db-env';

config({ path: '.env', override: false });

const localEnv = buildLocalDevEnv(process.env);

// M5-T5c (YUK-321) — gate 选项 b：双进程拓扑（app + worker）。
// LISTEN loop 不消费 boss job，dev 也必须有独立 worker 进程。
// worker:dev 经此处 env 注入 DATABASE_URL，免手动 source .env。
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: localEnv.DATABASE_URL,
  NEXT_PUBLIC_BASE_URL: localEnv.NEXT_PUBLIC_BASE_URL,
};

const api = spawn('pnpm', ['rw:api'], { stdio: 'inherit', env });
const web = spawn('pnpm', ['rw:web'], { stdio: 'inherit', env });
const worker = spawn('pnpm', ['worker:dev'], { stdio: 'inherit', env });
const children = [api, web, worker];

const stop = (code: number | null) => {
  for (const c of children) c.kill('SIGINT');
  process.exit(code ?? 0);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const c of children) c.on('exit', stop);
