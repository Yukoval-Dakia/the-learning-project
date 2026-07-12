// YUK-601 (UI design doc v1.1 §2.2-§2.4，APPROVED #762) — /admin/subjects/$id
// trait 编辑面（detail 页）。组件只收 props（subjectId + navigate），零路由库
// import（capability ui 不 import 路由——observability.tsx:2-3 既有边界；$id 由
// web/src/router.tsx 的 route wrapper 读出后以 prop 注入）。
//
// 数据（§2.4）：GET /api/admin/subjects（header 行 + sharedBy 名称映射，与列表页
// 共享 ['admin-subjects'] 缓存但**直达刷新不依赖其在场**——本组件自行 query）+
// GET .../$id/traits（六绑定）+ 按需 journal / traits?kind=。一切写 onSuccess
// invalidate 涉及 key + ['subjects']（badge 即时翻转到 onboarding 面）。
//
// CAS 409 分流（§2.3）：**只认 body 携 currentRevision 的 409**（= CAS 陈旧守卫）
// → 顶部内联条 + 自动 refetch；rename/restore 撞名 409 无 currentRevision → 行内
// 直出「名称已被占用」类 server 文案，不 refetch 重放。
// 降级判据：UI 用 degraded !== null 判「是否降级」（review-764 NOTE：不用
// effective !== revision——快照滞后窗口会误报 flicker）。

import { ApiError, apiFetch, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useState } from 'react';
import type { AdminSubjectRow } from './subjects';

// ---------- wire 类型（对齐 admin-read.ts 投影） ----------

type TraitKind =
  | 'charter'
  | 'judge_policy'
  | 'cause_taxonomy'
  | 'source_policy'
  | 'render_theme'
  | 'scheduling';

interface TraitBindingRow {
  kind: TraitKind;
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  revision: number;
  effectiveRevision: number | string;
  degraded: 'journal_fallback' | 'code_seed' | null;
  payload: Record<string, unknown>;
  sharedBy: string[];
}

interface SubjectTraitsResponse {
  subjectRevision: number;
  bindings: TraitBindingRow[];
}

interface JournalRow {
  revision: number;
  action: string;
  actor: string;
  createdAt: string;
}

interface CatalogRow {
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  revision: number;
  boundBy: string[];
}

// ---------- CAS 分流 helper（§2.3） ----------

