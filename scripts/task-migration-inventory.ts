import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Offline source inventory. This never imports an application module or opens a database.
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? files(path)
      : path.endsWith('.ts') && !path.includes('.test.')
        ? [path]
        : [];
  });
}
const paths = [...files('src'), ...files('server'), ...files('scripts')];
const sources = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const constants = new Map<string, string>();
for (const { text } of sources) {
  for (const match of text.matchAll(/(?:const|let)\s+(\w+(?:QUEUE|_TZ))\s*=\s*['"]([^'"]+)['"]/g))
    constants.set(match[1], match[2]);
}
function value(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  return null;
}
function props(node: ts.ObjectLiteralExpression) {
  return new Map(
    node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property)
        ? [[property.name.getText(), property.initializer] as const]
        : [],
    ),
  );
}
function imports(node: ts.Node): string[] {
  const result: string[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const path = value(child.arguments[0]);
      if (path) result.push(path);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return result;
}
const rows: {
  name: string;
  owner: string;
  queue: string;
  backend: string;
  cron: string | null;
  tz: string | null;
  dependencies: string | null;
  handlerImports: string[];
  producerSources: string[];
}[] = [];
const declarations = sources.filter(
  ({ path }) =>
    /^src\/capabilities\/[^/]+\/manifest.ts$/.test(path) ||
    ['src/server/boss/handlers.ts', 'src/server/memory/triggers.ts'].includes(path),
);
for (const { path, text } of declarations) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = props(node);
      const name = value(properties.get('name'));
      const queue = value(properties.get('queue'));
      if (name && queue) {
        const schedule = properties.get('schedule');
        const sched =
          schedule && ts.isObjectLiteralExpression(schedule) ? props(schedule) : properties;
        const load = properties.get('load');
        rows.push({
          name,
          owner: path,
          queue,
          backend: value(properties.get('backend')) ?? 'pg-boss',
          cron: value(sched.get('cron')),
          tz: value(sched.get('tz')),
          dependencies: properties.get('dependsOn')?.getText(source) ?? null,
          handlerImports: load ? imports(load) : [],
          producerSources: [],
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const [name, owner, queue, cron, tz] of [
  ['echo', 'src/server/boss/handlers.ts', 'fast', null, null],
  ['memory_event_ingest', 'src/server/memory/triggers.ts', 'llm', null, null],
  ['memory_brief_regen', 'src/server/memory/triggers.ts', 'llm', null, null],
  ['memory_reconcile', 'src/server/memory/triggers.ts', 'llm', null, null],
  [
    'nightly_orchestrator',
    'src/server/orchestration/register.ts',
    'llm',
    '30 2 * * *',
    'Asia/Shanghai',
  ],
  [
    'event_subscription_dispatch',
    'src/server/event-subscriptions/dispatch-mount.ts',
    'fast',
    '* * * * *',
    'Asia/Shanghai',
  ],
] as const)
  rows.push({
    name,
    owner,
    queue,
    backend: 'pg-boss',
    cron,
    tz,
    dependencies: null,
    handlerImports: [],
    producerSources: [],
  });
const dynamicDispatchSources = new Set<string>();
for (const { path, text } of sources) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['send', 'schedule'].includes(node.expression.name.text)
    ) {
      const name = value(node.arguments[0]);
      if (name)
        rows
          .find((row) => row.name === name)
          ?.producerSources.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
      else if (node.expression.expression.getText(source).toLowerCase().includes('boss'))
        dynamicDispatchSources.add(
          `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const output = {
  issue: 'YUK-1355',
  base: 'a6d89037b',
  evidence:
    'Static source declarations and direct dispatch sites; no runtime census or private data.',
  sourceHashes: declarations.map(({ path, text }) => ({
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
  })),
  families: rows
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({
      ...row,
      producerSources: [...new Set(row.producerSources)],
      recoveryOwner:
        row.name === 'prune_job_events'
          ? 'database phase, pg-boss until explicit drain; DBOS after drain'
          : 'pg-boss with existing domain receipt/claim/outbox owner; unchanged',
      dlq: row.queue === 'fast' ? null : `${row.name}_dlq`,
      retry:
        row.name === 'event_subscription_dispatch'
          ? '2 redeliveries, 30s exponential backoff; no DLQ'
          : row.name.startsWith('memory_') && row.queue === 'llm'
            ? 'createJobQueue: 2 redeliveries, 30s exponential backoff; event attempt bookkeeping is domain-owned'
            : row.queue === 'fast'
              ? 'pg-boss default 2, immediate; no DLQ'
              : 'queue-config: 2 redeliveries, 30s exponential backoff',
      idempotencyAndUnknownOutcome:
        row.name === 'prune_job_events'
          ? 'workflow ID + fixed cutoff + atomic delete/receipt; no external calls'
          : 'See per-domain recovery ownership in YUK-1355 runbook; no bulk replay or admission by this inventory',
    })),
  dynamicDispatchSources: [...dynamicDispatchSources].sort(),
  internalQueues: ['__pgboss__send-it is owned by pg-boss, not a business family'],
};
writeFileSync(
  'docs/planning/2026-10-07-yuk1355-task-inventory.json',
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(
  `Inventoried ${rows.length} registered application queues; ${dynamicDispatchSources.size} dynamic dispatch sites require their named domain owner.`,
);
