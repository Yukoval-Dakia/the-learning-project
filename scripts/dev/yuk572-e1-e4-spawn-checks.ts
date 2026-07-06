// YUK-572 PR-2 — E-1..E-4 dev validation harness (spec §10 / §2 / §6).
//
// These four checks are UNPROVABLE from the SDK typings (docstring aliases, no exported
// constants, bypassPermissions vs hook-deny ambiguity) — they are runtime facts that must
// be verified against a REAL `claude` subprocess before the RESEARCH_MEETING_AGENT_ENABLED
// flag is flipped. E-2 / E-3 / E-4 are BLOCKING (§10): if any fails, do NOT flip the flag.
//
//   E-1  Task spawn: the director's allowlist literal 'Task' actually spawns the nested
//        evidence-scout (the scout runs → the spawn-cap hook counts ≥1, and/or the scout
//        writes report_findings). If the runtime tool name were 'Agent', the spawn would
//        silently never fire.
//   E-2  Usage/cost aggregation: the nested scout's usage rolls INTO the parent run's
//        total_cost_usd (§2 — the "no-aggregation fallback" branch was deleted, so the
//        design DEPENDS on this). Verified by a spawn-run cost > a no-spawn-run cost. On
//        the flat OAuth lane total_cost_usd may be 0 → INCONCLUSIVE (inspect modelUsage by
//        hand, §7); NOT a pass — see computeExitCode below (review MAJOR #1: an
//        inconclusive E-2 must NEVER exit 0 and silently authorize flipping the flag).
//   E-3  mcpServers by-name resolution: the scout's AgentDefinition.mcpServers:['research_
//        evidence'] resolves to the top-level in-process server, i.e. the scout can call an
//        evidence read tool (its call lands in the shared evidence toolTrace).
//   E-4  bypassPermissions hook-deny: under permissionMode:'bypassPermissions' (hardcoded
//        in the runner), a PreToolUse deny on the 2nd Task is HONORED → the breadth cap is
//        structural. If not honored, breadth is only a soft maxTurns bound (附录 A #6).
//
// This harness goes through the REAL runAgentTask (so the runner's auth env + the §2
// agents/hooks passthrough + ctx.mcpServers are exercised exactly as production), and
// observes the four properties from OUTSIDE: the spawn-cap hook's own counter, the shared
// evidence toolTrace, the report_findings capture, and the two runs' cost delta.
//
// Requirements (else the harness prints a clear "cannot run" and exits 1 — it never fakes
// a pass): DATABASE_URL + a working provider for the anthropic-sub override
// (CLAUDE_CODE_OAUTH_TOKEN) OR set AI_PROVIDER_OVERRIDE + the matching auth. Run with:
//   RESEARCH_MEETING_AGENT_ENABLED=1 pnpm tsx scripts/dev/yuk572-e1-e4-spawn-checks.ts
//
// Exit codes: 0 = all checks pass (E-1 AND the three blocking checks E-2/E-3/E-4) — safe
// to flip the flag. 1 = cannot run (missing env / harness crash) — no verdict reached. 2 =
// at least one check genuinely FAILED — do not flip. 3 = E-2 is INCONCLUSIVE (flat OAuth
// lane reports total_cost_usd=0) — a human must inspect result.modelUsage by hand before
// the flag may be flipped; this is DISTINCT from both pass (0) and fail (2).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

const REQUIRED_ENV = ['DATABASE_URL'];

interface CheckReport {
  scoutSpawns: number;
  scoutReadToolCalls: number;
  reportFindingsCaptured: boolean;
  costUsd: number;
  taskRunId: string;
}

/**
 * Pure exit-code decision table (review MAJOR #1) — no SDK/DB dependency, so it is
 * directly unit-testable (yuk572-e1-e4-spawn-checks.unit.test.ts). The house style
 * forbids nested ternaries (see director.ts §9/§10 fixes); this is written as a plain
 * if/else chain instead of `blockingOk && e1 ? 0 : e2Inconclusive ? 3 : 2`.
 *
 * CONTRACT: e2Inconclusive must NEVER produce exit 0 — an unmeasured cost delta must
 * never be silently treated as a pass that authorizes flipping the flag.
 */
