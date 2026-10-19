/**
 * audit:tool-params — YUK-1559 (C1): every tool the pi lane can mount must
 * compile to a JSON Schema whose ROOT declares type:"object".
 *
 * Wire evidence: opencode-go/deepseek-v4.1-flash rejected the admission
 * structured-submit tool with 400 `schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'` — a Zod union compiles to a bare
 * `anyOf` root. This audit fails the build on ANY registration surface that
 * would wire a non-object-root parameters document, so the next union/
 * primitive/array tool is caught at PR time, not at a paid request.
 *
 * ── COVERED SURFACES (real registration paths, post-conversion schemas) ────
 *   domain_tool        — manifest copilotTools decls → decl.load() →
 *                        inputSchema through zodToToolParametersSchema (the
 *                        same converter buildPiDomainAgentTools + registerTool
 *                        enforce at runtime).
 *   structured_submit  — task-registry kinds with structuredOutputMode:'tool'
 *                        → structuredOutputSchema through the same converter
 *                        (pi-agent-adapter mounts it via piCustomTool).
 *   custom_mount       — the hand-rolled piCustomTool inventories: agency
 *                        evidence server, meeting director server, knowledge
 *                        write_proposal mount, and the Task/Agent spawn tools.
 *                        Checked on the REAL produced AgentTool.parameters.
 *   remote_mcp         — NOT enumerable without a live server; enforced at
 *                        mount composition in connectPiRemoteMcp (mount fails
 *                        loudly on a non-object root). Reported, not scanned.
 *
 * Exit 1 on any violation. No DB, network, or provider calls — tool modules
 * load under a syntactically-valid DATABASE_URL stub (audit-architecture-
 * deepening precedent); tool handlers are never executed.
 */

process.env.DATABASE_URL ??= 'postgresql://audit:unused@127.0.0.1:1/audit?sslmode=disable';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';

const TOOL_PARAMS_PARAMS = { io: 'input', reused: 'inline', target: 'draft-07' } as const;

/** Minimal registry shape this audit reads (mirrors audit-structured-judge). */
type TaskDefLike = {
  structuredOutputMode?: unknown;
  structuredOutputSchema?: ZodTypeAny;
};

interface CheckRow {
  surface: string;
  name: string;
  ok: boolean;
  detail?: string;
}

function isObjectRoot(parameters: unknown): boolean {
  return (
    typeof parameters === 'object' &&
    parameters !== null &&
    !Array.isArray(parameters) &&
    (parameters as { type?: unknown }).type === 'object'
  );
}

