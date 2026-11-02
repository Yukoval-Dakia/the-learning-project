import { useState } from 'react';
import { makeLookup } from '@/ui/lib/makeLookup';
import { openCopilot } from '@/ui/lib/use-copilot-dwell';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import {
  PracticeQueue,
  PracticeQueueState,
  type QueueRow,
} from '@/ui-next/practice-studio/PracticeQueue';

import type { PfToast } from './PracticeFacePage';
import type { StreamItem, StreamSource, StreamStatus, StreamView } from './practice-api';
import { usePracticeClient } from './practice-client';

type SrcMeta = { label: string; tone: string; icon: string };

const SRC_META: Record<StreamSource, SrcMeta> = {
  decay: { label: '到期复习', tone: 'info', icon: 'history' },
  variant: { label: '错题变式', tone: 'again', icon: 'mistakes' },
  new_check: { label: '新学自测', tone: 'good', icon: 'spark2' },
  paper: { label: '打包卷', tone: 'coral', icon: 'layers' },
  on_demand: { label: '点播', tone: 'neutral', icon: 'send' },
  import: { label: '导入', tone: 'neutral', icon: 'record' },
  // YUK-551 — frontier（B3 learnable_frontier 尾）。label '下一步'/icon 'target' 逐字借自已上线
  // 姊妹组件 FrontierRail（knowledge-a5 面,A5 S2/YUK-354）:frontier-tag-next（FrontierRail.tsx
  // renderFrontierBody,:78）+ 头部 target icon（FrontierRail 组件,:102;设计源
  // screen-knowledge-a5.jsx:39）——跨面借用经 owner 批准（2026-07-03,pface 设计源 PFACE_SRC
  // data-pface.jsx:6-13 无 frontier token）。tone 'neutral':唯一既不断言难度也不断言掌握判定的
  // tone（info/good/hard/again 各有判定语义,coral 与 paper 撞色）,与 on_demand/import 共用
  // neutral 有先例;「下一步」的辨识度由 label + target icon 承担。owner 2026-07-03 重裁——初裁
  // 'hard' 的「六态中唯一未占用」前提被 review 证伪（neutral 本就被 on_demand+import 双占,
  // 「唯一性」从不是真约束;而唯一未占用的 hard 是全仓警示琥珀,不宜作中性来源标）。
  frontier: { label: '下一步', tone: 'neutral', icon: 'target' },
  intervention: { label: '干预检验', tone: 'info', icon: 'target' },
};

// 未知 source 防御 fallback（YUK-551）——src/ui/lib/api.ts 的 apiJson 是运行时零校验裸 cast
// （`res.json() as Promise<T>`），源枚举有四份手维护副本无共享 SoT。TS `Record<StreamSource>`
// 穷尽性只保护本文件定义处字面量，对「后端产出 FE 未同步新源」这一失效模式零防护（'frontier'
// 漂移就是活证据）。集中式 accessor（入参 widen 到 string）+ fallback 与既有 srcMeta idiom 同型
// （QuestionsPage/DraftReviewPage/QuestionDetailPage 已各复制一份、待收敛——makeLookup 抽取收敛
// 是 tracked follow-up），并镜像 softmax-selection.ts resolveEnumKind「未知枚举值→安全兜底，
// 绝不 throw」。fallback 三字段逐字对齐三姊妹页的 *_FALLBACK（'其它来源'/neutral/'doc'）。
const SRC_META_FALLBACK: SrcMeta = { label: '其它来源', tone: 'neutral', icon: 'doc' };

// dev-only once-per-source 提醒（YUK-551 review F2）:未知 source 纯静默 fallback 会把「后端已
// 发新源、FE 忘同步」藏进『其它来源』badge——dev 下每个未知值 warn 一次（模块级 Set 去重,
// 不做无门槛 per-render warn）,prod 零噪声。
const warnedSources = new Set<string>();
const lookupSrcMeta = makeLookup(SRC_META as Readonly<Record<string, SrcMeta>>, SRC_META_FALLBACK);

// 所有 SRC_META 访问一律经此（PfSrcBadge + done 行锚点 + 做题页眉）——不再有 bare index。
function srcMeta(source: string): SrcMeta {
  const meta = lookupSrcMeta(source);
  if (meta !== SRC_META_FALLBACK) return meta;
  if (import.meta.env.DEV && !warnedSources.has(source)) {
    warnedSources.add(source);
    console.warn(
      `[PfStream] 未知 stream source '${source}'——已回退『其它来源』badge。若为新增后端源，请同步 practice-api.ts StreamSource 联合 + PfStream SRC_META。`,
    );
  }
  return meta;
}

/** YUK-1473 — the `data-morph` key a stream row's title shares with the question page's title (M4). */
export function practiceMorphKey(itemId: string): string {
  return `pf-item-${itemId}`;
}

/** The source's plain label (e.g. for the practice page's eyebrow). */
export function practiceSourceLabel(source: string): string {
  return srcMeta(source).label;
}

export function PfSrcBadge({ source }: { source: string }) {
  const s = srcMeta(source);
  return (
    <span className={`badge tone-${s.tone}`}>
      <LoomIcon name={s.icon as never} size={12} />
      {s.label}
    </span>
  );
}