export interface ECheckOutcome {
  e1: boolean;
  e2Pass: boolean;
  e2Inconclusive: boolean;
  e3: boolean;
  e4: boolean;
}

export function computeExitCode(outcome: ECheckOutcome): number {
  const blockingOk = outcome.e2Pass && outcome.e3 && outcome.e4;
  if (blockingOk && outcome.e1) {
    return 0;
  }
  if (outcome.e2Inconclusive) {
    return 3;
  }
  return 2;
}

async function assembleAndRun(directive: string): Promise<CheckReport> {
  // Dynamic import AFTER loadEnv() (called in main() below): @/db/client reads
  // DATABASE_URL at module top.
  const [
    { db },
    { runAgentTask },
    { buildEvidenceServer },
    { createFindingsCapture },
    { buildEvidenceScoutAgentDefinition },
    { buildDirectorServer, createDirectorCaps, DIRECTOR_ALLOWED_TOOLS },
    { EVIDENCE_SCOUT_CHARTER, RESEARCH_MEETING_AGENT_ACTOR },
    { EVIDENCE_READ_TOOL_NAMES },
  ] = await Promise.all([
    import('@/db/client'),
    import('@/server/ai/runner'),
    import('@/server/agency/scout/evidence-mcp'),
    import('@/server/agency/scout/report-findings'),
    import('@/server/agency/scout/scout-agent'),
    import('@/capabilities/agency/server/meeting/director-tools'),
    import('@/capabilities/agency/server/meeting/director'),
    import('@/server/agency/scout/tool-names'),
  ]);

  const now = new Date();
  const capture = createFindingsCapture();
  const evidence = buildEvidenceServer({
    db,
    now,
    selfSourceKind: RESEARCH_MEETING_AGENT_ACTOR,
    capture,
  });
  const director = buildDirectorServer({
    db,
    now,
    meetingContext: {
      pending_conjectures: [],
      // A synthetic candidate cell so the director has something concrete to hand the
      // scout. The evidence tools may return empty (no seeded rows) — an empty return
      // still proves the mcpServers-by-name resolution (E-3): the CALL landed.
      candidate_cells: [
        {
          knowledge_id: 'kc_validation_probe',
          cause_category: 'concept_confusion',
          recurrence_count: 2,
          baseline_p: 0.5,
          theta_precision: 1.0,
          probe_here: true,
          evidence_event_ids: ['att_validation_1', 'att_validation_2'],
        },
      ],
      recent_failure_summary: { window_days: 14, total_failures: 2, distinct_kcs: 1 },
    },
    knownConjectureKeys: new Set<string>(),
    caps: createDirectorCaps(),
    triggerEventId: `e_check_trigger_${now.getTime()}`,
    toolContextTaskRunId: `e_check_tool_${now.getTime()}`,
  });
  const scout = buildEvidenceScoutAgentDefinition({ prompt: EVIDENCE_SCOUT_CHARTER });

  let scoutSpawns = 0;
  const spawnCapMatcher: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Task') {
          if (scoutSpawns >= 1) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'E-4 validation: scout spawn cap reached (≤1)',
              },
            };
          }
          scoutSpawns += 1;
        }
        return { continue: true };
      },
    ],
  };

  const result = await runAgentTask(
    'ResearchMeetingDirectorTask',
    {
      run_kind: 'agent_nightly_validation',
      now: now.toISOString(),
      validation_directive: directive,
    },
    {
      db,
      override: { provider: 'anthropic-sub' },
      mcpServers: {
        research_evidence: evidence.server,
        research_meeting_director: director.server,
      },
      allowedTools: [...DIRECTOR_ALLOWED_TOOLS],
      agents: { 'evidence-scout': scout },
      hooks: { PreToolUse: [spawnCapMatcher] },
    },
  );

  const readNames = new Set<string>(EVIDENCE_READ_TOOL_NAMES);
  const trace = evidence.readToolTrace();
  const scoutReadToolCalls = trace.filter((t) =>
    readNames.has(`mcp__research_evidence__${t.tool}`),
  ).length;

  return {
    scoutSpawns,
    scoutReadToolCalls,
    reportFindingsCaptured: capture.value !== null,
    costUsd: result.cost_usd ?? 0,
    taskRunId: result.task_run_id,
  };
}

