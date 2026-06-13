// S14 (YUK-335 批次丙) — ⌘K 命令面板，兑现 topbar searchbox 的可见承诺。
//
// 设计源 docs/design/loom-refresh/project/command-palette.jsx（CommandPalette /
// paletteIndex）：搜索框 + 分组结果 + ↑↓/↵/esc + 点击 + scrim 关 + 选中可见滚动。
// 设计稿 index 用 window.DATA mock（页面 / 知识 / 题库 / 错题 / 学习项）；这里
// 换 **真 SPA 数据**：
//   • 页面组 → 复用 nav-config 的 NAV（与侧栏 / 移动栏同一真理源，不另立漂移的
//     页面表）；route 用 NAV 项的真实 SPA path（/today 等）。
//   • 知识节点组 → open 时 fetch /api/knowledge（getTree，经 apiJson + x-internal-
//     token），title=name route=/knowledge/${id}。
//   • 题库 / 错题 / 学习项 → **省略**（与 S13 nav 同裁断：SPA 无这三条路由，索引
//     它们会造死链 / 假入口，owner 红线不 fabricate）。后续 M 在 SPA 接通后回填。
//
// 路由耦合只经调用方注入的 navigate prop（RootShell 经 router.history.push）——
// 本组件不 import 任何路由库。.cmdk-* 样式由 globals.css（§App shell 端口，
// palette.css L9-74）就位。

import { type KnowledgeTreeNode, getTree } from '@/capabilities/knowledge/ui/knowledge-api';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { NAV, isSection } from './nav-config';

export interface CommandPaletteProps {
  /** 是否打开（RootShell 持 paletteOpen state；⌘K toggle / searchbox 点击驱动）。 */
  open: boolean;
  /** 关闭面板（选中跳转后、esc、scrim 点击）。 */
  onClose: () => void;
  /** 路由推入（RootShell 经 router.history.push 注入）；选中行跳转用。 */
  navigate: (to: string) => void;
}

// 单条可索引结果行。group 是分组标题（页面 / 知识节点）；hay 是分词过滤的检索串。
interface PaletteRow {
  group: string;
  icon: LoomIconName;
  title: string;
  meta: string;
  route: string;
  hay: string;
}

const PER_GROUP = 5; // 设计 command-palette.jsx:41，每组结果上限。

// 页面组：复用 nav-config 的 NAV 真理源（跳过分组标题行）。route = NAV 项真实
// SPA path；meta 显示该 path（设计用 "/" + id，这里用真路径更准）。flatMap +
// isSection 正向 guard 让 TS 收窄到 NavItem（! 否定 guard 在 filter 不传播窄化）。
function pageRows(): PaletteRow[] {
  return NAV.flatMap((entry) =>
    isSection(entry)
      ? []
      : [
          {
            group: '页面',
            icon: entry.icon,
            title: entry.label,
            meta: entry.path,
            route: entry.path,
            hay: `${entry.label} ${entry.id} ${entry.path}`,
          },
        ],
  );
}

// 知识节点组：真 /api/knowledge 行 → 结果。title=name，route=/knowledge/${id}。
function knowledgeRows(nodes: KnowledgeTreeNode[]): PaletteRow[] {
  return nodes.map((n) => ({
    group: '知识节点',
    icon: 'knowledge',
    title: n.name,
    meta: n.effective_domain ?? n.domain ?? '',
    route: `/knowledge/${n.id}`,
    hay: `${n.name} ${n.domain ?? ''} ${n.id}`,
  }));
}

