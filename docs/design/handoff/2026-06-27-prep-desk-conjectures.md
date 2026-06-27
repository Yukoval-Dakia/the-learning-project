# 备课台 (Prep-Desk) Conjecture Card — Functional Handoff

- **Issues**: YUK-406 (教研团 Phase 0 关系脑), YUK-440 (A13 conjecture engine)
- **Date**: 2026-06-27
- **Scope of THIS handoff**: the backend read model + route are shipped (U4). This doc is the **functional / contract** handoff that triggers the claude-design pass for the felt 备课台 card UI. The card UI itself is **design-gated** and NOT in the U4 PR.
- **Status**: backend live (`GET /api/prep-desk/conjectures`), UI pending design.
- **NO UI code here** — no `.tsx`, no `.css`, no visual styling. Wire-shape + behaviour rules only.

---

## 0. What the 备课台 is (and is NOT)

The 备课台 ("prep desk") is the surface where the private teaching team shows the owner
**what it has prepared for them** — "为你而备", not a task list. It surfaces the team's
current *conjectures* about the learner's mind: misconception beliefs the nightly
research-meeting job induced from recurring failure cells, each paired with an **unrun
discriminating probe** the team is *about to ask*.

It is **NOT** a backlog, an inbox, a todo list, or a nag. It surfaces at most **3**
conjectures, ranked by salience — a finite, guilt-free feed.

---

## 1. Wire-shape contract (what the UI consumes)

`GET /api/prep-desk/conjectures` → `200`:

```jsonc
{
  "conjectures": [
    {
      "id": "evt_…",                 // conjecture id === proposal event id (no separate row)
      "claim": "you treat the chain rule as multiplying derivatives",
      "knowledge_id": "kn_chain_rule",
      "cause_category": "concept_misunderstanding",
      "probe_md": "d/dx sin(x^2) = ?",   // the UNRUN discriminating probe (team is about to ask)
      "recurrence_count": 3,             // failure-cell recurrence (always ≥ 2)
      "discriminating": true,            // probe only THIS misconception fails
      "predicted_p": 0.3,                // claim's implied P(owner answers probe correctly)
      "baseline_p_at_induction": 0.6,    // PFA/θ p(L) baseline the claim must beat
      "corrected_by_owner": false,       // true once owner rewrote the claim (edit path)
      "evidence": [                       // back-link to the events/questions that induced it
        { "kind": "event", "id": "evt_a" },
        { "kind": "question", "id": "q_b" }
      ],
      "proposed_at": "2026-06-27T…Z"     // ISO-8601
    }
  ]
}
```

- `conjectures` is **0..3** entries, already **sorted by salience DESC** (see §2). The UI
  renders them in array order; no client-side re-sort needed.
- Read model: `loadPrepDeskConjectures(db)` in
  `src/capabilities/shell/server/prep-desk.ts`. Route shell:
  `src/capabilities/shell/api/prep-desk-conjectures.ts`. Auth: `x-internal-token` (the
  standard `/api/*` gate).
- Backed by the existing experimental:proposal event/inbox path — pending `conjecture`
  proposals only (`listProposalInboxPage(db, { status:'pending', kind:'conjecture' })`).
  Zero inbox/writer change (same precedent as `goal_scope`).

### `KIND_META.conjecture` — deliberate cross-task UI dependency (DO NOT add in U4)

The shared inbox UI (`src/capabilities/shell/ui/inbox-api.ts`) carries a `KIND_META`
map keyed by proposal kind (label / icon / copy). It does **not yet** have a
`conjecture` entry. The 备课台 card design lane (or whichever UI lane lands the card)
**must add `KIND_META.conjecture`** so the conjecture renders with team-meeting framing
("教研团的猜想 / 备课") rather than a generic proposal fallback. This is flagged here as
a known cross-task item; it is **design-gated and intentionally NOT added in U4**.

---

## 2. Salience, the ≤3 cap, and the anti-guilt invariants

### Salience ranking (server-side)
`salience = confidence × recurrence_count`, sorted DESC, then sliced to the top **3**
(`PREP_DESK_MAX`). `confidence` is read **only** on the server to compute salience and is
then **dropped** — see invariant (a). The UI receives an already-ranked, already-capped
list.