export function isCasStale(err: unknown): err is ApiError {
  return (
    err instanceof ApiError && err.status === 409 && typeof err.details.currentRevision === 'number'
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.details.issues as Array<{ subjectId: string; errors: string[] }> | undefined;
    if (issues && issues.length > 0) {
      return issues.map((i) => `${i.subjectId}: ${i.errors.join('; ')}`).join(' · ');
    }
    return err.code ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function writeJson(path: string, method: string, body: unknown): Promise<void> {
  await apiFetch(path, { method, body: JSON.stringify(body) });
}

// ---------- 主组件 ----------

export function AdminSubjectTraitsSurface({
  subjectId,
  navigate,
}: {
  subjectId: string;
  navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const [casNotice, setCasNotice] = useState(false);

  const subjectsQ = useQuery({
    queryKey: ['admin-subjects'],
    queryFn: () => apiJson<{ subjects: AdminSubjectRow[] }>('/api/admin/subjects'),
  });
  const traitsQ = useQuery({
    queryKey: ['admin-subject-traits', subjectId],
    queryFn: () => apiJson<SubjectTraitsResponse>(`/api/admin/subjects/${subjectId}/traits`),
  });

  const header = subjectsQ.data?.subjects.find((s) => s.id === subjectId);
  const nameOf = (id: string) =>
    subjectsQ.data?.subjects.find((s) => s.id === id)?.displayName ?? id;
  const subjectRevision = traitsQ.data?.subjectRevision ?? 0;
  const isGeneral = subjectId === 'general';
  const retired = header?.retiredAt != null;

  const invalidateAll = () => {
    // 任一写成功即清 CAS 横幅（review-766 P3：refetch 后重放成功不该滞留横幅）。
    setCasNotice(false);
    void queryClient.invalidateQueries({ queryKey: ['admin-subjects'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-subject-traits', subjectId] });
    // 前缀失效全部 journal（rollback 后未关的历史面板会缺新 revision——review-766 P2）。
    void queryClient.invalidateQueries({ queryKey: ['admin-trait-journal'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-traits'] });
    void queryClient.invalidateQueries({ queryKey: ['subjects'] });
  };
  // CAS 409（携 currentRevision）→ 顶部条 + refetch；其余错误由调用处内联呈现。
  // 顺序：先 invalidate（其中清横幅）再置横幅，防清掉自己。
  const onWriteError = (err: unknown): boolean => {
    if (isCasStale(err)) {
      invalidateAll();
      setCasNotice(true);
      return true;
    }
    return false;
  };

  const link = (to: string, label: string) => (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  return (
    <main className="page wide">
      <PageHeader
        title={header?.displayName ?? subjectId}
        eyebrow="ADMIN · trait 编辑面"
        sub={`${subjectId} · rev ${subjectRevision}${header?.version ? ` · ${header.version}` : ''}`}
      >
        <div style={linkRowStyle}>
          {link('/admin/subjects', '← subjects')}
          {link('/admin/runs', 'runs')}
          {link('/admin/cost', 'cost')}
          {link('/admin/failures', 'failures')}
          {link('/admin/coverage-lattice', 'coverage')}
          {link('/admin/conjecture-scores', 'conjecture')}
        </div>
      </PageHeader>

      <div style={badgeRowStyle}>
        {header && <Badge tone="neutral">{isGeneral ? 'general' : header.origin}</Badge>}
        {retired && <Badge tone="neutral">retired</Badge>}
        {header?.isGeneralFallback === true && <Badge tone="neutral">通用模式</Badge>}
      </div>

      {casNotice && (
        <Card pad="lg">
          <p style={noticeStyle}>
            配置已被其他会话更新，已刷新最新版本，请重新提交。
            <button type="button" style={inlineBtnStyle} onClick={() => setCasNotice(false)}>
              知道了
            </button>
          </p>
        </Card>
      )}

      {traitsQ.isSuccess && (
        // 控制行 gate 在 traitsQ 成功后（review-766 P3：加载期 subjectRevision
        // 回落 0 会让 rev-0 科目的写 pre-load 静默成功）。
        <ControlRow
          subjectId={subjectId}
          subjectRevision={subjectRevision}
          isGeneral={isGeneral}
          retired={retired}
          isBuiltin={header?.origin === 'builtin'}
          onWriteError={onWriteError}
          onDone={invalidateAll}
        />
      )}

      <Stateful
        status={traitsQ.isLoading ? 'loading' : traitsQ.isError ? 'error' : 'ok'}
        onRetry={() => void traitsQ.refetch()}
        errorText="trait 绑定加载失败。"
        skeleton={
          <Card pad="lg">
            <p style={mutedTextStyle}>trait 绑定加载中...</p>
          </Card>
        }
      >
        <Card pad="lg">
          {(traitsQ.data?.bindings ?? []).map((b) => (
            <TraitRow
              key={b.kind}
              subjectId={subjectId}
              subjectRevision={subjectRevision}
              isGeneral={isGeneral}
              binding={b}
              nameOf={nameOf}
              onWriteError={onWriteError}
              onDone={invalidateAll}
            />
          ))}
        </Card>
      </Stateful>
    </main>
  );
}

// ---------- 控制行动作区（§2.3 矩阵 rename / retire·restore / reset） ----------

function ControlRow({
  subjectId,
  subjectRevision,
  isGeneral,
  retired,
  isBuiltin,
  onWriteError,
  onDone,
}: {
  subjectId: string;
  subjectRevision: number;
  isGeneral: boolean;
  retired: boolean;
  isBuiltin: boolean;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState<null | 'retire' | 'restore' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async (action: 'rename' | 'retire' | 'restore' | 'reset') => {
      setError(null);
      if (action === 'rename') {
        await writeJson(`/api/admin/subjects/${subjectId}`, 'PATCH', {
          expectedRevision: subjectRevision,
          displayName: newName,
        });
      } else {
        await writeJson(`/api/admin/subjects/${subjectId}/${action}`, 'POST', {
          expectedRevision: subjectRevision,
        });
      }
    },
    onSuccess: () => {
      setRenaming(false);
      setNewName('');
      setConfirming(null);
      onDone();
    },
    onError: (err) => {
      if (!onWriteError(err)) setError(errText(err));
      setConfirming(null);
    },
  });

  const confirmText: Record<string, string> = {
    retire: 'retire 后仍可解析历史数据，不再出现在选科/词表。确认退休？',
    restore: '恢复该科目为 live。确认？',
    reset: '六绑定指回种子；已 fork 的副本保留为孤儿，不删除。确认重置？',
  };

  return (
    <Card pad="lg">
      <div style={actionRowStyle}>
        {renaming ? (
          <>
            <input
              style={renameInputStyle}
              value={newName}
              placeholder="新名称"
              maxLength={32}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="新科目名"
            />
            <button
              type="button"
              style={inlineBtnStyle}
              disabled={run.isPending || newName.trim().length === 0}
              onClick={() => run.mutate('rename')}
            >
              确认改名
            </button>
            <button type="button" style={inlineBtnStyle} onClick={() => setRenaming(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" style={inlineBtnStyle} onClick={() => setRenaming(true)}>
            rename
          </button>
        )}
        {!isGeneral &&
          (retired ? (
            <button type="button" style={inlineBtnStyle} onClick={() => setConfirming('restore')}>
              restore
            </button>
          ) : (
            <button type="button" style={inlineBtnStyle} onClick={() => setConfirming('retire')}>
              retire
            </button>
          ))}
        {!isGeneral && (
          <button type="button" style={inlineBtnStyle} onClick={() => setConfirming('reset')}>
            reset{isBuiltin ? '（名字随种子恢复）' : ''}
          </button>
        )}
        {isGeneral && (
          <span style={mutedTextStyle} title="general 绑定结构性锁定（v3.2 §2.3）">
            general：无 retire / reset（结构性锁定）
          </span>
        )}
      </div>
      {confirming && (
        <p style={noticeStyle}>
          {confirmText[confirming]}
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={run.isPending}
            onClick={() => run.mutate(confirming)}
          >
            确认
          </button>
          <button type="button" style={inlineBtnStyle} onClick={() => setConfirming(null)}>
            取消
          </button>
        </p>
      )}
      {error && <p style={errStyle}>{error}</p>}
    </Card>
  );
}

// ---------- 六绑定行 + per-kind 就地展开编辑（§2.2 open-question 3 = A） ----------

function TraitRow({
  subjectId,
  subjectRevision,
  isGeneral,
  binding,
  nameOf,
  onWriteError,
  onDone,
}: {
  subjectId: string;
  subjectRevision: number;
  isGeneral: boolean;
  binding: TraitBindingRow;
  nameOf: (id: string) => string;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  const [panel, setPanel] = useState<null | 'edit' | 'fork' | 'rebind' | 'journal'>(null);
  // 自有判定与写门同式（trait ownership，v3.2）。
  const own =
    binding.traitId === `trt_seed_${subjectId}_${binding.kind}` ||
    binding.ownerSubjectId === subjectId;
  const shared = binding.sharedBy.length > 1;

  return (
    <div style={traitRowStyle}>
      <div style={traitHeadStyle}>
        <strong style={kindStyle}>{binding.kind}</strong>
        <code style={monoSmallStyle}>{binding.traitId}</code>
        <Badge tone="neutral">{binding.origin}</Badge>
        {binding.ownerSubjectId && (
          <span style={mutedTextStyle}>owner: {nameOf(binding.ownerSubjectId)}</span>
        )}
        {binding.seedVersion && <span style={mutedTextStyle}>seed {binding.seedVersion}</span>}
        <span style={mutedTextStyle}>rev {binding.revision}</span>
        {binding.degraded !== null && (
          // 黄底徽标（doc §2.2；hard = 项目色板的黄档，review-766 P3 校正）。
          <Badge tone="hard">
            {binding.degraded} · 实际在用 {String(binding.effectiveRevision)}
          </Badge>
        )}
        <span style={mutedTextStyle} title={binding.sharedBy.map((s) => nameOf(s)).join('、')}>
          共 {binding.sharedBy.length} 科
        </span>
        <span style={traitActionsStyle}>
          <button
            type="button"
            style={inlineBtnStyle}
            onClick={() => setPanel(panel === 'edit' ? null : 'edit')}
          >
            编辑
          </button>
          {/* fork/换绑对 general 渲染禁用态 + 锁定 title（doc §2.3 general 特殊态；
              禁用是 UI 礼貌，422 写门才是红线）。 */}
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={isGeneral}
            title={isGeneral ? 'general 绑定结构性锁定（v3.2 §2.3）' : '剥离出本科副本，稍后再改'}
            onClick={() => setPanel(panel === 'fork' ? null : 'fork')}
          >
            fork
          </button>
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={isGeneral}
            title={isGeneral ? 'general 绑定结构性锁定（v3.2 §2.3）' : undefined}
            onClick={() => setPanel(panel === 'rebind' ? null : 'rebind')}
          >
            换绑
          </button>
          <button
            type="button"
            style={inlineBtnStyle}
            onClick={() => setPanel(panel === 'journal' ? null : 'journal')}
          >
            历史
          </button>
        </span>
      </div>
      {panel === 'edit' && (
        <TraitEditPanel
          subjectId={subjectId}
          subjectRevision={subjectRevision}
          isGeneral={isGeneral}
          binding={binding}
          own={own}
          shared={shared}
          nameOf={nameOf}
          onWriteError={onWriteError}
          onDone={() => {
            setPanel(null);
            onDone();
          }}
        />
      )}
      {panel === 'fork' && (
        <ForkPanel
          subjectId={subjectId}
          subjectRevision={subjectRevision}
          binding={binding}
          onWriteError={onWriteError}
          onDone={() => {
            setPanel(null);
            onDone();
          }}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'rebind' && (
        <RebindPanel
          subjectId={subjectId}
          subjectRevision={subjectRevision}
          binding={binding}
          nameOf={nameOf}
          onWriteError={onWriteError}
          onDone={() => {
            setPanel(null);
            onDone();
          }}
        />
      )}
      {panel === 'journal' && (
        <JournalPanel
          binding={binding}
          onWriteError={onWriteError}
          onDone={() => {
            // rollback 成功即关面板（review-766 P2）——重开时 refetch 拿到新 revision，
            // 不会留着陈旧列表 + 全行「回滚到此」误导。
            setPanel(null);
            onDone();
          }}
        />
      )}
    </div>
  );
}

// ---------- 编辑面板：逐字段表单 + 三分保存语义（§2.2 owner review P1） ----------

function TraitEditPanel({
  subjectId,
  subjectRevision,
  isGeneral,
  binding,
  own,
  shared,
  nameOf,
  onWriteError,
  onDone,
}: {
  subjectId: string;
  subjectRevision: number;
  isGeneral: boolean;
  binding: TraitBindingRow;
  own: boolean;
  shared: boolean;
  nameOf: (id: string) => string;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  // 逐字段草稿：string 字段直接编辑；复杂字段（数组/对象）以字段级 JSON 文本编辑。
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(binding.payload)) {
      d[k] = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    }
    return d;
  });
  const [error, setError] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<string | null>(null);
  // 待确认的写模式（own+shared 主按钮 → 'subject'；共享面按钮 → 'shared'）——
  // 两入口效果在该分支重合（doc §2.2），但提交路径各走各的端点。
  const [confirmMode, setConfirmMode] = useState<null | 'subject' | 'shared'>(null);

  const buildPayload = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(binding.payload)) {
      const text = draft[k] ?? '';
      if (typeof v === 'string') {
        out[k] = text;
      } else {
        try {
          out[k] = JSON.parse(text);
        } catch {
          setError(`字段 ${k} 不是合法 JSON`);
          return null;
        }
      }
    }
    return out;
  };

  const save = useMutation({
    mutationFn: async (mode: 'subject' | 'shared') => {
      setError(null);
      const payload = buildPayload();
      if (!payload) throw new Error('draft_invalid');
      if (mode === 'subject') {
        await writeJson(`/api/admin/subjects/${subjectId}/traits/${binding.kind}`, 'PUT', {
          expectedSubjectRevision: subjectRevision,
          expectedTraitRevision: binding.revision,
          payload,
        });
      } else {
        await writeJson(`/api/admin/traits/${binding.traitId}`, 'PUT', {
          expectedRevision: binding.revision,
          payload,
        });
      }
    },
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof Error && err.message === 'draft_invalid') return;
      if (!onWriteError(err)) setError(errText(err));
      setConfirmMode(null);
    },
  });

  const validate = useMutation({
    mutationFn: async () => {
      setError(null);
      setValidateResult(null);
      const payload = buildPayload();
      if (!payload) throw new Error('draft_invalid');
      const res = await apiFetch(`/api/admin/subjects/${subjectId}/validate`, {
        method: 'POST',
        body: JSON.stringify({ traitPayloadOverrides: { [binding.kind]: payload } }),
      });
      const body = (await res.json()) as { valid: boolean; errors: string[]; warnings: string[] };
      setValidateResult(
        body.valid ? '预检通过' : `预检失败：${body.errors.slice(0, 5).join('; ')}`,
      );
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'draft_invalid') return;
      setError(errText(err));
    },
  });

  // 三分保存语义（owner review P1）：非自有 → COW 预告；自有独占 → 原地；
  // 自有共享 → 波及清单 + 二次确认。
  const saveLabel = !own
    ? '保存（自动 fork 本科副本）'
    : shared
      ? `保存（影响 ${binding.sharedBy.length} 科）`
      : '保存（本科生效）';
  const needsConfirm = own && shared;
  // 共享写入口：general 恒有（其种子编辑本就是全体跟随）；其余 sharedBy>1。
  const showSharedWrite = isGeneral || shared;

  return (
    <div style={panelStyle}>
      {Object.entries(binding.payload).map(([k, v]) => (
        <label key={k} style={fieldLabelStyle}>
          <span style={fieldNameStyle}>{k}</span>
          <textarea
            style={fieldInputStyle}
            rows={typeof v === 'string' ? 2 : 5}
            value={draft[k] ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, [k]: e.target.value }))}
          />
        </label>
      ))}
      {!own && <p style={mutedTextStyle}>保存将自动为本科 fork 一份副本（原 trait 不受影响）。</p>}
      <div style={actionRowStyle}>
        <button
          type="button"
          style={inlineBtnStyle}
          disabled={save.isPending}
          onClick={() => {
            if (needsConfirm) setConfirmMode('subject');
            else save.mutate('subject');
          }}
        >
          {save.isPending ? '保存中…' : saveLabel}
        </button>
        {showSharedWrite && (
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={save.isPending}
            onClick={() => setConfirmMode('shared')}
          >
            编辑共享面（影响 {binding.sharedBy.length} 科）
          </button>
        )}
        <button
          type="button"
          style={inlineBtnStyle}
          disabled={validate.isPending}
          onClick={() => validate.mutate()}
        >
          {validate.isPending ? '预检中…' : '预检'}
        </button>
        {binding.seedVersion !== null && (
          <ResetToSeedButton
            binding={binding}
            onWriteError={onWriteError}
            onDone={onDone}
            onError={setError}
          />
        )}
      </div>
      {confirmMode !== null && (
        <p style={noticeStyle}>
          将影响绑定此 trait 的全部科目：{binding.sharedBy.map((s) => nameOf(s)).join('、')}。确认？
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={save.isPending}
            onClick={() => save.mutate(confirmMode)}
          >
            确认写入
          </button>
          <button type="button" style={inlineBtnStyle} onClick={() => setConfirmMode(null)}>
            取消
          </button>
        </p>
      )}
      {validateResult && <p style={mutedTextStyle}>{validateResult}</p>}
      {error && <p style={errStyle}>{error}</p>}
    </div>
  );
}

function ResetToSeedButton({
  binding,
  onWriteError,
  onDone,
  onError,
}: {
  binding: TraitBindingRow;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      writeJson(`/api/admin/traits/${binding.traitId}/reset-to-seed`, 'POST', {
        expectedRevision: binding.revision,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) onError(errText(err));
      setConfirming(false);
    },
  });
  if (confirming) {
    return (
      <span style={noticeStyle}>
        恢复出厂将影响绑定此 trait 的全部 {binding.sharedBy.length} 科。
        <button
          type="button"
          style={inlineBtnStyle}
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          确认
        </button>
        <button type="button" style={inlineBtnStyle} onClick={() => setConfirming(false)}>
          取消
        </button>
      </span>
    );
  }
  return (
    <button type="button" style={inlineBtnStyle} onClick={() => setConfirming(true)}>
      恢复出厂
    </button>
  );
}

// ---------- fork：显式剥离，不带编辑（§2.3 矩阵 fork 行，review-766 P1） ----------

function ForkPanel({
  subjectId,
  subjectRevision,
  binding,
  onWriteError,
  onDone,
  onCancel,
}: {
  subjectId: string;
  subjectRevision: number;
  binding: TraitBindingRow;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () =>
      writeJson(`/api/admin/subjects/${subjectId}/traits/${binding.kind}/fork`, 'POST', {
        expectedSubjectRevision: subjectRevision,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) setError(errText(err));
    },
  });
  return (
    <div style={panelStyle}>
      <p style={noticeStyle}>
        剥离后本科独立演化，不再跟随来源（{binding.traitId}）。确认 fork？
        <button
          type="button"
          style={inlineBtnStyle}
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? 'fork 中…' : '确认 fork'}
        </button>
        <button type="button" style={inlineBtnStyle} onClick={onCancel}>
          取消
        </button>
      </p>
      {error && <p style={errStyle}>{error}</p>}
    </div>
  );
}

