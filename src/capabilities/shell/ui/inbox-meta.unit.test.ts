// M4-T6 (YUK-319/YUK-318)：收件箱/工作台 ui 元数据契约测试——
// KIND_META 与 core aiProposalKinds 对账（新增 kind 必须同步补 UI 元数据）、
// kindMeta/evidenceReadable fallback 语义、heatLevel 分桶边界。

import { acceptSupportedProposalKinds, aiProposalKinds } from '@/core/schema/proposal';
import { describe, expect, it } from 'vitest';

import {
  KIND_META,
  dedupeEvidence,
  evidenceReadable,
  isAcceptSupported,
  isBlockMergeStale,
  kindMeta,
  splitReasonIds,
} from './inbox-api';
import { heatLevel } from './workbench-api';

describe('KIND_META vs aiProposalKinds 对账', () => {
  it('每个 core proposal kind 都有 UI 元数据条目', () => {
    const missing = aiProposalKinds.filter((k) => !(k in KIND_META));
    expect(missing).toEqual([]);
  });

  it('KIND_META 不含 core 之外的多余 kind', () => {
    const known = new Set<string>(aiProposalKinds);
    const extra = Object.keys(KIND_META).filter((k) => !known.has(k));
    expect(extra).toEqual([]);
  });

  it('每条元数据 label 非空且 tone 在五件套内', () => {
    const tones = new Set(['info', 'coral', 'good', 'hard', 'neutral']);
    for (const [kind, meta] of Object.entries(KIND_META)) {
      expect(meta.label, kind).not.toBe('');
      expect(meta.icon, kind).not.toBe('');
      expect(tones.has(meta.tone), `${kind} tone=${meta.tone}`).toBe(true);
    }
  });
});

// M4 review fix (YUK-319, codex P2)：dispatchAccept 未实现 kind 的分区钉测。
// dispatchAccept（src/server/proposals/actions.ts）新增/移除 case 时，必须同步
// 更新 core 的 acceptSupportedProposalKinds，否则这里漂移警报。
describe('acceptSupportedProposalKinds 分区对账', () => {
  const unsupported = ['defer', 'archive', 'judge_retraction'] as const;

  it('acceptSupported ∪ {defer, archive, judge_retraction} === aiProposalKinds', () => {
    const union = new Set<string>([...acceptSupportedProposalKinds, ...unsupported]);
    expect([...union].sort()).toEqual([...aiProposalKinds].sort());
    // 两个分区不相交（unsupported 不得混进 supported 集合）。
    for (const k of unsupported) {
      expect(
        (acceptSupportedProposalKinds as readonly string[]).includes(k),
        `${k} 不应在 acceptSupported`,
      ).toBe(false);
    }
  });

  it('isAcceptSupported 按分区判定（含未知 kind = false）', () => {
    expect(isAcceptSupported('knowledge_edge')).toBe(true);
    expect(isAcceptSupported('block_merge')).toBe(true);
    for (const k of unsupported) {
      expect(isAcceptSupported(k), k).toBe(false);
    }
    expect(isAcceptSupported('brand_new_kind')).toBe(false);
  });
});

describe('kindMeta fallback', () => {
  it('已知 kind 返回注册条目', () => {
    expect(kindMeta('knowledge_edge')).toEqual({ label: '知识关系', icon: 'link', tone: 'info' });
  });

  it('未知 kind 返回 raw kind + inbox icon + neutral（绝不 throw）', () => {
    expect(kindMeta('brand_new_kind')).toEqual({
      label: 'brand_new_kind',
      icon: 'inbox',
      tone: 'neutral',
    });
  });
});

describe('heatLevel 分桶边界', () => {
  it('0 空 / 1-2 轻 / 3-5 中 / 6-9 高 / 10-15 峰 / ≥16 满', () => {
    expect(heatLevel(-1)).toBe(0);
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(2)).toBe(1);
    expect(heatLevel(3)).toBe(2);
    expect(heatLevel(5)).toBe(2);
    expect(heatLevel(6)).toBe(3);
    expect(heatLevel(9)).toBe(3);
    expect(heatLevel(10)).toBe(4);
    expect(heatLevel(15)).toBe(4);
    // S3-fix (YUK-335): 满 coral 第 5 档（设计收束高潮）现真实出现在高活跃日。
    expect(heatLevel(16)).toBe(5);
  });
});

