// YUK-601 (UI design doc v1.1 §2.2-§2.4，APPROVED #762) — /admin/subjects/$id
// trait 编辑面（detail 页）。组件只收 props（subjectId + navigate），零路由库
// import（capability ui 不 import 路由——observability.tsx:2-3 既有边界；$id 由
// Start route（server/start/routes/admin.subjects.$id.tsx）读出后以 prop 注入）。
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
//
// 呈现：M3E 管理后台外壳（YUK-1473，docs/design/2026-11-03-admin-write-m3e.md）。只换呈现：
// 每个写的 payload、确认步骤、忙时禁用、失效与 CAS 分流都与原来逐字相同。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { Button, Chip } from '@/ui-next/public';
import {
  type AdminControlClient,
  type TraitBindingRow,
  httpAdminControlClient,
} from './admin-control-client';
import {
  AdminArea,
  AdminFrame,
  AdminHead,
  AdminNav,
  type AdminNavLink,
  AdminPanel,
  adminAreaStatus,
} from './admin-frame';

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

// The detail page's link row: same targets and order as before (back to subjects first).
const NAV: readonly AdminNavLink[] = [
  { to: '/admin/subjects', label: '← 学科配置' },
  { to: '/admin/runs', label: '运行记录' },
  { to: '/admin/cost', label: '成本' },
  { to: '/admin/failures', label: '失败记录' },
  { to: '/admin/coverage-lattice', label: '供题覆盖' },
  { to: '/admin/conjecture-scores', label: '猜想评分' },
];

// ---------- 主组件 ----------

