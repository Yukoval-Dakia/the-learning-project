// YUK-1051 — response-types 纯函数单测：stable option ids、空集合≠missing、
// 配对/排序纯操作、六态元信息、MIME→证据类别。
import { describe, expect, it } from 'vitest';
import {
  COARSE_OUTCOME_META,
  SUBMISSION_LIFECYCLE_META,
  assignMatch,
  choiceSelectionsEqual,
  deriveOptionIds,
  evidenceKindFromMime,
  isSlotResponseAnswered,
  moveOrderedItem,
  moveOrderedItemTo,
  nativeResponseEntry,
  nativeResponseValue,
  optionLabel,
  optionsFromChoicesMd,
  serializeResponseSet,
} from './response-types';

describe('deriveOptionIds — stable option identity', () => {
  it('同一文本恒同 id（内容派生，与渲染轮次无关）', () => {
    const a = deriveOptionIds(['甲', '乙'], 'q1');
    const b = deriveOptionIds(['甲', '乙'], 'q1');
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
    expect(a[0]).toMatch(/^opt_/);
  });

  it('重排不改变各选项的身份（stable id 不授权重排，但身份跟随内容）', () => {
    const base = deriveOptionIds(['甲', '乙', '丙'], 'q1');
    const shuffled = deriveOptionIds(['丙', '甲', '乙'], 'q1');
    // 内容相同 → id 相同，与位置无关
    expect(shuffled[1]).toBe(base[0]);
    expect(shuffled[0]).toBe(base[2]);
  });

  it('重复文本按出现次序消歧', () => {
    const ids = deriveOptionIds(['同上', '同上', '其他'], 'q1');
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });

  it('scope 防跨题同文本撞 id', () => {
    const a = deriveOptionIds(['甲'], 'q1');
    const b = deriveOptionIds(['甲'], 'q2');
    expect(a[0]).not.toBe(b[0]);
  });

  it('空白差异归一（trim + 折叠空白）', () => {
    const a = deriveOptionIds(['  甲  '], 'q1');
    const b = deriveOptionIds(['甲'], 'q1');
    expect(a).toEqual(b);
  });
});

describe('optionLabel — 展示序号不硬编码 4', () => {
  it('0→A, 25→Z, 26 起退化为数字', () => {
    expect(optionLabel(0)).toBe('A');
    expect(optionLabel(3)).toBe('D');
    expect(optionLabel(25)).toBe('Z');
    expect(optionLabel(26)).toBe('27');
  });

  it('optionsFromChoicesMd 支持任意选项数', () => {
    const opts = optionsFromChoicesMd(
      Array.from({ length: 7 }, (_, i) => `选项${i}`),
      'q1',
    );
    expect(opts).toHaveLength(7);
    expect(opts[4].label).toBe('E');
    expect(new Set(opts.map((o) => o.id)).size).toBe(7);
  });
});

describe('isSlotResponseAnswered — 空集合 vs missing', () => {
  it('missing（undefined/null）是未作答', () => {
    expect(isSlotResponseAnswered(undefined)).toBe(false);
    expect(isSlotResponseAnswered(null)).toBe(false);
  });

  it('显式空集合 ≠ missing，但也未构成实质作答', () => {
    expect(isSlotResponseAnswered({ kind: 'choice', option_ids: [] })).toBe(false);
    expect(isSlotResponseAnswered({ kind: 'text', text: '' })).toBe(false);
  });

  it('有内容即作答', () => {
    expect(isSlotResponseAnswered({ kind: 'choice', option_ids: ['opt_x'] })).toBe(true);
    expect(isSlotResponseAnswered({ kind: 'text', text: ' 42 ' })).toBe(true);
    expect(isSlotResponseAnswered({ kind: 'matching', pairs: { l1: null } })).toBe(false);
    expect(isSlotResponseAnswered({ kind: 'matching', pairs: { l1: 'r2' } })).toBe(true);
    expect(isSlotResponseAnswered({ kind: 'ordering', ordered_ids: ['a', 'b'] })).toBe(true);
  });
});

