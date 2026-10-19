import {
  BlankAnswerShape,
  type BlankAnswerShapeT,
  findAnswerShapeDeclarations,
} from './blank-answer-shape';
import type { ResponseSpecT } from './response';
import type { BlankKeyCriterionT, ScoringBasisT } from './scoring';

// ====================================================================
// YUK-1568（第 2 片）— 已声明 answer_shape 的封闭数学解释与比较核心
// ====================================================================
//
// 单一共享核心（设计 yuk1568-k1-answer-semantics-plan.md §3）：同一份解析/
// 规范化既服务实际判分（grade.ts gradeBlankExactUnit 经 evaluation 传入冻结
// slot 声明），也服务准入（solve.ts keysAgree / 作者键核验）、发布保护与
// 发题闸。绝不出现第二套数学判断；不新建通用 CAS、registry 或服务。
//
// 纪律（设计 §3，不可弱化）：
//   - 语法必须【完整消费】输入：不允许部分匹配、不找最后一个等号、不全局
//     删标点；解析失败/歧义/超限 → undecidable（带具体 reason），绝不截断
//     后比较，也绝不因解析失败判错或判对。
//   - 内部规范值：有理数（BigInt 精确分数）、带端点开闭的区间并集、有序
//     坐标、有理系数直线（非零整体比例归一）、无序有限集合（成员禁止重复）。
//     分数与十进制用精确有理数 —— 1/3 ≠ 0.3333（无 epsilon）；区间开闭、
//     无穷、空集与相接边界合并全部精确（相邻开区间不吞公共缺点）。
//   - 数值单位语义镜像 grade.ts numericCorrect / withinTolerance 的冻结行为
//     （mathjs parseUnit + expected_unit 换算 + 容差；无新增宽容）。默认单位
//     仅在 shape.unit.accepts_bare_number 显式允许时生效；无单位 rational
//     精确路径与私有 numeric key 浮点/容差路径分开。
//   - 有限集合/区间成员不做容差配对（非传递容差不进集合语义）。
//   - 输入长度/成员数/子句数超限 → undecidable（明确 reason），不截断。

/** 比较器实现版本（methodFingerprint / 声明支持判定一并携带）。 */
export const DECLARED_BLANK_COMPARE_VERSION = 'k1-math-v1.compare@1';

// ---------- 复杂度边界（超限 → undecidable，绝不截断后比较） ----------

const MAX_INPUT_CHARS = 480;
const MAX_UNION_CLAUSES = 24;
const MAX_SET_MEMBERS = 48;
const MAX_POINT_AXES = 8;
const MAX_LINE_TERMS = 24;

/**
 * 本比较器已实现的输入语法（按 value kind）。声明携带未实现的 notation
 * （如 finite_set 的 set_builder）即【未支持】—— 付费/发题闸继续拒绝，
// 不因 schema 合法就视为已准入（设计 §5 切片 2 出口）。
 */
const IMPLEMENTED_NOTATIONS: Readonly<
  Record<BlankAnswerShapeT['value']['kind'], readonly string[]>
> = {
  number: ['fraction', 'decimal'],
  interval_set: ['interval', 'inequality', 'set_builder'],
  point: ['tuple'],
  affine_line: ['equation'],
  finite_set: ['roster'],
};

// ---------- 有理数（精确分数；BigInt） ----------

interface Rat {
  readonly n: bigint;
  readonly d: bigint; // 恒 > 0；gcd(|n|, d) = 1
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new Error('rational denominator zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

const ratAdd = (a: Rat, b: Rat): Rat => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const ratSub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const ratMul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
const ratDiv = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n);
const ratEq = (a: Rat, b: Rat): boolean => a.n === b.n && a.d === b.d;
const ratLt = (a: Rat, b: Rat): boolean => a.n * b.d < b.n * a.d;
const ratToNumber = (a: Rat): number => Number(a.n) / Number(a.d);
const ratIsZero = (a: Rat): boolean => a.n === 0n;
const ratRender = (a: Rat): string => `${a.n}/${a.d}`;

const RATIONAL_LITERAL_RE = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:\/([+-]?)(\d+(?:\.\d+)?|\.\d+))?$/;

function decimalToRat(text: string): Rat | null {
  const dot = text.indexOf('.');
  if (dot === -1) {
    try {
      return rat(BigInt(text), 1n);
    } catch {
      return null;
    }
  }
  const digits = text.slice(dot + 1);
  try {
    return rat(BigInt(`${text.slice(0, dot) || '0'}${digits}`), 10n ** BigInt(digits.length));
  } catch {
    return null;
  }
}

/** 全串有理数字面量：整数 / 有限十进制 / 分数（分子分母可为有限十进制）。 */
function parseRatLiteral(text: string): Rat | null {
  const match = RATIONAL_LITERAL_RE.exec(text);
  if (match == null) return null;
  const signA = match[1] === '-' ? -1n : 1n;
  const numerator = decimalToRat(match[2]);
  if (numerator == null) return null;
  if (match[3] == null || match[4] == null) return rat(signA * numerator.n, numerator.d);
  const signB = match[3] === '-' ? -1n : 1n;
  const denominator = decimalToRat(match[4]);
  if (denominator == null || ratIsZero(denominator)) return null;
  return ratDiv(rat(signA * numerator.n, numerator.d), rat(signB * denominator.n, denominator.d));
}

// ---------- 规范对象 ----------

/** 区间端点：null = ±∞（lo:null 是 -∞，hi:null 是 +∞；无穷端点恒开）。 */
interface Interval {
  lo: Rat | null;
  loClosed: boolean;
  hi: Rat | null;
  hiClosed: boolean;
}

interface CanonicalNumber {
  kind: 'number';
  value: Rat;
}
interface CanonicalIntervalSet {
  kind: 'interval_set';
  intervals: Interval[]; // 规范形：升序、两两不可合并（缺口保留）、无空区间
}
interface CanonicalPoint {
  kind: 'point';
  coords: Rat[];
}
interface CanonicalLine {
  kind: 'affine_line';
  a: Rat;
  b: Rat;
  c: Rat; // 首 nonzero 的 (a,b) 系数已归一为 1；a=b=0 已被拒绝
}
interface CanonicalFiniteSet {
  kind: 'finite_set';
  members: string[]; // 成员规范序列化（排序后）；重复已在上游拒绝
}

