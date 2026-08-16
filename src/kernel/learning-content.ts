export function htmlContainsAssessment(html: string): boolean {
  return /(?:data-(?:copilot-question-id|copilot-answer|answer|correct)|\b(?:quiz|question|exercise)\b|题目|练习题|测验|作答|答案)/i.test(
    html,
  );
}
