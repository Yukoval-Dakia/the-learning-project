export const meta = {
  name: 'backlog-engine',
  description: 'Autonomous backlog engine: refresh inputs, scan codebase/docs/PRs/Linear, ground+verify, reconcile+rank, draft Linear issues for approval',
  whenToUse: 'Recurring backlog grooming. Self-contained: regenerates its own Linear inventory + scout context each run, so it can be scheduled. NEVER files issues itself — returns a master list + drafts for human approval.',
  phases: [
    { title: 'Refresh', detail: 'regenerate Linear inventory + scout context (self-contained)' },
    { title: 'Discover', detail: 'enumerate ADRs + triage open PRs into buckets at runtime' },
    { title: 'Scan', detail: 'grounded source scanners (ADR drift, code debt, docs, PRs, Linear)' },
    { title: 'Verify', detail: 'adversarial per-task verification — open every cited evidence' },
    { title: 'Reconcile', detail: 'dedup across sources + against all existing issues, rank by impact' },
    { title: 'Select', detail: 'extract top-N new issues (bounded structured)' },
    { title: 'Draft', detail: 'one full Linear issue draft per top item' },
  ],
}

const REPO = '/Users/yukoval/yukoval-projects/the-learning-project'
const SCOUT = '.omc/research/backlog-engine-scout.md'
const INV = '.omc/research/backlog-engine-linear-inventory.md'
const TEAM = 'YUK'