type CanonicalObject =
  | CanonicalNumber
  | CanonicalIntervalSet
  | CanonicalPoint
  | CanonicalLine
  | CanonicalFiniteSet;

function boundRender(b: Rat | null, closed: boolean, isLo: boolean): string {
  if (b == null) return isLo ? '-inf' : '+inf';
  return `${closed ? (isLo ? '[' : ']') : isLo ? '(' : ')'}${ratRender(b)}`;
}

function intervalRender(iv: Interval): string {
  return `${boundRender(iv.lo, iv.loClosed, true)},${boundRender(iv.hi, iv.hiClosed, false)}`;
}

function serializeObject(obj: CanonicalObject): string {
  switch (obj.kind) {
    case 'number':
      return `n:${ratRender(obj.value)}`;
    case 'interval_set':
      return `iv:${obj.intervals.map(intervalRender).join('u')}`;
    case 'point':
      return `pt:${obj.coords.map(ratRender).join('|')}`;
    case 'affine_line':
      return `ln:${ratRender(obj.a)}/${ratRender(obj.b)}/${ratRender(obj.c)}`;
    case 'finite_set':
      return `fs:${obj.members.join(',')}`;
  }
}

// ---------- 解析失败载体 ----------

export type DeclaredParseFailure = { ok: false; reason: string };
export type DeclaredParseResult<T> = { ok: true; value: T } | DeclaredParseFailure;

const fail = (reason: string): DeclaredParseFailure => ({ ok: false, reason });

// ---------- 输入规范化（NFKC + 数学符号映射 + 去空白） ----------

/**
 * 判定数学语义前的封闭规范化：NFKC（全角括号/逗号/关系符 → ASCII）、
 * Unicode 减号 → '-'、乘号 → '*'、剥离全部空白（"5 / 2" → "5/2"）。
 * 保号保括号保否定：不删任何非空白字符、不做任何"容错"改写。
 *
 * R1 P1-2 修复：NFKC 会把上标/下标/分数字符折叠成普通数字（x²→x2、
 * 2²→22、½→1⁄2、x₀→x0）——那是"先丢语义再猜"。这些字符在规范化【之前】
 * 显式拒绝（准入编译与作答两入口共用本函数），绝不改写后继续解释；
 * 封闭语法解释不了的输入返回 undecidable/invalid 带具体 reason。
 * 唯一例外：作答入口中声明数值单位（expected_unit）的 lane 走下方
 * declaredUnitResponseCorruptsValue 的数值区分流，恢复旧 mathjs 单位解析。
 */
const SEMANTICS_CORRUPTING_NFKC_RE =
  /[\u00b9\u00b2\u00b3\u2070-\u209f\u00bc-\u00be\u2150-\u215f\u2044]/u;

function normalizeMathInput(raw: string): DeclaredParseResult<string> {
  if (SEMANTICS_CORRUPTING_NFKC_RE.test(raw)) {
    return fail('superscript_subscript_or_vulgar_fraction_not_supported');
  }
  return {
    ok: true,
    value: raw
      .normalize('NFKC')
      .replace(/\u2212/g, '-')
      .replace(/[\u00d7\u00b7]/g, '*')
      .replace(/\s+/g, ''),
  };
}

/**
 * R2 单位 lane 分流（仅 compareDeclaredBlank 在 number + 声明 expected_unit
 * 时使用；准入编译入口不消费作答，不受影响）。
 *
 * mathjs Unit.parse 的单位名允许数字（内建 m2=SURFACE、m3=VOLUME），旧路
 * 径在 convertUnitTo 内部 NFKC 后令 `3 m²`→`3 m2` 正确换算。整串上标拒绝
 * 先于单位换算运行会把这类旧支持作答全部打成 pending —— R2 判定的回归。
 *
 * 但不能直接对带单位作答绕过 raw guard：mathjs 从串首读数值词法区
 * （[±][0-9.eE] 及前导空白），折叠字符落在该区内或紧邻其后时，NFKC 产物
 * 并入数值本身 —— `3² m`→`32 m`、`3e² m`→`3e2 m`、`²m`→`2 m`、
 * `３² m`→`32 m`（全角数字同样属数值区）、`3⁄4`→`3/4` —— 先丢语义再给
 * 分，与 P1-2 同类，必须仍拒绝。
 *
 * 判定：逐折叠字符检查其【之前】的全部 raw 前缀经 NFKC 后是否整段仍属数
 * 值区字符类 [+-0-9.eE\s]。若是（前缀可含全角数字/±/空白，均折回数值区字
 * 符），该折叠产物并入 mathjs 读到的值 → 拒绝；若前缀已出现字母/括号等
 * 非数值区字符（单位 token 已开始），折叠字符只落在单位部分 —— `m²`→`m2`
 * 正是旧支持的单位写法 —— 原样交给 convertUnitTo/mathjs 决定，不新增任
 * 何宽容（mathjs 解析失败照旧 unparseable → undecidable，量纲不符照旧
 * incorrect）。
 */
const UNIT_LANE_NUMERIC_ZONE_RE = /^[+\-0-9.eE\s]*$/;

function declaredUnitResponseCorruptsValue(raw: string): boolean {
  const chars = [...raw];
  for (let i = 0; i < chars.length; i += 1) {
    if (!SEMANTICS_CORRUPTING_NFKC_RE.test(chars[i])) continue;
    if (UNIT_LANE_NUMERIC_ZONE_RE.test(chars.slice(0, i).join('').normalize('NFKC'))) {
      return true;
    }
  }
  return false;
}

const POSITIVE_INFINITY_TOKENS = new Set(['+∞', '∞']);
const NEGATIVE_INFINITY = '-∞';

// ---------- number ----------

function parseDeclaredNumber(text: string, shape: BlankAnswerShapeT): DeclaredParseResult<Rat> {
  const allowFraction = shape.notation.includes('fraction');
  const allowDecimal = shape.notation.includes('decimal');
  const value = parseRatLiteral(text);
  if (value == null) {
    if (!allowFraction && text.includes('/')) return fail('fraction_not_declared');
    if (!allowDecimal && text.includes('.')) return fail('decimal_not_declared');
    return fail('number_literal_unparseable');
  }
  if (!allowFraction && text.includes('/')) return fail('fraction_not_declared');
  if (!allowDecimal && text.includes('.')) return fail('decimal_not_declared');
  return { ok: true, value };
}

// ---------- 区间并集 ----------

