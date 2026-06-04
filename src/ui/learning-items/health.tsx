'use client';

// D11 health-bar aggregation + bar (read-time only, zero owned state — see
// docs/design/2026-06-04-u0-decisions.md D11③). Shared by the learning-items
// list page and the [id] detail page so the 口径 cannot drift (CodeRabbit,
// PR #294). For a learning item's knowledge_ids: count nodes, sum overdue
// due-cards, average mastery over nodes WITH evidence. evidence-guard: if
// every node has evidence_count < 3 the bar renders muted (no misleading
// mastery%).

/** Structural subset of the pages' KnowledgeNode — only what health needs. */
export interface HealthKnowledgeNode {
  mastery: number | null;
  evidence_count: number;
}

export interface ItemHealth {
  nodeCount: number;
  dueCount: number;
  avgMastery: number | null;
  lowEvidence: boolean;
}

export function aggregateHealth(
  knowledgeIds: string[],
  knowledgeById: Map<string, HealthKnowledgeNode>,
  dueSummary: Record<string, { overdue: number; due_soon: number }> | undefined,
): ItemHealth {
  const nodeCount = knowledgeIds.length;
  let dueCount = 0;
  let masterySum = 0;
  let masteryNodes = 0;
  let anyEvidence = false;
  for (const kid of knowledgeIds) {
    dueCount += dueSummary?.[kid]?.overdue ?? 0;
    const node = knowledgeById.get(kid);
    if (node) {
      if (node.evidence_count >= 3) anyEvidence = true;
      if (node.evidence_count > 0 && node.mastery !== null) {
        masterySum += node.mastery;
        masteryNodes += 1;
      }
    }
  }
  const avgMastery = masteryNodes > 0 ? Math.round((masterySum / masteryNodes) * 100) : null;
  return { nodeCount, dueCount, avgMastery, lowEvidence: !anyEvidence };
}

export function ItemHealthBar({ health }: { health: ItemHealth }) {
  if (health.nodeCount === 0) return null;
  return (
    <div className={`item-health${health.lowEvidence ? ' muted' : ''}`}>
      <span className="health-seg">
        <span className="health-n tnum">{health.nodeCount}</span>
        <span className="health-l">知识点</span>
      </span>
      <span className="health-seg due">
        <span className="health-n tnum">{health.dueCount}</span>
        <span className="health-l">到期</span>
      </span>
      <span className="health-seg">
        <span className="health-n tnum">
          {health.avgMastery === null ? '—' : `${health.avgMastery}%`}
        </span>
        <span className="health-l">平均掌握</span>
      </span>
    </div>
  );
}
