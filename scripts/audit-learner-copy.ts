import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const ALLOWLIST_PATH = 'scripts/audit-learner-copy-allowlist.json';

// Only surfaces learners see directly. Admin/observability keep diagnostic terms; API clients,
// comments, and identifiers are out of scope. Add new learner surfaces explicitly here.
export const LEARNER_COPY_FILES = [
  'src/ui/shell/AppTopbar.tsx',
  'src/ui/components/VisionTab.tsx',
  'src/ui/components/UsageReceiptLine.tsx',
  'src/ui/primitives/CollapsibleList.tsx',
  'src/capabilities/ingestion/ui/RecordPage.tsx',
  'src/capabilities/practice/ui/PracticeFacePage.tsx',
  'src/capabilities/practice/ui/PfStream.tsx',
  'src/capabilities/practice/ui/PfPaper.tsx',
  'src/capabilities/practice/ui/solo/PracticeSolo.tsx',
  'src/capabilities/practice/ui/solo/DraftConflictPanel.tsx',
  'src/capabilities/practice/ui/solo/SoloCoach.tsx',
  'src/capabilities/practice/ui/solo/FigureLightbox.tsx',
  'src/capabilities/practice/ui/solo/QuoteSelection.tsx',
  'src/capabilities/practice/ui/HintLadder.tsx',
  'src/capabilities/practice/ui/worksheet/WorksheetPrintPage.tsx',
  'src/capabilities/practice/ui/worksheet/worksheet-plan.ts',
  'src/capabilities/shell/ui/TodayPage.tsx',
  'src/capabilities/practice/ui/library/LibraryPage.tsx',
  'src/capabilities/practice/ui/library/ScopeLine.tsx',
  'src/capabilities/practice/ui/library/QuestionLine.tsx',
  'src/capabilities/practice/ui/library/AllView.tsx',
  'src/capabilities/practice/ui/library/MistakesView.tsx',
  'src/capabilities/practice/ui/library/ReviewView.tsx',
  'src/capabilities/practice/ui/library/ReviewBar.tsx',
  'src/capabilities/practice/ui/library/HeldView.tsx',
  'src/capabilities/practice/ui/library/ServingButton.tsx',
  'src/capabilities/practice/ui/library/QuestionPage.tsx',
  'src/capabilities/practice/ui/library/QuestionBanner.tsx',
  'src/capabilities/practice/ui/library/QuestionNotice.tsx',
  'src/capabilities/practice/ui/library/QuestionPaper.tsx',
  'src/capabilities/practice/ui/library/QuestionEditor.tsx',
  'src/capabilities/practice/ui/library/QuestionTidy.tsx',
  'src/capabilities/practice/ui/library/MyHistory.tsx',
  'src/capabilities/practice/ui/library/NextSteps.tsx',
  'src/capabilities/practice/ui/library/library-copy.ts',
  'src/capabilities/practice/ui/library/mistake-read.ts',
  'src/capabilities/practice/ui/library/use-question-writes.ts',
  'src/capabilities/practice/ui/library/use-batch-verify.ts',
  'src/capabilities/copilot/ui/companion/CompanionPanel.tsx',
  'src/capabilities/copilot/ui/companion/Composer.tsx',
  'src/capabilities/copilot/ui/companion/ContextBar.tsx',
  'src/capabilities/copilot/ui/companion/ConversationList.tsx',
  'src/capabilities/copilot/ui/companion/HeroBlock.tsx',
  'src/capabilities/copilot/ui/companion/MessageRow.tsx',
  'src/capabilities/copilot/ui/companion/NudgeBar.tsx',
  'src/capabilities/copilot/ui/companion/ProposalNotice.tsx',
  'src/capabilities/copilot/ui/companion/RunFooter.tsx',
  'src/capabilities/copilot/ui/companion/SkillTurnBlock.tsx',
  'src/capabilities/copilot/ui/companion/SummaryCard.tsx',
  'src/capabilities/copilot/ui/companion/ToolResultSnapshot.tsx',
  'src/capabilities/copilot/ui/companion/ToolRow.tsx',
  'src/capabilities/copilot/ui/companion/focus-chips.ts',
  'src/capabilities/copilot/ui/companion/plain-errors.ts',
  'src/capabilities/copilot/ui/companion/run-copy.ts',
  'src/capabilities/copilot/ui/companion/tool-labels.ts',
  'src/capabilities/shell/ui/InboxPage.tsx',
  'src/capabilities/shell/ui/inbox-tier.ts',
  'src/capabilities/shell/ui/blocks/SessionsStrip.tsx',
  'src/capabilities/shell/ui/blocks/KpiRow.tsx',
  'src/capabilities/shell/ui/blocks/LoomHero.tsx',
  'src/capabilities/shell/ui/coach-hub-view.ts',
  'src/capabilities/shell/ui/CoachHub.tsx',
  'src/capabilities/shell/ui/CoachCalibrationView.tsx',
  'src/capabilities/shell/ui/EffectivenessTrendPanel.tsx',
  'src/capabilities/onboarding/ui/ScreenProfile.tsx',
  'src/capabilities/onboarding/ui/recompute/RecomputeComponents.tsx',
  'src/capabilities/agency/ui/page.tsx',
  'src/capabilities/agency/ui/AgentNotesBoard.tsx',
  'src/capabilities/agency/ui/AgentNoteCard.tsx',
  'src/capabilities/agency/ui/AgentNoteGroupCard.tsx',
  'src/capabilities/agency/ui/meta.ts',
  'src/capabilities/observability/ui/EventDetailPage.tsx',
  'src/capabilities/knowledge/ui/KnowledgePage.tsx',
  'src/capabilities/knowledge/ui/NodeDrawer.tsx',
  'src/capabilities/knowledge/ui/FrontierRail.tsx',
  'src/capabilities/knowledge/ui/BandChip.tsx',
  'src/capabilities/knowledge/ui/NodeComposite.tsx',
  'src/capabilities/knowledge/ui/node-dims.ts',
  'src/capabilities/knowledge/ui/KnowledgeDetailPage.tsx',
  'src/capabilities/knowledge/ui/MisconceptionList.tsx',
  'src/capabilities/knowledge/ui/MeshGraph.tsx',
  'src/capabilities/notes/ui/NotesPage.tsx',
  'src/capabilities/notes/ui/NoteReaderPage.tsx',
] as const;