function intervalIsEmpty(iv: Interval): boolean {
  if (iv.lo != null && iv.hi != null) {
    if (ratLt(iv.hi, iv.lo)) return true;
    if (ratEq(iv.lo, iv.hi) && !(iv.loClosed && iv.hiClosed)) return true;
  }
  return false;
}

/** 规范化区间并集：丢空区间、排序、只合并真正相接/重叠的区间（缺点不吞）。
 * R1 P1-1 修复：并集语义下【同下端点的闭性必须合并】——`(0,1)∪[0,2)` 的
 * 真实并集是 `[0,2)`（含 0），不能只改 hi 丢 loClosed；prev 已覆盖到 +∞ 的
 * 早 continue 分支同样先合并同下端点闭性（`(0,+∞)∪[0,+∞)=[0,+∞)`）。
 * 相邻双开区间的缺点仍保留不吞。 */
function normalizeIntervalUnion(intervals: Interval[]): Interval[] {
  const live = intervals.filter((iv) => !intervalIsEmpty(iv));
  live.sort((x, y) => {
    if (x.lo == null && y.lo == null) return 0;
    if (x.lo == null) return -1;
    if (y.lo == null) return 1;
    if (!ratEq(x.lo, y.lo)) return ratLt(x.lo, y.lo) ? -1 : 1;
    if (x.hi == null && y.hi == null) return 0;
    if (x.hi == null) return 1;
    if (y.hi == null) return -1;
    return ratEq(x.hi, y.hi) ? 0 : ratLt(x.hi, y.hi) ? -1 : 1;
  });
  const out: Interval[] = [];
  for (const iv of live) {
    const prev = out[out.length - 1];
    if (prev == null) {
      out.push({ ...iv });
      continue;
    }
    // 同下端点：并集下端闭性 = 两侧闭性之或（任一侧含该点则并集含该点）。
    const mergeLoClosed = () => {
      if (iv.lo != null && prev.lo != null && ratEq(iv.lo, prev.lo)) {
        prev.loClosed = prev.loClosed || iv.loClosed;
      }
    };
    if (prev.hi == null) {
      // prev 已覆盖到 +∞：iv 是子集，但同下端点的闭性仍可能扩大覆盖。
      mergeLoClosed();
      continue;
    }
    const touches =
      iv.lo != null &&
      (ratLt(iv.lo, prev.hi) || (ratEq(iv.lo, prev.hi) && (prev.hiClosed || iv.loClosed)));
    if (touches) {
      mergeLoClosed();
      if (iv.hi == null) {
        prev.hi = null;
        prev.hiClosed = false;
      } else if (
        ratLt(prev.hi, iv.hi) ||
        (ratEq(prev.hi, iv.hi) && iv.hiClosed && !prev.hiClosed)
      ) {
        prev.hi = iv.hi;
        prev.hiClosed = iv.hiClosed;
      }
      continue;
    }
    out.push({ ...iv });
  }
  return out;
}

function intersectIntervals(a: Interval, b: Interval): Interval {
  const pickLo = (): Pick<Interval, 'lo' | 'loClosed'> => {
    if (a.lo == null) return { lo: b.lo, loClosed: b.loClosed };
    if (b.lo == null) return { lo: a.lo, loClosed: a.loClosed };
    if (ratLt(a.lo, b.lo)) return { lo: b.lo, loClosed: b.loClosed };
    if (ratLt(b.lo, a.lo)) return { lo: a.lo, loClosed: a.loClosed };
    return { lo: a.lo, loClosed: a.loClosed && b.loClosed };
  };
  const pickHi = (): Pick<Interval, 'hi' | 'hiClosed'> => {
    if (a.hi == null) return { hi: b.hi, hiClosed: b.hiClosed };
    if (b.hi == null) return { hi: a.hi, hiClosed: a.hiClosed };
    if (ratLt(a.hi, b.hi)) return { hi: a.hi, hiClosed: a.hiClosed };
    if (ratLt(b.hi, a.hi)) return { hi: b.hi, hiClosed: b.hiClosed };
    return { hi: a.hi, hiClosed: a.hiClosed && b.hiClosed };
  };
  const lo = pickLo();
  const hi = pickHi();
  return { lo: lo.lo, loClosed: lo.loClosed, hi: hi.hi, hiClosed: hi.hiClosed };
}

/** q < a / q ≤ a / q > a / q ≥ a → 半轴区间。 */
function halfLine(rel: '<' | '≤' | '>' | '≥', bound: Rat): Interval {
  switch (rel) {
    case '<':
      return { lo: null, loClosed: false, hi: bound, hiClosed: false };
    case '≤':
      return { lo: null, loClosed: false, hi: bound, hiClosed: true };
    case '>':
      return { lo: bound, loClosed: false, hi: null, hiClosed: false };
    case '≥':
      return { lo: bound, loClosed: true, hi: null, hiClosed: false };
  }
}

const flipRel = (rel: '<' | '≤' | '>' | '≥'): '<' | '≤' | '>' | '≥' =>
  rel === '<' ? '>' : rel === '≤' ? '≥' : rel === '>' ? '<' : '≤';

/** 单条不等式子句（可为链 A rel B rel C）：中段必须是声明的 binding。 */
function parseInequalityClause(clause: string, binding: string): DeclaredParseResult<Interval> {
  const ops = [...clause.matchAll(/[<>≤≥]/g)].map((m) => ({
    op: m[0] as '<' | '>' | '≤' | '≥',
    index: m.index ?? 0,
  }));
  if (ops.length === 0 || ops.length > 2) {
    return fail(`inequality_clause_ops_invalid(${ops.length})`);
  }
  const left = clause.slice(0, ops[0].index);
  if (ops.length === 1) {
    const right = clause.slice(ops[0].index + 1);
    const leftIsBinding = left === binding;
    const rightIsBinding = right === binding;
    if (leftIsBinding === rightIsBinding) {
      return fail('inequality_binding_position_invalid');
    }
    const literalText = leftIsBinding ? right : left;
    const rel = leftIsBinding ? ops[0].op : flipRel(ops[0].op);
    const bound = parseRatLiteral(literalText);
    if (bound == null) return fail(`inequality_bound_unparseable('${literalText}')`);
    return { ok: true, value: halfLine(rel, bound) };
  }
  const mid = clause.slice(ops[0].index + 1, ops[1].index);
  const right = clause.slice(ops[1].index + 1);
  if (mid !== binding) return fail('inequality_chain_middle_not_binding');
  const lo = parseRatLiteral(left);
  const hi = parseRatLiteral(right);
  if (lo == null) return fail(`inequality_bound_unparseable('${left}')`);
  if (hi == null) return fail(`inequality_bound_unparseable('${right}')`);
  return {
    ok: true,
    value: intersectIntervals(halfLine(flipRel(ops[0].op), lo), halfLine(ops[1].op, hi)),
  };
}

