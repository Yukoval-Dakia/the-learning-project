// YUK-340 — dock 对话语言回手稿（copy layer）。The design truth source for the
// dock conversation wording is docs/design/loom-refresh/project/copilot.jsx
// (CopilotDrawer): the AI speaks as 「编排者」 in first person, and the blank
// thread opens with the manuscript-voice cop-blank copy (L135-141). This test
// pins the shipped copy to that source at the source-text level (same idiom as
// CopilotDock.a11y.unit.test.ts — a full Dock render drags stores/SSE wiring).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CopilotDock conversation voice (YUK-340)', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
    'utf8',
  );

  it('names the AI voice 编排者 everywhere a msg-name renders (copilot.jsx L36)', () => {
    expect(source).toContain("m.role === 'ai' ? '编排者' : '我'");
    expect(source).not.toContain("'Loom Copilot'");
  });

  it('titles the drawer with the persona name, not the product name (copilot.jsx L125)', () => {
    const drawerMount = source.slice(
      source.indexOf('<CopilotDrawer'),
      source.indexOf('headBadge='),
    );
    expect(drawerMount).toContain('title="编排者"');
  });

  it('opens an empty thread with the design cop-blank copy verbatim (copilot.jsx L135-141)', () => {
    const emptyMarker = source.indexOf('className="chat-empty"');
    const emptyBlock = source.slice(emptyMarker - 200, emptyMarker + 700).replace(/\s+/g, ' ');
    expect(emptyBlock).toContain('我是你的编排者');
    expect(emptyBlock).toContain(
      '前台和昨夜后台的我是同一个 —— 我能引用它为你备的东西。问我今天该学什么、为什么这么排，或让我改动；每一句话我都给你一份可留可撤的改动。',
    );
    // The drifted third-person IM line is gone.
    expect(source).not.toContain('它会读你的错题、知识图谱与今日计划来回答');
  });

  it('does not advertise the unimplemented @-mention affordance in the composer placeholder', () => {
    // Design placeholder is 「问 Loom 任何事，或 @ 一个知识节点…」, but the dock has
    // no @-mention path; promising it would be false copy (YUK-340 recorded fork).
    const composerMarker = source.indexOf('data-testid="copilot-composer-input"');
    const composerTag = source.slice(composerMarker - 260, composerMarker + 40);
    expect(composerTag).toContain('placeholder="问 Loom 任何事…"');
    expect(composerTag).not.toContain('@ 一个知识节点');
  });
});
