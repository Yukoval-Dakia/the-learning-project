import type { Page, Route } from '@playwright/test';

const TOKEN_STORAGE_KEY = 'loom_internal_token';
const TOKEN = 'usability-fixture-token';

export type UsabilityScenario =
  | 'existing-evidence'
  | 'empty-database'
  | 'unauthorized'
  | 'practice-mutation-failure'
  | 'questions-pagination'
  | 'teaching-brief';

interface FixtureController {
  unexpectedRequests: string[];
  mutationAttempts: () => number;
  /**
   * YUK-789 — every mutating / telemetry call the teaching-brief band makes, in order
   * (`METHOD /path`). The click-through spec asserts on this instead of on focus order:
   * a band that renders but never reaches its mutation is exactly the "looks wired,
   * isn't" failure this fixture set exists to catch.
   */
  briefCalls: () => string[];
}

const evidenceKeys = {
  active_goal: false,
  goal_history: false,
  knowledge: false,
  question: false,
  source_material: false,
  artifact: false,
  review_due: false,
  pending_attribution: false,
  practice_stream: false,
  proposal: false,
  learning_session: false,
  user_event: false,
};

function weekHeat(): Array<{ day: string; count: number }> {
  return Array.from({ length: 7 }, (_, index) => ({
    day: `2026-07-${String(index + 7).padStart(2, '0')}`,
    count: index === 6 ? 2 : 0,
  }));
}

function workbenchSummary(isEmpty: boolean) {
  return {
    proposals: {
      total: 0,
      decision_total: 0,
      by_kind: {},
      has_more: false,
      limit: 50_000,
      status: 'pending',
    },
    kpi: {
      due_count: isEmpty ? 0 : 2,
      pending_attribution_count: 0,
      knowledge_count: isEmpty ? 0 : 3,
      goal_count: 0,
    },
    cold_start: {
      is_empty: isEmpty,
      evidence: isEmpty
        ? evidenceKeys
        : { ...evidenceKeys, knowledge: true, question: true, review_due: true },
    },
    active_goal: null,
    active_sessions: [],
    week_heat: weekHeat(),
  };
}

// YUK-721 — a full FINDING-state teaching brief (contract §6.1 wire shape, wenyan-flavored
// copy). Anti-guilt lock (§8.1): no calibration/confidence/recurrence/backlog anywhere; the
// only ids are opaque provenance the UI never renders.
function teachingBrief() {
  return {
    brief_id: 'evt_conjecture_wy1',
    state: 'finding',
    updated_at: '2026-07-18T15:10:00.000Z',
    expires_at: '2026-07-25T15:10:00.000Z',
    finding: {
      claim_md: '你可能把「使动用法」和「意动用法」混为一谈——见到宾语前的活用动词就先当使动。',
      knowledge_id: 'kn_word_activation',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '最近几次涉及词类活用的作答里，这个模式重复出现，值得用一道判别题确认。',
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_wy_a' },
        { role: 'induction', kind: 'question', id: 'q_source_wy_b' },
      ],
    },
    prepared_action: {
      kind: 'review_finding',
      proposal_id: 'evt_conjecture_wy1',
      probe_preview_md: '「渔人甚异之」中的「异」是使动还是意动？请说明你的判断依据。',
    },
    current_outcome: {
      status: 'awaiting_decision',
      summary_md: '这仍是一条待检验的判断。',
    },
  };
}

// YUK-789 — the SAME brief after「就按这个方向验证」: the server re-projects the accepted
// finding to `probe_ready` (contract §5: prepared_action becomes answer_probe, outcome
// becomes awaiting_answer). Same brief_id, so the band takes its forward-announce path
// instead of treating it as a new candidate.
function teachingBriefProbeReady() {
  const finding = teachingBrief();
  return {
    brief_id: finding.brief_id,
    state: 'probe_ready',
    updated_at: '2026-07-18T15:12:00.000Z',
    expires_at: null,
    finding: finding.finding,
    basis: finding.basis,
    prepared_action: {
      kind: 'answer_probe',
      probe_question_id: 'q_probe_wy1',
      prompt_md: finding.prepared_action.probe_preview_md,
    },
    current_outcome: {
      status: 'awaiting_answer',
      summary_md: '这道判别题已经备好，等你作答。',
    },
  };
}

