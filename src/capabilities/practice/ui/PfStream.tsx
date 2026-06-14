// M2 练习面 — 流视图（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-stream.jsx：§6.1 织线纵轨——
// item 挂在线上、AI 开场白与第一人称理由陪练递题、已完成项收紧成织入的一行；
// 跳过的留流尾可捡回；流尾点播 composer。点播生成（quiz-gen 异步链）M2 后端
// 未接——composer 提交后 toast 告知（占位，M4 夜链/quiz 域接上后变真）。

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';

import type { PfToast } from './PracticeFacePage';
import {
  type StreamItem,
  type StreamSource,
  type StreamView,
  advanceStreamItem,
  recomposeStream,
} from './practice-api';

const SRC_META: Record<StreamSource, { label: string; tone: string; icon: string }> = {
  decay: { label: '衰减复习', tone: 'info', icon: 'history' },
  variant: { label: '错题变式', tone: 'again', icon: 'mistakes' },
  new_check: { label: '新学自测', tone: 'good', icon: 'spark2' },
  paper: { label: '打包卷', tone: 'coral', icon: 'layers' },
  on_demand: { label: '点播', tone: 'neutral', icon: 'send' },
  import: { label: '导入', tone: 'neutral', icon: 'record' },
};

export function PfSrcBadge({ source }: { source: StreamSource }) {
  const s = SRC_META[source];
  return (
    <span className={`badge tone-${s.tone}`}>
      <LoomIcon name={s.icon as never} size={12} />
      {s.label}
    </span>
  );
}

// pf-item-kp / pf-paper-title 锚点名（设计 pface.css L52/67：「每张卡有自己的名字」）。
// 数据真相：composer（stream-composer.ts）把 knowledgeLabel / paper title 织进 reasoning
// 模板（`「${label}」`），但 StreamItem wire（stream-store.ts StreamView）未把它持久化为
// 独立字段——故这里从 reasoning 提取首个 `「…」` 作锚点（真实数据派生，非 fabricate）。
// 无 label 时 composer 回退到「这一块」(kpSuffix)，此情形不显示锚点（避免伪锚）。
// FOLLOW-UP（phase-deferred）：理想是 stream item wire 直供 knowledge_name / paper title
// 独立字段，去掉此处对 reasoning 文案格式的耦合——见交付报告缺失字段清单。
function anchorFromReasoning(reasoning: string): string | null {
  const m = reasoning.match(/「([^」]+)」/);
  if (!m) return null;
  const name = m[1].trim();
  return name && name !== '这一块' ? name : null;
}

