# Functional Handoff — #41 Reproducible Diagnostic Profile ("recompute ✓")

> **For claude design.** This is a FUNCTIONAL handoff — it specifies what the feature does, its states, the data each state carries, the interaction, and the trust semantics. **It prescribes ZERO visual style** (no colors, type, spacing, layout, motion). Design those within the existing loom design system. YUK-495 Phase 1 S5 (catalog idea #41). Companion: `docs/design/2026-06-25-coldstart-diagnostic-coach-sketch.md`.

## 1. One-line intent

The learner's diagnostic profile (the per-KC mastery picture) gains a **"recompute"** affordance that re-derives every displayed number **on the device, instantly, offline**, and shows whether it matches the server **to the last bit**. The headline trust claim — *"this is what we think you know"* — stops being faith-based and becomes **falsifiable**: a number you can re-derive, not an opinion.

## 2. Where it attaches (existing surfaces — do NOT redesign these)

Two existing surfaces already render the profile; #41 adds a verification layer ON them. Both keep their current loom design — the handoff is only about the NEW recompute/verify affordance + states.

- **Starting profile screen** — `src/capabilities/onboarding/ui/ScreenProfile.tsx` ("我们现在怎么看你"). Per-KC rows already show: KC name · a **band** (a track with a filled "可能掌握区间" from `lo`→`hi`, a **mark** at the point estimate `p(L)`, axis labels 较弱 / 可能区间 lo–hi / 较稳) · a **confidence pill** (未测 / 低置信 / 较可信) · evidence (`N 题 · SE X.XX`).
- **Calibration-maturity surface** — the observability "how trustworthy is this measurement" card (`src/capabilities/observability/server/calibration-maturity.ts`). The recompute badge's natural profile-level home.

## 3. What is NEW to design — the recompute/verify affordance + its states

The feature is a small verification control + a result indicator. It can live at **two granularities** (design may use one or both; recommend profile-level primary, per-KC secondary):

- **Profile-level**: one "recompute ✓" control for the whole profile (re-derives all visible KCs).
- **Per-KC** (optional): the same verify indicator on each KC row.

Design these **states** (this is the core of the handoff):

| State | Meaning | Data to surface |
|---|---|---|
| **A. Unverified (default)** | Numbers shown, not yet re-derived. A latent "verify" affordance invites the check. | the existing profile (unchanged) + an idle "recompute" affordance |
| **B. Recomputing** | The device is re-deriving (this is **near-instant + offline** — likely a flash, not a spinner-worthy wait; design for "felt instant"). | transient; may be skippable visually |
| **C. Verified ✓ (match)** | Every displayed number was re-derived on-device and matches the server **bit-for-bit**. The trust payoff. | a "verified / re-derived ✓" indicator; optionally "matches to the last bit" affordance; per-KC ✓ if per-KC granularity |
| **D. Mismatch ✗ (drift)** | The re-derived number does NOT match the server (rare — a data/version drift). Must be **legible and honest**, not alarming-for-no-reason, and should name WHICH KC/number diverged. | which KC(s) diverged + the two values (shown vs re-derived); a calm "records out of sync here" framing |

Notes for the states:
- **B is the WOW** — instant + offline + private. Design should make C feel like it arrived immediately (airplane-mode-grade), not like a server round-trip.
- **D is rare but load-bearing for trust** — the whole point is the system will *tell you* if its numbers ever drift. Don't hide it; don't over-alarm it.

## 4. Interaction

- Tap the recompute affordance → states B → (C | D). Optionally auto-run on profile open (design's call — auto-on-load makes "verified ✓" the resting state; tap-to-verify makes it an explicit act). Either is fine functionally.
- Offline must work: the re-derivation runs entirely on-device (no network). If there's no cached server value to compare against (truly offline first-load), design a "re-derived locally (no server to compare yet)" variant — still shows the number is self-consistent, just not server-compared.
- Read-only: this never changes the profile or any data. It only observes + verifies.

## 5. Trust copy semantics — the HONEST boundary (do not let copy oversell)

The verification covers the **display arithmetic** of each KC: the point estimate `p(L)`, the band `lo`/`hi`, and the standard error `SE` — all re-derived from a small set of resolved evidence scalars (the KC's success/fail counts, its precision, its difficulty anchor) via the same math the server uses, now bit-exact across device and server.

**It does NOT re-derive everything.** Specifically it does NOT independently recompute the per-KC difficulty anchor's representative value (a server/DB aggregate). So:
- ✅ Honest copy: *"re-derived from your evidence on this device — matches the server exactly."*
- ❌ Do NOT imply it re-derives the entire pipeline from raw events, or that it re-runs the AI/judging. It audits the **displayed diagnostic arithmetic**, which is the headline trust surface.

**Honest uncertainty stays first-class** (existing principle): wide bands / 低置信 / 未测 are FEATURES, surfaced not hidden. The recompute badge verifies the numbers *including* their uncertainty — it does not make a wide band look more certain. A verified ✓ on a wide-band low-confidence KC means "this honest wide band is itself re-derivable," not "now it's trustworthy."

## 6. Scope / non-goals (for this slice)

- **In**: the recompute affordance + states A–D on the existing profile / calibration-maturity surface; the instant/offline/verified trust moment; the honest-boundary copy.
- **Out (later slices)**: full event-log replay / "scrub the trajectory" (#46), the Twin fan-chart (#30), any animation of the profile *changing* over time. This slice is a static-snapshot verification, not a time machine.
- **Read-only, live-safe.** No data mutation.

## 7. Design-system fit (the only "style" constraint)

Work within the existing **loom design system** (tokens / primitives / the look already used by ScreenProfile + the observability cards). Reuse existing primitives (cards, pills, the band track, icons) where they fit. The verify ✓ / mismatch ✗ indicators and the recompute control are the new elements — give them a treatment coherent with loom, at your discretion. **No palette/type/spacing is prescribed here by engineering; that's design's call.**

## 8. What engineering provides (so design knows the data is real)

- Per-KC, the resolved scalars + the derived `{ p(L) point, lo, hi, SE, confidence bucket, evidence_count }` are already computed server-side (`getMasteryProjection` → `pLearnedBand`) and rendered by ScreenProfile today.
- The on-device re-derivation (the WASM isomorphic core, YUK-495) reproduces those derived numbers bit-for-bit. Engineering wires the compare; design owns how the verify state reads. The "matches to the last bit" claim is real, not marketing.

---

**Loop:** claude design returns visual concepts for the states A–D + the recompute control → engineering implements slice-by-slice against the returned design, verifying each against the prototype (playwright visual loop), no style invented by engineering.
