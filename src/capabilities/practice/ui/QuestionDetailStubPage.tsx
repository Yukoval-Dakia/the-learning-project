// YUK-409 — 题库题详情 /questions/:id（v1 stub）。
//
// **v1 stub**：只渲 prompt_md / choices / reference(参考答案) / kind / difficulty /
// knowledge labels 的简单 Card，避免列表 row-click 落到 404。完整 loom
// docs/design/loom-refresh/project/screen-item-detail.jsx 风格的题详情编辑面
// （可编辑 stem/options、变体家族树、关联状态、删除约束 modal——见 questions.css 的
// 完整 .qd-* / .qb-modal 样式块）= **下一刀**。本 stub 只读，不接 PATCH/DELETE。
//
// 复用既有 getQuestion（GET /api/questions/:id 的富聚合投影；practice-api 的
// QuestionDetail 类型是服务端全投影的兼容子集）。questions.css 同目录已 import（列表面
// 带入），detail 段的 .qd-* 类直接可用。

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import './questions.css';

import { type QuestionDetail, getQuestion } from './practice-api';

// 题型 label（对照 QuestionsPage QKIND；stub 只需 label + icon）。
const QKIND: Record<string, { label: string; icon: LoomIconName }> = {
  choice: { label: '选择', icon: 'list' },
  true_false: { label: '判断', icon: 'check' },
  fill_blank: { label: '填空', icon: 'hash' },
  short_answer: { label: '简答', icon: 'pencil' },
  essay: { label: '论述', icon: 'doc' },
  computation: { label: '计算', icon: 'hash' },
  reading: { label: '阅读', icon: 'book' },
  translation: { label: '翻译', icon: 'book' },
  derivation: { label: '推导', icon: 'fx' },
};
function kindMeta(kind: string) {
  return QKIND[kind] ?? { label: '题', icon: 'quiz' as LoomIconName };
}

function DiffPips({ d }: { d: number }) {
  const tone = d <= 2 ? 'good' : d === 3 ? 'hard' : 'again';
  return (
    <span className="qb-diff" title={`难度 ${d}`}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`qb-pip${i <= d ? ` on tone-${tone}` : ''}`} />
        ))}
      </span>
    </span>
  );
}

function DetailBody({ d }: { d: QuestionDetail }) {
  const k = kindMeta(d.kind);
  return (
    <>
      <div className="qd-sec">
        <div className="qd-sec-h">
          <LoomIcon name="quiz" size={13} />
          题面 prompt_md
        </div>
        <div className="qd-preview">
          <MathMarkdown notation="latex" className="q-md">
            {d.prompt_md}
          </MathMarkdown>
        </div>
      </div>

      {d.choices_md && d.choices_md.length > 0 && (
        <div className="qd-sec">
          <div className="qd-sec-h">
            <LoomIcon name="list" size={13} />
            选项 options
          </div>
          <div className="qd-opts">
            {d.choices_md.map((opt, i) => (
              // 选项无稳定 id（定序文本串），A/B/C/D 行号即语义；stub 不标正确项
              // （detail 投影不含 answer key 对照，同 DraftReviewPage 取舍）。
              // biome-ignore lint/suspicious/noArrayIndexKey: choices 是定序文本串、无稳定 id
              <div key={i} className="qd-opt">
                <span className="qd-opt-key">{String.fromCharCode(65 + i)}</span>
                <span className="qd-opt-text">
                  <MathMarkdown notation="latex">{opt}</MathMarkdown>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="qd-sec">
        <div className="qd-sec-h">
          <LoomIcon name="check" size={13} />
          参考答案 reference_md
        </div>
        {d.reference_md ? (
          <div className="qd-answer">
            <MathMarkdown notation="latex" className="q-md">
              {d.reference_md}
            </MathMarkdown>
          </div>
        ) : (
          <div className="qd-figure">
            <LoomIcon name="alert" size={16} />
            <span className="qd-figure-cap">本题暂无参考答案</span>
          </div>
        )}
      </div>

      <div className="qd-sec">
        <div className="qd-sec-h">
          <LoomIcon name="tag" size={13} />
          题型 · 难度 · 知识点
        </div>
        <div className="qd-head-meta">
          <span className="qb-kind">
            <LoomIcon name={k.icon} size={13} />
            {k.label}
          </span>
          <DiffPips d={d.difficulty} />
          {d.labels.map((l) => (
            <span key={l.id} className="qb-ktag">
              <LoomIcon name="tag" size={11} />
              {l.name}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

export interface QuestionDetailStubPageProps {
  id: string;
  navigate: (to: string) => void;
}

export default function QuestionDetailStubPage({ id, navigate }: QuestionDetailStubPageProps) {
  const detailQ = useQuery({
    queryKey: ['question-detail', id],
    queryFn: () => getQuestion(id),
  });

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">QUESTION · {id} · v1 stub（只读）</div>
        <div className="page-head-row">
          <h1 className="page-title serif">题目详情</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="arrowL" onClick={() => navigate('/questions')}>
              返回题库
            </Btn>
          </div>
        </div>
      </div>

      {detailQ.isError ? (
        <Card pad="lg">
          <EmptyState
            icon="alert"
            title="题目加载失败"
            text={(detailQ.error as Error)?.message ?? '该题不存在或已被归档。'}
            action={
              <Btn variant="secondary" icon="arrowL" onClick={() => navigate('/questions')}>
                返回题库
              </Btn>
            }
          />
        </Card>
      ) : detailQ.isLoading || !detailQ.data ? (
        <Card pad="default">
          <SkLines rows={5} />
        </Card>
      ) : (
        <Card pad="lg">
          <DetailBody d={detailQ.data} />
          <div className="qd-figure" style={{ marginTop: 'var(--s-4)' }}>
            <LoomIcon name="sparkle" size={16} />
            <div>
              <div className="qd-figure-cap">这是 v1 题详情占位</div>
              <div className="qd-figure-sub">
                完整 loom 题详情编辑面（可编辑 stem/options · 变体家族树 · 关联状态 · 删除约束）=
                下一刀
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
