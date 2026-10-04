import {
  type MemoryIngestReplayRequest,
  MemoryIngestReplayRequestSchema,
} from '../../src/server/memory/memory-ingest-recovery-contract';

export const MEMORY_INGEST_RECOVERY_HELP = `Memory ingest recovery (single-event operator tool)
  list [--after ID] [--limit 1..100]       read-only stalled marker inventory
  replay --event ID --request UUID --expected-fence ID --operator NAME --reason TEXT --allow-paid-replay

Replay preserves all old markers/attempts. It first performs exact Mem0 lookup;
an empty lookup may perform one new paid add for this request, then the ordinary
brief/reconcile fan-out (which can incur further cost). An ambiguous earlier add
may already have succeeded. Reuse the same request and arguments to retry;
new authorization requires a fresh fence from list and accepts that ambiguity.
No batch mode, automatic clearing, production approval, or historical DLQ replay
is implied by this tool. DATABASE_URL selects the target; inspect it privately.
`;

export type MemoryIngestRecoveryCommand =
  | { kind: 'help' }
  | { kind: 'list'; afterId: string; limit: number }
  | { kind: 'replay'; request: MemoryIngestReplayRequest };

export function parseMemoryIngestRecoveryArgs(args: string[]): MemoryIngestRecoveryCommand {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { kind: 'help' };
  const [command, ...rest] = args;
  if (command !== 'list' && command !== 'replay') throw new Error('expected list or replay');
  const allowed = new Set(
    command === 'list'
      ? ['--after', '--limit']
      : [
          '--event',
          '--request',
          '--expected-fence',
          '--operator',
          '--reason',
          '--allow-paid-replay',
        ],
  );
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag || !allowed.has(flag) || flags.has(flag))
      throw new Error('unknown or duplicate option');
    if (flag === '--allow-paid-replay') {
      flags.set(flag, 'true');
      continue;
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  if (command === 'list') {
    const rawLimit = flags.get('--limit') ?? '50';
    const limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('limit must be 1..100');
    return { kind: 'list', afterId: flags.get('--after') ?? '', limit };
  }
  const parsed = MemoryIngestReplayRequestSchema.safeParse({
    sourceEventId: flags.get('--event'),
    requestId: flags.get('--request'),
    expectedFenceId: flags.get('--expected-fence'),
    operator: flags.get('--operator'),
    reason: flags.get('--reason'),
    allowPaidReplay: flags.has('--allow-paid-replay'),
  });
  if (!parsed.success)
    throw new Error(
      'replay requires one event, UUID request, expected fence, operator, reason and --allow-paid-replay',
    );
  return { kind: 'replay', request: parsed.data };
}