export function AdminSubjectTraitsSurface({
  subjectId,
  navigate,
  client = httpAdminControlClient,
}: {
  subjectId: string;
  navigate: (to: string) => void;
  client?: AdminControlClient;
}) {
  const queryClient = useQueryClient();
  const [casNotice, setCasNotice] = useState(false);

  const subjectsQ = useQuery({
    queryKey: ['admin-subjects'],
    queryFn: () => client.getSubjects(),
  });
  const traitsQ = useQuery({
    queryKey: ['admin-subject-traits', subjectId],
    queryFn: () => client.getSubjectTraits({ subjectId }),
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

  return (
    <AdminFrame>
      <AdminNav links={NAV} current={`/admin/subjects/${subjectId}`} navigate={navigate} />
      <AdminHead
        kicker="ADMIN · trait 编辑面"
        title={header?.displayName ?? subjectId}
        lead={`${subjectId} · rev ${subjectRevision}${header?.version ? ` · ${header.version}` : ''}`}
      />

      <div className="adm-chip-row">
        {header && <Chip>{isGeneral ? 'general' : header.origin}</Chip>}
        {retired && <Chip>retired</Chip>}
        {header?.isGeneralFallback === true && <Chip>通用模式</Chip>}
      </div>

      {casNotice && (
        <div className="adm-cas" role="status">
          <p>配置已被其他会话更新，已刷新最新版本，请重新提交。</p>
          <Button variant="ghost" size="sm" onClick={() => setCasNotice(false)}>
            知道了
          </Button>
        </div>
      )}

      {traitsQ.isSuccess && (
        // 控制行 gate 在 traitsQ 成功后（review-766 P3：加载期 subjectRevision
        // 回落 0 会让 rev-0 科目的写 pre-load 静默成功）。
        <ControlRow
          client={client}
          subjectId={subjectId}
          subjectRevision={subjectRevision}
          isGeneral={isGeneral}
          retired={retired}
          isBuiltin={header?.origin === 'builtin'}
          onWriteError={onWriteError}
          onDone={invalidateAll}
        />
      )}

      <AdminArea
        status={adminAreaStatus(traitsQ)}
        loadingLabel="trait 绑定加载中"
        errorText="trait 绑定加载失败。"
        onRetry={() => void traitsQ.refetch()}
      >
        <AdminPanel
          id="adm-traits"
          title="trait 绑定"
          aside={<Chip>{(traitsQ.data?.bindings ?? []).length}</Chip>}
          flush
        >
          <ul className="adm-traits">
            {(traitsQ.data?.bindings ?? []).map((b) => (
              <TraitRow
                client={client}
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
          </ul>
        </AdminPanel>
      </AdminArea>
    </AdminFrame>
  );
}

// ---------- 控制行动作区（§2.3 矩阵 rename / retire·restore / reset） ----------

function ControlRow({
  client,
  subjectId,
  subjectRevision,
  isGeneral,
  retired,
  isBuiltin,
  onWriteError,
  onDone,
}: {
  client: AdminControlClient;
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
        await client.renameSubject({
          subjectId,
          expectedRevision: subjectRevision,
          displayName: newName,
        });
      } else {
        await client[`${action}Subject`]({ subjectId, expectedRevision: subjectRevision });
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
    <AdminPanel id="adm-subject-control" title="科目操作">
      <div className="adm-acts">
        {renaming ? (
          <>
            <input
              className="adm-input adm-input-name"
              value={newName}
              placeholder="新名称"
              maxLength={32}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="新科目名"
            />
            <Button
              size="sm"
              disabled={run.isPending || newName.trim().length === 0}
              onClick={() => run.mutate('rename')}
            >
              确认改名
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setRenaming(true)}>
            rename
          </Button>
        )}
        {!isGeneral &&
          (retired ? (
            <Button size="sm" onClick={() => setConfirming('restore')}>
              restore
            </Button>
          ) : (
            <Button size="sm" className="adm-btn-danger" onClick={() => setConfirming('retire')}>
              retire
            </Button>
          ))}
        {!isGeneral && (
          <Button size="sm" className="adm-btn-danger" onClick={() => setConfirming('reset')}>
            reset{isBuiltin ? '（名字随种子恢复）' : ''}
          </Button>
        )}
        {isGeneral && (
          <span className="adm-note" title="general 绑定结构性锁定（v3.2 §2.3）">
            general：无 retire / reset（结构性锁定）
          </span>
        )}
      </div>
      {confirming && (
        <div className="adm-confirm">
          <p>{confirmText[confirming]}</p>
          <div className="adm-acts">
            <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(confirming)}>
              确认
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="adm-field-error" role="alert">
          {error}
        </p>
      )}
    </AdminPanel>
  );
}

// ---------- 六绑定行 + per-kind 就地展开编辑（§2.2 open-question 3 = A） ----------

function TraitRow({
  client,
  subjectId,
  subjectRevision,
  isGeneral,
  binding,
  nameOf,
  onWriteError,
  onDone,
}: {
  client: AdminControlClient;
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
    <li className="adm-trait">
      <div className="adm-trait-head">
        <strong className="adm-trait-kind">{binding.kind}</strong>
        <code className="adm-mono adm-trait-id">{binding.traitId}</code>
        <Chip>{binding.origin}</Chip>
        {binding.ownerSubjectId && (
          <span className="adm-trait-meta">owner: {nameOf(binding.ownerSubjectId)}</span>
        )}
        {binding.seedVersion && <span className="adm-trait-meta">seed {binding.seedVersion}</span>}
        <span className="adm-trait-meta">rev {binding.revision}</span>
        {binding.degraded !== null && (
          // 黄底徽标（doc §2.2；原 hard 黄档 → ui-next caution，review-766 P3 校正）。
          <Chip tone="caution">
            {binding.degraded} · 实际在用 {String(binding.effectiveRevision)}
          </Chip>
        )}
        <span className="adm-trait-meta" title={binding.sharedBy.map((s) => nameOf(s)).join('、')}>
          共 {binding.sharedBy.length} 科
        </span>
        <span className="adm-acts adm-trait-acts">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panel === 'edit'}
            onClick={() => setPanel(panel === 'edit' ? null : 'edit')}
          >
            编辑
          </Button>
          {/* fork/换绑对 general 渲染禁用态 + 锁定 title（doc §2.3 general 特殊态；
              禁用是 UI 礼貌，422 写门才是红线）。 */}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panel === 'fork'}
            disabled={isGeneral}
            title={isGeneral ? 'general 绑定结构性锁定（v3.2 §2.3）' : '剥离出本科副本，稍后再改'}
            onClick={() => setPanel(panel === 'fork' ? null : 'fork')}
          >
            fork
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panel === 'rebind'}
            disabled={isGeneral}
            title={isGeneral ? 'general 绑定结构性锁定（v3.2 §2.3）' : undefined}
            onClick={() => setPanel(panel === 'rebind' ? null : 'rebind')}
          >
            换绑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panel === 'journal'}
            onClick={() => setPanel(panel === 'journal' ? null : 'journal')}
          >
            历史
          </Button>
        </span>
      </div>
      {panel === 'edit' && (
        <TraitEditPanel
          client={client}
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
          client={client}
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
          client={client}
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
          client={client}
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
    </li>
  );
}

// ---------- 编辑面板：逐字段表单 + 三分保存语义（§2.2 owner review P1） ----------

function TraitEditPanel({
  client,
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
  client: AdminControlClient;
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
        await client.editSubjectTrait({
          subjectId,
          kind: binding.kind,
          expectedSubjectRevision: subjectRevision,
          expectedTraitRevision: binding.revision,
          payload,
        });
      } else {
        await client.editSharedTrait({
          traitId: binding.traitId,
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
      const body = await client.validateSubject({
        subjectId,
        traitPayloadOverrides: { [binding.kind]: payload },
      });
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
    <div className="adm-trait-panel">
      {Object.entries(binding.payload).map(([k, v]) => (
        <label key={k} className="adm-field">
          <span className="adm-field-name adm-field-key">{k}</span>
          <textarea
            className="adm-input adm-textarea"
            rows={typeof v === 'string' ? 2 : 5}
            value={draft[k] ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, [k]: e.target.value }))}
          />
        </label>
      ))}
      {!own && <p className="adm-note">保存将自动为本科 fork 一份副本（原 trait 不受影响）。</p>}
      <div className="adm-acts">
        <Button
          variant="primary"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            if (needsConfirm) setConfirmMode('subject');
            else save.mutate('subject');
          }}
        >
          {save.isPending ? '保存中…' : saveLabel}
        </Button>
        {showSharedWrite && (
          <Button size="sm" disabled={save.isPending} onClick={() => setConfirmMode('shared')}>
            编辑共享面（影响 {binding.sharedBy.length} 科）
          </Button>
        )}
        <Button size="sm" disabled={validate.isPending} onClick={() => validate.mutate()}>
          {validate.isPending ? '预检中…' : '预检'}
        </Button>
        {binding.seedVersion !== null && (
          <ResetToSeedButton
            client={client}
            binding={binding}
            onWriteError={onWriteError}
            onDone={onDone}
            onError={setError}
          />
        )}
      </div>
      {confirmMode !== null && (
        <div className="adm-confirm">
          <p>
            将影响绑定此 trait 的全部科目：{binding.sharedBy.map((s) => nameOf(s)).join('、')}
            。确认？
          </p>
          <div className="adm-acts">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(confirmMode)}>
              确认写入
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmMode(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {validateResult && (
        <p className="adm-note" role="status">
          {validateResult}
        </p>
      )}
      {error && (
        <p className="adm-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ResetToSeedButton({
  client,
  binding,
  onWriteError,
  onDone,
  onError,
}: {
  client: AdminControlClient;
  binding: TraitBindingRow;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
  onError: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      client.resetTraitToSeed({ traitId: binding.traitId, expectedRevision: binding.revision }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) onError(errText(err));
      setConfirming(false);
    },
  });
  if (confirming) {
    return (
      <span className="adm-inline-confirm">
        <span>恢复出厂将影响绑定此 trait 的全部 {binding.sharedBy.length} 科。</span>
        <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
          确认
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          取消
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" className="adm-btn-danger" onClick={() => setConfirming(true)}>
      恢复出厂
    </Button>
  );
}

// ---------- fork：显式剥离，不带编辑（§2.3 矩阵 fork 行，review-766 P1） ----------

function ForkPanel({
  client,
  subjectId,
  subjectRevision,
  binding,
  onWriteError,
  onDone,
  onCancel,
}: {
  client: AdminControlClient;
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
      client.forkSubjectTrait({
        subjectId,
        kind: binding.kind,
        expectedSubjectRevision: subjectRevision,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (!onWriteError(err)) setError(errText(err));
    },
  });
  return (
    <div className="adm-trait-panel">
      <div className="adm-confirm">
        <p>剥离后本科独立演化，不再跟随来源（{binding.traitId}）。确认 fork？</p>
        <div className="adm-acts">
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'fork 中…' : '确认 fork'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
      {error && (
        <p className="adm-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------- 换绑选择器（§2.3；loading/empty/error 三态，review findings 折入） ----------

function RebindPanel({
  client,
  subjectId,
  subjectRevision,
  binding,
  nameOf,
  onWriteError,
  onDone,
}: {
  client: AdminControlClient;
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
    queryFn: () => client.getTraits({ kind: binding.kind }),
  });
  const candidates = (q.data?.traits ?? []).filter((t) => t.traitId !== binding.traitId);

  const run = useMutation({
    mutationFn: (targetTraitId: string) =>
      client.rebindSubjectTrait({
        subjectId,
        kind: binding.kind,
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
    <div className="adm-trait-panel">
      <AdminArea
        status={adminAreaStatus(q)}
        loadingLabel="候选加载中"
        errorText="候选加载失败。"
        onRetry={() => void q.refetch()}
        inline
      >
        {candidates.length === 0 ? (
          <p className="adm-note">本 kind 暂无其它可换绑 trait。</p>
        ) : (
          <ul className="adm-pick-list">
            {candidates.map((t) => (
              <li
                key={t.traitId}
                className="adm-pick-row"
                data-picked={picked === t.traitId ? '' : undefined}
              >
                <code className="adm-mono adm-trait-id">{t.traitId}</code>
                <Chip>{t.origin}</Chip>
                <span className="adm-trait-meta">
                  用于：
                  {t.boundBy.length === 0
                    ? '（未绑定）'
                    : t.boundBy.map((s) => nameOf(s)).join('、')}
                </span>
                <Button
                  size="sm"
                  className="adm-pick-btn"
                  disabled={run.isPending}
                  onClick={() => setPicked(t.traitId)}
                >
                  选择
                </Button>
              </li>
            ))}
          </ul>
        )}
      </AdminArea>
      {picked && (
        <div className="adm-confirm">
          <p>改绑后沿用目标 trait（{picked}）的后续演化。确认？</p>
          <div className="adm-acts">
            <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(picked)}>
              确认换绑
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="adm-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------- journal / rollback（§2.2 point 4：纯 revision 列表，含 reconcile） ----------

function JournalPanel({
  client,
  binding,
  onWriteError,
  onDone,
}: {
  client: AdminControlClient;
  binding: TraitBindingRow;
  onWriteError: (err: unknown) => boolean;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['admin-trait-journal', binding.traitId],
    queryFn: () => client.getTraitJournal({ traitId: binding.traitId }),
  });

  const run = useMutation({
    mutationFn: (targetRevision: number) =>
      client.rollbackTrait({
        traitId: binding.traitId,
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
    <div className="adm-trait-panel">
      <AdminArea
        status={adminAreaStatus(q)}
        loadingLabel="历史加载中"
        errorText="历史加载失败。"
        onRetry={() => void q.refetch()}
        inline
      >
        <ol className="adm-pick-list">
          {(q.data?.journal ?? []).map((row) => (
            <li
              key={row.revision}
              className="adm-pick-row"
              data-picked={target === row.revision ? '' : undefined}
            >
              <span className="adm-mono adm-strong">rev {row.revision}</span>
              <Chip>{row.action}</Chip>
              <span className="adm-trait-meta">
                {row.actor} · {row.createdAt.slice(0, 19).replace('T', ' ')}
              </span>
              {row.revision !== binding.revision && (
                <Button
                  size="sm"
                  className="adm-pick-btn adm-btn-danger"
                  title="产生一条新 revision，不删除历史（rollback-forward）"
                  disabled={run.isPending}
                  onClick={() => setTarget(row.revision)}
                >
                  回滚到此
                </Button>
              )}
            </li>
          ))}
        </ol>
      </AdminArea>
      {target !== null && (
        <div className="adm-confirm">
          <p>回滚产生一条新 revision（git-revert 语义），不删除历史。确认回滚到 rev {target}？</p>
          <div className="adm-acts">
            <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(target)}>
              确认
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="adm-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