describe('choiceSelectionsEqual', () => {
  it('集合语义（与次序无关）', () => {
    expect(choiceSelectionsEqual(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(choiceSelectionsEqual(['a'], ['a', 'b'])).toBe(false);
    expect(choiceSelectionsEqual([], [])).toBe(true);
  });
});

describe('assignMatch — 配对指派', () => {
  it('exclusive：右项被占用时改配会摘下旧配对', () => {
    const start = { l1: 'r1', l2: null };
    const next = assignMatch(start, 'l2', 'r1');
    expect(next).toEqual({ l1: null, l2: 'r1' });
  });

  it('非 exclusive：允许复用', () => {
    const next = assignMatch({ l1: 'r1' }, 'l2', 'r1', { exclusive: false });
    expect(next).toEqual({ l1: 'r1', l2: 'r1' });
  });

  it('清空配对（rightId=null）', () => {
    expect(assignMatch({ l1: 'r1' }, 'l1', null)).toEqual({ l1: null });
  });
});

describe('ordering 纯操作', () => {
  it('moveOrderedItem 上移/下移；越界原样', () => {
    expect(moveOrderedItem(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveOrderedItem(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveOrderedItem(['a', 'b'], 'a', 'up')).toEqual(['a', 'b']);
    expect(moveOrderedItem(['a', 'b'], 'b', 'down')).toEqual(['a', 'b']);
  });

  it('moveOrderedItemTo 序号编辑（1-based，clamp）', () => {
    expect(moveOrderedItemTo(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
    expect(moveOrderedItemTo(['a', 'b', 'c'], 'c', 1)).toEqual(['c', 'a', 'b']);
    expect(moveOrderedItemTo(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(moveOrderedItemTo(['a', 'b', 'c'], 'a', -2)).toEqual(['a', 'b', 'c']);
  });
});

describe('evidenceKindFromMime（D10 口径）', () => {
  it('image/audio/video/pdf/text 各归其类；未知 → other', () => {
    expect(evidenceKindFromMime('image/png')).toBe('image');
    expect(evidenceKindFromMime('audio/mpeg')).toBe('audio');
    expect(evidenceKindFromMime('video/mp4; codecs=avc1')).toBe('video');
    expect(evidenceKindFromMime('application/pdf')).toBe('pdf');
    expect(evidenceKindFromMime('text/markdown')).toBe('text');
    expect(evidenceKindFromMime('application/octet-stream')).toBe('other');
    expect(evidenceKindFromMime(null)).toBe('other');
    expect(evidenceKindFromMime(undefined)).toBe('other');
  });
});

describe('六状态与判定结果元信息', () => {
  it('六状态齐、各有非对错色的 label/tone（§6.4 纪律）', () => {
    const keys = Object.keys(SUBMISSION_LIFECYCLE_META);
    expect(keys).toEqual([
      'draft',
      'submitted_pending',
      'group_tentative',
      'needs_review',
      'effective',
      'superseded',
    ]);
    for (const k of keys) {
      const meta = SUBMISSION_LIFECYCLE_META[k as keyof typeof SUBMISSION_LIFECYCLE_META];
      expect(meta.label.length).toBeGreaterThan(0);
      // lifecycle tone 集合刻意不含 again（错）——对错色只来自 released outcome。
      expect(['neutral', 'info', 'hard', 'good']).toContain(meta.tone);
    }
  });

  it('COARSE_OUTCOME_META 覆盖四态 coarse outcome', () => {
    expect(Object.keys(COARSE_OUTCOME_META).sort()).toEqual([
      'correct',
      'incorrect',
      'partial',
      'unsupported',
    ]);
  });
});

describe('serializeResponseSet — autosave 脏检查', () => {
  it('键序/选择次序无关；内容变即变', () => {
    const a = serializeResponseSet({
      s1: { kind: 'choice', option_ids: ['x', 'y'] },
      s2: { kind: 'text', text: '答' },
    });
    const b = serializeResponseSet({
      s2: { kind: 'text', text: '答' },
      s1: { kind: 'choice', option_ids: ['y', 'x'] },
    });
    expect(a).toBe(b);
    const c = serializeResponseSet({ s1: { kind: 'choice', option_ids: ['x'] } });
    expect(a).not.toBe(c);
  });
});

describe('native frozen response editing', () => {
  it('keeps opaque published option IDs even when option text is duplicated', () => {
    const slot = {
      kind: 'multi_choice' as const,
      slot_id: 'r-opaque',
      part_id: 'p',
      min_select: 1,
      max_select: 2,
      options: [
        { option_id: 'id-first', label: '甲', text: '相同正文' },
        { option_id: 'id-second', label: '乙', text: '相同正文' },
      ],
    };
    const entry = nativeResponseEntry(slot, { kind: 'choice', option_ids: ['id-second'] });
    expect(entry).toEqual({ slot_id: 'r-opaque', kind: 'choice', option_ids: ['id-second'] });
    expect(nativeResponseValue(entry)).toEqual({ kind: 'choice', option_ids: ['id-second'] });
    expect(nativeResponseValue(undefined)).toBeUndefined();
    expect(nativeResponseEntry(slot, { kind: 'choice', option_ids: [] })).toMatchObject({
      option_ids: [],
    });
  });
  it.each(['', '  ', '1/2', '12 kg', 'Infinity', '0x10'])(
    'retains unparsed numeric original %j without pretending it was zero',
    (raw) => {
      const entry = nativeResponseEntry(
        { kind: 'numeric', slot_id: 'numeric', part_id: 'p' },
        { kind: 'text', text: raw },
      );
      expect(entry).toEqual({ kind: 'numeric', slot_id: 'numeric', raw_input: raw, value: null });
      expect(nativeResponseValue(entry)).toEqual({ kind: 'text', text: raw });
    },
  );
  it('keeps numeric zero, surrounding whitespace and confidence separately', () => {
    const entry = nativeResponseEntry(
      { kind: 'numeric', slot_id: 'n', part_id: 'p' },
      { kind: 'text', text: ' 0 ' },
      { kind: 'numeric', slot_id: 'n', value: null, self_confidence: 3 },
    );
    expect(entry).toEqual({
      kind: 'numeric',
      slot_id: 'n',
      raw_input: ' 0 ',
      value: 0,
      self_confidence: 3,
    });
  });
  it('preserves original open evidence while changing text', () => {
    const previous = {
      kind: 'open' as const,
      slot_id: 'open',
      text_md: 'old',
      evidence: [
        {
          evidence_id: 'page-1',
          kind: 'image' as const,
          mime_type: 'image/png',
          bytes: 127,
          uploaded_at: '2026-10-04T00:00:00.000Z',
          asset: {
            asset_id: 'asset-original',
            digest: `sha256:${'a'.repeat(64)}`,
          },
        },
      ],
    };
    expect(
      nativeResponseEntry(
        {
          kind: 'open_response',
          slot_id: 'open',
          part_id: 'p',
          accepted_evidence: [],
          evidence_required: false,
        },
        { kind: 'text', text: '  原文\n第二行  ' },
        previous,
      ),
    ).toEqual({ ...previous, text_md: '  原文\n第二行  ' });
  });
  it('matching and ordering round-trip native item identities; wrong field kinds fail', () => {
    const matching = {
      kind: 'matching' as const,
      slot_id: 'm',
      pairs: [{ item_id: 'left-opaque', option_id: 'right-opaque' }],
    };
    expect(nativeResponseValue(matching)).toEqual({
      kind: 'matching',
      pairs: { 'left-opaque': 'right-opaque' },
    });
    const ordering = { kind: 'ordering' as const, slot_id: 'o', item_order: ['second', 'first'] };
    expect(nativeResponseValue(ordering)).toEqual({
      kind: 'ordering',
      ordered_ids: ['second', 'first'],
    });
    expect(() =>
      nativeResponseEntry(
        { kind: 'text', slot_id: 't', part_id: 'p', math_preview: false },
        { kind: 'choice', option_ids: ['opaque'] },
      ),
    ).toThrow();
  });
});
