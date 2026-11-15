// M3 笔记面 — 只读正文 body（从 NoteReaderPage 提取的同一 renderer，非第二套）。
// 两个 live consumer：完整阅读器（NoteReaderPage）与知识详情页主笔记内嵌预览
//（YUK-1473，设计「主笔记用的就是同一套块渲染（只读）」chat1.md:727-728）。
// 样式依赖 notes-m3e.css 的 [data-ui-next].nt-page 作用域：宿主须把本组件放进
// 一个带 .nt-page 的 UiNextRoot（内嵌时加 data-note-embed 抵消 reader 版心）。

import { ChevronRight, Link } from 'lucide-react';
import { useState } from 'react';
import { InteractiveArtifactRenderer } from '@/ui/components/InteractiveArtifactRenderer';
import './notes-m3e.css';

import { NoteBlockView } from './NoteBlocks';
import { type BodyBlock, SEMANTIC_KIND_LABEL, type SemanticKind } from './notes-api';

export type NoteBodyBlock = BodyBlock;

export interface NoteDocBodyProps {
  type: string;
  title: string;
  interactive: { html: string } | null;
  blocks: NoteBodyBlock[];
  navigate: (to: string) => void;
  onOpenQuestion: (questionId: string) => void;
}

// YUK-339 — 块锚点深链（设计源 NoteReaderBody anchor()，screen-note-reader.jsx:36-40）。
// hash-only pushState：地址栏变为可分享的 #nb-<blockId>（保留 ?entry= 入口上下文），
// 不触发 router 导航也不引发原生锚点瞬跳；滚动交给 scrollIntoView + notes-m3e.css
// .nt-blk 的 scroll-margin-top(84px)（与设计源 scrollTop-84 同源，无 JS 硬编码）。
function jumpToBlockAnchor(anchorId: string) {
  window.history.pushState(null, '', `#${anchorId}`);
  document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth' });
}

// 每块发 nt-blk-{type} 类；非 section 块型映射到同语义短类。section 块固定
// .nt-blk-section（notes-m3e.css 的 gutter 常亮规则锚定它）。
const BLOCK_KIND_CLASS: Record<string, string> = {
  semanticBlock: 'nt-blk-plain',
  crossLinkBlock: 'nt-blk-cross',
  questionRefBlock: 'nt-blk-qref',
};

// 小节标题：semanticBlock 的 kind 标签（按维度成段的笔记才有，与
// bodyBlocksToNoteSections 1:1）。check 是不判分的自解释小节；kind 缺失/未知回退普通块。
function sectionKindLabel(b: BodyBlock): string | null {
  if (b.type !== 'semanticBlock') return null;
  const kind = b.attrs?.semantic_kind;
  if (typeof kind !== 'string') return null;
  return SEMANTIC_KIND_LABEL[kind as SemanticKind] ?? null;
}

// ADR-0033 D5 — read-mode doc body. Pure presentational (no queries/state) so it
// is renderToString-testable on the node-only unit stack (AutoEnrolledPanel
// PanelBody precedent). Three render modes:
//   • type='interactive' + interactive non-null → sandboxed renderer (the
//     interactive artifact's body_blocks is always null, so it never reaches the
//     block branch).
//   • type='interactive' + interactive null → parse-fail degraded notice (the
//     server loaded the row but attrs.html failed its schema barrier; the page
//     still shows title/labels chrome instead of 404ing).
//   • note types → block list, or the empty-note prompt.
export function NoteDocBody({
  type,
  title,
  interactive,
  blocks,
  navigate,
  onOpenQuestion,
}: NoteDocBodyProps) {
  // YUK-339：section 折叠态（blockId → collapsed）。hook 必须在 interactive 早退
  // 分支之前——组件实例的 type 稳定，但 React 规则禁止条件调用 hook。初始渲染在
  // renderToString 下照常工作，ADR-0033 D5 的静态 HTML 测试不受影响。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = (blockId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  if (type === 'interactive') {
    if (interactive) {
      return (
        <div className="nt-doc">
          <InteractiveArtifactRenderer html={interactive.html} title={title} />
        </div>
      );
    }
    return (
      <div className="nt-doc">
        <p className="nt-quiet">互动内容暂时无法渲染——这篇产物的内容未通过校验，已记录待修复。</p>
      </div>
    );
  }

  // S12 (YUK-335)：read 态正文用 .nt-body（17px 阅读字号）+
  // NoteBlockView variant="read"（crossLink 渲整宽链接卡）。interactive 分支走 .nt-doc。
  // YUK-339：note-types 分支 Notion 化（设计源 NoteReaderBody，
  // screen-note-reader.jsx:46-69）——每块 .nt-blk（28px gutter 网格）+
  // .nt-blk-gutter 手柄（section 折叠 / 非 section 锚点）+ .nt-blk-content；section =
  // semanticBlock 小节（标题 h2.nt-blk-h，折叠隐体留标题）。已如下偏离设计源
  // 并在 PR 记录：锚点 id 沿用既有 nb-<blockId|index> 方案（outline 同源，非设计
  // 的 nb-anchor- 前缀）；锚点按钮做深链（hash + 滚动），不做剪贴板复制；生产无
  // b.link 链接行语义（crossLink 整块即链接卡，YUK-541），不引链接行。
  return (
    <div className="nt-body">
      {blocks.length === 0 && <p className="nt-quiet">空笔记——切到编辑写第一块。</p>}
      {blocks.map((b, i) => {
        const anchorId = `nb-${b.attrs?.id ?? i}`;
        const blockKey = b.attrs?.id ?? String(i);
        const sectionLabel = sectionKindLabel(b);
        const isSection = sectionLabel !== null;
        const isCollapsed = collapsed.has(blockKey);
        return (
          <div
            key={blockKey}
            id={anchorId}
            className={
              isSection
                ? 'nt-blk nt-blk-section'
                : `nt-blk ${BLOCK_KIND_CLASS[b.type] ?? 'nt-blk-plain'}`
            }
          >
            <div className="nt-blk-gutter">
              {isSection ? (
                <button
                  type="button"
                  className="nt-blk-btn nt-blk-collapse"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed ? `展开「${sectionLabel}」小节` : `折叠「${sectionLabel}」小节`
                  }
                  onClick={() => toggleSection(blockKey)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="nt-blk-btn"
                  title="锚点链接"
                  aria-label="锚点链接：更新地址栏并直达此块"
                  onClick={() => jumpToBlockAnchor(anchorId)}
                >
                  <Link size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="nt-blk-content">
              {isSection && <h2 className="nt-blk-h">{sectionLabel}</h2>}
              {(!isSection || !isCollapsed) && (
                <NoteBlockView
                  block={b}
                  variant="read"
                  onLink={(artifactId) => navigate(`/notes/${artifactId}`)}
                  onOpenQuestion={onOpenQuestion}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
