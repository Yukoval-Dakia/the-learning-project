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
//   E-4  bypassPermissions deny enforcement: under permissionMode:'bypassPermissions'
//        (hardcoded in the runner), a deny on the 2nd Task spawn from EITHER the
//        PreToolUse hook or the canUseTool callback (round-2 review #9 — two independent
//        layers sharing one counter) is HONORED → the breadth cap is structural. If
//        neither is honored, breadth is only a soft maxTurns bound (附录 A #6). Measured
//        directly via denyTriggered (round-2 review #2), not inferred from the final
//        spawn count (which cannot distinguish "2nd attempt denied" from "no 2nd attempt
//        was ever made").
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
// lane reports total_cost_usd=0, OR the field is entirely missing) AND E-3/E-4 are BOTH
// independently confirmed passing — a human must inspect result.modelUsage by hand before
// the flag may be flipped. Round-2 review MAJOR #1: exit 3 is reserved for the case where
// E-2's unmeasured delta is the ONLY reason the run isn't a clean pass — if E-3 or E-4
// genuinely failed too, this exits 2 (not 3), so a developer skimming only the "E-2
// INCONCLUSIVE" line can never miss a real blocking failure and flip the flag anyway.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanUseTool, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

const REQUIRED_ENV = ['DATABASE_URL'];

interface CheckReport {
  scoutSpawns: number;
  scoutReadToolCalls: number;
  reportFindingsCaptured: boolean;
  /** count of times EITHER enforcement layer (the PreToolUse hook OR canUseTool) actually
   *  returned a deny decision for a 2nd+ Task spawn attempt (review round-2 MAJOR #2 —
   *  `scoutSpawns === 1` alone cannot distinguish "a 2nd spawn was attempted and denied"
   *  from "the LLM never even tried a 2nd spawn", which would silently false-positive
   *  E-4). Both layers share ONE counter (see the canUseTool wiring below — never two
   *  independent ones, which could each grant a spawn and double the effective cap). */
  denyTriggered: number;
  /** null when the SDK result did not surface cost_usd at all (a possible SDK-side
   *  regression); 0 is a DISTINCT, legitimate value (flat OAuth lane reports no per-call
   *  cost). Both block a meaningful cost-delta measurement, but review round-2 MINOR #4
   *  flagged that `?? 0` conflated the two into one diagnostic message — classifyE2
   *  reports them with different text. */
  costUsd: number | null;
  taskRunId: string;
}

/**
 * Pure exit-code decision table (review MAJOR #1) — no SDK/DB dependency, so it is
 * directly unit-testable (yuk572-e1-e4-spawn-checks.unit.test.ts). The house style
 * forbids nested ternaries (see director.ts §9/§10 fixes); this is written as a plain
 * if/else chain instead of `blockingOk && e1 ? 0 : e2Inconclusive ? 3 : 2`.
 *
 * CONTRACT: e2Inconclusive must NEVER produce exit 0 — an unmeasured cost delta must
 * never be silently treated as a pass that authorizes flipping the flag. AND (round-2
 * fix) it must never mask a genuine E-3/E-4 failure by returning 3 when either of them
 * is false — exit 3 is reserved for "E-2 is the ONLY unresolved check."
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
  // INCONCLUSIVE (3) only when E-3 and E-4 are BOTH independently confirmed passing —
  // i.e. the ONLY reason blockingOk is false is E-2's unmeasured cost delta. If E-3 or
  // E-4 genuinely failed, that is a real FAIL (2): reporting 3 here would let a developer
  // who only skims the "E-2 INCONCLUSIVE" message miss a real E-3/E-4 failure and flip
  // the flag anyway — the exact regression review round-2 MAJOR #1 flagged in the prior
  // formula. e1 is NOT part of the blocking set (only E-2/E-3/E-4 gate the flag per the
  // file header) so it is deliberately not checked here — but in practice e1 failing
  // (Task never actually spawned the scout) also drives e3 and e4 to false (no scout
  // ever ran to make a read-tool call or hit the spawn cap), so this branch is
  // unreachable when e1 is false anyway; no separate e1 check is needed.
  if (outcome.e2Inconclusive && outcome.e3 && outcome.e4) {
    return 3;
  }
  return 2;
}

/** E-2 classification result (review round-2 MINOR #4 — extracted into a pure, testable
 *  function so the null-vs-zero distinction has direct unit coverage, mirroring
 *  computeExitCode above). */
export interface E2Classification {
  e2Pass: boolean;
  e2Inconclusive: boolean;
  /** ready-to-print diagnostic line for this check. */
  reasonLine: string;
}