function chunk(arr, n) {
  const out = []
  const size = Math.max(1, Math.ceil(arr.length / n))
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ─────────────────────────── Phase 0: Refresh inputs ───────────────────────────
// Makes the engine self-contained so it can be scheduled: regenerate the Linear
// inventory and scout context fresh each run instead of relying on stale files.
phase('Refresh')
await parallel([
  () => agent(
    `Regenerate the Linear issue inventory file. cd ${REPO}.
Load the Linear list_issues tool: ToolSearch "select:mcp__claude_ai_Linear__list_issues".
Paginate ALL issues for team "${TEAM}", orderBy updatedAt: call with limit 250; if the result is too large it is auto-saved to a file path (parse that file with \`python3 -c "import json;d=json.load(open(PATH));...\"\`); capture the returned \`cursor\`; call again with that cursor; repeat until hasNextPage is false. Each issue dict has: title, status (string), priority{value,name}|null, createdAt, updatedAt, labels[], project (may be absent), and a url ending /issue/YUK-NNN/slug — extract the YUK-NNN identifier from url (there is no 'identifier' key). Dedupe by identifier across pages.
Write markdown to ${INV} (mkdir -p .omc/research) with sections:
## META — total count; count by status; highest/lowest YUK number; and a CAVEAT line: "updatedAt is polluted by workspace reorgs — use createdAt + status + supersession reasoning for staleness, NOT updatedAt."
## FULL INVENTORY — every issue, one per line, sorted by YUK desc: \`YUK-NNN | STATUS | created=YYYY-MM-DD | updated=YYYY-MM-DD | Pn | [labels] | PROJECT | TITLE\`
## OPEN (NON-TERMINAL) — status NOT in {Done,Canceled,Completed,Duplicate}, sorted by YUK asc; state the count.
## DORMANCY CANDIDATES — from OPEN, those with createdAt before (today minus 14 days); one per line with createdAt. Candidates only.
Be exhaustive; do not omit or invent issues. Return ONLY: the file path + total/open/dormancy counts.`,
    { label: 'refresh-inventory', phase: 'Refresh' }
  ),
  () => agent(
    `Regenerate the scout context file ${SCOUT}. cd ${REPO} (mkdir -p .omc/research).
This file is the shared grounding + rules for downstream scanners. Write it with:
- Header: repo root ${REPO}; Linear team "${TEAM}"; today's date (run \`date +%Y-%m-%d\`); default branch main; pointer to ${INV} for dedup.
- IRON RULE: every finding cites concrete evidence (file:line / PR#+comment-url / YUK-id); no speculation.
- Active Linear projects: list them by running the Linear list_projects tool for team ${TEAM} (ToolSearch "select:mcp__claude_ai_Linear__list_projects") — name + status + which is the current product direction; mark Completed projects as "do not add to".
- Linear staleness caveat: updatedAt polluted by reorgs → use createdAt + status + supersession. Point to the graveyard doc docs/superpowers/specs/2026-06-18-rethink-abandoned-directions-archive.md (if it exists) for abandoned directions.
- Stack reality (read CLAUDE.md "Stack note"): Hono API + Vite SPA + pg-boss (Next.js retired YUK-321 M5); PG presence (not Redis); capability manifests in src/capabilities/*/manifest.ts composed in server/app.ts. ADRs predating this may be legitimately superseded.
- Codebase TODO facts: run \`rg -n -e 'TODO|FIXME|HACK|XXX' -g '*.ts' -g '*.tsx' src server web scripts | head -40\` and summarize; note that the real value is ADR drift + non-TODO debt (501/not_implemented stubs, it.todo, FUTURE_* declared-unimplemented, @deprecated).
- docs/ map: run \`find docs -name '*.md' | wc -l\` and \`ls docs docs/design docs/superpowers/specs docs/superpowers/plans docs/planning\`; note distinguish genuinely-open-and-untracked from historical/shipped/intentional-deferred.
- Issue body template (read an existing issue's shape, e.g. via Linear get_issue on a recent Bug issue): sections 现象 / 机制 / 代码证据(file:line, mandatory) / 影响 / 修法(give BOTH 轻量 minimal AND 完整 thorough options) / 验收. Labels from existing set; priority 1-4.
- Dedup rule (MANDATORY): before proposing any NEW issue, check it against ${INV}; classify NEW / TRACKED(cite YUK) / LINEAR-HYGIENE(merge/close existing). Only NEW gets drafted.
Return ONLY the file path written.`,
    { label: 'refresh-scout', phase: 'Refresh' }
  ),
])

// ─────────────────── Phase 0b: Discover ADRs + triage open PRs ───────────────────
phase('Discover')
const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    adrs: { type: 'array', items: { type: 'string' } },
    reviewPRs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { number: { type: 'number' }, title: { type: 'string' }, note: { type: 'string' } }, required: ['number'] } },
    auditDriftPRs: { type: 'array', items: { type: 'number' } },
    depPRs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { number: { type: 'number' }, title: { type: 'string' } }, required: ['number'] } },
  },
  required: ['adrs', 'reviewPRs', 'auditDriftPRs', 'depPRs'],
}
const disc = await agent(
  `cd ${REPO}. Enumerate inputs for the backlog scan. Return a structured object:
- adrs: every ADR id from \`ls docs/adr/*.md\` (just the leading number string, e.g. "0001","0034"; one per file).
- reviewPRs: open PRs likely to carry UNADDRESSED review comments. From \`gh pr list --state open --json number,title,headRefName,isDraft,author --limit 80\`: include PRs that are NOT \`audit-drift/*\` branches and NOT dependabot, especially bot-authored (devin/codex) or human PRs with review threads. For each add {number,title,note} (note = why it's a review candidate). Cap ~15.
- auditDriftPRs: the numbers of all open \`audit-drift/YYYY-MM-DD\` draft PRs (process-hygiene pile).
- depPRs: open dependabot PRs as {number,title}.
Be accurate; use gh. Do not invent PR numbers.`,
  { label: 'discover', phase: 'Discover', schema: DISCOVERY_SCHEMA }
)

const adrBatches = chunk(disc && disc.adrs ? disc.adrs : [], 5)
const reviewPRs = (disc && disc.reviewPRs ? disc.reviewPRs : [])
const auditDriftPRs = (disc && disc.auditDriftPRs ? disc.auditDriftPRs : [])
const depPRs = (disc && disc.depPRs ? disc.depPRs : [])
log(`Discovered ${(disc && disc.adrs || []).length} ADRs (${adrBatches.length} batches), ${reviewPRs.length} review PRs, ${auditDriftPRs.length} audit-drift drafts, ${depPRs.length} dependabot PRs`)

function preamble(key) {
  return `You are a grounding-strict backlog scanner (key=${key}). First: cd ${REPO} and run \`pwd && git rev-parse --show-toplevel\`.
READ FIRST: ${SCOUT} (shared grounding + rules). For Linear cross-check also read ${INV}.
IRON RULE: every finding cites concrete evidence — \`file:line\` / \`PR#NNN + comment URL\` / \`YUK-id\`. NO speculation; if you did not open and confirm it, do NOT report it. Quote the snippet.
Prefer serena / claude-context over blind grep for code discovery; grep for literal strings.
OUTPUT markdown, numbered. Per finding use EXACTLY:
### F-${key}-<n>: <short imperative title>
- source: <codebase|docs|prs|linear>
- evidence: <specific file:line / PR#+url / YUK-id + quoted snippet>
- severity: <data-loss|security|correctness|reliability|hygiene|docs>
- impact: <one sentence blast radius>
- existing: <likely-tracked YUK-NNN via ${INV}, or "none">
- summary: <2-3 sentences: what is wrong + why it matters>
- proposed-fix-seed: <one line direction>
Report ONLY genuinely-actionable, untracked/under-tracked items. If none, say "NO ACTIONABLE FINDINGS". Do not pad.`
}