export function CommandPalette({ open, onClose, navigate }: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 知识节点 open 时才 fetch（设计 index 在 open 时构建）；与 KnowledgePage 同
  // queryKey ['knowledge-tree'] → React Query 去重，不增请求。
  const treeQ = useQuery({ queryKey: ['knowledge-tree'], queryFn: getTree, enabled: open });
  const knowledge = useMemo(() => treeQ.data?.rows ?? [], [treeQ.data]);

  // 全量 index（页面组静态 + 知识节点组）。设计 paletteIndex 等价物。
  const index = useMemo<PaletteRow[]>(
    () => (open ? [...pageRows(), ...knowledgeRows(knowledge)] : []),
    [open, knowledge],
  );

  const results = useMemo<PaletteRow[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      // rest 态：页面组 + 前 4 个知识节点入口（设计 command-palette.jsx:38）。
      return index
        .filter((r) => r.group === '页面')
        .concat(index.filter((r) => r.group === '知识节点').slice(0, 4));
    }
    const terms = query.split(/\s+/);
    const seen: Record<string, number> = {};
    return index.filter((r) => {
      const hay = r.hay.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
      seen[r.group] = (seen[r.group] || 0) + 1;
      return seen[r.group] <= PER_GROUP;
    });
  }, [q, index]);

  // 选区随 query 复位（设计 command-palette.jsx:51）。body 只调 setSel——deps 是
  // 「query 变就复位」的真意图，非 body 读取的值。
  // biome-ignore lint/correctness/useExhaustiveDependencies: q drives the reset; the body intentionally only calls the (stable) setter.
  useEffect(() => {
    setSel(0);
  }, [q]);
  // open 时清空 query + autofocus input（设计 command-palette.jsx:52）。
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 保持选中行可见（设计 command-palette.jsx:55-62）。body 读 refs（list/选中行）
  // 但须在 sel / results 变化后跑——deps 是触发条件，非 body 读取值。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sel/results are the triggers; the body reads refs (listRef + queried row), not these values.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[data-sel="1"]');
    if (el && list) {
      const t = el.offsetTop;
      const b = t + el.offsetHeight;
      const st = list.scrollTop;
      const h = list.clientHeight;
      if (t < st) list.scrollTop = t - 8;
      else if (b > st + h) list.scrollTop = b - h + 8;
    }
  }, [sel, results]);

  // a11y：Tab 困在 dialog 内 + 关闭时焦点回原触发元素 + Esc 关（既有 modal 模式，
  // 与 onKeyDown 的 esc 幂等——都调 onClose）。
  useFocusTrap(open, onClose, panelRef);

  const pick = (r: PaletteRow | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.route);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  let lastGroup: string | null = null;
  return (
    // .cmdk-scrim 是定位 + flex 居中容器（无 role）；点击关闭由一个铺满的真
    // <button> 承载（键盘可达，沿 CopilotDrawer/PfSolo scrim 先例），避免 div+onClick
    // 的 a11y 漏洞。.cmdk 是真 dialog（role=dialog），esc / Tab-trap / autofocus 由
    // input onKeyDown + useFocusTrap 覆盖。
    <div className="cmdk-scrim">
      <button
        type="button"
        aria-label="关闭搜索"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        className="cmdk"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> 需 imperative
        // showModal()/close() API，与受控 open prop + scrim/focus-trap 模式不兼容
        // （同 CopilotDrawer / PfSolo）。
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="cmdk-head">
          <LoomIcon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索卡片、节点、错题…"
            aria-label="搜索"
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">没有匹配「{q}」的结果。</div>}
          {results.map((r, i) => {
            const head =
              r.group !== lastGroup ? (
                <div className="cmdk-group" key={`g${r.group}`}>
                  {r.group}
                </div>
              ) : null;
            lastGroup = r.group;
            return (
              <Fragment key={`${r.group}:${r.route}`}>
                {head}
                <button
                  type="button"
                  className={`cmdk-row${i === sel ? ' on' : ''}`}
                  data-sel={i === sel ? '1' : '0'}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(r)}
                >
                  <span className="cmdk-ic">
                    <LoomIcon name={r.icon} size={15} />
                  </span>
                  <span className="cmdk-title">{r.title}</span>
                  {r.meta ? <span className="cmdk-meta mono">{r.meta}</span> : null}
                  <LoomIcon name="arrow" size={13} className="cmdk-go" />
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot mono">↑↓ 选择 · ↵ 打开 · esc 关闭</div>
      </div>
    </div>
  );
}