async function main() {
  const { loadEnv } = await import('../../server/env');
  loadEnv();

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[E-checks] cannot run — missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.AI_PROVIDER_OVERRIDE) {
    console.error(
      '[E-checks] cannot run — the director runs on the anthropic-sub override which needs ' +
        'CLAUDE_CODE_OAUTH_TOKEN (or set AI_PROVIDER_OVERRIDE + matching auth). Refusing to ' +
        'report a pass without a real SDK run.',
    );
    process.exit(1);
  }

  console.log('[E-checks] Run 1/2 — DOUBLE-SPAWN (E-1 / E-3 / E-4)…');
  const spawnRun = await assembleAndRun(
    'VALIDATION RUN. Step 1: call get_meeting_context. Step 2: use the Task tool to spawn ' +
      'the evidence-scout subagent to investigate the single candidate cell. Step 3: try to ' +
      'spawn the evidence-scout a SECOND time — this MUST be denied by the system. Step 4: ' +
      'stop. Do NOT propose anything.',
  );

  console.log('[E-checks] Run 2/2 — NO-SPAWN baseline (E-2)…');
  const noSpawnRun = await assembleAndRun(
    'VALIDATION RUN. Call get_meeting_context ONCE, then stop immediately. Do NOT use the ' +
      'Task tool. Do NOT spawn any subagent. Do NOT propose anything.',
  );

  const e1 = spawnRun.scoutSpawns >= 1 || spawnRun.reportFindingsCaptured;
  const e3 = spawnRun.scoutReadToolCalls >= 1;
  const e4 = spawnRun.scoutSpawns === 1; // 2nd spawn denied → counter capped at 1
  const costDelta = spawnRun.costUsd - noSpawnRun.costUsd;
  const e2Pass = spawnRun.costUsd > 0 && costDelta > 0;
  const e2Inconclusive = spawnRun.costUsd === 0; // flat OAuth lane → inspect modelUsage by hand

  const line = (label: string, ok: boolean, note = '') =>
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`;

  console.log('\n=== YUK-572 E-1..E-4 checklist ===');
  console.log(
    line(
      'E-1  Task spawn fires the nested scout',
      e1,
      `spawns=${spawnRun.scoutSpawns}, report_findings=${spawnRun.reportFindingsCaptured}`,
    ),
  );
  console.log(
    e2Inconclusive
      ? '  INCONCLUSIVE  E-2  usage/cost aggregation — total_cost_usd=0 (flat OAuth lane); inspect result.modelUsage by hand (§7)'
      : line(
          'E-2  nested usage aggregates into parent cost',
          e2Pass,
          `spawn=$${spawnRun.costUsd.toFixed(6)} vs no-spawn=$${noSpawnRun.costUsd.toFixed(6)} (Δ=$${costDelta.toFixed(6)})`,
        ),
  );
  console.log(
    line(
      'E-3  mcpServers by-name resolves for the scout',
      e3,
      `scout read-tool calls=${spawnRun.scoutReadToolCalls}`,
    ),
  );
  console.log(
    line(
      'E-4  bypassPermissions honors PreToolUse deny',
      e4,
      `final spawn count=${spawnRun.scoutSpawns} (expected 1)`,
    ),
  );
  console.log('\nBLOCKING (E-2/E-3/E-4): the flag must NOT be flipped unless all three PASS.');

  const exitCode = computeExitCode({ e1, e2Pass, e2Inconclusive, e3, e4 });
  if (exitCode === 3) {
    console.log(
      '\nE-2 INCONCLUSIVE → exit 3，需人工核 cost 聚合后才能翻 flag（inspect result.modelUsage ' +
        'by hand, §7 — do NOT flip RESEARCH_MEETING_AGENT_ENABLED until a human confirms the ' +
        'nested scout usage actually rolled into the parent cost)。',
    );
  }
  process.exit(exitCode);
}

// Only run the CLI entrypoint when this file is executed directly (not when
// computeExitCode is imported for unit testing — mirrors scripts/audit-draft-status.ts's
// guard so importing this module never triggers a real DB/SDK run as a side effect).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[E-checks] harness failed', err);
    process.exit(1);
  });
}
