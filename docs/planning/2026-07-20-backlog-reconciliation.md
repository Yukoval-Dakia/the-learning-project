# Backlog reconciliation board — 2026-07-20

## Scope and completeness

This is the durable publication of the 2026-07-20 Backlog/In Progress inventory grounding. Linear remains authoritative for live issue state.

- Expected open identifiers at inventory snapshot: **107 unique**
- Classified entries: **107**
- Classified unique identifiers: **107**
- Missing / unexpected / duplicate assignments: **0 / 0 / 0**
- Independent verifier verdict: **PASS**

The original classifier emitted 107 rows but only 80 unique identifiers. The corrected A/B/C rescan below supersedes its provisional partition.

| Disposition | Count |
|---|---:|
| RESEARCH_BOARD | 65 |
| QUICK_EXECUTE | 9 |
| KEEP_ACTIVE | 6 |
| MOVE_BACKLOG | 15 |
| CLOSE_DONE | 8 |
| CANCEL_OBSOLETE | 3 |
| CANCEL_OBSOLETE_CONDITIONAL | 1 |
| **Total** | **107** |

## RESEARCH_BOARD — 65

These issues require an owner/product/scientific decision, design preflight, architecture research, external/operations work, a data/statistics gate, or a larger program before bounded implementation.

YUK-147, YUK-181, YUK-203, YUK-213, YUK-229, YUK-230, YUK-254, YUK-257, YUK-285, YUK-289, YUK-291, YUK-295, YUK-308, YUK-320, YUK-327, YUK-338, YUK-339, YUK-340, YUK-346, YUK-360, YUK-369, YUK-370, YUK-371, YUK-374, YUK-390, YUK-391, YUK-414, YUK-416, YUK-418, YUK-419, YUK-431, YUK-437, YUK-443, YUK-444, YUK-452, YUK-454, YUK-457, YUK-464, YUK-496, YUK-505, YUK-508, YUK-509, YUK-522, YUK-530, YUK-536, YUK-537, YUK-542, YUK-545, YUK-546, YUK-552, YUK-562, YUK-563, YUK-571, YUK-588, YUK-589, YUK-591, YUK-594, YUK-605, YUK-608, YUK-675, YUK-677, YUK-678, YUK-679, YUK-680, YUK-684.

## QUICK_EXECUTE — 9

- **YUK-366** — serialize behind the active supply-selection lane.
- **YUK-384** — serialize behind edge-mutation work.
- **YUK-392** — remove the remaining Step-5 `kindsMatch` rejection; serialize behind YUK-556 because both touch QuizGen.
- **YUK-448** — add PfPaper per-slot `latency_ms`; UI design-doc preflight is mandatory before implementation.
- **YUK-460** — serialize behind YUK-301 note-refine.
- **YUK-497** — add the missing copilot revert route/UI caller; UI design-doc preflight is mandatory before implementation.
- **YUK-556** — structured QuizGen reference solutions; active PR #998.
- **YUK-584** — validate research-meeting evidence references server-side.
- **YUK-595** — implement the same-KC wrong-streak cut using the merged cut-1 infrastructure.

## KEEP_ACTIVE — 6

YUK-293, YUK-310, YUK-354, YUK-405, YUK-406, YUK-439.

## MOVE_BACKLOG — 15

YUK-187, YUK-268, YUK-287, YUK-350, YUK-376, YUK-377, YUK-386, YUK-438, YUK-492, YUK-506, YUK-524, YUK-550, YUK-572, YUK-596, YUK-685.

## CLOSE_DONE — 8

YUK-322, YUK-326, YUK-397, YUK-407, YUK-440, YUK-471, YUK-490, YUK-585.

Already applied and re-read before this board: YUK-326, YUK-397, YUK-407, YUK-440, YUK-471, YUK-585. YUK-490 was already Done. **YUK-322 was subsequently owner-approved, applied, and re-read as Done.**

## CANCEL_OBSOLETE — 3

YUK-255, YUK-373, YUK-532.

YUK-255 was already applied and re-read. **YUK-373 and YUK-532 were subsequently owner-approved, applied, and re-read as Canceled.**

## CANCEL_OBSOLETE_CONDITIONAL — 1

- **YUK-555** — do not mutate until its hard-cap acceptance is explicitly preserved in YUK-605 or a named successor.

## Additional issue capture

- **YUK-679** was extended in place (rather than duplicated) with `srtOutcome`, continuous-credit/Fisher helpers, a Rust-port-or-ADR-0046-exemption closure, and explicit historical replay compatibility.
- The four owner-approved acceptance-ready drafts were filed and re-read in Backlog:
  1. **YUK-738** — ASR/TTS audio evidence path for English listening/speaking.
  2. **YUK-739** — move rating/cause semantics into `SubjectProfile`.
  3. **YUK-740** — restore LearningRecord single-writer/CAS/status-transition policy.
  4. **YUK-741** — batch misconception-recurrence aggregate reads before enabling the flag.
- Independent YUK-584 verification approved the merged implementation; its sole remaining optional throw/retry coverage hardening was captured as **YUK-742** (Backlog).

## Mutation boundary

All owner-approved immediate corrections and captures above were applied and re-read. **YUK-555 remains intentionally unmodified** until its hard-cap acceptance is explicitly preserved in YUK-605 or a named successor.