const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'HTTP endpoint', pattern: /\bGET\s+\/api\//i },
  { label: 'transport protocol', pattern: /\bSSE\b/ },
  { label: 'internal demand mode', pattern: /\bON_DEMAND\b/ },
  { label: 'internal session kind', pattern: /\breview_session\b/ },
  { label: 'internal decision verbs', pattern: /\baccept\s*\/\s*dismiss\b/i },
  { label: 'internal agent wording', pattern: /代理观察/ },
  { label: 'raw Coach metric', pattern: /label\s*=\s*['"]reviews|无失败\s+attempt/i },
  { label: 'internal scope field', pattern: /scopeKnowledgeIds/ },
  { label: 'migration milestone', pattern: /\bM[45]\b/ },
  { label: 'legacy implementation', pattern: /旧栈|旧页/ },
  { label: 'internal agent-note kind', pattern: /experimental:agent_note/ },
  { label: 'internal note structure', pattern: /block tree/i },
  { label: 'internal frontier name', pattern: /learnable_frontier/ },
  { label: 'internal family name', pattern: />[^<{]*\blineage\b/i },
  { label: 'internal graph terms', pattern: /\b(?:hierarchy|typed edges?)\b/i },
  { label: 'internal question heading', pattern: /\bQUESTIONS?\b/ },
  {
    label: 'raw practice item identity',
    pattern: /\{it\.item_kind\}.*\{it\.ref_id/,
  },
  {
    label: 'internal practice author label',
    pattern: />[^<]*\b(?:composer|coach)\s*·/i,
  },
  { label: 'internal record heading', pattern: /\bRECORD\b\s*·\s*attempts/i },
  { label: 'internal domain field', pattern: /\/\s*domain\b/i },
  { label: 'internal question field', pattern: /题面\s+stem\b/i },
  { label: 'modeling acronym', pattern: /\b(?:CDM|IRT)\b/ },
  { label: 'storage or worker detail', pattern: /\b(?:R2|worker)\b/i },
  { label: 'document pipeline detail', pattern: /\b(?:pandoc|VLM)\b/i },
  { label: 'learning-model detail', pattern: /\b(?:FSRS|PFA)\b|p\(L\)/i },
  { label: 'internal trend term', pattern: /纵向\s+delta|\bKC\b|\bn\s*=\s*\d+/ },
  {
    label: 'internal calibration term',
    pattern: /θ̂|\bfirm up\b|\bcold-start\b|\bevidence\s*=\s*0/i,
  },
  { label: 'architecture language', pattern: /正交|\badr-\d+/i },
  {
    label: 'internal verification language',
    pattern: /本设备重导|服务端|逐位|succ\s*\/\s*fail|p̂|(?:中位|θ̂)\s+SE\b|>\s*SE\s*</i,
  },
  { label: 'internal profile heading', pattern: /per-KC|mastery_state|precision/i },
  { label: 'internal AI task kind', pattern: /\b[A-Z][A-Za-z]+Task\b/ },
  {
    label: 'disconnected action copy',
    pattern: /暂未接线|尚未接线|暂未接通|尚未接通|占位(?:成功|动作)|(?:假|伪)成功/,
  },
  { label: 'dead placeholder action', pattern: /\b(?:const|let)\s+placeholder\s*=/ },
];

export interface CopyViolation {
  file: string;
  line: number;
  label: string;
  value: string;
}

export interface CopyAllowlistEntry {
  file: string;
  label: string;
  valueIncludes: string;
  reason: string;
}

interface CopyAllowlistFile {
  entries: CopyAllowlistEntry[];
}

function visibleLiterals(text: string): Array<{ value: string; line: number }> {
  const rows: Array<{ value: string; line: number }> = [];
  // Strip block/line comments before checking each line. Rules use whole words or explicit phrases,
  // so internal identifiers like `useIngestionSSE` / `QUESTION_KINDS` are not false positives.
  let inBlockComment = false;
  for (const [index, rawLine] of text.split('\n').entries()) {
    let line = rawLine;
    let cleaned = '';
    for (let i = 0; i < line.length; i += 1) {
      if (inBlockComment) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '/') break;
      cleaned += line[i];
    }
    line = cleaned.trim();
    if (line.length > 0) rows.push({ value: line, line: index + 1 });
  }
  return rows;
}

export function scanLearnerCopy(file: string, text: string): CopyViolation[] {
  const violations: CopyViolation[] = [];
  for (const literal of visibleLiterals(text)) {
    for (const rule of BANNED) {
      if (rule.pattern.test(literal.value)) {
        violations.push({ file, line: literal.line, label: rule.label, value: literal.value });
      }
    }
  }
  return violations;
}

export function validateCopyAllowlist(entries: readonly CopyAllowlistEntry[]): void {
  for (const [index, entry] of entries.entries()) {
    for (const key of ['file', 'label', 'valueIncludes', 'reason'] as const) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new Error(`learner-copy allowlist entry ${index} has empty ${key}`);
      }
    }
  }
}

