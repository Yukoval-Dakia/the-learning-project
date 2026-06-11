// M3 笔记面 — 块编辑器（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/note-editor.jsx：每块 gutter
//（grip 拖拽重排 + plus 斜杠菜单）+ 块内容编辑。落地映射（pre-flight B 偏离②）：
// 设计稿扁平块 ↔ 真实 semanticBlock 文档——编辑器把 doc.content 当块列表，
// 文本块编辑 source_markdown。斜杠菜单 = 4 个 semantic kind + 交叉链 + 题目
// 引用（用户增量）——**quiz 内嵌测验已剔除（D6）**。atom 块（crossLink/
// questionRef/check 墓碑）不可嵌套编辑，整块删除/移动。
// 保存由宿主（NoteReaderPage）发 PATCH body-blocks 乐观锁。

import { Btn } from '@/ui/primitives/Btn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';

import { NoteBlockView, QuestionPicker } from './NoteBlocks';
import {
  type BodyBlock,
  type NotePageLabel,
  SEMANTIC_KIND_LABEL,
  type SemanticKind,
  searchArtifacts,
} from './notes-api';

let blockSeq = 0;
function newBlockId(): string {
  blockSeq += 1;
  return `nb_${Date.now().toString(36)}_${blockSeq}`;
}

function makeSemanticBlock(kind: Exclude<SemanticKind, 'check'>): BodyBlock {
  const text = '';
  return {
    type: 'semanticBlock',
    attrs: {
      id: newBlockId(),
      semantic_kind: kind,
      source_tier: 'user',
      user_verified: false,
      version: 1,
      source_markdown: text,
    },
    content: [{ type: 'paragraph', content: [] }],
  };
}

// 文本同步进 content 段落（server 的 bodyBlocksToNoteSections 读 content 文本，
// source_markdown 是镜像源——两处一起写保持一致）。
function withText(b: BodyBlock, text: string): BodyBlock {
  return {
    ...b,
    attrs: { ...b.attrs, source_markdown: text },
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

function ArtifactPicker({
  excludeId,
  onPick,
  onClose,
}: {
  excludeId: string;
  onPick: (a: { id: string; title: string; type: string }) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Array<{ id: string; title: string; type: string }>>([]);
  return (
    <div className="slash-menu fade-key" style={{ maxHeight: 280, overflowY: 'auto' }}>
      <div className="slash-head meta">交叉链 · 搜索笔记/学习项</div>
      <input
        className="input"
        style={{ margin: '4px 8px', width: 'calc(100% - 16px)' }}
        value={q}
        placeholder="标题关键词…"
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          if (v.trim().length >= 1) {
            void searchArtifacts(v.trim(), excludeId).then((r) => setRows(r.rows));
          } else {
            setRows([]);
          }
        }}
      />
      {rows.map((a) => (
        <button type="button" key={a.id} className="slash-item" onClick={() => onPick(a)}>
          <LoomIcon name="link" size={14} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.title}
          </span>
          <span className="mono slash-key">{a.type}</span>
        </button>
      ))}
      <button type="button" className="slash-item" onClick={onClose}>
        <LoomIcon name="close" size={13} />
        <span>取消</span>
      </button>
    </div>
  );
}

