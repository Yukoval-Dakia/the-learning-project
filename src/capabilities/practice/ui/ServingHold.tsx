// YUK-1514 — 「暂不出题」的共用界面：原因白话、等待时长、唯一的操作按钮。
// 题库总览（QuestionsPage）和题目详情（QuestionDetailPage）两处共用，别处不用。
//
// 只看后端给的 serving：
//   • 按钮只由 next_action 决定（哪个原因给哪个按钮由后端定，前端不写死）；
//   • pending_action 不为空 → 按钮禁用，显示「已提交，正在排队」；
//   • 不认识的原因、或 hold_reason 为 null（含从没发布过的老题）→ 统一「暂不出题」。
// 命令幂等键：一次点击在事件处理里生成一个；网络失败的自动重试沿用同一个（react-query
// 的 retry 复用同一组 variables），新的一次点击才换新键。后端按键去重，同一次点击最多付费一次。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, type ApiOperationParameters, apiOperationJson } from '@/ui/lib/api';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Btn } from '@/ui/primitives/Btn';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import type { QBankListResult, QBankQuestion, QuestionFullDetail } from './practice-api';

export type QuestionServing = QBankQuestion['serving'];
export type ServingCounts = NonNullable<QBankListResult['serving_counts']>;
type ServingCommand = ApiOperationParameters<'runQuestionServingAction'>['path']['command'];
type HoldReason = NonNullable<QuestionServing['hold_reason']>;

interface HoldCopy {
  /** Badge 上的短标签。 */
  label: string;
  /** 详情页的一句白话解释。 */
  explain: string;
  /** 没有按钮、也不在排队时补的一句指引（只在 next_action 为空时出现）。 */
  noActionHint?: string;
  tone: BadgeTone;
  icon: LoomIconName;
}

const HOLD_COPY: Record<HoldReason, HoldCopy> = {
  awaiting_admission: {
    label: '还在检查',
    explain: '这道题刚加入题库，还在检查能不能准确判分，检查完就会出给你。',
    noActionHint: '检查还在进行，过一会儿再来看。',
    tone: 'info',
    icon: 'clock',
  },
  admission_failed: {
    label: '检查没通过',
    explain: '检查时发现这道题现在还没法准确判分，所以先不出给你。',
    noActionHint: '题目内容没有变，再检查一次结果也一样。请先修改题目并保存，保存后会重新检查。',
    tone: 'again',
    icon: 'alert',
  },
  source_check_failed: {
    label: '来源没确认',
    explain: '这道题的出处还没能确认，确认之前先不出给你。',
    tone: 'hard',
    icon: 'link',
  },
  verify_hold: {
    label: '暂停待复核',
    explain: '这道题被暂停了，复核之后才会再出给你。',
    tone: 'hard',
    icon: 'eye',
  },
  retraction_hold: {
    label: '正在撤回',
    explain: '这道题正在撤回，撤回期间不会出给你。',
    tone: 'neutral',
    icon: 'archive',
  },
  no_input_renderer: {
    label: '暂时没法作答',
    explain: '这道题要求的作答方式，页面暂时还显示不了，所以先不出给你。',
    tone: 'neutral',
    icon: 'pencil',
  },
  invalid_presentation: {
    label: '题面显示有问题',
    explain: '这道题用来显示的数据有损坏，页面没法正常展示，所以先不出给你。',
    noActionHint: '修改题目并保存后会重新检查。',
    tone: 'again',
    icon: 'alert',
  },
  withdrawn: {
    label: '已撤回',
    explain: '这道题已经撤回，不会再出给你。',
    tone: 'neutral',
    icon: 'archive',
  },
};

const UNKNOWN_COPY: HoldCopy = {
  label: '暂不出题',
  explain: '这道题暂时不会出给你。',
  tone: 'neutral',
  icon: 'lock',
};

const COMMAND_LABEL: Record<ServingCommand, string> = {
  reverify: '重新核验',
  recheck_source: '重新检查来源',
  release_verify_hold: '恢复出题',
};

const PENDING_LABEL = '已提交，正在排队';

export function holdCopy(reason: string | null): HoldCopy {
  return reason != null && Object.hasOwn(HOLD_COPY, reason)
    ? HOLD_COPY[reason as HoldReason]
    : UNKNOWN_COPY;
}

/** 「已等待 X 小时」；满 48 小时改用天。nowMs 由调用方传入（取数据拿到的时间），渲染保持纯。 */
export function waitedLabel(heldSince: string | null, nowMs: number): string | null {
  if (heldSince == null) return null;
  const since = Date.parse(heldSince);
  if (Number.isNaN(since)) return null;
  const hours = Math.floor(Math.max(0, nowMs - since) / 3_600_000);
  if (hours < 1) return '已等待不到 1 小时';
  if (hours < 48) return `已等待 ${hours} 小时`;
  return `已等待 ${Math.floor(hours / 24)} 天`;
}

/** 行内 / 详情顶部的原因 Badge；能出题时不渲染。 */
export function ServingHoldBadge({ serving }: { serving: QuestionServing }) {
  if (serving.servable) return null;
  const copy = holdCopy(serving.hold_reason);
  return (
    <Badge tone={copy.tone} dot={serving.pending_action != null}>
      {serving.pending_action == null && <LoomIcon name={copy.icon} size={12} />}
      {copy.label}
    </Badge>
  );
}