/** 不等式子句列表（且 / and / , / ; 连接），全部绑定同一声明量后取交。 */
function parseInequalityClauses(body: string, binding: string): DeclaredParseResult<Interval> {
  const normalized = body
    .replace(/且/g, ';')
    .replace(/&&/g, ';')
    .replace(/\b(and|AND|And)\b/g, ';');
  const clauses = normalized.split(/[;,]/).filter((part) => part.length > 0);
  if (clauses.length === 0 || clauses.length > MAX_UNION_CLAUSES) {
    return fail(`inequality_clause_count_invalid(${clauses.length})`);
  }
  let acc: Interval | null = null;
  for (const clause of clauses) {
    const parsed = parseInequalityClause(clause, binding);
    if (!parsed.ok) return parsed;
    acc = acc == null ? parsed.value : intersectIntervals(acc, parsed.value);
  }
  return { ok: true, value: acc as Interval };
}

/** 单段区间记号 (a,b] / [a,b) / (-∞,b) / [a,+∞)。 */
function parseIntervalPiece(piece: string): DeclaredParseResult<Interval> {
  const first = piece[0];
  const last = piece[piece.length - 1];
  if ((first !== '(' && first !== '[') || (last !== ')' && last !== ']')) {
    return fail('interval_delimiter_invalid');
  }
  const middle = piece.slice(1, -1);
  const comma = middle.indexOf(',');
  if (comma === -1 || middle.indexOf(',', comma + 1) !== -1) {
    return fail('interval_endpoint_comma_invalid');
  }
  const loText = middle.slice(0, comma);
  const hiText = middle.slice(comma + 1);
  let lo: Rat | null;
  if (loText === NEGATIVE_INFINITY) {
    lo = null;
  } else {
    lo = parseRatLiteral(loText);
    if (lo == null) return fail(`interval_lo_unparseable('${loText}')`);
  }
  let hi: Rat | null;
  if (POSITIVE_INFINITY_TOKENS.has(hiText)) {
    hi = null;
  } else {
    hi = parseRatLiteral(hiText);
    if (hi == null) return fail(`interval_hi_unparseable('${hiText}')`);
  }
  if (lo == null && first === '[') return fail('infinite_endpoint_closed');
  if (hi == null && last === ']') return fail('infinite_endpoint_closed');
  return {
    ok: true,
    value: { lo, loClosed: first === '[', hi, hiClosed: last === ']' },
  };
}

function parseDeclaredIntervalSet(
  text: string,
  value: Extract<BlankAnswerShapeT['value'], { kind: 'interval_set' }>,
  notations: readonly string[],
): DeclaredParseResult<CanonicalIntervalSet> {
  if (text === '∅') {
    if (!notations.includes('interval')) return fail('notation_interval_not_declared');
    return { ok: true, value: { kind: 'interval_set', intervals: [] } };
  }
  if (text.startsWith('{')) {
    if (!notations.includes('set_builder')) return fail('notation_set_builder_not_declared');
    const m = /^\{([^|]*)\|(.*)\}$/.exec(text);
    if (m == null) return fail('set_builder_form_invalid');
    if (m[1] !== value.binding) return fail('set_builder_binding_mismatch');
    const inner = parseInequalityClauses(m[2], value.binding);
    if (!inner.ok) return inner;
    return {
      ok: true,
      value: { kind: 'interval_set', intervals: normalizeIntervalUnion([inner.value]) },
    };
  }
  if (/[<>≤≥]/.test(text)) {
    if (!notations.includes('inequality')) return fail('notation_inequality_not_declared');
    const inner = parseInequalityClauses(text, value.binding);
    if (!inner.ok) return inner;
    return {
      ok: true,
      value: { kind: 'interval_set', intervals: normalizeIntervalUnion([inner.value]) },
    };
  }
  if (!notations.includes('interval')) return fail('notation_interval_not_declared');
  const pieces = text.split('∪');
  if (pieces.length > MAX_UNION_CLAUSES) {
    return fail(`interval_union_count_excessive(${pieces.length})`);
  }
  const intervals: Interval[] = [];
  for (const piece of pieces) {
    const parsed = parseIntervalPiece(piece);
    if (!parsed.ok) return parsed;
    intervals.push(parsed.value);
  }
  return {
    ok: true,
    value: { kind: 'interval_set', intervals: normalizeIntervalUnion(intervals) },
  };
}

// ---------- point ----------

function parseDeclaredPoint(
  text: string,
  shape: Extract<BlankAnswerShapeT['value'], { kind: 'point' }>,
): DeclaredParseResult<CanonicalPoint> {
  if (!text.startsWith('(') || !text.endsWith(')')) return fail('point_tuple_delimiter_invalid');
  const parts = text.slice(1, -1).split(',');
  if (parts.length !== shape.axes.length) {
    return fail(`point_dimension_mismatch(${parts.length}≠${shape.axes.length})`);
  }
  const coords: Rat[] = [];
  for (const part of parts) {
    const value = parseRatLiteral(part);
    if (value == null) return fail(`point_coord_unparseable('${part}')`);
    coords.push(value);
  }
  return { ok: true, value: { kind: 'point', coords } };
}

// ---------- affine_line ----------

type LinearToken =
  | { type: 'num'; value: Rat; compound: boolean }
  | { type: 'id'; name: string }
  | { type: 'op'; op: string };

/** R1 P1-3：compound 标记该数字 token 是词法层吸收了内部 '/' 的分数
 * （源串含 "a/b"）。作为【独立系数】合法（3/2x），作为【除法除数】
 * 意味着源串是连续除法（x/2/3）——结合性有歧义，一律拒绝。 */