async function main(): Promise<void> {
  const { zodToToolParametersSchema } = await import('@/kernel/zod-json-schema');
  const { capabilities } = await import('@/capabilities/index');
  const { tasks } = await import('@/capabilities/task-registry');

  const rows: CheckRow[] = [];

  // ── domain_tool: the DomainTool registry surface (manifest decl.load()). ──
  for (const cap of capabilities) {
    for (const decl of cap.copilotTools?.tools ?? []) {
      if (!decl.load) continue;
      const surface = `domain_tool(${cap.name})`;
      try {
        const tool = (await decl.load()) as {
          name?: string;
          inputSchema?: Parameters<typeof zodToToolParametersSchema>[0];
        };
        const name = tool.name ?? decl.name;
        if (tool.inputSchema === undefined || tool.inputSchema === null) {
          rows.push({ surface, name, ok: false, detail: 'tool has no inputSchema' });
          continue;
        }
        try {
          const parameters = zodToToolParametersSchema(tool.inputSchema, TOOL_PARAMS_PARAMS);
          rows.push({
            surface,
            name,
            ok: isObjectRoot(parameters),
            ...(isObjectRoot(parameters)
              ? {}
              : { detail: `converted root type is ${JSON.stringify(parameters.type ?? null)}` }),
          });
        } catch (error) {
          rows.push({
            surface,
            name,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        rows.push({
          surface,
          name: decl.name,
          ok: false,
          detail: `load() failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  // ── structured_submit: tool-mode task output schemas become the submit
  //    tool's parameters via pi-agent-adapter → piCustomTool. ──
  for (const [kind, def] of Object.entries(tasks as Record<string, TaskDefLike>)) {
    if (def.structuredOutputMode !== 'tool') continue;
    const name = `${kind} → mcp__structured_output__submit`;
    if (def.structuredOutputSchema === undefined) {
      rows.push({
        surface: 'structured_submit',
        name,
        ok: false,
        detail: "structuredOutputMode:'tool' without a structuredOutputSchema",
      });
      continue;
    }
    try {
      const parameters = zodToToolParametersSchema(def.structuredOutputSchema, TOOL_PARAMS_PARAMS);
      rows.push({
        surface: 'structured_submit',
        name,
        ok: isObjectRoot(parameters),
        ...(isObjectRoot(parameters)
          ? {}
          : { detail: `converted root type is ${JSON.stringify(parameters.type ?? null)}` }),
      });
    } catch (error) {
      rows.push({
        surface: 'structured_submit',
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── custom_mount: hand-rolled piCustomTool inventories — check the REAL
  //    AgentTool.parameters each builder produces. ──
  const customTools: { wire: string; parameters: unknown }[] = [];
  {
    const { buildEvidenceServer } = await import('@/capabilities/agency/server/scout/evidence-mcp');
    const { createFindingsCapture } = await import(
      '@/capabilities/agency/server/scout/report-findings'
    );
    const { buildDirectorServer, createDirectorCaps } = await import(
      '@/capabilities/agency/server/meeting/director-tools'
    );
    const { buildKnowledgeReviewPiMount } = await import('@/capabilities/knowledge/server/review');
    const { buildPiSpawnAgentTools } = await import('@/server/ai/tools/pi-subagent');

    const evidence = buildEvidenceServer({
      db: {} as never,
      now: new Date(),
      selfSourceKind: 'audit:tool-params',
      capture: createFindingsCapture(),
    });
    const director = buildDirectorServer({
      db: {} as never,
      now: new Date(),
      meetingContext: {
        pending_conjectures: [],
        candidate_cells: [],
        recent_failure_summary: { window_days: 0, total_failures: 0, distinct_kcs: 0 },
      },
      knownConjectureKeys: new Set(),
      caps: createDirectorCaps(),
      triggerEventId: 'audit',
      toolContextTaskRunId: 'audit',
      parentLifecycleSignal: new AbortController().signal,
      failureAttempts: [],
      runTaskFn: (() => Promise.reject(new Error('audit stub — never called'))) as never,
    });
    const writeProposal = buildKnowledgeReviewPiMount({} as never, 'audit');
    const spawn = buildPiSpawnAgentTools(
      {},
      { runNested: () => Promise.reject(new Error('audit stub — never called')) },
    );
    for (const tool of [
      ...evidence.tools,
      ...director.tools,
      ...(writeProposal.type === 'custom' ? writeProposal.tools : []),
      ...spawn,
    ]) {
      customTools.push({ wire: tool.name, parameters: tool.parameters });
    }
  }
  for (const tool of customTools) {
    rows.push({
      surface: 'custom_mount',
      name: tool.wire,
      ok: isObjectRoot(tool.parameters),
      ...(isObjectRoot(tool.parameters)
        ? {}
        : {
            detail: `mounted parameters root type is ${JSON.stringify(
              (tool.parameters as { type?: unknown } | null | undefined)?.type ?? null,
            )}`,
          }),
    });
  }

  const violations = rows.filter((row) => !row.ok);
  const bySurface = new Map<string, { scanned: number; failed: number }>();
  for (const row of rows) {
    const entry = bySurface.get(row.surface) ?? { scanned: 0, failed: 0 };
    entry.scanned += 1;
    if (!row.ok) entry.failed += 1;
    bySurface.set(row.surface, entry);
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, violations }, null, 2));
    if (violations.length > 0) process.exit(1);
    return;
  }

  console.log('audit:tool-params — tool parameters root must declare type:"object" (YUK-1559)\n');
  console.log('  scanned surfaces (post-conversion wire schemas):');
  for (const [surface, stat] of [...bySurface.entries()].sort()) {
    console.log(`    - ${surface.padEnd(28)} ${stat.scanned} tool(s), ${stat.failed} violation(s)`);
  }
  console.log(
    '    - remote_mcp (not enumerable — enforced at mount composition in connectPiRemoteMcp)',
  );
  console.log('');

  if (violations.length === 0) {
    console.log('  VIOLATIONS: (none)');
  } else {
    console.log(`  VIOLATIONS (tool parameters root is not type:"object"):  ${violations.length}`);
    for (const row of violations) {
      console.log(`    - [${row.surface}] ${row.name}: ${row.detail ?? 'non-object root'}`);
    }
    console.log(
      '\n  Fix: declare the parameters root as a JSON Schema object. A union of pure object\n' +
        '  schemas is normalized by zodToToolParametersSchema (type:"object" + anyOf kept); a\n' +
        '  genuinely non-object input (array/primitive) must be re-contracted against its real\n' +
        '  consumer — do not mask it behind an empty object.',
    );
  }

  if (violations.length > 0) process.exit(1);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
