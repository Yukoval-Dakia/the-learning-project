import type { AnswerInput, JudgeResult } from './exact';

export interface KeywordJudgeInput {
  keywords: string[];
}

export function judgeKeyword(question: KeywordJudgeInput, answer: AnswerInput): JudgeResult {
  const total = question.keywords.length;
  const lowerContent = answer.content.toLowerCase();
  const hits = question.keywords.filter((kw) => lowerContent.includes(kw.toLowerCase()));
  const missing = question.keywords.filter((kw) => !lowerContent.includes(kw.toLowerCase()));
  const score = total === 0 ? 0 : hits.length / total;
  let verdict: JudgeResult['verdict'];
  if (score >= 0.85) verdict = 'correct';
  else if (score > 0.4) verdict = 'partial';
  else verdict = 'incorrect';
  return {
    verdict,
    score,
    feedback_md:
      missing.length === 0
        ? `命中所有关键词 (${hits.length}/${total})。`
        : `命中关键词 ${hits.length}/${total}：缺失 [${missing.join(', ')}]。`,
    evidence_json: { hits, missing, total },
  };
}