// ---------- 换绑选择器（§2.3；loading/empty/error 三态，review findings 折入） ----------

function RebindPanel({
  subjectId,
  subjectRevision,
  binding,
  nameOf,
  onWriteError,
  onDone,
}: {
  subjectId: string;
  subjectRevision: number;
  binding: TraitBindingRow;
  nameOf: (id: string) => string;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['admin-traits', binding.kind],
    queryFn: () => apiJson<{ traits: CatalogRow[] }>(`/api/admin/traits?kind=${binding.kind}`),
  });
  const candidates = (q.data?.traits ?? []).filter((t) => t.traitId !== binding.traitId);

  const run = useMutation({
    mutationFn: (targetTraitId: string) =>
      writeJson(`/api/admin/subjects/${subjectId}/traits/${binding.kind}/binding`, 'PUT', {
        targetTraitId,
        expectedSubjectRevision: subjectRevision,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) setError(errText(err));
      setPicked(null);
    },
  });

  return (
    <div style={panelStyle}>
      <Stateful
        status={q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'}
        onRetry={() => void q.refetch()}
        errorText="候选加载失败。"
        skeleton={<p style={mutedTextStyle}>候选加载中...</p>}
      >
        {candidates.length === 0 ? (
          <p style={mutedTextStyle}>本 kind 暂无其它可换绑 trait。</p>
        ) : (
          candidates.map((t) => (
            <div key={t.traitId} style={actionRowStyle}>
              <code style={monoSmallStyle}>{t.traitId}</code>
              <Badge tone="neutral">{t.origin}</Badge>
              <span style={mutedTextStyle}>
                用于：
                {t.boundBy.length === 0 ? '（未绑定）' : t.boundBy.map((s) => nameOf(s)).join('、')}
              </span>
              <button
                type="button"
                style={inlineBtnStyle}
                disabled={run.isPending}
                onClick={() => setPicked(t.traitId)}
              >
                选择
              </button>
            </div>
          ))
        )}
      </Stateful>
      {picked && (
        <p style={noticeStyle}>
          改绑后沿用目标 trait（{picked}）的后续演化。确认？
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={run.isPending}
            onClick={() => run.mutate(picked)}
          >
            确认换绑
          </button>
          <button type="button" style={inlineBtnStyle} onClick={() => setPicked(null)}>
            取消
          </button>
        </p>
      )}
      {error && <p style={errStyle}>{error}</p>}
    </div>
  );
}