### Anti-guilt invariants the card MUST honour
- **(a) NO confidence number is ever rendered.** `confidence` does not cross the wire
  (it is absent from `PrepDeskConjecture` and from the JSON response — asserted by test).
  The card must not surface a confidence %, a "73% sure" badge, or any
  false-precision number. The conjecture is a hypothesis, not a measurement.
  (Defense-in-depth rationale: the existing `ProposalCard.tsx` renders any `confidence`
  field as a `%` bar — so the field is structurally withheld at the read model.)
- **(b) NO backlog / todo / unread count.** Do not show "12 conjectures waiting" or a
  growing queue. The cap is 3; show 0..3, full stop. Zero conjectures = a calm empty
  state ("教研团暂无新猜想"), not a "you're all caught up!" achievement nag.
- **(c) NO push / nagging.** No red dots, no "action required", no overdue styling. The
  framing is the team having *prepared something for you*, surfaced when you visit —
  pull, not push.

`predicted_p` and `baseline_p_at_induction` MAY inform copy/visual emphasis (e.g. "the
team expects this to trip you up" when `predicted_p` is low), but must NOT be rendered as
bare probabilities/percentages — same false-precision rule as confidence applies in
spirit.

---

## 3. Owner actions (already wired in the backend)

The conjecture flows through the **existing proposal decide pipeline**
(`/api/proposals/[id]/decide` → `acceptAiProposal` / `dismissAiProposal` →
`acceptConjectureProposal`, the U2 applier in
`src/capabilities/agency/server/conjecture-accept.ts`). The UI needs **accept / edit /
reject** affordances mapping to that pipeline:

- **Accept = acknowledge, NOT confirm.** Owner agrees with the *direction* of the
  conjecture. This is a **calibration anchor**, not a confirmed weakness
  (`weakness_confirmed` is always `false`; only the later probe one-shot mints a
  confirmed weakness). The card's accept affordance should read as "对，往这个方向想" —
  acknowledgement, not "this is definitely my weakness".
- **Edit → `corrected_by_owner` + mem0 CORE seam.** Owner rewrites the claim
  (`corrected_payload`). Sets `corrected_by_owner=true` and writes the owner's version to
  mem0 CORE via the injectable `ConjectureCoreWriter` seam. Still not auto-confirmed.
- **Reject → dismiss + digest.** Routes through `dismissAiProposal` (rating `dismiss` +
  decision signal → digest). The conjecture drops off the 备课台.

**ND-5 red line (backend, for UI awareness):** none of these ever write FSRS / review
state or enroll a learning item. The card must not present accept as "add to my reviews".

---

## 4. Anki-export tripwire — the non-exportable artifact

`claim` + `evidence` back-link + the **unrun `probe_md`** together form a
**conjecture-with-provenance**, which is a deliberately **non-exportable** artifact: it
must NOT be exportable to a flashcard / Anki card. The whole point is that the probe is a
question the team is *about to ask* to discriminate a hypothesis — not a settled
question/answer pair to drill. The card must surface `probe_md` as **"the question the
team is about to ask"** framing, never as a flippable flashcard front/back. Any future
export feature must treat these as tripwired (skip, not serialize).

---

## 5. Files (backend, shipped in U4)

- `src/capabilities/shell/server/prep-desk.ts` — `loadPrepDeskConjectures(db)` read model
  + `PrepDeskConjecture` wire type + `PREP_DESK_MAX`.
- `src/capabilities/shell/api/prep-desk-conjectures.ts` — `GET` route shell.
- `src/capabilities/shell/manifest.ts` — route mount.
- `src/capabilities/shell/server/prep-desk.db.test.ts` — read-model + registration tests.
- `postman/api-endpoints.json` (+ regenerated collection) — route spec.

### Design lane TODO (gated, not in U4)
1. The felt 备课台 card UI (per this contract + the anti-guilt invariants).
2. Add `KIND_META.conjecture` to `src/capabilities/shell/ui/inbox-api.ts` (§1).
3. Accept / edit / reject affordances → existing `/api/proposals/[id]/decide` pipeline (§3).
