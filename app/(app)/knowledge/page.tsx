'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: string | null;
  effective_domain: string | null;
}

export default function KnowledgePage() {
  const q = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  const nodes = q.data?.rows ?? [];
  const childrenByParent = new Map<string | null, KnowledgeNode[]>();
  for (const n of nodes) {
    const parent = n.parent_id;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent)?.push(n);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }
  const roots = childrenByParent.get(null) ?? [];

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader
        title="知识图谱"
        eyebrow="/knowledge"
        sub={nodes.length > 0 ? `共 ${nodes.length} 个节点` : undefined}
      />

      {q.isLoading && (
        <Card>
          <p style={mutedStyle}>正在加载…</p>
        </Card>
      )}

      {q.isError && (
        <Card>
          <p style={errorStyle}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </Card>
      )}

      {q.isSuccess && roots.length === 0 && (
        <Card pad="lg">
          <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--ink-3)' }}>
            还没有知识节点。AI 会在归因 / 提议时自动生成。
          </p>
        </Card>
      )}

      {q.isSuccess && roots.length > 0 && (
        <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
          <ul style={treeRootStyle}>
            {roots.map((node) => (
              <TreeRow key={node.id} node={node} childrenByParent={childrenByParent} depth={0} />
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}

interface TreeRowProps {
  node: KnowledgeNode;
  childrenByParent: Map<string | null, KnowledgeNode[]>;
  depth: number;
}

function TreeRow({ node, childrenByParent, depth }: TreeRowProps) {
  const kids = childrenByParent.get(node.id) ?? [];
  return (
    <li style={{ marginLeft: depth === 0 ? 0 : 'var(--s-4)' }}>
      <Link href={`/knowledge/${node.id}`} style={rowStyle}>
        <span style={nameStyle}>{node.name}</span>
        {node.effective_domain && <Badge tone="neutral">{node.effective_domain}</Badge>}
      </Link>
      {kids.length > 0 && (
        <ul style={treeChildStyle}>
          {kids.map((k) => (
            <TreeRow key={k.id} node={k} childrenByParent={childrenByParent} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const treeRootStyle: React.CSSProperties = {
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const treeChildStyle: React.CSSProperties = {
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginTop: 4,
  paddingLeft: 'var(--s-3)',
  borderLeft: '1px solid var(--line-soft)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  padding: '6px 8px',
  borderRadius: 'var(--r-2)',
  textDecoration: 'none',
  color: 'var(--ink)',
  transition: 'background var(--dur-fast) var(--ease-out)',
};

const nameStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  color: 'var(--ink)',
};
