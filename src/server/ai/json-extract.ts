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

import { sanitizeJsonStringLiterals } from '@/server/orchestrator/json-sanitize';

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

// 确定性转义 JSON 字符串里的非法反斜杠：模型写 LaTeX 时偶尔输出 `\(`
// / `\dfrac` 这类单反斜杠序列；它们不是合法 JSON escape，却能在不改变内容的
// 前提下机械改写为 `\\(` / `\\dfrac`。合法的 JSON escape（含完整 `\uXXXX`）
// 原样保留。只在字符串内部处理，绝不重划字符串边界。
function escapeInvalidJsonStringBackslashes(slice: string): string {
  const out: string[] = [];
  let inString = false;
  let mathDelimiter: '$' | '$$' | '\\(' | '\\[' | null = null;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (!inString) {
      out.push(ch);
      if (ch === '"') {
        inString = true;
        mathDelimiter = null;
      }
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      inString = false;
      mathDelimiter = null;
      continue;
    }
    if (ch === '$') {
      const delimiter = slice[i + 1] === '$' ? '$$' : '$';
      if (mathDelimiter === delimiter) {
        mathDelimiter = null;
      } else if (mathDelimiter === null) {
        mathDelimiter = delimiter;
      }
      out.push(delimiter);
      if (delimiter === '$$') i += 1;
      continue;
    }
    if (ch !== '\\') {
      out.push(ch);
      continue;
    }

    const next = slice[i + 1];
    if (next === '"' || next === '\\' || next === '/') {
      out.push(ch, next);
      i += 1;
      continue;
    }
    const suffix = slice.slice(i + 1);
    const likelyLatexCommand =
      mathDelimiter !== null &&
      (/^[bfrt][A-Za-z]/.test(suffix) || /^n(?:abla|eg|eq|ewline|ot|u)/.test(suffix));
    if (next && 'bfnrt'.includes(next) && !likelyLatexCommand) {
      out.push(ch, next);
      i += 1;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(slice.slice(i + 2, i + 6))) {
      out.push(slice.slice(i, i + 6));
      i += 5;
      continue;
    }
    if ((next === '(' || next === '[') && mathDelimiter === null) {
      mathDelimiter = next === '(' ? '\\(' : '\\[';
    } else if (
      (next === ')' && mathDelimiter === '\\(') ||
      (next === ']' && mathDelimiter === '\\[')
    ) {
      mathDelimiter = null;
    }

    out.push('\\\\');
  }
  return out.join('');
}

// 模型偶尔在完整输出末尾少闭合一层 object/array。只有在字符串已闭合、括号栈
// 从未错配时，才把栈中确定可知的闭合符逆序补到末尾；截断在字符串/属性值中间的
// 情形保持原样，继续响亮失败。
function closeUnterminatedJsonContainers(slice: string): string {
  const expectedClosers: string[] = [];
  let inString = false;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      expectedClosers.push('}');
    } else if (ch === '[') {
      expectedClosers.push(']');
    } else if (ch === '}' || ch === ']') {
      if (expectedClosers.pop() !== ch) return slice;
    }
  }
  if (inString || expectedClosers.length === 0) return slice;
  return slice + expectedClosers.reverse().join('');
}

export type RepairLevel = false | 'deterministic' | 'jsonrepair';

interface LadderHit {
  json: unknown;
  level: Exclude<RepairLevel, false>;
}

