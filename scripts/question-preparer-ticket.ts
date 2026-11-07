// Operator entry for a manual gap ticket. ADR-0078 D2 keeps manual requests as one of the
// three ticket sources; this script is that seam. The work order is an EvidenceDemandV1 and
// goes through the same enqueue as the bank-gap tool, so the ticket event, the preparer job
// and the cooldown ledger share one transaction and the 7-day fingerprint cooldown applies.
//
// Without --confirm nothing is written: the script only validates the work order and prints
// the derived target. A write needs --confirm and either NODE_ENV=production (the TEST
// container, whose compose env points DATABASE_URL at that stack) or NODE_ENV=development
// with this worktree's dev database on the dev Postgres (:5434). Everything else is refused
// before a connection opens.
import { readFile } from 'node:fs/promises';
import { buildQuestionPreparerTarget } from '@/capabilities/practice/supply/server/preparer-target';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';
import { DEV_DATABASE_PATTERN, devDatabaseName } from './dev-worktree-db';

const USAGE = 'Usage: tsx scripts/question-preparer-ticket.ts <ticket.json|-> [--confirm]';
/** Ledger attribution for an operator filing; the bank-gap tool keeps its own actor. */
const LEDGER_ACTOR = 'manual_preparer_ticket';

interface CliArgs {
  ticketPath: string;
  confirm: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--confirm') confirm = true;
    else if (arg === '--help' || arg === '-h') throw new Error(USAGE);
    else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown flag ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  const [ticketPath, ...extra] = positional;
  if (!ticketPath || extra.length > 0) throw new Error(USAGE);
  return { ticketPath, confirm };
}

interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
}

/** Write guard: the TEST container (production env) or this worktree's dev database. */
function assertWriteTarget(): DatabaseTarget {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required with --confirm');
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  const target = { host: url.hostname, port: url.port, database };
  // Inside the container the compose env already names that stack's database; the script
  // cannot tell TEST from production, and both are operator-authorized targets.
  if (process.env.NODE_ENV === 'production') return target;
  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      'Refusing to write: use NODE_ENV=production inside the TEST container, or NODE_ENV=development with this worktree dev DATABASE_URL',
    );
  }
  if (url.port !== '5434') {
    throw new Error(
      `Refusing to write: dev writes require the dev Postgres on port 5434, got ${url.port || '(default port)'}`,
    );
  }
  if (!DEV_DATABASE_PATTERN.test(database) || database !== devDatabaseName()) {
    throw new Error(
      `Refusing to write: ${database} is not this worktree's dev database (${devDatabaseName()})`,
    );
  }
  return target;
}

async function readTicket(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const demand = EvidenceDemandV1.parse(JSON.parse(await readTicket(args.ticketPath)));
  // A ticket that can never spend or has expired must not take the 7-day cooldown slot;
  // file_bank_gap holds these too. Cap=0 is not checked here: open the cap before --confirm.
  if (demand.control.max_budget_micro_usd !== null && demand.control.max_budget_micro_usd <= 0) {
    throw new Error('Refusing ticket: control.max_budget_micro_usd is 0');
  }
  if (demand.control.needed_by !== null && Date.parse(demand.control.needed_by) <= Date.now()) {
    throw new Error('Refusing ticket: control.needed_by has passed');
  }
  const target = buildQuestionPreparerTarget(demand, {
    reason: `manual gap ticket (demand_id=${demand.demand_id}) filed by an operator; no search evidence scope`,
  });
  const plan = {
    demand_id: demand.demand_id,
    target_id: target.id,
    fingerprint: target.fingerprint,
    subject_id: target.subjectId,
    knowledge_ids: target.knowledgeIds,
    kind: target.kind,
    difficulty_band: target.difficultyBand,
    desired_count: target.desiredCount,
    min_source_tier: target.minSourceTier,
    route_preference: target.routePreference,
  };
  if (!args.confirm) {
    console.log(JSON.stringify({ status: 'dry_run', ...plan }, null, 2));
    return;
  }

  const database = assertWriteTarget();
  // Load the DB client only after the target is known to be writable: a dry run (and a
  // refused write) must not need DATABASE_URL or open a pool.
  const [{ db }, { enqueueQuestionPreparerTicket }, { getRunningBoss }] = await Promise.all([
    import('@/db/client'),
    import('@/capabilities/practice/supply/server/question-preparer-ticket'),
    import('@/server/boss/client'),
  ]);
  try {
    const result = await enqueueQuestionPreparerTicket(db, demand, target, {
      ledgerActorRef: LEDGER_ACTOR,
    });
    console.log(JSON.stringify({ ...result, ...plan, database }, null, 2));
  } finally {
    const boss = getRunningBoss();
    if (boss) {
      await boss.stop().catch((error: unknown) => {
        console.error('boss.stop() failed:', error);
      });
    }
    await db.$client.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