const STREAM_VERDICT_META = {
  good: { label: '对', icon: 'check' },
  hard: { label: '部分对', icon: 'minus' },
  again: { label: '错', icon: 'close' },
} as const;

function completedAtLabel(completedAt: string | null): string {
  if (!completedAt) return '已完成';
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return '已完成';
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
  return `${time} 完成`;
}

export function PfStream({
  stream,
  loading,
  error,
  openItem,
  refresh,
  updateItem,
  addToast,
}: {
  stream: StreamView | null;
  loading: boolean;
  error: Error | null;
  openItem: (item: StreamItem) => void;
  refresh: () => Promise<StreamView | null>;
  updateItem: (
    item: StreamItem,
    status: StreamStatus,
    action: string,
    onConfirmed: (confirmed: StreamItem) => void | Promise<void>,
  ) => void | Promise<void>;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const { recomposeStream } = usePracticeClient();
  const [demand, setDemand] = useState('');
  const [recomposing, setRecomposing] = useState(false);

  if (loading) return <PracticeQueueState />;
  if (error) return <PracticeQueueState error={error.message} />;
  if (!stream) return null;

  const scope = stream.scope ?? null;
  const items = stream.items;
  const active = items.filter((it) => it.status !== 'skipped');
  const skipped = items.filter((it) => it.status === 'skipped');
  const pending = items.filter((it) => it.status === 'pending');
  // current = 正在做的那项优先（中途退出回来还在原位），否则第一个待做。
  const currentItem = items.find((it) => it.status === 'in_progress') ?? pending[0] ?? null;
  const allDone = items.length > 0 && stream.progress.done === items.length;
  const etaMin = stream.progress.estimated_remaining_minutes;
  let openingLine = stream.opening_line;
  if (allDone)
    openingLine = scope ? `「${scope.label}」这轮已经完成。` : '都织完了——下面是今天的线头。';
  let progressEta = `预计还剩 ~${etaMin} 分钟`;
  if (allDone) progressEta = scope ? '本轮完成' : '今日完成';
  const emptyTitle = scope ? `「${scope.label}」暂无可练题目` : '今天流里还没有东西';
  const emptyText = scope
    ? '当前题库里没有关联到这个知识点的已发布题目；返回知识页补题或稍后再试。'
    : '录几道题，或让我按当前信号重排一次。';
  const closingLine = scope
    ? `「${scope.label}」这轮题目都完成了。`
    : '今天的线都织完了——回头看哪根还松，随时叫我补。';

  const skip = (it: StreamItem) => {
    void updateItem(it, 'skipped', '跳过练习', async () => {
      await refresh();
    });
  };
  const unskip = (it: StreamItem) => {
    void updateItem(it, 'pending', '恢复练习', async () => {
      await refresh();
    });
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
  const handoffDemand = () => {
    const request = demand.trim();
    if (!request) return;
    // Hand the ask to the Copilot composer only; the learner decides when to send.
    openCopilot(request, { send: false });
    setDemand('');
  };

  const row = (it: StreamItem): QueueRow => {
    const completed = it.status === 'done';
    const isSkipped = it.status === 'skipped';
    const anchor = it.item_kind === 'paper' ? it.paper_title : it.knowledge_name;
    const label = isSkipped
      ? '捡回来'
      : it.item_kind === 'paper'
        ? '进入卷'
        : it.answer_recorded
          ? '已交 · 查看'
          : '开始作答';
    return {
      id: it.id,
      morphKey: practiceMorphKey(it.id),
      title: anchor ?? srcMeta(it.source).label,
      source: srcMeta(it.source).label,
      kind: it.item_kind === 'paper' ? '整卷练习' : '单题练习',
      reason: it.reasoning,
      facts:
        it.item_kind === 'paper' && it.total_slots !== null
          ? `${it.total_slots} 题 · 约 ${it.estimated_minutes} 分钟`
          : null,
      note: it.item_kind === 'paper' ? '交卷后统一判分 · 卷内无即时反馈' : null,
      current: currentItem?.id === it.id,
      completed,
      completion: completed ? completedAtLabel(it.completed_at) : null,
      verdict: it.verdict ? STREAM_VERDICT_META[it.verdict].label : null,
      action: completed
        ? null
        : {
            label,
            run: () => {
              if (isSkipped) unskip(it);
              else openItem(it);
            },
          },
      skip:
        !isSkipped && it.status === 'pending' && it.source !== 'intervention'
          ? () => skip(it)
          : null,
    };
  };

  return (
    <PracticeQueue
      opening={openingLine}
      context={`${scope ? `知识点专项 · ${scope.label}` : '今日练习'} · ${stream.date} · 预算 ${stream.budget.minutes} 分钟`}
      done={stream.progress.done}
      total={stream.progress.total}
      remaining={progressEta}
      active={active.map(row)}
      skipped={skipped.map(row)}
      emptyTitle={emptyTitle}
      emptyText={emptyText}
      closing={allDone ? closingLine : null}
      recompose={scope ? null : { busy: recomposing, run: () => void recompose() }}
      demand={scope ? null : { value: demand, change: setDemand, handoff: handoffDemand }}
    />
  );
}