function tokenizeLinear(text: string): DeclaredParseResult<LinearToken[]> {
  const tokens: LinearToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1;
      // 分数系数 "3/2"（贪婪数字 + '/' + 数字；"x/2" 由变量分支处理）。
      if (text[j] === '/' && /[0-9.]/.test(text[j + 1] ?? '')) {
        let k = j + 1;
        while (k < text.length && /[0-9.]/.test(text[k])) k += 1;
        const value = parseRatLiteral(text.slice(i, k));
        if (value == null) return fail(`line_number_unparseable('${text.slice(i, k)}')`);
        tokens.push({ type: 'num', value, compound: true });
        i = k;
        continue;
      }
      const value = parseRatLiteral(text.slice(i, j));
      if (value == null) return fail(`line_number_unparseable('${text.slice(i, j)}')`);
      tokens.push({ type: 'num', value, compound: false });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z]/.test(text[j])) j += 1;
      tokens.push({ type: 'id', name: text.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/='.includes(ch)) {
      tokens.push({ type: 'op', op: ch });
      i += 1;
      continue;
    }
    return fail(`line_char_unsupported('${ch}')`);
  }
  return { ok: true, value: tokens };
}

function varSlot(name: string, variables: readonly [string, string]): 0 | 1 | null {
  if (name === variables[0]) return 0;
  if (name === variables[1]) return 1;
  return null;
}

/** 线性表达式 → (var1 系数, var2 系数, 常数)。变量必须恰为声明的两个之一。 */
function parseLinearExpression(
  text: string,
  variables: readonly [string, string],
): DeclaredParseResult<{ a: Rat; b: Rat; c: Rat }> {
  const tokenized = tokenizeLinear(text);
  if (!tokenized.ok) return tokenized;
  const tokens = tokenized.value;
  if (tokens.some((t) => t.type === 'op' && t.op === '=')) {
    return fail('line_expression_contains_eq');
  }
  let a = rat(0n);
  let b = rat(0n);
  let c = rat(0n);
  let i = 0;
  let termCount = 0;
  const readTerm = (sign: bigint): DeclaredParseResult<null> => {
    if (termCount >= MAX_LINE_TERMS) return fail('line_term_count_excessive');
    termCount += 1;
    const t = tokens[i];
    if (t == null) return fail('line_term_missing');
    if (t.type === 'num') {
      i += 1;
      const coef = t.value;
      const afterNum = tokens[i];
      if (afterNum?.type === 'op' && afterNum.op === '*') {
        i += 1;
        const v = tokens[i];
        if (v?.type !== 'id') return fail('line_mul_target_not_variable');
        i += 1;
        const slot = varSlot(v.name, variables);
        if (slot == null) return fail(`line_unknown_variable('${v.name}')`);
        const signed = ratMul(coef, rat(sign));
        if (slot === 0) a = ratAdd(a, signed);
        else b = ratAdd(b, signed);
        return { ok: true, value: null };
      }
      if (afterNum?.type === 'id') {
        i += 1;
        const slot = varSlot(afterNum.name, variables);
        if (slot == null) return fail(`line_unknown_variable('${afterNum.name}')`);
        const signed = ratMul(coef, rat(sign));
        if (slot === 0) a = ratAdd(a, signed);
        else b = ratAdd(b, signed);
        return { ok: true, value: null };
      }
      c = ratAdd(c, ratMul(coef, rat(sign)));
      return { ok: true, value: null };
    }
    if (t.type === 'id') {
      i += 1;
      let coef = rat(sign);
      const slot = varSlot(t.name, variables);
      if (slot == null) return fail(`line_unknown_variable('${t.name}')`);
      const afterId = tokens[i];
      if (afterId?.type === 'op' && afterId.op === '/') {
        i += 1;
        const d = tokens[i];
        if (d?.type !== 'num' || ratIsZero(d.value)) return fail('line_var_divisor_invalid');
        // R1 P1-3：除数是词法层吸收了内部 '/' 的分数 token（源串形如 x/2/3）
        // ——连续除法的结合性有歧义（左结合 x/6 ≠ 右除 x÷(2/3)=3x/2），
        // 一律拒绝，绝不选括号解释；分数作为【独立系数】（3/2x）仍支持。
        if (d.compound) return fail('line_consecutive_division_not_supported');
        i += 1;
        coef = ratDiv(coef, d.value);
      } else if (afterId?.type === 'op' && afterId.op === '*') {
        i += 1;
        const m = tokens[i];
        if (m?.type !== 'num') return fail('line_mul_factor_not_number');
        i += 1;
        coef = ratMul(coef, m.value);
      }
      if (slot === 0) a = ratAdd(a, coef);
      else b = ratAdd(b, coef);
      return { ok: true, value: null };
    }
    return fail('line_term_shape_invalid');
  };
  // R1 P1-2：项与项之间必须有显式 +/- 分隔。首个项可以无符号开头，其后
  // 任何不是 +/- 的 token 直接进入 readTerm 的旧路径会把相邻 token 暗作
  // 加法（NFKC 把 y=x² 折成 y=x2 后被读成 x+2）——那类输入现在必须拒绝
  // （line_term_separator_missing → undecidable），绝不猜成加项。
  let firstTerm = true;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'op' && (t.op === '+' || t.op === '-')) {
      i += 1;
      const r = readTerm(t.op === '-' ? -1n : 1n);
      if (!r.ok) return r;
      firstTerm = false;
      continue;
    }
    if (!firstTerm) return fail('line_term_separator_missing');
    const r = readTerm(1n);
    if (!r.ok) return r;
    firstTerm = false;
  }
  if (termCount === 0) return fail('line_expression_empty');
  return { ok: true, value: { a, b, c } };
}

function parseDeclaredLine(
  text: string,
  value: Extract<BlankAnswerShapeT['value'], { kind: 'affine_line' }>,
): DeclaredParseResult<CanonicalLine> {
  if (value.variables.length !== 2) return fail('line_variables_invalid');
  const variables = [value.variables[0], value.variables[1]] as [string, string];
  const eq = text.indexOf('=');
  if (eq === -1 || text.indexOf('=', eq + 1) !== -1) {
    return fail('line_equation_single_eq_required');
  }
  const lhs = parseLinearExpression(text.slice(0, eq), variables);
  if (!lhs.ok) return lhs;
  const rhs = parseLinearExpression(text.slice(eq + 1), variables);
  if (!rhs.ok) return rhs;
  const a = ratSub(lhs.value.a, rhs.value.a);
  const b = ratSub(lhs.value.b, rhs.value.b);
  const c = ratSub(lhs.value.c, rhs.value.c);
  if (ratIsZero(a) && ratIsZero(b)) return fail('degenerate_line_zero_zero');
  // 首 nonzero 的 (a,b) 系数归一 —— 仅非零整体比例等价。
  if (!ratIsZero(a)) {
    return {
      ok: true,
      value: { kind: 'affine_line', a: rat(1n), b: ratDiv(b, a), c: ratDiv(c, a) },
    };
  }
  return {
    ok: true,
    value: { kind: 'affine_line', a: rat(0n), b: rat(1n), c: ratDiv(c, b) },
  };
}

