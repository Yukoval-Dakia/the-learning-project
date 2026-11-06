// Deterministic crisis detection: lexical only, no model call. The raw text never
// leaves the caller; events record only class, template version, and entry point.
// First match wins: explicit > indirect > quoted_ironic > distress.

import { CRISIS_GUARD_CONFIG, type CrisisDetectionClass } from './config';

export type {
  CrisisDetectionClass,
  CrisisGuardConfig,
  CrisisTemplate,
} from './config';
export {
  CRISIS_GUARD_CONFIG,
  CRISIS_GUARD_CONFIG_VERSION,
  crisisTemplateForClass,
} from './config';

function normalize(text: string): string {
  // Lowercase for English patterns, NFKC for fullwidth forms (ｗｈｙ→why), collapse
  // whitespace; keep emoji (joke signal).
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Match each pattern against both forms: whitespace-collapsed (English phrases) and
 * fully despaced (Chinese input often has stray spaces). Either hit counts.
 */
function matchesAny(patterns: readonly RegExp[], spaced: string, despaced: string): boolean {
  return patterns.some(
    (pattern) => pattern.test(spaced) || (despaced !== spaced && pattern.test(despaced)),
  );
}

// ── Release rules (code, not lookarounds): a hit is released to 'none' only when
// every applicable condition holds. Two independent release paths.

// 1) 死-compound: "想死磕/记/背/缠/死死缠" is grim determination, not a death wish —
// released only when stripping every compound occurrence leaves no death evidence
// at all ("我想死磕完最后一题就去死" keeps its hit). 扛/撑/顶 are endurance verbs
// and never compound; a 不 right after the char negates it instead ("想死记不住了").
const SI_COMPOUND_RE =
  /(?:想|想去|要去|怎么)死(?:磕|缠|磨|黏|赖|跟|盯|抱|抓|捏|攥|揪|掐|拽|捂|记|背|啃|抠|命|卷|死)(?!不)/g;
// Method words mirror the vocabulary in config.ts's intent-gated method
// patterns (吞药/安眠药/褪黑素/跳楼/跳下去/割腕/烧炭/上吊/自尽/轻生) so the
// evidence check sees the same methods the term patterns do.
const DEATH_EVIDENCE_RE =
  /死|自杀|吞药|自尽|安眠药|褪黑素|跳楼|跳下去|割腕|烧炭|上吊|轻生|安乐死|了结|解脱|一了百了|结束自己|结束生命|消失|撑不|熬不|挺不|扛不|顶不|活不下|不想活|kill|die|dying|suicide|self[- ]?harm|end it|wanna die/;

// 2) Whitelist why-release: the third-party word must sit immediately next to the
// why-word (either side; English allows one auxiliary + determiner), the whole
// text must contain no first/second-person marker, and the text must be short —
// long analytic context keeps its hit because a miss costs more than a false
// positive. 60 chars ≈ two chat clauses: crisis utterances are short; anything
// longer falls back to "keep the hit".
const MAX_RELEASE_LEN = 60;
const WHY_WORD_ZH = '(?:为什么|为何|为啥|怎么会|咋|因何|何故|缘何|如何|怎么)';
const THIRD_PARTY_ZH =
  '(?:他|她|它|牠|他们|她们|它们|牠们|某人|别人|他人|旁人|外人|陌生人|人物|角色|' +
  '主人公|主角|配角|作者|诗人|词人|作家|名人|古人|伟人|英雄|反派|死者|逝者|当事人|' +
  '被害人|受害人|凶手|嫌疑人|罪犯|罪人|犯人|自杀者|案例|素材|原型|传记|课文|课本|' +
  '小说|故事|电影|剧本|文章|作品|寓言|典故|传说|神话|史料|新闻|报道|论文|例题|同学|' +
  '同桌|室友|同事|朋友|网友|家人|亲人|亲戚|父母|爸爸|妈妈|父亲|母亲|家长|长辈|哥哥|' +
  '姐姐|弟弟|妹妹|兄长|兄弟|姐妹|爷爷|奶奶|外公|外婆|姥爷|姥姥|叔叔|阿姨|舅舅|姑姑|' +
  '老师|导师|医生|护士|警察|军人|邻居|老乡|领导|老板|上司|教练|队友|对手|敌人|仇人|' +
  '恩人|爱人|恋人|对象|伴侣|配偶|丈夫|妻子|老公|老婆|男友|女友|前任|前夫|前妻|病友|' +
  '狱友|战友|细胞|组织|器官|细菌|病毒|微生物|动物|植物|鱼|鱼儿|鸟|鸟儿|猫|狗|兔子|' +
  '老鼠|虫子|昆虫|物体|东西|机器|设备|装置|仪器|模型|桥|塔|楼|墙|坝|堤|容器|结构|' +
  '材料|元件|零件|部件|系统|分子|原子|电子|粒子|蛋白|细胞器)';
const THIRD_PARTY_EN =
  '\\b(?:he|she|they|them|him|his|their|theirs|someone|somebody|character|protagonist|' +
  'hero|heroine|villain|author|poet|writer|narrator|victim|patient|deceased|classmate|' +
  'roommate|friend|parent|father|mother|teacher|doctor|therapist|counselor|animal|animals|' +
  'fish|bird|cells?|plants?|organism|creature|novel|story|essay|poem|text|passage|article|book)\\b';
const WHY_THIRD_PARTY_ZH_RE = new RegExp(
  `(?:${THIRD_PARTY_ZH})(?=${WHY_WORD_ZH})|(?:${WHY_WORD_ZH})(?=${THIRD_PARTY_ZH})`,
);
const WHY_THIRD_PARTY_EN_RE = new RegExp(
  `why\\s+(?:does|do|did|would|is|are|was|were|has|have|will)\\s+(?:the\\s+|a\\s+|an\\s+|this\\s+|that\\s+)?${THIRD_PARTY_EN}`,
);
// Any personal marker anywhere in the text blocks the why-release — pronoun lists
// are never complete, so the adjacency rule above is the primary defense.
const PERSONAL_RE =
  /我|俺|咱|自己|本人|老子|老娘|我们|咱们|你|您|你们|包括我|像我|人家|偶|朕|吾|吾辈|本宝宝|这边|孤|寡人|在下|鄙人|小生|小女子|奴家|晚辈|老朽|老身|\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves|you|your|yours|yourself|yourselves|u)\b/;