export function readCopyAllowlist(file = ALLOWLIST_PATH): CopyAllowlistEntry[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as CopyAllowlistFile;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`${file} must contain an entries array`);
  }
  validateCopyAllowlist(parsed.entries);
  return parsed.entries;
}

function allowlistMatches(violation: CopyViolation, entry: CopyAllowlistEntry): boolean {
  return (
    violation.file === entry.file &&
    violation.label === entry.label &&
    violation.value.includes(entry.valueIncludes)
  );
}

export function applyCopyAllowlist(
  violations: readonly CopyViolation[],
  entries: readonly CopyAllowlistEntry[],
): { violations: CopyViolation[]; staleEntries: CopyAllowlistEntry[] } {
  validateCopyAllowlist(entries);
  return {
    violations: violations.filter(
      (violation) => !entries.some((entry) => allowlistMatches(violation, entry)),
    ),
    staleEntries: entries.filter(
      (entry) => !violations.some((violation) => allowlistMatches(violation, entry)),
    ),
  };
}

export function auditLearnerCopy(
  files: readonly string[] = LEARNER_COPY_FILES,
  allowlist: readonly CopyAllowlistEntry[] = readCopyAllowlist(),
): { violations: CopyViolation[]; staleEntries: CopyAllowlistEntry[] } {
  const found: CopyViolation[] = [];
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const text = fs.readFileSync(absolute, 'utf8');
    found.push(...scanLearnerCopy(file, text));
  }
  return applyCopyAllowlist(found, allowlist);
}

function run(): void {
  const { violations, staleEntries } = auditLearnerCopy();
  if (violations.length > 0 || staleEntries.length > 0) {
    console.error('Learner copy audit failed:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.label}] ${JSON.stringify(v.value)}`);
    }
    for (const entry of staleEntries) {
      console.error(
        `  stale allowlist [${entry.label}] ${entry.file} contains ${JSON.stringify(entry.valueIncludes)}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(`Learner copy audit passed (${LEARNER_COPY_FILES.length} surfaces).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