function adrTask(key, adrs) {
  return {
    key, label: `scan:${key}`,
    prompt: `${preamble(key)}

YOUR AREA — ADR implementation drift. For each ADR below (docs/adr/), read it, extract the DECISION, then check whether current code implements it. Report DRIFT ("ADR decided X, code does Y (file:line)") and silently-reversed-without-supersession-marker cases. If an ADR is correctly marked superseded and code matches, do NOT report.
ADRs: ${adrs.join(',')}
Stack note (scout): Next.js→Hono+Vite+pg-boss, Redis→PG, routes→capability manifests. ADRs predating that may be legitimately superseded — only report if the supersession is UNDOCUMENTED or code half-migrated.`,
  }
}

const TASKS = [
  ...adrBatches.map((b, i) => adrTask(`ADR${i + 1}`, b)),
  {
    key: 'CODE', label: 'scan:CODE', effort: 'medium',
    prompt: `${preamble('CODE')}

YOUR AREA — non-ADR code debt across src/ server/ web/ scripts/: \`throw ... not_implemented\` / HTTP 501 stubs; \`it.todo(\`/\`describe.todo\` placeholder tests; declared-but-unimplemented routes/maps (e.g. FUTURE_* dispatch tables); \`@deprecated\` symbols still referenced (check the deprecation notice is accurate vs callers); TODO/FIXME/HACK/XXX without a YUK ref. Use rg for markers, serena to confirm reachability. Report only actionable + untracked (check ${INV}).`,
  },
  { key: 'DOCSADR', label: 'scan:DOCSADR', prompt: `${preamble('DOCSADR')}\n\nYOUR AREA — unfinished DECISIONS inside docs/adr/: ADRs in Proposed/Draft/Accepted-but-unimplemented with no tracking issue; unresolved "open question"/"TBD"/"未决" that still matter; ADRs contradicting a newer ADR without a supersession note. Cite adr:line + quote. Skip implemented/tracked.` },
  { key: 'DOCSSPEC', label: 'scan:DOCSSPEC', prompt: `${preamble('DOCSSPEC')}\n\nYOUR AREA — docs/superpowers/specs/ + docs/superpowers/plans/. Find genuinely-open, still-relevant, UNTRACKED items: unresolved open questions, deferred items with no YUK, specced capability never built. Weight toward recent docs + current direction. Ignore shipped phases + intentional deferrals carrying a tracking ref. Cite doc:line + quote.` },
  { key: 'DOCSDES', label: 'scan:DOCSDES', prompt: `${preamble('DOCSDES')}\n\nYOUR AREA — docs/design/ + docs/planning/ (roadmaps v0.4/v0.5/copilot-arch). Find roadmap items planned-never-started/tracked; design decisions left TBD that still matter; gap-analysis/decisions-ledger docs listing unresolved items. Cite doc:line + quote. Skip shipped/tracked.` },
  { key: 'DOCSMISC', label: 'scan:DOCSMISC', prompt: `${preamble('DOCSMISC')}\n\nYOUR AREA — docs/discussion/, docs/modules/, docs/architecture.md, docs/agents/, docs/preflight/, docs/deploy/, root docs/*.md. Find unresolved threads, stale architecture/module claims that contradict current code, deploy/runbook gaps. Cite doc:line + quote. Skip tracked/shipped.` },
  {
    key: 'PRREVIEW', label: 'scan:PRREVIEW',
    prompt: `${preamble('PRREVIEW')}

YOUR AREA — open PRs with UNADDRESSED review comments. Examine these PRs: ${reviewPRs.map((p) => `#${p.number}`).join(', ') || '(none discovered)'}. For each: \`gh api repos/:owner/:repo/pulls/N/comments\`, \`.../reviews\`, \`.../issues/N/comments\`, \`gh pr view N --json title,state,isDraft,commits,headRefName\`. Determine which review comments are UNADDRESSED (no resolving follow-up commit; thread unresolved). Cross-check the linked issue status from ${INV} — flag "abandoned PR with open review comments" / "obsolete vs its issue (Canceled/Done)". Cite PR#, comment author+URL+quoted text, and the resolution gap. A still-valid review comment on a still-wanted change = actionable.`,
  },
  {
    key: 'PRHYG', label: 'scan:PRHYG', effort: 'medium',
    prompt: `${preamble('PRHYG')}

YOUR AREA — PR hygiene + dependency PRs.
1. audit-drift draft pile: ${auditDriftPRs.length} open \`audit-drift/*\` draft PRs (${auditDriftPRs.map((n) => `#${n}`).join(', ') || 'none'}). Confirm via gh. Finding = the daily audit-drift run opens draft PRs never triaged/closed → unbounded accumulation, reports never reach main.
2. dependabot pile: ${depPRs.map((p) => `#${p.number}`).join(', ') || 'none'}. Confirm open + age via gh; check whether any address known advisories tracked in Linear (search ${INV} for hono/undici/CVE). A stale security-relevant bump unmerged, or a poison bump blocking a group PR, = actionable. Do NOT propose merging — propose the triage/close-loop or config fix.
Cite PR numbers + dates + advisory linkage.`,
  },
  {
    key: 'LINEAR', label: 'scan:LINEAR',
    prompt: `${preamble('LINEAR')}

YOUR AREA — stale & duplicate Linear issues. Read ${INV} (full inventory + dormancy candidates) AND the graveyard doc docs/superpowers/specs/2026-06-18-rethink-abandoned-directions-archive.md (if present).
DUPLICATES: scan the OPEN set for near-identical or strongly-overlapping titles/scope. For each genuine cluster, read both issues (Linear get_issue — ToolSearch the tool) and confirm real overlap; recommend which to keep + which to set duplicateOf/close. Do NOT flag legitimate sequential decompositions (Step 0-N families, T-D*/S2-* sub-task families, follow-up chains).
STALE/SUPERSEDED: from OPEN (esp. dormancy candidates), find issues whose direction is abandoned/demoted per the graveyard, or superseded by a newer issue, or describing shipped work. Cite YUK-id + createdAt + supersession evidence. Be conservative — backlog ≠ stale.
Output standard F-LINEAR-<n> blocks; include both YUK-ids for dups.`,
  },
]

// ─────────────────────── Phase 1+2: scan → adversarial verify ───────────────────────
const verifyStage = (scanMd, task) => {
  if (!scanMd || (/NO ACTIONABLE FINDINGS/i.test(scanMd) && scanMd.length < 400)) return scanMd
  return agent(
    `You are an adversarial verifier (task=${task.key}). cd ${REPO}. Below are scanner findings. For EACH: OPEN the cited evidence yourself — Read the file:line, \`gh api\` the PR/comment, or look up the YUK-id in ${INV} / via Linear get_issue. Confirm BOTH (a) the evidence says what's claimed and (b) it's genuinely actionable and NOT already resolved/shipped/tracked. Be skeptical; default to DROPPING anything unconfirmable.
Return the SAME finding blocks but keep ONLY verified ones; append \`- verified: yes — <how confirmed>\` to each kept block; fix wrong evidence refs. End with \`- dropped: <n> (reasons)\` if any. If none survive, output \`NO VERIFIED FINDINGS\`.

FINDINGS:
${scanMd}`,
    { label: `verify:${task.key}`, phase: 'Verify' }
  )
}