export function NoteEditor({
  blocks,
  labels,
  noteId,
  onChange,
}: {
  blocks: BodyBlock[];
  labels: NotePageLabel[];
  noteId: string;
  onChange: (next: BodyBlock[]) => void;
}) {
  const [slashAt, setSlashAt] = useState<number | null>(null);
  const [picker, setPicker] = useState<'none' | 'xlink' | 'question'>('none');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const insertAt = (i: number, b: BodyBlock) => {
    onChange([...blocks.slice(0, i + 1), b, ...blocks.slice(i + 1)]);
    setSlashAt(null);
    setPicker('none');
  };
  const removeAt = (i: number) => {
    onChange(blocks.filter((_, j) => j !== i));
  };
  const onDrop = (i: number) => {
    if (dragIdx == null || dragIdx === i) {
      setDragIdx(null);
      setOverIdx(null);
      return;
    }
    const a = [...blocks];
    const [m] = a.splice(dragIdx, 1);
    a.splice(i, 0, m);
    onChange(a);
    setDragIdx(null);
    setOverIdx(null);
  };

  const SLASH_KINDS = Object.entries(SEMANTIC_KIND_LABEL) as Array<
    [Exclude<SemanticKind, 'check'>, string]
  >;

  return (
    <div className="note-editor">
      {blocks.map((b, i) => {
        const isAtom =
          b.type === 'crossLinkBlock' ||
          b.type === 'questionRefBlock' ||
          b.attrs?.semantic_kind === 'check';
        return (
          <div
            key={b.attrs?.id ?? `${b.type}-${i}`}
            className={`nb-wrap${overIdx === i ? ' is-over' : ''}${dragIdx === i ? ' is-dragging' : ''}`}
            onDragOver={(e) => {
              if (dragIdx != null) {
                e.preventDefault();
                setOverIdx(i);
              }
            }}
            onDrop={() => onDrop(i)}
          >
            <div className="nb-gutter">
              <button
                type="button"
                className="nb-grip"
                draggable
                title="拖拽重排"
                onDragStart={() => setDragIdx(i)}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
              >
                <LoomIcon name="grip" size={14} />
              </button>
              <button
                type="button"
                className="nb-plus"
                title="插入块 (/)"
                onClick={() => {
                  setSlashAt(slashAt === i ? null : i);
                  setPicker('none');
                }}
              >
                <LoomIcon name="slash" size={13} />
              </button>
              <button type="button" className="nb-plus" title="删除块" onClick={() => removeAt(i)}>
                <LoomIcon name="trash" size={13} />
              </button>
            </div>
            <div className="nb-content">
              {isAtom ? (
                <NoteBlockView block={b} />
              ) : (
                <div className={`nb-sem nb-sem-${b.attrs?.semantic_kind ?? 'plain'}`}>
                  {b.attrs?.semantic_kind && b.attrs.semantic_kind !== 'check' && (
                    <span className="nb-sem-tag mono">
                      {SEMANTIC_KIND_LABEL[b.attrs.semantic_kind]}
                    </span>
                  )}
                  <textarea
                    className="nb-edit-area"
                    rows={Math.max(2, (b.attrs?.source_markdown ?? '').split('\n').length)}
                    value={b.attrs?.source_markdown ?? ''}
                    placeholder="写点什么…"
                    onChange={(e) => {
                      const next = [...blocks];
                      next[i] = withText(b, e.target.value);
                      onChange(next);
                    }}
                  />
                </div>
              )}
            </div>
            {slashAt === i && picker === 'none' && (
              <div className="slash-menu fade-key">
                <div className="slash-head meta">插入块</div>
                {SLASH_KINDS.map(([kind, label]) => (
                  <button
                    type="button"
                    key={kind}
                    className="slash-item"
                    onClick={() => insertAt(i, makeSemanticBlock(kind))}
                  >
                    <LoomIcon name="doc" size={15} />
                    <span>{label}</span>
                    <span className="mono slash-key">/{kind}</span>
                  </button>
                ))}
                <button type="button" className="slash-item" onClick={() => setPicker('xlink')}>
                  <LoomIcon name="link" size={15} />
                  <span>交叉链</span>
                  <span className="mono slash-key">@artifact</span>
                </button>
                <button type="button" className="slash-item" onClick={() => setPicker('question')}>
                  <LoomIcon name="quiz" size={15} />
                  <span>引用题目</span>
                  <span className="mono slash-key">@question</span>
                </button>
                {/* D6：quiz 内嵌测验块型已裁撤，不提供插入入口。 */}
                <div className="slash-foot meta">
                  <LoomIcon name="link" size={11} /> 引用是纯链接——作答永远发生在练习面
                </div>
              </div>
            )}
            {slashAt === i && picker === 'xlink' && (
              <ArtifactPicker
                excludeId={noteId}
                onClose={() => setPicker('none')}
                onPick={(a) =>
                  insertAt(i, {
                    type: 'crossLinkBlock',
                    attrs: {
                      id: newBlockId(),
                      target: { artifact_id: a.id, kind: a.type },
                      label: a.title,
                    },
                  })
                }
              />
            )}
            {slashAt === i && picker === 'question' && (
              <QuestionPicker
                knowledgeIds={labels.map((l) => l.id)}
                onClose={() => setPicker('none')}
                onPick={(q) =>
                  insertAt(i, {
                    type: 'questionRefBlock',
                    attrs: {
                      id: newBlockId(),
                      question_id: q.id,
                      prompt_preview: q.prompt_md.slice(0, 120),
                    },
                  })
                }
              />
            )}
          </div>
        );
      })}
      <Btn
        size="sm"
        variant="ghost"
        icon="plus"
        onClick={() => setSlashAt(blocks.length - 1)}
        style={{ marginTop: 'var(--s-2)' }}
      >
        添加块
      </Btn>
    </div>
  );
}