// ---------- finite_set ----------

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseDeclaredFiniteSet(
  text: string,
  value: Extract<BlankAnswerShapeT['value'], { kind: 'finite_set' }>,
  notations: readonly string[],
): DeclaredParseResult<CanonicalFiniteSet> {
  if (text === '∅') return { ok: true, value: { kind: 'finite_set', members: [] } };
  if (!text.startsWith('{') || !text.endsWith('}')) return fail('finite_set_braces_required');
  if (!notations.includes('roster')) return fail('notation_roster_not_declared');
  const inner = text.slice(1, -1);
  if (inner === '') return { ok: true, value: { kind: 'finite_set', members: [] } };
  const parts = splitTopLevelCommas(inner);
  if (parts.length > MAX_SET_MEMBERS) {
    return fail(`finite_set_member_count_excessive(${parts.length})`);
  }
  const members: string[] = [];
  for (const part of parts) {
    const member = parseSetMember(part, value);
    if (!member.ok) return member;
    members.push(member.value);
  }
  const sorted = [...members].sort();
  if (new Set(sorted).size !== sorted.length) return fail('finite_set_duplicate_member');
  return { ok: true, value: { kind: 'finite_set', members: sorted } };
}

function parseSetMember(
  part: string,
  value: Extract<BlankAnswerShapeT['value'], { kind: 'finite_set' }>,
): DeclaredParseResult<string> {
  switch (value.item) {
    case 'number': {
      const parsed = parseRatLiteral(part);
      if (parsed == null) return fail(`set_member_unparseable('${part}')`);
      return { ok: true, value: `n:${ratRender(parsed)}` };
    }
    case 'point': {
      const axes = value.axes;
      if (axes == null) return fail('finite_set_point_axes_missing');
      const parsed = parseDeclaredPoint(part, { kind: 'point', axes });
      if (!parsed.ok) return parsed;
      return { ok: true, value: serializeObject(parsed.value) };
    }
    case 'affine_line': {
      const variables = value.variables;
      if (variables == null || variables.length !== 2) {
        return fail('finite_set_line_variables_missing');
      }
      const parsed = parseDeclaredLine(part, {
        kind: 'affine_line',
        variables,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: serializeObject(parsed.value) };
    }
  }
}

// ---------- 对象级解析分发 ----------

function parseDeclaredObject(
  text: string,
  shape: BlankAnswerShapeT,
): DeclaredParseResult<CanonicalObject> {
  switch (shape.value.kind) {
    case 'number': {
      const parsed = parseDeclaredNumber(text, shape);
      return parsed.ok ? { ok: true, value: { kind: 'number', value: parsed.value } } : parsed;
    }
    case 'interval_set':
      return parseDeclaredIntervalSet(text, shape.value, shape.notation);
    case 'point':
      return parseDeclaredPoint(text, shape.value);
    case 'affine_line':
      return parseDeclaredLine(text, shape.value);
    case 'finite_set':
      return parseDeclaredFiniteSet(text, shape.value, shape.notation);
  }
}

// ---------- 数值容差/单位（镜像 grade.ts 冻结语义，不新增宽容） ----------

export type NumericTolerance =
  | { kind: 'absolute'; value: number }
  | { kind: 'relative'; ratio: number };

/** 与 grade.ts withinTolerance 同式（冻结语义）。 */
function withinToleranceOf(value: number, expected: number, tolerance: NumericTolerance): boolean {
  const diff = Math.abs(value - expected);
  if (!Number.isFinite(value)) return false;
  if (tolerance.kind === 'absolute') return diff <= tolerance.value;
  return expected === 0 ? diff === 0 : diff / Math.abs(expected) <= tolerance.ratio;
}

/** 与 grade.ts numericCorrect 的 mathjs 换算同语义（parseUnit/equalBase/toNumber）。 */
async function convertUnitTo(
  raw: string,
  expectedUnit: string,
): Promise<{ ok: true; value: number } | { ok: false; kind: 'unparseable' | 'wrong_base' }> {
  const text = raw.normalize('NFKC').trim();
  const { unit: parseUnit } = await import('mathjs');
  let reference: import('mathjs').Unit;
  try {
    reference = parseUnit(1, expectedUnit);
  } catch {
    return { ok: false, kind: 'unparseable' };
  }
  try {
    const given = parseUnit(text);
    if (!given.equalBase(reference)) return { ok: false, kind: 'wrong_base' };
    return { ok: true, value: given.toNumber(expectedUnit) };
  } catch {
    return { ok: false, kind: 'unparseable' };
  }
}

// ---------- 编译与比较（小接口：compileDeclaredKey / compareDeclaredBlank） ----------

/** 私有键的窄读面（text 键在此不带 normalization —— 声明数学路径不消费它）。 */
export type DeclaredPrivateKey =
  | { kind: 'text'; accepted: readonly string[] }
  | {
      kind: 'numeric';
      expected: number;
      tolerance: NumericTolerance;
      expected_unit?: string;
    };

export type CompiledDeclaredKey =
  | { kind: 'number_exact_rational'; value: Rat }
  | {
      kind: 'number_tolerance';
      expected: number;
      tolerance: NumericTolerance;
      expectedUnit: string | null;
      acceptsBare: boolean;
    }
  | { kind: 'exact_object'; canonical: string };

export type DeclaredCompileResult =
  | { ok: true; compiled: CompiledDeclaredKey }
  | { ok: false; reason: string };

/**
 * 编译已声明槽位的私有评分键：每个 accepted 别名都必须完整解析为【同一个
 * 数学对象】（A/B 两解的别名数可不同，但绝不许交集/并集刷通过）。解析
 * 失败、别名间对象不一致、键形态与声明不相容（单位缺项/冲突、numeric 键
 * 配非 number 声明等）→ ok:false + 具体原因，不猜答案。
 */
export function compileDeclaredKey(
  shape: BlankAnswerShapeT,
  key: DeclaredPrivateKey,
): DeclaredCompileResult {
  if (shape.value.kind === 'number') {
    if (key.kind === 'numeric') {
      const declaredUnit = shape.value.unit;
      if (declaredUnit == null && key.expected_unit != null) {
        return {
          ok: false,
          reason:
            'number shape declares no unit input requirement but the private numeric key carries expected_unit',
        };
      }
      if (declaredUnit != null) {
        if (key.expected_unit == null) {
          return {
            ok: false,
            reason: `number shape declares unit '${declaredUnit.unit}' but the private numeric key has no expected_unit`,
          };
        }
        if (key.expected_unit.normalize('NFKC') !== declaredUnit.unit.normalize('NFKC')) {
          return {
            ok: false,
            reason: `declared unit '${declaredUnit.unit}' conflicts with private key expected_unit '${key.expected_unit}'`,
          };
        }
      }
      return {
        ok: true,
        compiled: {
          kind: 'number_tolerance',
          expected: key.expected,
          tolerance: key.tolerance,
          expectedUnit: key.expected_unit ?? null,
          acceptsBare: declaredUnit?.accepts_bare_number ?? false,
        },
      };
    }
    if (shape.value.unit != null) {
      return {
        ok: false,
        reason:
          'number shape with a declared unit requires a numeric key (text aliases cannot carry frozen unit semantics)',
      };
    }
    let value: Rat | null = null;
    for (const alias of key.accepted) {
      const normalized = normalizeMathInput(alias);
      if (!normalized.ok) {
        return {
          ok: false,
          reason: `text alias '${alias}' cannot be read under the declared notation (${normalized.reason})`,
        };
      }
      if (normalized.value.length > MAX_INPUT_CHARS) {
        return { ok: false, reason: `alias length exceeds ${MAX_INPUT_CHARS} chars` };
      }
      const parsed = parseDeclaredNumber(normalized.value, shape);
      if (!parsed.ok) {
        return {
          ok: false,
          reason: `text alias '${alias}' does not parse as a declared number (${parsed.reason})`,
        };
      }
      if (value == null) value = parsed.value;
      else if (!ratEq(value, parsed.value)) {
        return {
          ok: false,
          reason: `text aliases disagree as exact rationals ('${ratRender(value)}' vs '${ratRender(parsed.value)}')`,
        };
      }
    }
    if (value == null) return { ok: false, reason: 'empty accepted alias list' };
    return { ok: true, compiled: { kind: 'number_exact_rational', value } };
  }
  // interval_set / point / affine_line / finite_set：只有 text 键可表达完整对象。
  if (key.kind !== 'text') {
    return {
      ok: false,
      reason: `answer_shape value kind '${shape.value.kind}' cannot be expressed by a numeric key`,
    };
  }
  let canonical: string | null = null;
  for (const alias of key.accepted) {
    const normalized = normalizeMathInput(alias);
    if (!normalized.ok) {
      return {
        ok: false,
        reason: `text alias '${alias}' cannot be read under the declared notation (${normalized.reason})`,
      };
    }
    if (normalized.value.length > MAX_INPUT_CHARS) {
      return { ok: false, reason: `alias length exceeds ${MAX_INPUT_CHARS} chars` };
    }
    const parsed = parseDeclaredObject(normalized.value, shape);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `text alias '${alias}' does not parse as declared ${shape.value.kind} (${parsed.reason})`,
      };
    }
    const serialized = serializeObject(parsed.value);
    if (canonical == null) canonical = serialized;
    else if (canonical !== serialized) {
      return {
        ok: false,
        reason: `text aliases are not the same mathematical object ('${canonical}' vs '${serialized}')`,
      };
    }
  }
  if (canonical == null) return { ok: false, reason: 'empty accepted alias list' };
  return { ok: true, compiled: { kind: 'exact_object', canonical } };
}