// YUK-271 行为恢复（codex 验证轮 P2）：旧 inbox.test.tsx 的等价测试随旧壳删除，
// 随 isBlockMergeStale 回归——窄化只命中 stale 的 block_merge accept 响应。
describe('isBlockMergeStale', () => {
  it('stale 的 block_merge accept 响应命中', () => {
    expect(
      isBlockMergeStale({ kind: 'block_merge', stale: true, skip_reason: 'skipped:not_draft' }),
    ).toBe(true);
  });

  it('已写入 / 幂等的 block_merge accept 不命中', () => {
    expect(isBlockMergeStale({ kind: 'block_merge', stale: false })).toBe(false);
    expect(isBlockMergeStale({ kind: 'block_merge', idempotent: true })).toBe(false);
  });

  it('其它 kind 或非对象输入不命中', () => {
    expect(isBlockMergeStale({ kind: 'knowledge_node', stale: true })).toBe(false);
    expect(isBlockMergeStale(null)).toBe(false);
    expect(isBlockMergeStale('block_merge')).toBe(false);
  });
});

describe('evidenceReadable', () => {
  it('knowledge → /knowledge/:id 可导航', () => {
    expect(evidenceReadable({ kind: 'knowledge', id: 'kn1' })).toEqual({
      text: '源自一个知识点',
      route: '/knowledge/kn1',
    });
  });

  it('artifact → /notes/:id 可导航', () => {
    expect(evidenceReadable({ kind: 'artifact', id: 'ar1' })).toEqual({
      text: '源自一篇笔记',
      route: '/notes/ar1',
    });
  });

  it('event/question/record 详情页未迁 SPA → route=null 纯文本', () => {
    for (const kind of ['event', 'question', 'record'] as const) {
      const r = evidenceReadable({ kind, id: 'x1' });
      expect(r.route, kind).toBeNull();
      expect(r.text, kind).not.toBe('');
    }
  });
});

// S7 (YUK-335, audit §3.4)：evidence chip 同 readable 文案去重 + 计数。
describe('dedupeEvidence', () => {
  it('同 kind（同 readable 文案）折成一组并计数', () => {
    const out = dedupeEvidence([
      { kind: 'event', id: 'e1' },
      { kind: 'event', id: 'e2' },
      { kind: 'event', id: 'e3' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].ref.id).toBe('e1'); // 保留首个 ref
  });

  it('不同 kind 各成一组，保持首次出现顺序', () => {
    const out = dedupeEvidence([
      { kind: 'event', id: 'e1' },
      { kind: 'question', id: 'q1' },
      { kind: 'event', id: 'e2' },
    ]);
    expect(out.map((d) => d.ref.kind)).toEqual(['event', 'question']);
    expect(out.map((d) => d.count)).toEqual([2, 1]);
  });

  it('空数组 → 空结果', () => {
    expect(dedupeEvidence([])).toEqual([]);
  });
});

// S7 (YUK-335, audit §3.4 + §2 P3)：reason_md raw-ID 切分（display-only，不改词）。
describe('splitReasonIds', () => {
  it('命中 block-<cuid>，prose 段保留原词', () => {
    const segs = splitReasonIds('建议合并题块 block-abc123def456 与下一块');
    expect(segs).toEqual([
      { text: '建议合并题块 ', raw: false },
      { text: 'block-abc123def456', raw: true },
      { text: ' 与下一块', raw: false },
    ]);
  });

  it('命中命名空间 ID（synthetic:wenyan:...）', () => {
    const segs = splitReasonIds('来源 synthetic:wenyan:0001 已变更');
    expect(segs.find((s) => s.raw)?.text).toBe('synthetic:wenyan:0001');
    // 拼回原文逐字不变
    expect(segs.map((s) => s.text).join('')).toBe('来源 synthetic:wenyan:0001 已变更');
  });

  it('命中裸长串（≥20 位小写字母数字）', () => {
    const id = 'a1b2c3d4e5f6g7h8i9j0k1';
    const segs = splitReasonIds(`引用 ${id} 记录`);
    expect(segs.find((s) => s.raw)?.text).toBe(id);
  });

  it('不误伤中文 / 正常英文短词 / 短数字', () => {
    const md = '这是一段正常的判定理由 with English words and code 42';
    const segs = splitReasonIds(md);
    expect(segs.every((s) => !s.raw)).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe(md);
  });

  it('纯 prose 返回单个 raw=false 段，拼回原文不变', () => {
    const md = '建议接受这个合并';
    expect(splitReasonIds(md)).toEqual([{ text: md, raw: false }]);
  });

  it('多个 ID 全部切出，拼回逐字等于原文', () => {
    const md = '合并 block-abcdef123456 到 block-987654fedcba 完成';
    const segs = splitReasonIds(md);
    expect(segs.filter((s) => s.raw)).toHaveLength(2);
    expect(segs.map((s) => s.text).join('')).toBe(md);
  });
});