// 修复梯度（PR #750 独立 review MAJOR 后分级）：
//   确定性级（内容保真可证明，只做转义、绝不重划字符串边界）：
//     ① escapeContentQuotes（内容引号）
//     ② escapeInvalidJsonStringBackslashes（字符串内非法反斜杠）
//     ③ sanitizeJsonStringLiterals（字符串内裸控制字符，复用 orchestrator 状态机）
//     ④ closeUnterminatedJsonContainers（只补确定缺失的尾部闭合符）
//   jsonrepair 级（启发式；对 ASCII 标点毗邻引号的形态可能【静默重划字符串边界】——
//   截断内容 + 伪造 key，且能过非 strict 的 Zod 门。review 已用真实 lib 复现）：
//     ⑤ jsonrepair(原文)  ⑥ jsonrepair(确定性结果)
// allowRisky=false 时只走确定性级——适用于「解析结果直接持久化且无下游隔离门」的站点。
function tryRepairLadder(
  slice: string,
  allowRisky: boolean,
  allowContainerClosure: boolean,
): LadderHit {
  const escaped = escapeInvalidJsonStringBackslashes(escapeContentQuotes(slice));
  try {
    return { json: JSON.parse(escaped), level: 'deterministic' };
  } catch {
    /* 下一级 */
  }
  const sanitizedEscaped = sanitizeJsonStringLiterals(escaped);
  const sanitized = allowContainerClosure
    ? closeUnterminatedJsonContainers(sanitizedEscaped)
    : sanitizedEscaped;
  try {
    return { json: JSON.parse(sanitized), level: 'deterministic' };
  } catch (deterministicErr) {
    if (!allowRisky) throw deterministicErr;
  }
  try {
    return { json: JSON.parse(jsonrepair(slice)), level: 'jsonrepair' };
  } catch {
    /* 下一级 */
  }
  return { json: JSON.parse(jsonrepair(sanitized)), level: 'jsonrepair' }; // 失败向上抛，由调用方包装
}

export interface LooseJsonResult {
  json: unknown;
  /**
   * false = 严格解析直接成功；'deterministic' = 仅经内容保真的确定性修复（引号/控制字符
   * 转义），可与严格解析同等对待；'jsonrepair' = 经启发式修复——语法救回但内容完整性
   * 无法机证（可能截断/重划字符串边界），**持久化内容的调用点必须做隔离**
   * （quiz_gen → metadata.parse_repaired → quiz_verify 晋级封顶 needs_review）。
   */
  repaired: RepairLevel;
}

export interface ParseJsonLooseOpts {
  /**
   * 'reject' = 只允许确定性修复级，jsonrepair 级按不可修处理（重抛原始错误）。
   * 用于解析结果直接落库、且下游没有 parse_repaired 隔离门的站点（sourcing）。
   */
  riskyRepair?: 'allow' | 'reject';
  /**
   * Missing tail closers are ambiguous with an exactly-boundary truncation.
   * Enable only when the caller immediately applies a strict schema that proves
   * every required field/cardinality is present; default callers never infer them.
   */
  containerClosure?: 'schema_validated';
}

/**
 * 从 LLM 输出文本中提取第一个 `{` 到最后一个 `}` 的切片并宽松解析。
 * @param label 出现在修复 warn 日志里的站点名（不进错误串——错误串由调用点自己包）
 * @returns null = 文本中没有 `{...}`；否则解析结果
 * @throws 严格解析与修复都失败时，抛出【严格解析的原始 SyntaxError】
 */
export function parseJsonObjectLoose(
  text: string,
  label: string,
  opts: ParseJsonLooseOpts = {},
): LooseJsonResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = text.slice(start, end + 1);
  const hasTruncatedSuffix = text.slice(end + 1).trim().length > 0;
  const needsLatexRepair = escapeInvalidJsonStringBackslashes(slice) !== slice;
  let strictErr: unknown;
  try {
    const strictJson = JSON.parse(slice);
    if (!needsLatexRepair) return { json: strictJson, repaired: false };
    strictErr = new SyntaxError(`${label} contained an ambiguous LaTeX escape`);
  } catch (err) {
    strictErr = err;
  }
  {
    let hit: LadderHit;
    try {
      hit = tryRepairLadder(
        slice,
        (opts.riskyRepair ?? 'allow') === 'allow',
        opts.containerClosure === 'schema_validated' && !hasTruncatedSuffix,
      );
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
    console.warn(
      `[json-extract] ${label}: repaired malformed LLM JSON (level=${hit.level}, YUK-607 repair band)`,
    );
    return { json: hit.json, repaired: hit.level };
  }
}
