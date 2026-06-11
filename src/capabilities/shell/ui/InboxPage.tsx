// M4-T6 (YUK-319/YUK-318)：收件箱页（设计稿 screen-mistakes.jsx ScreenInbox
// L128-203）。偏差（design pre-flight 预批）：
// ①科目 FilterRow 不渲——科目轴 M5 随 effective_domain 派生收编，eyebrow 同步
//   去「按科目」；
// ②空态 CTA「去看错题本」改「去看知识图」——错题本未迁 SPA；
// ③stagger 容器类是 globals .today-loom scoped，错落改为 per-card
//   animationDelay（lane 内 index × 50ms）；
// ④resolved 留痕 map 同设计稿本地 state（裁决后卡片淡化留痕，刷新后消失）。
// edge-preview 的节点名经 knowledge getTree 建 id→name map 白话化。

import { getTree } from '@/capabilities/knowledge/ui/knowledge-api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ProposalCard } from './ProposalCard';
import { KIND_META, kindMeta, listProposals } from './inbox-api';
import './shell.css';

function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="filter-row">
      <span className="filter-row-l">{label}</span>
      {options.map(([v, l]) => (
        <button
          type="button"
          key={v}
          className={`chip${value === v ? ' is-on' : ''}`}
          onClick={() => onChange(v)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export interface InboxPageProps {
  navigate: (to: string) => void;
}

export default function InboxPage({ navigate }: InboxPageProps) {
  const [kindFilter, setKindFilter] = useState('all');
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['proposals', 'pending'], queryFn: listProposals });
  const treeQ = useQuery({ queryKey: ['knowledge-tree'], queryFn: getTree });

  const nameOf = useMemo(() => {
    const map = new Map((treeQ.data?.rows ?? []).map((n) => [n.id, n.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [treeQ.data]);

  const showError = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const rows = q.data?.rows ?? [];

  // lane 顺序：按 KIND_META 键序稳定排列，未知 kind 追加在尾（fallback 同
  // kindMeta：绝不丢卡）。
  const laneKinds = useMemo(() => {
    const present = new Set(rows.map((r) => r.kind));
    const known = Object.keys(KIND_META).filter((k) => present.has(k));
    const unknown = [...present].filter((k) => !(k in KIND_META));
    return [...known, ...unknown];
  }, [rows]);

  const visibleKinds = kindFilter === 'all' ? laneKinds : laneKinds.filter((k) => k === kindFilter);
  const visible = kindFilter === 'all' ? rows : rows.filter((r) => r.kind === kindFilter);
  const remaining = visible.filter((r) => !resolved[r.id]).length;

  const typeOpts: [string, string][] = [
    ['all', '全部'],
    ...laneKinds.map((k): [string, string] => [k, kindMeta(k).label]),
  ];

  const breakdown = laneKinds
    .map((k) => `${kindMeta(k).label} ${rows.filter((r) => r.kind === k).length}`)
    .join(' · ');

  const costTotal = rows.reduce((acc, r) => acc + (r.cost_micro_usd ?? 0), 0);

  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : rows.length === 0
        ? 'empty'
        : 'ok';

  const clearedEmpty = (
    <EmptyState
      icon="checkCircle"
      title="收件箱已清空"
      text="所有提议都已裁决。新提议会在下次 Dreaming session 后出现。"
      action={
        <Btn variant="secondary" iconEnd="arrow" onClick={() => navigate('/knowledge')}>
          去看知识图
        </Btn>
      }
    />
  );

  return (
    <main className="page wide inbox-loom">
      <header className="page-head">
        <div className="eyebrow">INBOX · AI 提议 · 按类型筛选</div>
        <h1 className="page-title serif">收件箱</h1>
        <p className="page-lead">
          每条 AI 提议都带一句白话来源说明，逐条 accept /
          dismiss。每次裁决写入一条事件，下次不再露面。
        </p>
      </header>

      <LoomCard pad sunk style={{ marginBottom: 'var(--s-5)' }}>
        <div className="inbox-summary-row nowrap-meta">
          <span className="card-icon accent">
            <LoomIcon name="sparkle" size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>
              {remaining} 条待裁决{kindFilter !== 'all' ? ' · 已筛选' : ''}
            </div>
            <div className="meta">
              {breakdown}
              {costTotal > 0 ? ` · 累计 $${(costTotal / 1e6).toFixed(4)}` : ''}
            </div>
          </div>
        </div>
        <FilterRow label="类型" options={typeOpts} value={kindFilter} onChange={setKindFilter} />
      </LoomCard>

      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="提议列表暂不可用。"
        skeleton={<SkLines rows={4} />}
        empty={clearedEmpty}
      >
        {remaining === 0 ? (
          kindFilter !== 'all' ? (
            <EmptyState
              icon="filter"
              title="没有匹配的提议"
              text="放宽类型筛选试试。"
              action={
                <Btn variant="secondary" onClick={() => setKindFilter('all')}>
                  清除筛选
                </Btn>
              }
            />
          ) : (
            clearedEmpty
          )
        ) : (
          visibleKinds.map((k) => {
            const laneRows = rows.filter((r) => r.kind === k);
            const live = laneRows.filter((r) => !resolved[r.id]).length;
            const meta = kindMeta(k);
            return (
              <section key={k}>
                <SectionLabel count={live || null}>
                  <span className="inbox-lane-label">
                    <span className={`lane-ic tone-${meta.tone}`}>
                      <LoomIcon name={meta.icon as LoomIconName} size={14} />
                    </span>
                    {meta.label}
                  </span>
                </SectionLabel>
                <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
                  {laneRows.map((p, i) => (
                    <ProposalCard
                      key={p.id}
                      p={p}
                      index={i}
                      resolved={resolved[p.id] ?? null}
                      nameOf={nameOf}
                      navigate={navigate}
                      onResolve={(id, label) => setResolved((r) => ({ ...r, [id]: label }))}
                      onError={showError}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </Stateful>

      {toast && (
        <div className="pf-toasts" aria-live="polite">
          <div className="pf-toast t-info">
            <LoomIcon name="close" size={15} className="ico" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}