export function classifyE2(spawnCost: number | null, noSpawnCost: number | null): E2Classification {
  if (spawnCost === null || noSpawnCost === null) {
    return {
      e2Pass: false,
      e2Inconclusive: true,
      reasonLine:
        '  INCONCLUSIVE  E-2  usage/cost aggregation — result.cost_usd is MISSING (undefined) ' +
        'on at least one run (a possible SDK-side regression, NOT a flat-rate zero) — ' +
        'inspect result.modelUsage by hand (§7)',
    };
  }
  if (spawnCost === 0) {
    return {
      e2Pass: false,
      e2Inconclusive: true,
      reasonLine:
        '  INCONCLUSIVE  E-2  usage/cost aggregation — total_cost_usd=0 (flat OAuth lane, a ' +
        'legitimate zero, NOT a missing field); inspect result.modelUsage by hand (§7)',
    };
  }
  const delta = spawnCost - noSpawnCost;
  const pass = delta > 0;
  return {
    e2Pass: pass,
    e2Inconclusive: false,
    reasonLine:
      `  ${pass ? 'PASS' : 'FAIL'}  E-2  nested usage aggregates into parent cost — ` +
      `spawn=$${spawnCost.toFixed(6)} vs no-spawn=$${noSpawnCost.toFixed(6)} (Δ=$${delta.toFixed(6)})`,
  };
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

  // review round-3 A1 — id-keyed idempotent design (mirrors director.ts's spawn-cap
  // fix exactly; see director.ts for the full soundness writeup + the double-increment
  // deadlock this SUPERSEDES). `PreToolUseHookInput.tool_use_id` and canUseTool's
  // `options.toolUseID` correlate to the SAME underlying tool call across both SDK
  // surfaces, so decideSpawn's granted-id Set is safe against either layer being
  // consulted once, both being consulted for the same call, or both for different
  // calls. `denyTriggered` (round-2 #2) is the DIRECT signal a deny actually fired.
  const grantedSpawnToolUseIds = new Set<string>();
  let denyTriggered = 0;
  // review round-3 CodeRabbit Minor #10 — the director's OWN evidence reads share the
  // SAME evidence server + toolTrace as any spawned scout (director.ts §5: "director 与
  // scout 共享此 server"), and the director's allowlist includes the same 6 read tools.
  // Without a time-window filter, a director-side read (e.g. before ever spawning the
  // scout) would be miscounted as scout activity, false-positiving E-3 even if the
  // scout itself never got to call an evidence tool. Recorded the moment the FIRST
  // spawn is granted (0→1 transition only); trace entries at/after this timestamp are
  // scout-attributable (the validation directive tells the director to spawn BEFORE
  // investigating, so anything before this point is unambiguously the director's own).
  let scoutSpawnedAt: string | undefined;
  function decideSpawn(toolUseId: string): 'allow' | 'deny' {
    if (grantedSpawnToolUseIds.has(toolUseId)) {
      return 'allow';
    }
    if (grantedSpawnToolUseIds.size >= 1) {
      return 'deny';
    }
    grantedSpawnToolUseIds.add(toolUseId);
    scoutSpawnedAt = scoutSpawnedAt ?? new Date().toISOString();
    return 'allow';
  }
  const spawnCapMatcher: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Task') {
          if (decideSpawn(input.tool_use_id) === 'deny') {
            denyTriggered += 1;
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'E-4 validation: scout spawn cap reached (≤1)',
              },
            };
          }
        }
        return { continue: true };
      },
    ],
  };
  // Mirrors director.ts's canUseTool layer exactly (same rationale + the same HONEST
  // caveat about SDK-consultation-order uncertainty lives there — see director.ts's
  // spawn-cap comment for the full writeup; this harness must exercise the identical
  // wiring production uses so the dev validation run is representative). Note:
  // denyTriggered can be incremented more than once for the SAME rejected 2nd call if
  // BOTH layers independently process it — harmless for the `>= 1` pass/fail gate
  // (E-4 only needs "at least one deny fired somewhere"), just not an exact per-call
  // tally.
  const spawnCapCanUseTool: CanUseTool = async (toolName, _input, options) => {
    if (toolName === 'Task' && decideSpawn(options.toolUseID) === 'deny') {
      denyTriggered += 1;
      return { behavior: 'deny', message: 'E-4 validation: scout spawn cap reached (≤1)' };
    }
    return { behavior: 'allow' };
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
      canUseTool: spawnCapCanUseTool,
    },
  );

  const readNames = new Set<string>(EVIDENCE_READ_TOOL_NAMES);
  const trace = evidence.readToolTrace();
  let scoutReadToolCalls: number;
  if (scoutSpawnedAt === undefined) {
    // The scout never spawned — every evidence read recorded is the director's own.
    scoutReadToolCalls = 0;
  } else {
    const spawnedAt = scoutSpawnedAt;
    scoutReadToolCalls = trace.filter(
      (t) => readNames.has(`mcp__research_evidence__${t.tool}`) && t.t > spawnedAt,
    ).length;
  }

  return {
    scoutSpawns: grantedSpawnToolUseIds.size,
    scoutReadToolCalls,
    reportFindingsCaptured: capture.value !== null,
    denyTriggered,
    costUsd: result.cost_usd ?? null,
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
  // review round-2 MAJOR #2 — denyTriggered is the DIRECT signal (either layer actually
  // fired a deny for a 2nd+ spawn attempt), not an inference from the final spawn count
  // (which cannot distinguish "2nd attempt denied" from "no 2nd attempt was ever made").
  const e4 = spawnRun.denyTriggered >= 1;
  const e2 = classifyE2(spawnRun.costUsd, noSpawnRun.costUsd);
  const e2Pass = e2.e2Pass;
  const e2Inconclusive = e2.e2Inconclusive;

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
  console.log(e2.reasonLine);
  console.log(
    line(
      'E-3  mcpServers by-name resolves for the scout',
      e3,
      `scout read-tool calls=${spawnRun.scoutReadToolCalls}`,
    ),
  );
  console.log(
    line(
      'E-4  a spawn-cap enforcement layer (PreToolUse hook and/or canUseTool) denies the 2nd Task spawn',
      e4,
      `denyTriggered=${spawnRun.denyTriggered}, final spawn count=${spawnRun.scoutSpawns} (expected 1)`,
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
