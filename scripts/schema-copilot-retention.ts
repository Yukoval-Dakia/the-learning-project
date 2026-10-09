import ts from 'typescript';
import type { WriteStatement } from './audit-schema-writes';

// ADR-0063 retains these physical inventories across installations. The
// continuation has no current writer; subagent_run also has native consumers.
export const CONTINUATION_COLUMNS: Readonly<Record<string, string>> = {
  id: 'text',
  subagent_run_id: 'text',
  session_id: 'text',
  parent_turn_event_id: 'text',
  result_event_id: 'text',
  status: 'text',
  claim_token: 'text',
  lease_expires_at: 'timestamp with time zone',
  task_run_id: 'text',
  reply_event_id: 'text',
  pg_boss_job_id: 'text',
  error_code: 'text',
  error_message: 'text',
  created_at: 'timestamp with time zone',
  started_at: 'timestamp with time zone',
  settled_at: 'timestamp with time zone',
  updated_at: 'timestamp with time zone',
};

export const SUBAGENT_COLUMNS: Readonly<Record<string, string>> = {
  id: 'text',
  session_id: 'text',
  parent_turn_event_id: 'text',
  launch_key: 'text',
  parent_task_run_id: 'text',
  objective_hash: 'text',
  objective: 'text',
  status: 'text',
  cancel_requested_by: 'text',
  cancel_requested_at: 'timestamp with time zone',
  claim_token: 'text',
  lease_expires_at: 'timestamp with time zone',
  hard_deadline_at: 'timestamp with time zone',
  child_task_run_id: 'text',
  started_event_id: 'text',
  settled_event_id: 'text',
  pg_boss_job_id: 'text',
  result_md: 'text',
  error_code: 'text',
  error_message: 'text',
  created_at: 'timestamp with time zone',
  started_at: 'timestamp with time zone',
  settled_at: 'timestamp with time zone',
  updated_at: 'timestamp with time zone',
};

export const RETIRED_SUBAGENT_COLUMNS = new Set([
  'claim_token',
  'hard_deadline_at',
  'child_task_run_id',
  'pg_boss_job_id',
]);

const NATIVE_UPDATE_COLUMNS = new Set([
  'status',
  'result_md',
  'error_code',
  'error_message',
  'settled_event_id',
  'settled_at',
  'lease_expires_at',
  'updated_at',
  'cancel_requested_by',
  'cancel_requested_at',
]);

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

/** Bounded construction evidence; unresolved payloads cannot prove a native write. */
export function nativeSubagentWriteViolation(statement: WriteStatement): string | undefined {
  if (statement.explicitPayload !== true) return 'unresolved native child payload';
  const file = ts.createSourceFile(
    'payload.ts',
    `const value = ${statement.payload}`,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = file.statements[0];
  const value =
    declaration && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations[0]?.initializer
      : undefined;
  if (!value || !ts.isObjectLiteralExpression(value) || value.properties.length === 0)
    return 'native child payload must be a non-empty explicit object';
  const assignments = new Map<string, ts.Expression>();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      return 'unresolved native child property';
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      return 'unresolved native child column';
    const name = property.name.text;
    if (RETIRED_SUBAGENT_COLUMNS.has(name)) return `retired mailbox column ${name}`;
    if (!Object.hasOwn(SUBAGENT_COLUMNS, name)) return `unknown native child column ${name}`;
    if (statement.kind === 'update' && !NATIVE_UPDATE_COLUMNS.has(name))
      return `native child updates cannot change launch column ${name}`;
    if (assignments.has(name)) return `duplicate native child column ${name}`;
    assignments.set(
      name,
      unwrap(ts.isPropertyAssignment(property) ? property.initializer : property.name),
    );
  }
  const lease = assignments.get('lease_expires_at');
  if (lease && lease.kind !== ts.SyntaxKind.NullKeyword)
    return 'native children cannot acquire mailbox leases; only explicit null cleanup is permitted';
  if (statement.kind === 'insert') {
    const status = assignments.get('status');
    if (
      !status ||
      !ts.isStringLiteral(status) ||
      status.text !== 'running' ||
      statement.nativeStartedAt !== true
    )
      return 'native child inserts must explicitly start running with a constructed started_at date';
  } else {
    const status = assignments.get('status');
    if (
      status &&
      (!statement.statusValues?.length ||
        statement.statusValues.some(
          (value) => !['succeeded', 'failed', 'cancelled', 'lost'].includes(value),
        ))
    )
      return 'native child status updates must prove terminal outcomes, never mailbox reactivation';
  }
  return undefined;
}
