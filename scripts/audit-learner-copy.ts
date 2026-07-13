import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 只列学习者会直接看到的 surface。Admin/observability 保留诊断术语；API client、注释和
// 标识符也不属于本审计范围。新增学习者 surface 时应显式加入这里。
export const LEARNER_COPY_FILES = [
  'src/ui/shell/AppTopbar.tsx',
  'src/ui/components/VisionTab.tsx',
  'src/capabilities/ingestion/ui/RecordPage.tsx',
  'src/capabilities/practice/ui/PracticeFacePage.tsx',
  'src/capabilities/practice/ui/PfStream.tsx',
  'src/capabilities/practice/ui/QuestionDetailPage.tsx',
  'src/capabilities/shell/ui/TodayPage.tsx',
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
  'src/capabilities/notes/ui/NoteReaderPage.tsx',
] as const;

const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'HTTP endpoint', pattern: /\bGET\s+\/api\//i },
  { label: 'transport protocol', pattern: /\bSSE\b/ },
  { label: 'internal demand mode', pattern: /\bON_DEMAND\b/ },
  { label: 'internal scope field', pattern: /scopeKnowledgeIds/ },
  { label: 'migration milestone', pattern: /\bM[45]\b/ },
  { label: 'legacy implementation', pattern: /旧栈|旧页/ },
  { label: 'internal agent-note kind', pattern: /experimental:agent_note/ },
  { label: 'internal note structure', pattern: /block tree/i },
  { label: 'internal frontier name', pattern: /learnable_frontier/ },
  { label: 'internal family name', pattern: /\blineage\b/i },
  { label: 'internal graph terms', pattern: /\b(?:hierarchy|typed edges?)\b/i },
  { label: 'internal question heading', pattern: /\bQUESTION\b/ },
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
];

export interface CopyViolation {
  file: string;
  line: number;
  label: string;
  value: string;
}

function visibleLiterals(text: string): Array<{ value: string; line: number }> {
  const rows: Array<{ value: string; line: number }> = [];
  // 先去掉整段/单行注释，再按行检查。规则都采用完整词或明确短语，所以不会把
  // `useIngestionSSE` / `QUESTION_KINDS` 这类内部标识符误判为可见术语。
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

export function auditLearnerCopy(files: readonly string[] = LEARNER_COPY_FILES): CopyViolation[] {
  const violations: CopyViolation[] = [];
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const text = fs.readFileSync(absolute, 'utf8');
    for (const literal of visibleLiterals(text)) {
      for (const rule of BANNED) {
        if (rule.pattern.test(literal.value)) {
          violations.push({ file, line: literal.line, label: rule.label, value: literal.value });
        }
      }
    }
  }
  return violations;
}

const violations = auditLearnerCopy();
if (violations.length > 0) {
  console.error('Learner copy audit failed:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.label}] ${JSON.stringify(v.value)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Learner copy audit passed (${LEARNER_COPY_FILES.length} surfaces).`);
}