// ---------- journal / rollback（§2.2 point 4：纯 revision 列表，含 reconcile） ----------

function JournalPanel({
  binding,
  onWriteError,
  onDone,
}: {
  binding: TraitBindingRow;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['admin-trait-journal', binding.traitId],
    queryFn: () =>
      apiJson<{ journal: JournalRow[] }>(`/api/admin/traits/${binding.traitId}/journal`),
  });

  const run = useMutation({
    mutationFn: (targetRevision: number) =>
      writeJson(`/api/admin/traits/${binding.traitId}/rollback`, 'POST', {
        expectedRevision: binding.revision,
        targetRevision,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) setError(errText(err));
      setTarget(null);
    },
  });

  return (
    <div style={panelStyle}>
      <Stateful
        status={q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'}
        onRetry={() => void q.refetch()}
        errorText="历史加载失败。"
        skeleton={<p style={mutedTextStyle}>历史加载中...</p>}
      >
        {(q.data?.journal ?? []).map((row) => (
          <div key={row.revision} style={actionRowStyle}>
            <span style={monoSmallStyle}>rev {row.revision}</span>
            <Badge tone="neutral">{row.action}</Badge>
            <span style={mutedTextStyle}>
              {row.actor} · {row.createdAt.slice(0, 19).replace('T', ' ')}
            </span>
            {row.revision !== binding.revision && (
              <button
                type="button"
                style={inlineBtnStyle}
                title="产生一条新 revision，不删除历史（rollback-forward）"
                disabled={run.isPending}
                onClick={() => setTarget(row.revision)}
              >
                回滚到此
              </button>
            )}
          </div>
        ))}
      </Stateful>
      {target !== null && (
        <p style={noticeStyle}>
          回滚产生一条新 revision（git-revert 语义），不删除历史。确认回滚到 rev {target}？
          <button
            type="button"
            style={inlineBtnStyle}
            disabled={run.isPending}
            onClick={() => run.mutate(target)}
          >
            确认
          </button>
          <button type="button" style={inlineBtnStyle} onClick={() => setTarget(null)}>
            取消
          </button>
        </p>
      )}
      {error && <p style={errStyle}>{error}</p>}
    </div>
  );
}

// ---------- inline token styles（沿 subjects.tsx 的 legacy admin chrome 权威） ----------

const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  margin: '0 0 12px',
};

const traitRowStyle: CSSProperties = {
  borderTop: '1px solid var(--line-soft)',
  padding: '10px 0',
};

const traitHeadStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
};

const kindStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  minWidth: 110,
};

const traitActionsStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  gap: 6,
};

const panelStyle: CSSProperties = {
  margin: '10px 0 4px 118px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const fieldLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const fieldNameStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  color: 'var(--ink-4)',
};

const fieldInputStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: 6,
  border: '1px solid var(--line-soft)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--ink-2)',
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};

const inlineBtnStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  padding: '3px 10px',
  border: '1px solid var(--line-soft)',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--ink-2)',
  cursor: 'pointer',
};

const renameInputStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--ink-2)',
  width: '12em',
};

const noticeStyle: CSSProperties = {
  margin: 0,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--ink-2)',
};

const errStyle: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: 'var(--coral, #c0392b)',
};

const monoSmallStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 12.5,
};
