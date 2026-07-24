import { describe, expect, it } from 'vitest';
import { copilotAskRevertAllows } from './cascade-revert';

// YUK-497 wave-2 — the copilotAskOnly allowlist must mirror classifyRow's reversible set for the
// actions a copilot ask turn produces. Regressions for the two fixes (codex P2 + OCR): a propose-only
// ask is revertable, and a non-archive generate(knowledge_edge) — including an ABSENT edge_op —
// passes the filter rather than being rewritten to irreversible (which would 409 every revert).
type PredicateRow = Parameters<typeof copilotAskRevertAllows>[0];
const row = (r: { action: string; subject_kind?: string; payload?: unknown }): PredicateRow =>
  ({ subject_kind: 'query', payload: null, ...r }) as unknown as PredicateRow;

describe('copilotAskRevertAllows', () => {
  it('allows the event-layer proposals/votes a copilot ask emits (F2a)', () => {
    expect(copilotAskRevertAllows(row({ action: 'propose' }), false)).toBe(true);
    expect(copilotAskRevertAllows(row({ action: 'rate' }), false)).toBe(true);
  });

  it('refuses a rate that ACCEPTED a proposal but keeps dismiss/rollback reversible (wave-7 TeZZO)', () => {
    // rate=accept landed a KG mutation (reparent/merge/archive) OUTSIDE the event chain → irreversible,
    // else the revert tombstones ask→propose→rate while the mutation survives (false success).
    expect(
      copilotAskRevertAllows(row({ action: 'rate', payload: { rating: 'accept' } }), false),
    ).toBe(false);
    // dismiss / rollback / plain vote land no mutation → still reversible.
    expect(
      copilotAskRevertAllows(row({ action: 'rate', payload: { rating: 'dismiss' } }), false),
    ).toBe(true);
    expect(
      copilotAskRevertAllows(row({ action: 'rate', payload: { rating: 'rollback' } }), false),
    ).toBe(true);
  });

  it('allows the tool_use provenance mirror a copilot ask emits (wave-3 G2)', () => {
    // mcp-bridge writes action='tool_use', subject_kind='query'. Pure episodic provenance, so it is
    // both in EVENT_LAYER_ACTIONS (classifyRow → event_layer) and admitted here, letting a
    // propose-only ask that emitted a mirror revert instead of 409-ing.
    expect(copilotAskRevertAllows(row({ action: 'tool_use', subject_kind: 'query' }), false)).toBe(
      true,
    );
  });

  it('allows a non-archive generate(knowledge_edge), incl. absent edge_op and supersede (F2b)', () => {
    const edge = (payload: unknown) =>
      row({ action: 'generate', subject_kind: 'knowledge_edge', payload });
    expect(copilotAskRevertAllows(edge({}), false)).toBe(true); // absent edge_op === create
    expect(copilotAskRevertAllows(edge({ edge_op: 'create' }), false)).toBe(true);
    expect(copilotAskRevertAllows(edge({ edge_op: 'supersede' }), false)).toBe(true);
    expect(copilotAskRevertAllows(edge({ edge_op: 'archive' }), false)).toBe(false);
  });

  it('allows the ask/reply/snapshot anchors and refuses real learner facts', () => {
    expect(copilotAskRevertAllows(row({ action: 'experimental:copilot_user_ask' }), true)).toBe(
      true,
    );
    // The root anchor is only allowed as the ROOT — a non-root copilot_user_ask is not.
    expect(copilotAskRevertAllows(row({ action: 'experimental:copilot_user_ask' }), false)).toBe(
      false,
    );
    expect(copilotAskRevertAllows(row({ action: 'experimental:copilot_reply' }), false)).toBe(true);
    expect(copilotAskRevertAllows(row({ action: 'experimental:state_snapshot' }), false)).toBe(
      true,
    );
    // A real learner fact is never admitted by the copilot-ask allowlist.
    expect(copilotAskRevertAllows(row({ action: 'attempt' }), false)).toBe(false);
    expect(copilotAskRevertAllows(row({ action: 'accept_suggestion' }), false)).toBe(false);
  });

  it('refuses a materializing question_draft proposal on its payload marker (wave-5 TcHwW)', () => {
    // runQuestionAuthor writes the draft `question` row at PROPOSE time (outside the event chain) +
    // this proposal event, so the revert must fail-closed rather than tombstone the turn while
    // orphaning the draft. The marker is payload.ai_proposal.kind — independent of the event action.
    expect(
      copilotAskRevertAllows(
        row({
          action: 'experimental:proposal',
          subject_kind: 'question',
          payload: { ai_proposal: { kind: 'question_draft' } },
        }),
        false,
      ),
    ).toBe(false);
    // A knowledge propose (materialization DEFERRED to accept) stays reversible.
    expect(
      copilotAskRevertAllows(
        row({ action: 'propose', payload: { ai_proposal: { kind: 'knowledge_node' } } }),
        false,
      ),
    ).toBe(true);
  });
});