phase('Scan')
const verified = await pipeline(
  TASKS,
  (task) => agent(task.prompt, { label: task.label, phase: 'Scan', effort: task.effort }),
  verifyStage,
)

const survivors = verified.filter((m) => m && !/^\s*NO VERIFIED FINDINGS\s*$/i.test(m))
log(`Verified findings from ${survivors.length}/${TASKS.length} source tasks`)
const corpus = survivors.map((m, i) => `## SOURCE TASK ${TASKS[i] ? TASKS[i].key : i}\n\n${m}`).join('\n\n---\n\n')

// ─────────────────────── Phase 3: reconcile (barrier) ───────────────────────
phase('Reconcile')
const masterList = await agent(
  `You are the reconciliation pass for an autonomous backlog engine. cd ${REPO}. READ ${INV} (all existing issues) and ${SCOUT} (rules + template).
Below is the corpus of VERIFIED findings. Do four things:
1. DEDUP ACROSS SOURCES: collapse findings describing the same underlying problem (keep strongest evidence).
2. DEDUP AGAINST EXISTING ISSUES: for each, check ${INV} by keyword → NEW / TRACKED (cite YUK, don't refile) / LINEAR-HYGIENE (merge/close/supersede existing).
3. RANK NEW items by IMPACT: data-loss / security / nightly-chain breakage / all-PR-CI broken > core-path correctness/reliability > niche correctness > hygiene > docs; factor reach + actionability.
4. Suggest per NEW item: target project + parent umbrella + priority (1-4).
OUTPUT one markdown master list:
## A. TOP NEW ISSUES TO FILE (ranked) — each: **<title>** — severity · impact(1-5) · effort(S/M/L) · project/parent/priority · sources · key evidence · one-line rationale.
## B. OTHER NEW (lower priority, not drafted) — brief bullets.
## C. ALREADY TRACKED (finding → YUK).
## D. LINEAR HYGIENE ACTIONS (merge/close/supersede + which to keep + evidence).
## E. STATS (counts: sources surviving, verified findings, NEW, TRACKED, HYGIENE, dropped-as-dup).
Proposing an issue that already exists is the #1 failure — dedup rigorously against ${INV}.

VERIFIED FINDINGS CORPUS:
${corpus}`,
  { label: 'reconcile', phase: 'Reconcile' }
)