// YUK-789 — the A 档 auto-applied digest (/inbox) and the 成效趋势面 (/coach efficacy).
// Both are shipped learner surfaces reachable from the same SPA build; without fixtures
// a spec that walks into either route silently falls into the catch-all 501.
function autoAppliedDigest() {
  return {
    rows: [],
    breaker: { tripped: false, level: 'ok', applied: 0, cap: 8, window: 7 },
  };
}

function effectivenessTrend() {
  return {
    series: [],
    subject_roots: [],
    aggregate: { total_kcs_with_activity: 0, total_events: 0, by_subject: [] },
    metadata: {
      as_of: '2026-07-18T15:10:00.000Z',
      window_start: '2026-06-18T15:10:00.000Z',
      window_end: '2026-07-18T15:10:00.000Z',
      timezone: 'Asia/Shanghai',
      granularity: 'calendar_day',
      notable_limit: 6,
      eligible: 0,
      returned: 0,
      truncated: false,
    },
  };
}

function stream(status: 'pending' | 'skipped') {
  return {
    date: '2026-07-13',
    opening_line: '今天先复习一题。',
    budget: { pace: 'medium', minutes: 20 },
    items: [
      {
        id: 'stream-item-1',
        position: 0,
        item_kind: 'question',
        ref_id: 'question-1',
        source: 'decay',
        reasoning: '今天复习「二次函数」。',
        status,
        estimated_minutes: 2,
      },
    ],
    progress: {
      done: 0,
      total: 1,
      estimated_total_minutes: 2,
      estimated_remaining_minutes: status === 'pending' ? 2 : 0,
    },
  };
}

function question(index: number) {
  return {
    id: `question-${index + 1}`,
    kind: 'choice',
    prompt_md: `第 ${index + 1} 道回归题`,
    source: 'manual',
    source_tier: { tier: 1, name: '人工' },
    difficulty: (index % 5) + 1,
    visual_complexity: null,
    knowledge_ids: ['knowledge-math'],
    root_question_id: null,
    variant_depth: 0,
    parent_question_id: null,
    part_index: null,
    draft_status: null,
    created_at_sec: 1_784_000_000 - index,
    subject: 'math',
    knowledge_labels: [{ id: 'knowledge-math', name: '二次函数' }],
    is_composite: false,
    children: [],
  };
}

async function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

