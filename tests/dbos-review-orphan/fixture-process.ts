import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export function sanitizeDiagnostic(text: string, secrets: readonly string[] = []) {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[redacted]');
  return safe
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[redacted-url]')
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[^\s'",;]+/gi, 'Bearer [redacted]');
}

type ErrorDiagnostic = {
  fields: Record<string, string>;
  cause?: ErrorDiagnostic;
  truncated?: true;
};
export function errorDiagnostic(error: unknown, secrets: readonly string[] = []): ErrorDiagnostic {
  const seen = new Set<unknown>();
  function visit(value: unknown, depth: number): ErrorDiagnostic {
    if (depth === 5 || seen.has(value)) return { fields: {}, truncated: true };
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
      return { fields: { message: sanitizeDiagnostic(String(value), secrets).slice(0, 2048) } };
    seen.add(value);
    const fields: Record<string, string> = {};
    for (const key of [
      'name',
      'message',
      'stack',
      'code',
      'severity',
      'detail',
      'hint',
      'schema',
      'table',
      'constraint',
      'routine',
    ]) {
      const field: unknown = Reflect.get(value, key);
      if (typeof field === 'string' || typeof field === 'number')
        fields[key] = sanitizeDiagnostic(String(field), secrets).slice(
          0,
          key === 'stack' ? 4096 : 2048,
        );
    }
    if (fields.code && /^[A-Z0-9]{5}$/.test(fields.code)) fields.sqlstate = fields.code;
    const cause: unknown = Reflect.get(value, 'cause');
    return { fields, ...(cause === undefined ? {} : { cause: visit(cause, depth + 1) }) };
  }
  return visit(error, 0);
}
export function fixtureErrorMessage(options: {
  kind: string;
  error: unknown;
  pid: number;
  database?: string;
  stage: string;
  requestId?: string;
  secrets?: readonly string[];
}) {
  const diagnostic = errorDiagnostic(options.error, options.secrets);
  return {
    kind: options.kind,
    error: `${diagnostic.fields.stack ?? diagnostic.fields.message ?? 'Fixture error'}\n${JSON.stringify(diagnostic)}`,
    diagnostic,
    pid: options.pid,
    database:
      options.database && sanitizeDiagnostic(options.database, options.secrets).slice(0, 128),
    stage: sanitizeDiagnostic(options.stage, options.secrets).slice(0, 128),
    requestId:
      options.requestId && sanitizeDiagnostic(options.requestId, options.secrets).slice(0, 256),
  };
}

export const fixtureMessageSchema = z
  .object({
    kind: z.string(),
    boundary: z.string().optional(),
    workflowId: z.string().optional(),
    requestId: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();
type FixtureMessage = z.infer<typeof fixtureMessageSchema>;

export async function waitForFixtureMessage(options: {
  messages: FixtureMessage[];
  expected: string;
  exited: () => boolean;
  evidence: () => unknown;
  timeoutMs: number;
  accept?: (message: FixtureMessage) => boolean;
}) {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const unexpectedIndex = options.messages.findIndex(
      (message) =>
        (message.kind === 'failure' && options.expected !== 'failure') ||
        (message.kind === 'rejected' &&
          !['rejected', 'ack-or-rejected'].includes(options.expected)),
    );
    const index = options.messages.findIndex(
      (message) =>
        (options.expected === 'ack-or-rejected'
          ? ['ack', 'rejected'].includes(message.kind)
          : message.kind === options.expected) &&
        (!options.accept || options.accept(message)),
    );
    if (index >= 0 && (unexpectedIndex < 0 || index < unexpectedIndex))
      return fixtureMessageSchema.parse(options.messages.splice(index, 1)[0]);
    if (unexpectedIndex >= 0)
      throw new Error(
        sanitizeDiagnostic(
          `Unexpected IPC while waiting for ${options.expected}: ${JSON.stringify({ message: options.messages[unexpectedIndex], evidence: options.evidence() })}`,
        ),
      );
    if (options.exited() || Date.now() >= deadline)
      throw new Error(
        sanitizeDiagnostic(
          `Child ${options.exited() ? 'exited' : 'timed out'} waiting for ${options.expected}: ${JSON.stringify(options.evidence())}`,
        ),
      );
    await delay(25);
  }
}

export type ChildExit = [number | null, NodeJS.Signals | null];
type KillableChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;
async function exitedWithin(exited: Promise<ChildExit>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function cleanupOwnedChildren<T extends KillableChild>(
  children: Map<T, Promise<ChildExit>>,
  graceMs = 1000,
  killMs = 5000,
) {
  const results = await Promise.allSettled(
    [...children].map(async ([child, exited]) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!(await exitedWithin(exited, graceMs))) {
        child.kill('SIGKILL');
        if (!(await exitedWithin(exited, killMs)))
          throw new Error(`Owned child ${child.pid} did not exit after SIGKILL`);
      }
      children.delete(child);
    }),
  );
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Owned fixture child cleanup failed');
}

export function assertFixtureCanReset(children: Iterable<{ pid?: number }>, blocked?: string) {
  const pids = [...children].map((child) => child.pid);
  if (pids.length) throw new Error(`Reset refused with owned children: ${JSON.stringify(pids)}`);
  if (blocked) throw new Error(`Fixture suite blocked; durable evidence preserved: ${blocked}`);
}
export function nonterminalDurableWork(
  workflows: readonly { workflow_uuid: string; status: string }[],
) {
  return workflows.filter(
    (row) =>
      !['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status),
  );
}

// This checks the retained cron fixture ledger before either scenario can reset phases.
const cronFamilySchema = z.enum([
  'prune_orphan_conversation_sessions',
  'prune_orphan_placement_sessions',
]);
const cronLedgerSchema = z.object({
  workflows: z.array(
    z.object({ workflow_uuid: z.string(), name: cronFamilySchema, status: z.string() }),
  ),
  ticks: z.array(
    z.object({
      family: cronFamilySchema,
      tick_id: z.string(),
      backend: z.enum(['pg-boss', 'dbos']),
      candidates: z.array(z.object({ sessionId: z.string() })),
    }),
  ),
  receipts: z.array(
    z.object({ family: cronFamilySchema, tick_id: z.string(), session_id: z.string() }),
  ),
});
export function assertSettledCronLedger(raw: unknown) {
  const ledger = cronLedgerSchema.parse(raw);
  for (const workflow of ledger.workflows) {
    if (workflow.status !== 'SUCCESS')
      throw new Error(`Unsettled native workflow ${workflow.workflow_uuid}: ${workflow.status}`);
    if (
      !ledger.ticks.some(
        (tick) =>
          tick.family === workflow.name &&
          tick.tick_id === workflow.workflow_uuid &&
          tick.backend === 'dbos',
      )
    )
      throw new Error(`SUCCESS without admission ${workflow.name}/${workflow.workflow_uuid}`);
  }
  for (const tick of ledger.ticks) {
    if (
      tick.backend === 'dbos' &&
      !ledger.workflows.some(
        (workflow) => workflow.name === tick.family && workflow.workflow_uuid === tick.tick_id,
      )
    )
      throw new Error(`Native admission without workflow ${tick.family}/${tick.tick_id}`);
    for (const candidate of tick.candidates)
      if (
        !ledger.receipts.some(
          (receipt) =>
            receipt.family === tick.family &&
            receipt.tick_id === tick.tick_id &&
            receipt.session_id === candidate.sessionId,
        )
      )
        throw new Error(
          `Frozen candidate without receipt ${tick.family}/${tick.tick_id}/${candidate.sessionId}`,
        );
  }
}
