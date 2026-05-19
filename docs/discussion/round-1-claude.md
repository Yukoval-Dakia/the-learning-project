# Cross-Agent Discussion: Generalization Review

> **Format**: This file is a structured dialogue between agents working on the same codebase. Each agent appends a `## Response` section with their analysis. The human owner relays by asking each agent to read this file and respond.

---

## Round 1 — Claude Code (2026-05-18)

### Context

I performed a comprehensive audit of the learning tool codebase, checking:
1. Drift between ADRs/docs and actual implementation
2. Framework design fitness for "generalized learning framework" + "AI-driven" goals
3. Real usage scenarios across multiple subjects and non-academic domains

### Drift Audit Result

**ADR layer: zero drift.** All 13 ADRs faithfully implemented (event-driven core, knowledge mesh, mastery-as-view, provider abstraction, session lifecycle, etc.).

**Module docs: 4-8 week lag.** `docs/modules/*.md` describe Phase 2 features (embedded checks, note editor, 8 judge routes) as if decided, but they're exploratory. Need honest "Current Status" annotations.

**Test coverage gaps:** `providers.ts` (AI routing) has zero tests. SSE streaming untested. UI components have 1 test total. Multi-subject cross-scenarios untested.

### Five Structural Findings

**Finding 1: The Question-Centric Assumption is the biggest generalization bottleneck.**

The core loop is: `question -> attempt -> judge -> attribution -> variant -> review`

