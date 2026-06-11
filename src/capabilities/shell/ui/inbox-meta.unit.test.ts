// M4-T6 (YUK-319/YUK-318)：收件箱/工作台 ui 元数据契约测试——
// KIND_META 与 core aiProposalKinds 对账（新增 kind 必须同步补 UI 元数据）、
// kindMeta/evidenceReadable fallback 语义、heatLevel 分桶边界。

import { aiProposalKinds } from '@/core/schema/proposal';
import { describe, expect, it } from 'vitest';

import { KIND_META, evidenceReadable, kindMeta } from './inbox-api';
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
  it('0 空 / 1-2 轻 / 3-5 中 / 6-9 高 / ≥10 峰', () => {
    expect(heatLevel(-1)).toBe(0);
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(2)).toBe(1);
    expect(heatLevel(3)).toBe(2);
    expect(heatLevel(5)).toBe(2);
    expect(heatLevel(6)).toBe(3);
    expect(heatLevel(9)).toBe(3);
    expect(heatLevel(10)).toBe(4);
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
