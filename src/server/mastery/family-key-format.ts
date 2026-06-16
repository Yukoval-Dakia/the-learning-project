// YUK-372 — family_key 串格式的**单一真相源**（无依赖纯函数）。
//
// family_key = `${subject}:${primaryKnowledgeId}:${kind}:${source}`，是
// item_family_calibration 的主键。此前 family-key.ts:buildFamilyKey 与
// personalized-difficulty.ts:familyKey 各内联一份格式串、靠注释约定同步——任一处改格式漏改另一处
// 会让读写键瞬间漂移、静默废掉所有家族校准（慢资产）。提到本无依赖模块由两边 import，消除
// 「改一处漏另一处」的窗口（不引入 family-key.ts ↔ personalized-difficulty.ts 循环依赖）。
export function buildFamilyKey(
  subject: string,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): string {
  return `${subject}:${primaryKnowledgeId}:${kind}:${source}`;
}