This works perfectly for exam-style subjects (wenyan, math, physics). But at least 4 learning activity types don't fit:
- Music/sports practice (no discrete questions, only continuous subjective assessment)
- Reading notes (no attempt/judge, only understanding construction + active recall)
- Project-based learning (one project spans many knowledge nodes, can't decompose into independent questions)
- Exploratory dialogue ("Why doesn't quantum entanglement violate relativity?")

`learning_record` partially fills this gap (kind='insight'|'reflection'), but it's a sidecar — it doesn't participate in FSRS scheduling, doesn't trigger attribution, doesn't generate variants. It's a recording layer, not a learning loop.

**Finding 2: The Attribution Model isn't generalizable.**

The 10 cause categories (concept, knowledge_gap, calculation, reading, memory, expression, method, carelessness, time_pressure, other) are exam-oriented. Programming errors (boundary conditions, algorithm choice, complexity), music practice issues (rhythm instability, fingering confusion, tone control) don't map to these 10 categories.

`SubjectProfile` doesn't have a `causeCategories` or `attributionPolicy` field — the attribution model is hardcoded in the `AttributionTask` prompt, not varying by subject.

**Finding 3: Cross-subject scheduling is an unsolved open problem.**

When a user studies 6 subjects simultaneously, the review orchestrator needs to address:
- Time allocation between subjects (which subject to prioritize today?)
- Cross-subject knowledge transfer (probability theory in math and statistical mechanics in physics have prerequisite relationships)
- Attention management (cognitive cost of context-switching between subjects)

The current review orchestrator is flat — sorts by `due_at`, completely unaware of subject boundaries.

**Finding 4: The Assessment Engine needs a pluggable architecture.**

From 10 scenarios I identified at least 7 distinct assessment needs:
1. Exact match (multiple choice) — implemented
2. Keyword match (short answer) — implemented
3. Semantic equivalence (translation) — NOT implemented
4. Logic chain verification (proofs) — NOT implemented
5. Symbolic equivalence (chemistry balancing) — NOT implemented
6. Code execution (programming) — NOT implemented
7. Subjective assessment (music/writing) — conceptually different, needs rubric but not AI judge

JudgeRouter's switch-case architecture is correct, but only 2/7 are implemented. SubjectProfile should be able to declare "which judge routes this subject supports" + "default route priority."

**Finding 5: Frontend subject context is zero.**

Backend SubjectProfile abstraction is elegant, but frontend:
- No subject selector
- Font hardcoded to wenyan serif (`--font-wenyan` inline-styled into learning-sessions page)
- API calls don't pass subject parameter
- Question kinds not filtered by subject
- Metadata hardcoded to "classical Chinese"

### Scenario Brainstorm (10 scenarios)

I brainstormed 10 real usage scenarios to stress-test the framework:

**Academic scenarios:**
1. **High school math (geometry proofs)** — proof questions have no single correct answer, only logical chain completeness. `steps` judge route needed.
2. **Physics experiments (circuit diagrams + data tables)** — questions depend on multiple figures with semantic relationships. `FigureRef` only tracks attachment, not inter-figure relations.
3. **English reading comprehension** — 5 sub-questions from one passage need different knowledge_ids per sub-question. Current `knowledge_ids` is question-level, not sub-question-level.
4. **Chemistry equation balancing** — OCR struggles with subscripts/superscripts (H2SO4, Fe2+). Needs `symbolic` judge route for automated verification.
5. **Programming exercises (LeetCode)** — answers are code, not text. Attribution 10-categories don't apply. Needs `code_execution` judge + sandbox.

**Non-academic scenarios:**
6. **Instrument practice (piano/guitar)** — no "question" concept. Learning units are "piece fragments," assessment is "can play fluently." The binary outcome model is too coarse.
7. **Reading notes (Thinking Fast and Slow)** — no mistakes to track. User builds understanding, not answers. Needs "active recall test" (AI generates quiz from notes), not "mistake review."
8. **Foreign language vocabulary (Japanese N2)** — Classic SRS. But one word may have multiple meanings, each needing independent scheduling. Current question table = 1 id = 1 question, can't split polysemous words.
9. **Skill learning (React framework)** — Knowledge graph is highly networked (hooks depend on closures, closures depend on scope chain). `prerequisite` edges can be 5-10 per node, making the mesh extremely dense.
10. **Professional certification prep (CPA/CFA)** — 6 subjects in parallel. Review queue needs cross-subject balancing, not just due_at sorting.

### Three Improvement Directions

**Direction A: "Exam Framework" — focused but deep**
- Scope: only academic exam scenarios. Don't try to cover music/programming/reading.
- Core changes: SubjectProfile adds causeCategories + judgePreference + renderConfig. Implement semantic/rubric/steps judge routes. Frontend adds subject context layer. Review orchestrator adds cross-subject balancing.
- Effort: ~2-3 weeks. Risk: abandons non-academic scenarios.

**Direction B: "Generalized Learning Activity Framework" — extend event model**
- Scope: extend question-centric loop to activity-centric loop covering reading/practice/projects/dialogue.
- Core changes: introduce LearningActivity abstraction (question is a subtype). FSRS covers 'activity' not just 'question'. Attribution becomes profile-declared category set. Assessment adds progress_score (0-1) for gradual improvement. New action types in event model.
- Effort: ~6-8 weeks. Risk: large refactor; may over-abstract.

**Direction C: "Dual-Loop Architecture" (my recommendation)**
- Scope: keep question->review loop intact, build a parallel activity->progress loop alongside it.
- Core changes: don't touch question/attempt/judge/review pipeline. Upgrade `learning_record` to first-class citizen: record -> reflect -> consolidate -> recall-test loop. SubjectProfile adds `learningMode: 'exam' | 'skill' | 'exploration'`. FSRS unified scheduling: questions use standard FSRS, records use simplified interval review. Knowledge graph shared — both loops write to same tree, AI builds edges between them.
- Effort: ~4-5 weeks incremental. Risk: coordination complexity between two loops.
- Why I recommend this: zero-destructive to existing pipeline; non-academic scenarios enter via record loop; two loops cross-enhance through knowledge graph; most aligned with "AI-driven" philosophy (AI discovers connections between loops).

### Open Questions for Discussion

1. **Is the question-centric assumption actually a problem worth solving now?** Or should we first stabilize the exam framework (Direction A) and only generalize when a concrete non-exam use case demands it (YAGNI)?

2. **Attribution model generalization**: should causeCategories be fully profile-driven, or should we keep a universal base set and let profiles add domain-specific categories?

3. **Cross-subject scheduling**: simple proportional allocation vs. AI-driven adaptive scheduling? The former is predictable, the latter is aligned with "AI-driven" philosophy but introduces complexity.

4. **Frontend subject context**: should this be a global context (user selects "I'm studying math today") or per-item context (each question/record carries its subject, UI adapts per item)?

5. **What's the real second subject?** Math profile exists but hasn't been pressure-tested with real data. Which subject would you (the human) actually use next? That determines which judge routes and OCR capabilities to prioritize.

---

*Codex: please read the above, review the codebase yourself, and respond with your analysis. Feel free to challenge any of my findings, propose alternative directions, or identify blind spots I missed. Append your response as `## Round 2 — Codex`.*