export type DeclaredBlankComparison =
  | { outcome: 'correct' }
  | { outcome: 'incorrect'; reason?: string }
  | { outcome: 'undecidable'; reason: string };

/**
 * 已声明空的实际比较入口：作答与私有键走【同一份】解析与规范化。
 *   - correct / incorrect：完整解析后对象相等 / 不相等（错值、错端点、
 *     缺/多成员、换坐标、开闭不同 → incorrect，仍由原 rule 给分）。
 *   - undecidable：作答无法按声明完整解析、歧义、超限，或键与声明确定性
 *     冲突 —— 带 reason，判分侧给 pending，绝不伪零分。
 */
export async function compareDeclaredBlank(
  shape: BlankAnswerShapeT,
  key: DeclaredPrivateKey,
  rawResponse: string,
): Promise<DeclaredBlankComparison> {
  const compile = compileDeclaredKey(shape, key);
  if (!compile.ok) {
    return { outcome: 'undecidable', reason: `declared_key_invalid: ${compile.reason}` };
  }
  const compiled = compile.compiled;
  if (rawResponse.length > MAX_INPUT_CHARS) {
    return {
      outcome: 'undecidable',
      reason: `input_too_long(${rawResponse.length}>${MAX_INPUT_CHARS})`,
    };
  }
  const norm = normalizeMathInput(rawResponse);
  if (norm.ok && norm.value.length === 0) {
    return { outcome: 'undecidable', reason: 'empty_response' };
  }

  if (compiled.kind === 'number_tolerance') {
    if (norm.ok) {
      const bare = parseDeclaredNumber(norm.value, shape);
      if (bare.ok) {
        const value = ratToNumber(bare.value);
        if (compiled.expectedUnit == null) {
          return withinToleranceOf(value, compiled.expected, compiled.tolerance)
            ? { outcome: 'correct' }
            : { outcome: 'incorrect' };
        }
        // 裸数 + 声明单位：仅 accepts_bare_number 显式允许时按该单位解释。
        if (!compiled.acceptsBare) return { outcome: 'incorrect', reason: 'missing_unit' };
        return withinToleranceOf(value, compiled.expected, compiled.tolerance)
          ? { outcome: 'correct' }
          : { outcome: 'incorrect', reason: 'missing_unit_value_out_of_tolerance' };
      }
    }
    if (compiled.expectedUnit == null) {
      return {
        outcome: 'undecidable',
        reason: norm.ok ? 'numeric_response_unparseable' : norm.reason,
      };
    }
    // R2 分流：声明单位作答恢复经 convertUnitTo 的原 mathjs 解析（m²/m³
    // 等旧支持写法），但折叠字符落在数值词法区的输入仍按同一 reason 拒绝
    // （3² m→32 m 类数值改写绝不放行）；见 declaredUnitResponseCorruptsValue。
    if (declaredUnitResponseCorruptsValue(rawResponse)) {
      return {
        outcome: 'undecidable',
        reason: 'superscript_subscript_or_vulgar_fraction_not_supported',
      };
    }
    const converted = await convertUnitTo(rawResponse, compiled.expectedUnit);
    if (!converted.ok && converted.kind === 'unparseable') {
      return { outcome: 'undecidable', reason: 'unit_response_unparseable' };
    }
    if (!converted.ok) return { outcome: 'incorrect', reason: 'unit_dimension_mismatch' };
    return withinToleranceOf(converted.value, compiled.expected, compiled.tolerance)
      ? { outcome: 'correct' }
      : { outcome: 'incorrect', reason: 'unit_value_out_of_tolerance' };
  }

  // 其余 lane（无单位 number / 精确对象）保持整串 guard：折叠字符一律拒绝。
  if (!norm.ok) return { outcome: 'undecidable', reason: norm.reason };
  const text = norm.value;

  if (compiled.kind === 'number_exact_rational') {
    const parsed = parseDeclaredNumber(text, shape);
    if (!parsed.ok) return { outcome: 'undecidable', reason: parsed.reason };
    return ratEq(parsed.value, compiled.value) ? { outcome: 'correct' } : { outcome: 'incorrect' };
  }

  const parsed = parseDeclaredObject(text, shape);
  if (!parsed.ok) return { outcome: 'undecidable', reason: parsed.reason };
  return serializeObject(parsed.value) === compiled.canonical
    ? { outcome: 'correct' }
    : { outcome: 'incorrect' };
}

