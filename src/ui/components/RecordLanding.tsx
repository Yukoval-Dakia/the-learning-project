// A8 (YUK-354) — 录入成功着陆视图（IngestExit）。
//
// 取代录入成功后的硬跳 /mistakes：录完不再把人丢去一个死链，而是停在一个「有交代」
// 的着陆页 —— 收好了什么、进了哪些通道、挂到哪些知识点、现在能做什么（去练 / 去看
// 知识点 / 再录一份）。owner 锁定形态 = 停留的着陆页（非瞬时 toast）：成功后停留，
// 不自动跳走，多出口由用户选。
//
// PORT 自 docs/design/loom-refresh/project/screen-record-a8.jsx 的 IngestExit
// (L86-165) + record-a8.css 的 .ing-exit* 类（视觉参考，样式落地在 web/src/globals.css，
// 不整文件拷 record-a8.css）。只实现成功态；失败 / 退化态（RescueFail / DegradeBanner /
// figure-crop / docx·emptyblock 退化 banner）OUT-OF-SCOPE，本组件不碰。
//
// 数据现实（诚实优先）：录入响应给的是「计数 + id」，不带 title / 树路径 / 块数。所以
//   - 产出回执 = 计数（手填 1 / 批量 question_ids.length）。
//   - 「进了哪棵树」树路径响应没有 → 本期不做树路径（设计源那段是 mock）。
//   - 「挂到哪些知识点」手填可真实列（selectedKnowledge → label）；批量响应不带
//     knowledge_ids → 诚实占位（knowledgeUnavailable），不编。

import { Btn } from '@/ui/primitives/Btn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';

export interface RecordLandingKnowledge {
  id: string;
  label: string;
}

/**
 * 纯函数：把用户刚选的知识点 id 数组映射成 {id,label}（label 取自 knowledge query
 * 的节点 name，缺失时回落到 id —— 诚实，不编 label）。保留 selectedIds 的原始顺序。
 * 抽成纯函数便于 ManualForm 在 onSuccess 时一行调用 + unit 测（无 DB）。
 */
export function knowledgeLabelsFor(
  nodes: { id: string; name: string }[],
  selectedIds: string[],
): RecordLandingKnowledge[] {
  const byId = new Map(nodes.map((n) => [n.id, n.name]));
  return selectedIds.map((id) => ({ id, label: byId.get(id) ?? id }));
}

export interface RecordLandingProps {
  /** 已收好的题数：手填恒为 1；批量为 question_ids.length。 */
  count: number;
  /** true = 批量拍试卷导入；false = 单条手填。影响文案与「继续传 / 再录一份」措辞。 */
  isBatch: boolean;
  /** 用户为这批题挂的知识点（手填可真实列；批量传 []）。 */
  knowledge: RecordLandingKnowledge[];
  /**
   * true = 知识点去向不可得（批量导入响应不带 knowledge_ids），渲染诚实占位而非空列表。
   * 见 follow-up：wire 扩展批量 import 响应带回 knowledge_ids 后可去掉占位。
   */
  knowledgeUnavailable?: boolean;
  /** SPA 跳转（去练 /practice · 去看知识点 /knowledge/:id · 去错题本 /mistakes · 回今日 /today）。 */
  navigate: (to: string) => void;
  /** 「再录一份 / 继续传」：重置回录入表单（停留在录入面，不离页）。 */
  onRecordAnother: () => void;
}

export function RecordLanding({
  count,
  isBatch,
  knowledge,
  knowledgeUnavailable = false,
  navigate,
  onRecordAnother,
}: RecordLandingProps) {
  // 编排者主动提议可被克制地收起（呼应 A3 主动开口）。收起后只留一行确认，不再追问。
  const [proposalDismissed, setProposalDismissed] = useState(false);

  return (
    <div className="ing-exit">
      <div className="ing-exit-hero">
        <div className="ing-exit-hero-top">
          <span className="ing-exit-hero-ic">
            <LoomIcon name="check" size={18} />
          </span>
          <span className="ing-exit-title">收好了 —— 这是它变成的东西</span>
        </div>
        <p className="ing-exit-lede">
          <b>{count} 道题</b>已收好。下面是它的去向和你现在能做的事 —— 不会把你丢在空页面。
        </p>
      </div>

      <div className="ing-exit-grid">
        <div className="ing-exit-card">
          <div className="ing-exit-card-l">
            <LoomIcon name="items" size={13} />
            收进了哪些通道
          </div>
          <ul className="ing-exit-channels">
            <li>
              <LoomIcon name="check" size={12} />
              <span>
                题库 · <b>{count} 道题</b>
              </span>
            </li>
            <li>
              <LoomIcon name="check" size={12} />
              <span>
                错题本 · <b>已标记</b>
                <span className="ing-channel-note">（标记，非独立通道）</span>
              </span>
            </li>
          </ul>
        </div>

        <div className="ing-exit-card">
          <div className="ing-exit-card-l">
            <LoomIcon name="knowledge" size={13} />
            挂到了哪些知识点
          </div>
          {knowledgeUnavailable ? (
            <p className="ing-exit-empty">导入响应未带知识点 id，wire 扩展后补。</p>
          ) : knowledge.length === 0 ? (
            <p className="ing-exit-empty">这次没有挂知识点。</p>
          ) : (
            <div className="ing-node-list">
              {knowledge.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="ing-node"
                  onClick={() => navigate(`/knowledge/${n.id}`)}
                >
                  <span className="nm">{n.label}</span>
                  <LoomIcon name="arrow" size={13} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 编排者主动提议出题（呼应 A3 主动开口）—— 克制、可忽略。 */}
      {proposalDismissed ? (
        <div className="ing-exit-dismissed">
          <LoomIcon name="check" size={14} />
          好的，先不出题 —— 需要时在练习里随时叫我。
        </div>
      ) : (
        <div className="ing-proposal">
          <LoomIcon name="sparkle" size={15} />
          <div className="ing-proposal-body">
            <span className="ing-proposal-trigger">录入后 · 编排者主动开口</span>
            <div className="ing-proposal-text">
              {isBatch
                ? `这批 ${count} 道题已收进题库。要不要现在就拿它们出一组练习？`
                : '这道题已收进题库。要不要现在就拿它出一组练习？'}
            </div>
            <div className="ing-proposal-acts">
              <Btn size="sm" variant="primary" icon="layers" onClick={() => navigate('/practice')}>
                好，去出题
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setProposalDismissed(true)}>
                先不用
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div className="ing-exit-foot">
        <Btn variant="secondary" icon="record" onClick={onRecordAnother}>
          {isBatch ? '继续传' : '再录一份'}
        </Btn>
        <Btn variant="ghost" icon="mistakes" onClick={() => navigate('/mistakes')}>
          去看错题本
        </Btn>
        <Btn variant="ghost" icon="today" onClick={() => navigate('/today')}>
          回今日
        </Btn>
      </div>
    </div>
  );
}
