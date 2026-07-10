// YUK-607 — LLM JSON 输出的宽松提取层（修复带）。
//
// quiz supply lane 的四个解析点（quiz_gen / quiz_verify / sourcing 的 parseOutput 克隆
// + verify-framework 的 extractJsonObject）原本都是「brace-slice + JSON.parse」硬解析。
// mimo 对含长中文字符串的题型（阅读理解材料）常产出字符串值内未转义 ASCII 引号的 JSON——
// spike（2026-07-10）实测该题型 3/3 批在生成侧整批阵亡（pg-boss 还会整 run 重试 ×2 白烧），
// solve_check 同族失败则静默降级 unsupported，独立解题轴空转。
//
// 契约（语义红线，勿动）：
//   1. 严格 JSON.parse 成功 → 原样返回 repaired:false，修复带零介入；
//   2. 严格失败 → jsonrepair（未转义引号/裸换行/智能引号等机械修复）后重试，
//      成功 → repaired:true + console.warn（worker 日志可观测修复率）；
//   3. 修复也失败 → 重抛【原始】SyntaxError——各调用点的错误串格式逐字节不变
//      （solve-check 错误串 byte-identical 契约，见 verify-framework 注 OCR PR #716）；
//   4. 文本里没有 {...} → 返回 null，由调用点用自己的既有措辞抛错。
// 修复带只救语法；语义仍由各站点下游的 Zod 门把关，判词/晋级逻辑不变。
//
// 与既有 `src/server/orchestrator/json-sanitize.ts` 的分工：那边是手写状态机、只转义字符串
// 内裸控制字符（teaching / solve-session 在用，保持不动）；本模块面向 quiz supply lane，用
// jsonrepair 覆盖更宽的失败类（未转义引号【spike 观测主类】/ 裸换行 / 智能引号等）。

import { jsonrepair } from 'jsonrepair';

// 确定性转义「内容引号」：一个未被反斜杠转义的 `"`，若其前一个非空白字符不是 {[,:
// （不可能是 string 开引号）、后一个非空白字符也不是 ,}]: （不可能是 string 闭引号或
// key 引号），则它必然是字符串值内部的内容引号 → 转义成 \"。合法 JSON 里结构引号
// 永远紧邻上述结构字符（忽略空白），故本变换对合法 JSON 是恒等映射。
// 动机（spike 2026-07-10 实测坏件）：mimo 在长中文串里写 `引用古语"读书百遍，其义自见"进行
// 说理` ——两个内容引号两侧全是 CJK 字符；jsonrepair 的启发式在此形态误判（把后半当 key，
// "Colon expected"），必须先走这层确定性修复。
function escapeContentQuotes(slice: string): string {
  const isOpenerCtx = (c: string | undefined) => c === '{' || c === '[' || c === ',' || c === ':';
  const isCloserCtx = (c: string | undefined) => c === ',' || c === '}' || c === ']' || c === ':';
  const out: string[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (ch !== '"') {
      out.push(ch);
      continue;
    }
    // 已转义（前面有奇数个反斜杠）→ 原样保留
    let bs = 0;
    for (let j = i - 1; j >= 0 && slice[j] === '\\'; j -= 1) bs += 1;
    if (bs % 2 === 1) {
      out.push(ch);
      continue;
    }
    let p = i - 1;
    while (p >= 0 && /\s/.test(slice[p])) p -= 1;
    let n = i + 1;
    while (n < slice.length && /\s/.test(slice[n])) n += 1;
    const prev = p >= 0 ? slice[p] : undefined;
    const next = n < slice.length ? slice[n] : undefined;
    // 文档首/尾的引号视为结构引号（prev/next 为 undefined 时不转义）
    if (prev === undefined || next === undefined || isOpenerCtx(prev) || isCloserCtx(next)) {
      out.push(ch);
    } else {
      out.push('\\"');
    }
  }
  return out.join('');
}

function tryRepairLadder(slice: string): unknown {
  const escaped = escapeContentQuotes(slice);
  try {
    return JSON.parse(escaped);
  } catch {
    /* 下一级 */
  }
  try {
    return JSON.parse(jsonrepair(slice));
  } catch {
    /* 下一级 */
  }
  return JSON.parse(jsonrepair(escaped)); // 最后一级失败则向上抛，由调用方包装
}

export interface LooseJsonResult {
  json: unknown;
  /** true = 严格解析失败、经 jsonrepair 修复后才成功（供调用点/日志区分） */
  repaired: boolean;
}

/**
 * 从 LLM 输出文本中提取第一个 `{` 到最后一个 `}` 的切片并宽松解析。
 * @param label 出现在修复 warn 日志里的站点名（不进错误串——错误串由调用点自己包）
 * @returns null = 文本中没有 `{...}`；否则解析结果
 * @throws 严格解析与修复都失败时，抛出【严格解析的原始 SyntaxError】
 */
export function parseJsonObjectLoose(text: string, label: string): LooseJsonResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return { json: JSON.parse(slice), repaired: false };
  } catch (strictErr) {
    let repairedJson: unknown;
    try {
      // 修复梯度：①确定性内容引号转义（CJK 语境主失败类）→ ②jsonrepair 兜广谱
      // （裸换行/智能引号/尾逗号等）→ ③两者叠加（引号 + 其它类并发时）。
      repairedJson = tryRepairLadder(slice);
    } catch (repairErr) {
      // 不可修：留一段错误位置附近的有界片段（±120 字符）供诊断——原始输出不落库，
      // 没有这段 warn 时该失败类完全无法事后归因（spike 2026-07-10 教训）。
      const posMatch = /position (\d+)/.exec((strictErr as Error).message);
      const pos = posMatch ? Number(posMatch[1]) : 0;
      const snippet = slice.slice(Math.max(0, pos - 120), pos + 120);
      console.warn(
        `[json-extract] ${label}: UNREPAIRABLE (strict: ${(strictErr as Error).message}; repair: ${(repairErr as Error).message}); snippet@${pos}: ${JSON.stringify(snippet)}`,
      );
      throw strictErr;
    }
    console.warn(`[json-extract] ${label}: repaired malformed LLM JSON (YUK-607 repair band)`);
    return { json: repairedJson, repaired: true };
  }
}