// A release never discards the whole utterance: the released span is removed and
// the remainder is reclassified with release disabled, so an independent hit in
// the rest of the text stands ("想死记硬背，活着没意思" → indirect).
// Clause boundaries: whitespace separates Chinese clauses ("他为什么想死 想死"
// releases only the question, the residual 想死 stays a hit) but is a normal
// word separator inside an English question.
const QUESTION_BOUNDARY_ZH = '，。！？；、：…—·.,!?;: ';
const QUESTION_BOUNDARY_EN = '，。！？；、：…—·.,!?;:';
// The EN why-release additionally requires the death term to close the
// utterance — any word after it means no release ("why does he want to die im
// the same" stays a hit, the pronoun list can't cover every colloquial form).
const EN_TERM_AT_END_RE =
  /\b(?:want(?:ed)? to die|wanna die|gonna die|going to die|kill(?:ing)? myself|end(?:ing)? my life|end it all|end it|commit suicide|suicide|suicidal|better off dead|self[- ]?harm|hurt(?:ing)? myself|no reason to live|not want to live|don'?t want to live|do not want to live|not want to be alive|don'?t want to be alive|do not want to be alive|give up on life|die|dying|dead|kill)[\s.,!?;:，。？！；：…—·、]*$/;

function stripWhyQuestion(text: string, pattern: RegExp, isEn: boolean): string {
  const match = pattern.exec(text);
  if (!match) return text;
  const rightBoundary = isEn ? QUESTION_BOUNDARY_EN : QUESTION_BOUNDARY_ZH;
  let left = 0;
  for (let i = match.index - 1; i >= 0; i--) {
    if (QUESTION_BOUNDARY_ZH.includes(text[i])) {
      left = i + 1;
      break;
    }
  }
  let right = text.length;
  for (let i = match.index + match[0].length; i < text.length; i++) {
    if (rightBoundary.includes(text[i])) {
      right = i;
      break;
    }
  }
  return text.slice(0, left) + text.slice(right);
}

// Returns the remainder text when a release path applies, null when the hit
// stands. The 死-compound precondition keeps its own death-evidence check —
// 就去死/再自杀/去死算了 are not lexical terms, so reclassifying alone would
// release real intent the owner requires to stay hits.
function releaseRemainder(spaced: string, despaced: string): string | null {
  const stripped = spaced.replace(SI_COMPOUND_RE, '');
  const strippedDespaced = despaced.replace(SI_COMPOUND_RE, '');
  if (
    (stripped !== spaced || strippedDespaced !== despaced) &&
    !DEATH_EVIDENCE_RE.test(stripped) &&
    !DEATH_EVIDENCE_RE.test(strippedDespaced)
  ) {
    return stripped !== spaced ? stripped : strippedDespaced;
  }
  if (spaced.length > MAX_RELEASE_LEN) return null;
  if (PERSONAL_RE.test(spaced) || PERSONAL_RE.test(despaced)) return null;
  return whyRemainder(spaced) ?? whyRemainder(despaced);
}

function whyRemainder(text: string): string | null {
  if (WHY_THIRD_PARTY_ZH_RE.test(text)) return stripWhyQuestion(text, WHY_THIRD_PARTY_ZH_RE, false);
  if (WHY_THIRD_PARTY_EN_RE.test(text)) {
    return EN_TERM_AT_END_RE.test(text)
      ? stripWhyQuestion(text, WHY_THIRD_PARTY_EN_RE, true)
      : null;
  }
  return null;
}

/** Pure; never throws — any input failure degrades to 'none'. */
export function classifyCrisisExpression(rawText: string): CrisisDetectionClass {
  let text: string;
  try {
    text = normalize(rawText);
  } catch {
    return 'none';
  }
  if (!text) return 'none';
  return classifyNormalized(text, true);
}

const ORDERED: readonly [CrisisDetectionClass, readonly RegExp[]][] = [
  ['explicit', CRISIS_GUARD_CONFIG.explicit_patterns],
  ['indirect', CRISIS_GUARD_CONFIG.indirect_patterns],
  ['quoted_ironic', CRISIS_GUARD_CONFIG.quoted_ironic_patterns],
  ['distress', CRISIS_GUARD_CONFIG.distress_patterns],
];

function classifyNormalized(spaced: string, allowRelease: boolean): CrisisDetectionClass {
  const despaced = spaced.replace(/ /g, '');
  for (const [detectionClass, patterns] of ORDERED) {
    try {
      if (!matchesAny(patterns, spaced, despaced)) continue;
      if (allowRelease && detectionClass !== 'distress') {
        const remainder = releaseRemainder(spaced, despaced);
        if (remainder !== null) {
          const residual = classifyNormalized(remainder, false);
          if (residual !== 'none') return residual;
          continue;
        }
      }
      return detectionClass;
    } catch {
      // One corrupt pattern group must not block the remaining classes.
    }
  }
  return 'none';
}
