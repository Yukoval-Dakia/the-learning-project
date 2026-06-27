// YUK-455 inc-E — prereq 诊断「向后传播」的 PURE 半（无 IO，cross-subject，住 core/）。
//
// 本模块只有「拓扑闭包 → 风险增量」这一步纯函数 + owner 固定先验常数。所有 DB/event
// IO（闭包 SQL walk + writeEvent emit）住 src/server/mastery/prereq-propagation.ts，
// 与 core/「无 IO」边界一致（同 pfa.ts / theta.ts 的纯数学住 core、写者住 server）。
//
// ── 是什么 ────────────────────────────────────────────────────────────────
// surmise relation 的「诊断向后半」：学习者答错 KC B，沿 KG 的 prerequisite 边向上
// 找 B 的（transitive）前置 A，按「离 B 越近 implication 越强」给每个受波及前置 A 算
// 一个掌握风险增量 risk_delta。这是观测投影（喂画像），不是判分。
//
// ── n=1 admissibility（litmus）─────────────────────────────────────────────
// 信号来源 = 单学习者 B 的自作答 outcome（failure）+ KG 拓扑（owner 供给的 prerequisite
// 边）+ owner 固定的传播权重/衰减常数。**无** a/slip/guess/φ/discrimination 等跨被试
// 方差参数 → 过 litmus。常数是 owner 固定先验（非拟合 item 参数）。
//
// ── 红线（ADR-0035 三轴正交）──────────────────────────────────────────────
// 向后风险**绝不可**折进 mastery_state.theta_hat / fail_count——前置 A 从未被作答，
// 写「假 fail」会用非证据污染 Elo 充分统计量、破坏三轴正交。本纯函数只产出独立的
// risk_delta 投影；写者只 EMIT event（独立 outbox 投影），永不写 mastery_state。
//
// ── PHASE-DEFERRED ────────────────────────────────────────────────────────
// 传播权重 / 衰减常数是 n=1 magic number——精确取值留待 owner 从 emit 出来的 risk_delta
// 分布里 N 周后选定（同 ADR-0040 决定2 的「先埋点再定阈」范式）。emit 阶段每条事件带
// threshold_deferred:true，埋点期不 gate 任何 live 行为（选题/p(L)/θ̂ 均不读）。

/** depth-1（失败 KC 的直接前置）处的风险幅度。owner 固定先验，非拟合参数。 */
export const PREREQ_RISK_BASE_WEIGHT = 1;

/**
 * 每跨一跳 prereq 链的几何衰减：depth-d 的前置拿 BASE · DECAY^(d-1)。B 失败的
 * implication 沿 prereq 链越往上越弱。owner 固定先验 ∈ (0,1)；精确值是 n=1 magic
 * number，待 emit 分布定（threshold_deferred）。
 */
export const PREREQ_RISK_DEPTH_DECAY = 0.5;

/**
 * 一条闭包边：从某个失败 KC 向上 walk 到的一个（transitive）前置。
 *   - prereq_kc：被上调掌握风险的前置 A。
 *   - source_kc：anchor 这条分支的失败 KC B（沿链向上不变）。
 *   - depth：从失败 KC 到该前置的跳数（1 = 直接前置）。
 */
export interface PrereqClosureEdge {
  prereq_kc: string;
  source_kc: string;
  depth: number;
}

/** 单条 (失败 KC, depth) 对某前置的风险贡献——证据可追溯用。 */
export interface PrereqRiskContribution {
  source_kc: string;
  depth: number;
  risk: number;
}

/** 一个前置 KC 的聚合风险读数。 */
export interface PrereqRiskReading {
  /** 被上调掌握风险的前置 KC（A）。 */
  knowledge_id: string;
  /** 聚合后的风险幅度 ∈ (0, baseWeight]——取所有贡献的 MAX（最近/最强 implication）。 */
  risk_delta: number;
  /** 所有贡献里的最小跳距（离任一失败 KC 最近的距离）。 */
  min_depth: number;
  /** 每条 (失败 KC, depth) 贡献，确定性排序。 */
  contributions: PrereqRiskContribution[];
}

export interface PrereqRiskOptions {
  /** 覆盖 depth-1 风险幅度（默认 PREREQ_RISK_BASE_WEIGHT）。 */
  baseWeight?: number;
  /** 覆盖每跳衰减（默认 PREREQ_RISK_DEPTH_DECAY）。 */
  depthDecay?: number;
}

/**
 * prereqRiskFromAttempt — PURE：把一组（已 walk 好的）prereq 闭包边折算成 per-前置-KC
 * 的聚合风险读数。确定性、无 IO、无随机。
 *
 * 聚合语义：多个失败 KC / 多条路径可能在不同 depth 到达同一前置——risk_delta 取所有
 * 贡献里的 MAX（最近/最强 implication），同时保留每条贡献作证据。退化自实现：
 *   - 空闭包 → 空 Map（NO-OP）。
 *   - prereq_kc === source_kc 的自指边丢弃（KC 不对自己的前置风险负责）。
 *
 * @param closure 已 walk 好的闭包边（IO 在 server 层 loadPrereqClosure 产出）。
 * @returns Map<前置 KC, 聚合风险读数>。
 */
export function prereqRiskFromAttempt(
  closure: PrereqClosureEdge[],
  opts?: PrereqRiskOptions,
): Map<string, PrereqRiskReading> {
  const baseWeight = opts?.baseWeight ?? PREREQ_RISK_BASE_WEIGHT;
  const depthDecay = opts?.depthDecay ?? PREREQ_RISK_DEPTH_DECAY;

  const byPrereq = new Map<string, PrereqRiskReading>();
  for (const edge of closure) {
    // 自指边丢弃——闭包理论上不产（base case 已排 from<>to），防御性兜底。
    if (edge.prereq_kc === edge.source_kc) continue;
    const risk = baseWeight * depthDecay ** (edge.depth - 1);
    const contribution: PrereqRiskContribution = {
      source_kc: edge.source_kc,
      depth: edge.depth,
      risk,
    };
    const existing = byPrereq.get(edge.prereq_kc);
    if (!existing) {
      byPrereq.set(edge.prereq_kc, {
        knowledge_id: edge.prereq_kc,
        risk_delta: risk,
        min_depth: edge.depth,
        contributions: [contribution],
      });
    } else {
      existing.contributions.push(contribution);
      // MAX implication（最近/最强）= risk 最大；min_depth 同步取最近跳距。
      existing.risk_delta = Math.max(existing.risk_delta, risk);
      existing.min_depth = Math.min(existing.min_depth, edge.depth);
    }
  }

  // 贡献确定性排序（source_kc 升序，再 depth 升序）——emit payload 可复现。
  for (const reading of byPrereq.values()) {
    reading.contributions.sort(
      (a, b) => a.source_kc.localeCompare(b.source_kc) || a.depth - b.depth,
    );
  }
  return byPrereq;
}
