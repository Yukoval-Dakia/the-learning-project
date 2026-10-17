// YUK-1398 (Stage 1 · B6 S3) — 确定性危机识别：纯词法，无模型调用，无副作用。
//
// 只做一件事：给一段自由文本一个 detection class。原始文本绝不离开调用方
// （会话记录已有既有落点）；事件记录见 `recordCrisisGuardEvent` 的调用方，
// 只写类别 / 模板版本 / 入口，不写原文。
//
// 判定优先级（先命中先停）：explicit > indirect > quoted_ironic > distress。
// 显式与间接词在任何位置命中都算；引用·反讽要求「死亡词 + 玩笑信号」同现
// （见 config.ts 注释），不会把单独的「哈哈哈」或单独的「累死算了」误报成
// 完整危机，也不会把带😂的真心话漏成普通消息——它仍会得到温和确认。

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
  // 小写化（英文词条全小写）+ 压缩空白，中文不受影响。保留 emoji（玩笑信号）。
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 每条词表同时在两种归一化形态上匹配：
 *   1. 压缩空白形（英文词条依赖词间空格，如 "kill myself"）；
 *   2. 去全部空白形（中文输入常混排空格/全角空格，如「每天只睡 4 小时」「吃多少 片」）。
 * 两种形态任一命中即算命中。
 */
function matchesAny(patterns: readonly RegExp[], spaced: string, despaced: string): boolean {
  return patterns.some((pattern) => pattern.test(spaced) || pattern.test(despaced));
}

/** 纯函数：识别类别。永不抛错；任何输入异常一律按 'none' 正常流转。 */
export function classifyCrisisExpression(rawText: string): CrisisDetectionClass {
  let text: string;
  try {
    text = normalize(rawText);
  } catch {
    return 'none';
  }
  if (!text) return 'none';
  const despaced = text.replace(/ /g, '');
  const ordered: readonly [CrisisDetectionClass, readonly RegExp[]][] = [
    ['explicit', CRISIS_GUARD_CONFIG.explicit_patterns],
    ['indirect', CRISIS_GUARD_CONFIG.indirect_patterns],
    ['quoted_ironic', CRISIS_GUARD_CONFIG.quoted_ironic_patterns],
    ['distress', CRISIS_GUARD_CONFIG.distress_patterns],
  ];
  for (const [detectionClass, patterns] of ordered) {
    try {
      if (matchesAny(patterns, text, despaced)) return detectionClass;
    } catch {
      // 单条词表配置损坏不阻塞判定，继续下一组。
    }
  }
  return 'none';
}