// ─────────────────────── Phase 4: select top-N (bounded schema) ───────────────────────
phase('Select')
const TOPN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    items: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          rank: { type: 'number' },
          title: { type: 'string' },
          theme: { type: 'string' },
          severity: { type: 'string', enum: ['data-loss', 'security', 'correctness', 'reliability', 'hygiene', 'docs'] },
          impact: { type: 'number', minimum: 1, maximum: 5 },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          suggestedProject: { type: ['string', 'null'] },
          suggestedParent: { type: ['string', 'null'] },
          suggestedPriority: { type: 'number', enum: [1, 2, 3, 4] },
          oneLine: { type: 'string' },
        },
        required: ['rank', 'title', 'severity', 'impact', 'effort', 'evidenceRefs', 'suggestedPriority', 'oneLine'],
      },
    },
  },
  required: ['items'],
}
const sel = await agent(
  `From the master list below, extract the items under "## A. TOP NEW ISSUES TO FILE" as a structured array (preserve rank order, cap 12). Copy evidenceRefs verbatim. Do not invent items not in section A.

MASTER LIST:
${masterList}`,
  { label: 'select-topN', phase: 'Select', schema: TOPN_SCHEMA, effort: 'medium' }
)
const items = (sel && sel.items ? sel.items : []).slice().sort((a, b) => a.rank - b.rank)
log(`Selected ${items.length} top items for drafting`)

// ─────────────────────── Phase 5: draft a full issue per top item ───────────────────────
phase('Draft')
const drafts = await parallel(items.map((it) => () =>
  agent(
    `You are drafting ONE well-scoped Linear issue. cd ${REPO}. RE-OPEN the cited evidence (confirm file:line still holds). Follow the EXACT template from ${SCOUT}:
- optional first line: 关联/父 epic if suggestedParent set.
- ## 现象 / ## 机制 / ## 代码证据 (file:line, mandatory, re-confirmed) / ## 影响 / ## 修法 (BOTH 轻量 AND 完整) / ## 验收 (verifiable).

ITEM:
title: ${it.title}
theme: ${it.theme || ''}
severity: ${it.severity} · impact ${it.impact} · effort ${it.effort}
sources: ${(it.sources || []).join(', ')}
evidenceRefs: ${(it.evidenceRefs || []).join(' | ')}
suggestedProject: ${it.suggestedProject || 'none'} · suggestedParent: ${it.suggestedParent || 'none'} · suggestedPriority: ${it.suggestedPriority}
oneLine: ${it.oneLine}

OUTPUT markdown: first a metadata header:
\`\`\`
TITLE: <final concise imperative title>
PROJECT: <project name or none>
PARENT: <YUK-NNN or none>
PRIORITY: <1-4>
LABELS: <comma list of EXISTING labels only, or empty>
\`\`\`
then the full issue body. Tight, evidence-dense, no filler.`,
    { label: `draft:${(it.title || 'item').slice(0, 28)}`, phase: 'Draft' }
  ).then((md) => ({ title: it.title, meta: it, draftMarkdown: md })).catch(() => null)
))

return { masterList, drafts: drafts.filter(Boolean), selectedCount: items.length, sourcesSurviving: survivors.length }