/** 已编译键的规范核验值（admission 证据用；number_tolerance 无精确核验值）。 */
export function compiledCanonicalOf(compiled: CompiledDeclaredKey): string | null {
  switch (compiled.kind) {
    case 'number_exact_rational':
      return `n:${ratRender(compiled.value)}`;
    case 'number_tolerance':
      return null;
    case 'exact_object':
      return compiled.canonical;
  }
}

/** number_exact_rational 编译值的浮点读数（跨 kind 铸键时按冻结容差比对用）。 */
export function declaredRationalValueOf(compiled: CompiledDeclaredKey): number | null {
  return compiled.kind === 'number_exact_rational' ? ratToNumber(compiled.value) : null;
}

// ---------- 声明支持判定（闸门共用，不能各写一份） ----------

export type DeclaredShapeSupport =
  | { supported: true; shape: BlankAnswerShapeT }
  | { supported: false; reason: string };

/**
 * 声明是否被本比较器真实支持：schema 合法 + 全部 notation 已实现 + 静态
 * 边界内。未支持/坏声明一律 fail-closed —— enqueue、maySend、publish、
 * serving、draft judgeable 用同一判定（设计 §5：不能 schema 合法就视为
 * executor 已准入）。
 */
export function declaredShapeSupport(shapeRaw: unknown): DeclaredShapeSupport {
  const parsed = BlankAnswerShape.safeParse(shapeRaw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      supported: false,
      reason: `invalid_declaration(${issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : 'unparseable'})`,
    };
  }
  const shape = parsed.data;
  const implemented = IMPLEMENTED_NOTATIONS[shape.value.kind];
  for (const notation of shape.notation) {
    if (!implemented.includes(notation)) {
      return {
        supported: false,
        reason: `notation '${notation}' for value kind '${shape.value.kind}' is not implemented by comparator ${DECLARED_BLANK_COMPARE_VERSION}`,
      };
    }
  }
  if (shape.value.kind === 'point' && shape.value.axes.length > MAX_POINT_AXES) {
    return { supported: false, reason: `point axes exceed ${MAX_POINT_AXES}` };
  }
  return { supported: true, shape };
}

/**
 * 裸 response_spec JSON（行快照）上的支持探测：任一声明槽未支持 → 付费/
 * 入队闸拒绝。宽松存在性扫描沿用 findAnswerShapeDeclarations（未知版本也
 * 算已声明并在此被判未支持）。
 */
export function declaredShapesAllSupported(
  responseSpecRaw: unknown,
): { ok: true } | { ok: false; reason: string } {
  for (const declaration of findAnswerShapeDeclarations(responseSpecRaw)) {
    const support = declaredShapeSupport(declaration.answer_shape);
    if (!support.supported) {
      return { ok: false, reason: `slot ${declaration.slot_id}: ${support.reason}` };
    }
  }
  return { ok: true };
}

/**
 * 冻结契约上的判分就绪检查（serving / admitted 发布共用）：发出范围内每个
 * 已声明 blank 槽必须（a）被本比较器支持、（b）被 blank_key unit 读取、
 * （c）该 unit 的私有键能按声明完整编译。任何缺项 → fail-closed。
 */
export function declaredBlankGradeReadiness(
  spec: ResponseSpecT,
  basis: ScoringBasisT,
  partIds?: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const scope = partIds == null ? null : new Set(partIds);
  const unitsBySlot = new Map<string, ScoringBasisT['units']>();
  for (const unit of basis.units) {
    for (const slotId of unit.slot_refs) {
      const list = unitsBySlot.get(slotId) ?? [];
      list.push(unit);
      unitsBySlot.set(slotId, list);
    }
  }
  for (const slot of spec.slots) {
    if (slot.kind !== 'blank' || slot.answer_shape == null) continue;
    if (scope != null && !scope.has(slot.part_id)) continue;
    const support = declaredShapeSupport(slot.answer_shape);
    if (!support.supported) {
      return { ok: false, reason: `slot ${slot.slot_id}: ${support.reason}` };
    }
    const units = unitsBySlot.get(slot.slot_id) ?? [];
    if (units.length === 0) {
      return { ok: false, reason: `slot ${slot.slot_id}: declared blank has no scoring unit` };
    }
    for (const unit of units) {
      if (unit.criterion.kind !== 'blank_key') {
        return {
          ok: false,
          reason: `slot ${slot.slot_id}: unit ${unit.scoring_unit_id} criterion '${unit.criterion.kind}' is not a blank_key`,
        };
      }
      const key: BlankKeyCriterionT['key'] = unit.criterion.key;
      const compile = compileDeclaredKey(support.shape, key);
      if (!compile.ok) {
        return {
          ok: false,
          reason: `slot ${slot.slot_id}: unit ${unit.scoring_unit_id} declared key does not compile (${compile.reason})`,
        };
      }
    }
  }
  return { ok: true };
}