export async function installApiFixtures(
  page: Page,
  scenario: UsabilityScenario,
): Promise<FixtureController> {
  const unexpectedRequests: string[] = [];
  const briefCalls: string[] = [];
  let mutationAttempts = 0;
  let streamStatus: 'pending' | 'skipped' = 'pending';
  // YUK-789 — the brief's server-side lifecycle, driven by the accept mutation.
  let briefState: 'finding' | 'probe_ready' = 'finding';

  await page.addInitScript(({ key, token }) => window.localStorage.setItem(key, token), {
    key: TOKEN_STORAGE_KEY,
    token: TOKEN,
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const key = `${method} ${url.pathname}`;

    if (key === 'GET /api/auth/check') return fulfill(route, { ok: true });
    if (key === 'GET /api/copilot/nudges') return fulfill(route, { nudges: [] });
    if (key === 'GET /api/subjects') {
      return fulfill(route, {
        subjects: [
          {
            id: 'math',
            displayName: '数学',
            aliases: [],
            renderConfig: { font_family: 'sans', notation: 'latex', code_highlight: null },
            causeCategories: [],
            isGeneralFallback: false,
            configurationStatus: 'configured',
          },
        ],
      });
    }

    if (key === 'GET /api/workbench/summary') {
      if (scenario === 'unauthorized') {
        return fulfill(route, { message: 'fixture token expired' }, 401);
      }
      return fulfill(route, workbenchSummary(scenario === 'empty-database'));
    }
    if (key === 'GET /api/workbench/overnight-digest') {
      return fulfill(route, {
        window: { from: '2026-07-12T18:00:00.000Z', to: '2026-07-13T00:00:00.000Z' },
        has_overnight_activity: false,
        runs: [],
        note_changes_count: 0,
        new_proposals_count: 0,
        new_conjectures_count: 0,
        agent_notes_count: 0,
        degraded_kinds: [],
      });
    }
    if (key === 'GET /api/prep-desk/probes') return fulfill(route, { probes: [] });
    // YUK-707/721 — the teaching brief band queries this on /today. The 'teaching-brief'
    // scenario returns a full FINDING brief; every other scenario stays a quiet {brief:null}.
    // YUK-789 — the finding advances to probe_ready once the accept mutation lands, so the
    // click-through spec can assert the real post-accept state instead of stopping at focus.
    if (key === 'GET /api/prep-desk/brief') {
      if (scenario !== 'teaching-brief') return fulfill(route, { brief: null });
      return fulfill(route, {
        brief: briefState === 'probe_ready' ? teachingBriefProbeReady() : teachingBrief(),
      });
    }
    // YUK-789 — TeachingBrief.tsx POSTs this on mount (brief_seen) and again on the accept
    // click (primary_action_started). It was missing from the table, so every teaching-brief
    // render fell into the catch-all 501 and polluted unexpectedRequests.
    if (key === 'POST /api/prep-desk/brief/interaction') {
      briefCalls.push(key);
      return fulfill(route, {
        interaction_event_id: 'evt_brief_interaction_1',
        local_day: '2026-07-18',
        idempotent: false,
      });
    }
    // YUK-789 — the append-only「知道了」outcome acknowledgement (contract §4.2).
    if (key === 'POST /api/prep-desk/brief/ack') {
      briefCalls.push(key);
      return fulfill(route, {
        brief_acknowledgement_event_id: 'evt_brief_ack_1',
        probe_result_event_id: 'evt_probe_result_wy1',
        brief_id: 'evt_conjecture_wy1',
        idempotent: false,
      });
    }
    // YUK-789 — the accept/dismiss mutation the band's two CTAs drive (decideProposal).
    // The accept flips the server-side brief projection to probe_ready.
    if (method === 'POST' && /^\/api\/proposals\/[^/]+\/decisions$/.test(url.pathname)) {
      briefCalls.push(`POST ${url.pathname}`);
      const body = request.postDataJSON() as { decision?: string } | null;
      if (body?.decision === 'accept') briefState = 'probe_ready';
      return fulfill(
        route,
        {
          proposal_id: 'evt_conjecture_wy1',
          proposal_kind: 'conjecture',
          decision: body?.decision ?? 'accept',
          decision_event_id: 'evt_rate_wy1',
          proposal_status: body?.decision === 'accept' ? 'accepted' : 'dismissed',
          created: true,
          idempotent: false,
          result: {
            kind: 'conjecture',
            rate_event_id: 'evt_rate_wy1',
            conjecture_id: 'evt_conjecture_wy1',
            corrected_by_owner: false,
            weakness_confirmed: false,
          },
        },
        201,
      );
    }
    // YUK-789 — A 档 auto-applied 读模型 (/inbox) + 成效趋势面 (/coach efficacy).
    if (key === 'GET /api/proposals/auto-applied') return fulfill(route, autoAppliedDigest());
    if (key === 'GET /api/observability/effectiveness-trend') {
      return fulfill(route, effectivenessTrend());
    }
    if (key === 'GET /api/agents/notes') return fulfill(route, { rows: [] });
    if (key === 'GET /api/artifacts/ai-changes/recent') {
      return fulfill(route, { window_hours: 24, rows: [] });
    }
    if (key === 'GET /api/cost/today') {
      return fulfill(route, {
        window: { from: 0, to: 0, label: 'today' },
        today: {
          by_currency: [],
          tokens_in: 0,
          tokens_out: 0,
          ledger_rows: 0,
          tool_calls: 0,
          by_task: [],
        },
      });
    }

    if (key === 'GET /api/practice/stream') return fulfill(route, stream(streamStatus));
    if (key === 'PATCH /api/practice/stream/items/stream-item-1') {
      mutationAttempts += 1;
      if (scenario === 'practice-mutation-failure' && mutationAttempts === 1) {
        return fulfill(route, { message: 'fixture mutation rejected' }, 503);
      }
      streamStatus = 'skipped';
      return fulfill(route, { item: stream(streamStatus).items[0] });
    }

    if (key === 'GET /api/questions') {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const all = Array.from({ length: 25 }, (_, index) => question(index));
      const items = all.slice(offset, offset + 20);
      return fulfill(route, {
        items,
        families: null,
        total: all.length,
        truncated: offset + items.length < all.length,
        page: { limit: 20, offset, has_more: offset + items.length < all.length },
        computed_at_sec: 1_784_000_000,
      });
    }

    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    return fulfill(
      route,
      { message: `No usability fixture for ${method} ${url.pathname}${url.search}` },
      501,
    );
  });

  return {
    unexpectedRequests,
    mutationAttempts: () => mutationAttempts,
    briefCalls: () => [...briefCalls],
  };
}