/** 「暂不出题」页签下的原因分布：by_reason 逐条 + 从没发布过的老题。 */
export function ServingHoldBreakdown({ counts }: { counts: ServingCounts }) {
  const rows = Object.entries(counts.by_reason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => ({ key: reason, label: holdCopy(reason).label, n }));
  const legacy = counts.legacy_unpublished ?? 0;
  if (rows.length === 0 && legacy === 0) return null;
  return (
    <div className="qb-holdsum">
      <span className="qb-holdsum-l">按原因</span>
      {rows.map((r) => (
        <span key={r.key} className="qb-holdsum-item">
          {r.label}
          <span className="qb-holdsum-n tnum">{r.n}</span>
        </span>
      ))}
      {legacy > 0 && (
        <span className="qb-holdsum-item">
          从没发布过的老题
          <span className="qb-holdsum-n tnum">{legacy} 道</span>
        </span>
      )}
    </div>
  );
}

// ── 命令 ─────────────────────────────────────────────────────────────────────

interface ServingCommandVars {
  command: ServingCommand;
  path: string;
  idempotencyKey: string;
}

function runServingCommand(vars: ServingCommandVars) {
  return apiOperationJson('runQuestionServingAction', {
    url: vars.path,
    method: 'POST',
    init: { headers: { 'Idempotency-Key': vars.idempotencyKey } },
  });
}

/** fetch 本身抛的网络错误（没有 HTTP 响应）才自动重试，且沿用同一个幂等键。 */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

function commandErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'unchanged_base_already_verified':
        return '题目内容没有变，再核验一次结果也一样。请先修改题目并保存。';
      case 'owner_hold':
        return '这道题是你自己设成暂不出题的，不需要重新核验。';
      case 'idempotency_key_reused':
        return '这次提交和之前的一次撞上了，没有执行。请刷新页面后再点一次。';
      case 'conflict':
        return '这道题刚刚有了变动，状态已刷新，请看过之后再决定。';
      default:
        return '操作没有成功，请稍后再试。';
    }
  }
  if (isNetworkFailure(err)) {
    return '网络断了，没能确认有没有提交成功。状态已刷新：如果没显示正在排队，再点一次。';
  }
  return '操作没有成功，请稍后再试。';
}

/**
 * 详情页「暂不出题」条：白话原因 + 等待时长 + 唯一操作（或指引 / 撤回入口）。
 * onOpenRetraction：retraction_hold 时跳到本页已有的撤回 / 移除区。
 */
export function ServingHoldPanel({
  questionId,
  serving,
  nowMs,
  onOpenRetraction,
}: {
  questionId: string;
  serving: QuestionServing;
  nowMs: number;
  onOpenRetraction: () => void;
}) {
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: runServingCommand,
    retry: (failureCount, err) => isNetworkFailure(err) && failureCount < 2,
    onSuccess: (res) => {
      // 用返回的 serving 立刻更新详情和题库行，按钮状态马上变；再让计数等其余投影重新取。
      qc.setQueryData<QuestionFullDetail>(['question-detail', questionId], (prev) =>
        prev ? { ...prev, serving: res.serving } : prev,
      );
      void qc.invalidateQueries({ queryKey: ['questions-bank'] });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: ['question-detail', questionId] });
      void qc.invalidateQueries({ queryKey: ['questions-bank'] });
    },
  });

  if (serving.servable) return null;
  const copy = holdCopy(serving.hold_reason);
  const waited = waitedLabel(serving.held_since, nowMs);
  const action = serving.next_action;
  const pending = serving.pending_action;
  const isRetraction = serving.hold_reason === 'retraction_hold';

  const resultText = mut.isError
    ? commandErrorText(mut.error)
    : mut.isSuccess && !mut.data.accepted
      ? '这道题现在的状态用不上这个操作，已按最新状态显示。'
      : null;

  return (
    <div className="qd-hold" aria-live="polite">
      <LoomIcon name={copy.icon} size={15} className="qd-hold-ico" />
      <div className="qd-hold-txt">
        <div>
          <span className="qd-hold-title">暂不出题 · {copy.label}</span>
          {waited && <span className="qd-hold-wait">{waited}</span>}
        </div>
        <div className="qd-hold-explain">
          {copy.explain}
          {action == null && pending == null && copy.noActionHint ? ` ${copy.noActionHint}` : ''}
        </div>
        {resultText && (
          <div className="qd-hold-result" role="alert">
            {resultText}
          </div>
        )}
      </div>
      <div className="qd-hold-act">
        {pending != null ? (
          <Btn size="sm" variant="secondary" icon="clock" disabled>
            {PENDING_LABEL}
          </Btn>
        ) : action != null ? (
          <Btn
            size="sm"
            variant="secondary"
            icon="refresh"
            disabled={mut.isPending}
            onClick={() =>
              mut.mutate({
                command: action.command,
                path: action.path,
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            {mut.isPending ? '提交中…' : COMMAND_LABEL[action.command]}
          </Btn>
        ) : isRetraction ? (
          <Btn size="sm" variant="ghost" iconEnd="arrow" onClick={onOpenRetraction}>
            去撤回 / 移除
          </Btn>
        ) : null}
      </div>
    </div>
  );
}
