// Daily composition, deterministic fallback, and answer reranking share this pure
// owner for the stream origin and its explanation. Selection policy stays with callers.

function kpSuffix(label?: string): string {
  return label ? `「${label}」` : '这一块';
}

export function presentDueQuestion(
  label?: string,
  source?: 'decay' | 'intervention',
): { source: 'decay' | 'intervention'; reasoning: string } {
  return {
    source: source ?? 'decay',
    reasoning:
      source === 'intervention'
        ? '这份针对当前薄弱点的材料已经准备好；先阅读，再完成检验。'
        : `我看了你的曲线：${kpSuffix(label)}到了复习边缘，先把它咬住。`,
  };
}

export function presentNonDueQuestion(
  role: 'variant' | 'new_check' | 'frontier' | undefined,
  label?: string,
): { source: 'variant' | 'new_check' | 'frontier'; reasoning: string } {
  if (role === 'new_check') {
    return {
      source: 'new_check',
      reasoning: `你刚学了${kpSuffix(label)}，自测一道确认真的进脑子了。`,
    };
  }
  if (role === 'frontier') {
    // 措辞红线（；Cosyn et al. 2021 JMP 实证 outer-fringe 首答正确率仅 ~27%）:
    // frontier 是「结构可达」信号,不是「容易/该会/正确率高」信号——不要在这段文案引入后者措辞
    // （「前置拿下了、可以开这块」是可达性叙述,非难度承诺）。详见
    return {
      source: 'frontier',
      reasoning: `${kpSuffix(label)}的前置你都拿下了，可以开这块新内容了。`,
    };
  }
  return {
    source: 'variant',
    reasoning: `之前${kpSuffix(label)}翻过车，这道换了说法再来一次。`,
  };
}

export function presentPracticePaper(
  title: string,
  source: 'paper' | 'on_demand' | 'import',
): { source: 'paper' | 'on_demand' | 'import'; reasoning: string } {
  return {
    source,
    reasoning:
      source === 'on_demand'
        ? `你点播的「${title}」排好了——卷内不给即时反馈，交卷统一判。`
        : source === 'import'
          ? `你导入的「${title}」在待做里——交卷后统一判分。`
          : `散题做完后用「${title}」收口——卷内不给即时反馈，交卷统一判。`,
  };
}
