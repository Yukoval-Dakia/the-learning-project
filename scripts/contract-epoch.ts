// YUK-1055 — DB contract epoch 运维 CLI（cutover runbook 的 marker 读写口）。
//
// 用法（全部需要显式 --target=<postgres-url>；写命令另要 --confirm-write + --actor）：
//   pnpm migration:epoch status     --target=<url>
//   pnpm migration:epoch outstanding --target=<url>
//   pnpm migration:epoch begin-prepare --target=<url> --epoch=<name> --actor=<who> [--note=...] --confirm-write
//   pnpm migration:epoch mark-ready    --target=<url> --epoch=<name> --actor=<who> [--note=...] --confirm-write
//   pnpm migration:epoch activate      --target=<url> --epoch=<name> --actor=<who> [--note=...] --confirm-write
//
// 纪律（与 migration-capture/apply 同款）：--target 必须是非空可解析、带 host/db
// 的 postgres URL；写命令必须 --confirm-write。绝不回退 DATABASE_URL。
//
// 语义见 src/server/contract-epoch/rules.ts：
//   begin-prepare → (target, 'preparing')   维护窗：runtime 全 fenced
//   mark-ready    → (target, 'ready')       迁移核验通过、待激活（仍 fenced）
//   activate      → (target, 'active')      统一切换点（同 epoch 可从
//                                          preparing|ready；换 epoch 必须 ready）

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  type EpochTransitionKind,
  readContractEpoch,
  transitionContractEpoch,
} from '@/server/contract-epoch';
import { reportOutstandingBossJobs } from '@/server/contract-epoch/boss-fence';

const USAGE = `usage:
  contract-epoch status|outstanding --target=<postgres-url>
  contract-epoch begin-prepare|mark-ready|activate --target=<postgres-url> --epoch=<name> --actor=<who> [--note=...] --confirm-write`;

function parseArgs(argv: string[]): {
  command: string;
  target: string | null;
  epoch: string | null;
  actor: string | null;
  note: string | null;
  confirmWrite: boolean;
} {
  const out = {
    command: '',
    target: null as string | null,
    epoch: null as string | null,
    actor: null as string | null,
    note: null as string | null,
    confirmWrite: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--target=')) out.target = arg.slice('--target='.length);
    else if (arg.startsWith('--epoch=')) out.epoch = arg.slice('--epoch='.length);
    else if (arg.startsWith('--actor=')) out.actor = arg.slice('--actor='.length);
    else if (arg.startsWith('--note=')) out.note = arg.slice('--note='.length);
    else if (arg === '--confirm-write') out.confirmWrite = true;
    else if (!arg.startsWith('--') && !out.command) out.command = arg;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return out;
}

/** migration-capture/apply 同款 target gate：非空、可解析、host+db 齐备。 */
function requireTarget(raw: string | null): string {
  if (!raw || raw.trim().length === 0) {
    throw new Error(`--target is required (never falls back to DATABASE_URL)\n${USAGE}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--target is not a parseable URL: ${JSON.stringify(raw)}`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || url.pathname === '/') {
    throw new Error(
      `--target must be a postgres URL with host and database: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

const TRANSITION_KIND: Record<string, EpochTransitionKind> = {
  'begin-prepare': 'begin_prepare',
  'mark-ready': 'mark_ready',
  activate: 'activate',
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = requireTarget(args.target);
  const client = postgres(target, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Db;
  try {
    if (args.command === 'status') {
      const marker = await readContractEpoch(db);
      console.log(
        '[contract-epoch] current:',
        marker === null
          ? '(implicit legacy/active — table absent or empty)'
          : `${marker.epoch}/${marker.state} seq=${marker.seq} ` +
              `entered_at=${marker.enteredAt.toISOString()} by=${marker.enteredBy}` +
              (marker.note ? ` note=${JSON.stringify(marker.note)}` : ''),
      );
      return;
    }
    if (args.command === 'outstanding') {
      const rows = await reportOutstandingBossJobs(db);
      if (rows.length === 0) {
        console.log('[contract-epoch] outstanding: none (or pgboss schema absent)');
        return;
      }
      for (const row of rows) {
        console.log(
          `[contract-epoch] outstanding ${row.queue} ${row.state}=${row.count} → ${row.disposition}`,
        );
      }
      const rollup = new Map<string, number>();
      for (const row of rows)
        rollup.set(row.disposition, (rollup.get(row.disposition) ?? 0) + row.count);
      console.log(
        '[contract-epoch] outstanding rollup:',
        [...rollup.entries()].map(([k, v]) => `${k}=${v}`).join(' '),
      );
      return;
    }
    const kind = TRANSITION_KIND[args.command];
    if (kind !== undefined) {
      if (!args.confirmWrite) {
        throw new Error(
          `'${args.command}' writes the epoch marker — pass --confirm-write\n${USAGE}`,
        );
      }
      if (!args.epoch) throw new Error(`'${args.command}' requires --epoch=<name>\n${USAGE}`);
      if (!args.actor) throw new Error(`'${args.command}' requires --actor=<who>\n${USAGE}`);
      const result = await transitionContractEpoch(
        db,
        kind,
        args.epoch,
        args.actor,
        args.note ?? undefined,
      );
      console.log(
        `[contract-epoch] ${args.command} → ${result.epoch}/${result.state} (seq ${result.seq})`,
      );
      return;
    }
    throw new Error(`unknown command: ${args.command || '(none)'}\n${USAGE}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[contract-epoch] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