export function PfStream({
  stream,
  loading,
  error,
  openItem,
  refresh,
  addToast,
}: {
  stream: StreamView | null;
  loading: boolean;
  error: Error | null;
  openItem: (item: StreamItem) => void;
  refresh: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const [demand, setDemand] = useState('');
  const [recomposing, setRecomposing] = useState(false);

  if (loading) return <p className="quiet-empty">正在编排今天的流…</p>;
  if (error) return <p className="quiet-empty">流加载失败：{error.message}</p>;
  if (!stream) return null;

  const items = stream.items;
  const active = items.filter((it) => it.status !== 'skipped');
  const skipped = items.filter((it) => it.status === 'skipped');
  const pending = items.filter((it) => it.status === 'pending');
  // current = 正在做的那项优先（中途退出回来还在原位），否则第一个待做。
  const currentItem = items.find((it) => it.status === 'in_progress') ?? pending[0] ?? null;
  const allDone = items.length > 0 && stream.progress.done === items.length;
  const etaMin = pending.reduce((m, it) => m + (it.item_kind === 'paper' ? 10 : 2), 0);

  const skip = async (it: StreamItem) => {
    await advanceStreamItem(it.id, 'skipped').catch(() => {});
    refresh();
  };
  const unskip = async (it: StreamItem) => {
    await advanceStreamItem(it.id, 'pending').catch(() => {});
    refresh();
  };
  const recompose = async () => {
    setRecomposing(true);
    try {
      const r = await recomposeStream();
      addToast(r.added > 0 ? `我重排了今天的流——新进 ${r.added} 项。` : '看过一轮，没有要补的。');
      refresh();
    } catch (e) {
      addToast(`重排失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setRecomposing(false);
    }
  };

  const row = (it: StreamItem) => {
    const isCur = currentItem?.id === it.id;
    const cls = [
      'pf-row',
      `kind-${it.item_kind === 'paper' ? 'paper' : 'question'}`,
      it.status === 'done'
        ? 'is-done'
        : it.status === 'skipped'
          ? 'is-skipped'
          : isCur
            ? 'is-current'
            : 'is-pending',
    ].join(' ');

    if (it.status === 'done') {
      // done 织入行（设计 pface-stream.jsx L40-52 / pface.css L72-74）：badge + 锚点名 +
      // verdict 三色 badge + 完成时刻。锚点名优先用 reasoning 提取的知识点名/卷标题，
      // 回退到 source label（PfSrcBadge 已显示来源，此处给可读名）。
      // FOLLOW-UP（phase-deferred）：verdict（again/hard/good，设计 color-is-judgment）与
      // 完成时刻（pf-done-at）在 review event 侧，StreamItem wire 未 join——故暂不渲染
      // verdict 三色 badge，完成时刻显示静态「已完成」。补 wire 字段后接真值，见报告。
      const doneAnchor = anchorFromReasoning(it.reasoning) ?? SRC_META[it.source].label;
      return (
        <div key={it.id} className={cls}>
          <span className="pf-node" />
          <div className="pf-done">
            <PfSrcBadge source={it.source} />
            <span className="pf-done-kp">{doneAnchor}</span>
            <span className="pf-done-at">已完成</span>
          </div>
        </div>
      );
    }

    const isSkipped = it.status === 'skipped';
    // 散题/卷卡的可读锚点名（reasoning 派生，见 anchorFromReasoning 注释）。
    const anchor = anchorFromReasoning(it.reasoning);
    const inner = (
      <div
        className="pf-item"
        // biome-ignore lint/a11y/useSemanticElements: 行卡片内嵌套了真按钮
        // （CTA + 跳过），native <button> 不允许嵌套交互元素；div+role 是
        // 可聚焦容器的正确 ARIA 形态。
        role="button"
        tabIndex={0}
        onClick={() => openItem(it)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openItem(it);
        }}
      >
        <div className="pf-item-top">
          <PfSrcBadge source={it.source} />
          {/* 散题卡知识点锚点（设计 pface.css L52 pf-item-kp，15px/600）——给每张卡
              「自己的名字」。锚点名来源见 anchorFromReasoning 注释（reasoning 派生，
              非 fabricate；无 label 时省略，不伪造锚点）。 */}
          {it.item_kind === 'question' && anchor && <span className="pf-item-kp">{anchor}</span>}
          <span className="pf-item-kind mono">
            <span className="src-q">
              {it.item_kind} · {it.ref_id.slice(0, 12)}
            </span>
          </span>
        </div>
        {it.item_kind === 'paper' && (
          <>
            {/* 卷卡 serif 标题 + facts 行（设计 pface.css L67-68 / pface-stream.jsx L71-77）。
                标题取 reasoning 里的卷名（composer 真实注入的「${p.title}」）。
                FOLLOW-UP（phase-deferred）：facts「N 题 · 约 X 分钟」需题数/估时——paper
                stream item wire 仅 ref_id，未带 total_slots/est（getPapers 才有 total_slots，
                但流不 join 卷读模型）；故 facts 行暂不渲染，不伪造题数。补 wire 字段后接真值。 */}
            {anchor && <div className="pf-paper-title">{anchor}</div>}
            <span className="pf-paper-note">
              <LoomIcon name="clock" size={12} />
              交卷后统一判分 · 卷内无即时反馈
            </span>
          </>
        )}
        <div className="pf-reason">
          <LoomIcon name="sparkle" size={13} className="ico" />
          <span>{it.reasoning}</span>
        </div>
        <div className="pf-item-cta">
          <Btn
            size="sm"
            variant={
              isCur
                ? 'primary'
                : isSkipped
                  ? 'ghost'
                  : it.item_kind === 'paper'
                    ? 'secondary'
                    : 'ghost'
            }
            icon={isSkipped ? 'undo' : it.item_kind === 'paper' ? 'layers' : 'pencil'}
            onClick={(e) => {
              e.stopPropagation();
              if (isSkipped) void unskip(it);
              else openItem(it);
            }}
          >
            {isSkipped ? '捡回来' : it.item_kind === 'paper' ? '进入卷' : '开始作答'}
          </Btn>
          {!isSkipped && it.status === 'pending' && (
            <button
              type="button"
              className="pf-skip"
              onClick={(e) => {
                e.stopPropagation();
                void skip(it);
              }}
            >
              跳过 · 流尾可回头
            </button>
          )}
        </div>
      </div>
    );

    return (
      <div key={it.id} className={cls}>
        <span className="pf-node" />
        {it.item_kind === 'paper' ? <div className="pf-item-stack">{inner}</div> : inner}
      </div>
    );
  };

  return (
    <div className="pface">
      <div className="pf-open">
        <span className="pf-open-ava">
          <LoomIcon name="sparkle" size={18} />
        </span>
        <div>
          <p className="pf-open-line">
            {allDone ? '都织完了——下面是今天的线头。' : stream.opening_line}
          </p>
          <span className="pf-open-meta">composer · {stream.date}</span>
        </div>
      </div>

      {items.length > 0 && (
        <div className="pf-prog">
          <span className="pf-prog-n">
            <b className="tnum">{stream.progress.done}</b> / {stream.progress.total}
          </span>
          <div className="bar thin">
            <span style={{ width: `${(stream.progress.done / stream.progress.total) * 100}%` }} />
          </div>
          <span className="pf-prog-eta">{allDone ? '今日完成' : `预计还剩 ~${etaMin} 分钟`}</span>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon="review"
          title="今天流里还没有东西"
          text="录几道题，或让我按当前信号重排一次。"
        />
      ) : (
        <div className="pf-thread">{active.map(row)}</div>
      )}

      {skipped.length > 0 && (
        <>
          <div className="section-label pf-skipped-label">
            <h2 className="serif">跳过的</h2>
            <span className="rule" />
            <span className="count">{skipped.length}</span>
          </div>
          <div className="pf-thread">{skipped.map(row)}</div>
        </>
      )}

      {/* 收尾短结（设计 pface-stream.jsx L155-163 / pface.css L97-100）：今日全部织完后
          在流尾渲一张 good-soft 收尾卡。文案为纯 UI 鼓励性短结（无数据依赖）。
          FOLLOW-UP（phase-deferred）：设计源 meta「coach · 收尾 · $cost」需收尾 agent run
          的成本/时刻——M2 无 closing-line 读模型（opening_line 才有模板），故 meta 用
          中性文案，不伪造成本数字。M4 夜链 AI 化后由 composer 写真值，见报告。 */}
      {allDone && (
        <div className="pf-close" style={{ marginTop: 'var(--s-8)' }}>
          <span className="pf-open-ava">
            <LoomIcon name="checkCircle" size={18} />
          </span>
          <div>
            <p className="pf-close-line">今天的线都织完了——回头看哪根还松，随时叫我补。</p>
            <span className="pf-close-meta">coach · 收尾</span>
          </div>
        </div>
      )}

      <div className="pf-item-cta" style={{ marginTop: 'var(--s-5)' }}>
        <Btn
          size="sm"
          variant="ghost"
          icon="refresh"
          disabled={recomposing}
          onClick={() => void recompose()}
        >
          {recomposing ? '重排中…' : '按当前信号重排'}
        </Btn>
      </div>

      <div className="pf-ondemand">
        <div className="pf-ondemand-label">
          <LoomIcon name="send" size={13} />
          点播 · ON_DEMAND
        </div>
        <div className="composer">
          <textarea
            rows={1}
            value={demand}
            placeholder="向我点播：比如「来份判断句专项卷」"
            onChange={(e) => setDemand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!demand.trim()) return;
                // 点播生成链（quiz-gen 异步）M2 未接——见文件头注。
                addToast(
                  '点播收到——出题链路在 M4 接上后，这里会出现生成中的占位卷。',
                  'info',
                  'clock',
                );
                setDemand('');
              }
            }}
            aria-label="向 AI 点播"
          />
          <IconBtn
            icon="send"
            size={16}
            title="点播"
            onClick={() => {
              if (!demand.trim()) return;
              addToast(
                '点播收到——出题链路在 M4 接上后，这里会出现生成中的占位卷。',
                'info',
                'clock',
              );
              setDemand('');
            }}
          />
        </div>
      </div>
    </div>
  );
}
