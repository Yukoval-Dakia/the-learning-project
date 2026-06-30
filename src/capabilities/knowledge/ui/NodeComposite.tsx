// A5 S3 (YUK-354) — NodeComposite 三维折叠（R · p(L) · difficulty）+ TransferList /
// DiagnosticDrill 诚实空态。PORT 自设计源
// docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 NodeComposite / TransferList /
// DiagnosticDrill。
//
// ⑥治理：三维各走离散档 + 区间 + 来源二态 + 低置信（复用 S1 BandChipView），绝不裸数字。
// 三轴正交：R ⟂ p(L) ⟂ difficulty，同屏并列绝不合并，纯 READ（band 化由 node-dims 纯函数做）。
//
// 诚实空态（忠于冷启设计，不假造）：
//   - TransferList：borrowed-θ 软层（applyKgSoftLayer）是 dark-ship（flag
//     GRAPH_LAPLACIAN_ENABLED / PREREQ_THETA_PROPAGATION_ENABLED 默认 OFF）→ 默认不产
//     transfer 项 → 渲设计的诚实空态。**不强行 wire borrowed-θ**（flag-gated future，
//     接线属后续片）。
//   - DiagnosticDrill（CDM/IRT）：无后端读路径（grep 零命中）→ 渲设计的诚实空态「证据
//     不足 / 低置信」。**不假造 CDM/IRT 数字**（无后端 follow-up）。
//   - MisconceptionList（S4 误区）本片完全不碰。

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';
import { BandChipView } from './BandChip';
import { A5_BANDS, UNKNOWN_BAND_LABEL } from './mastery-band';
import { type NodeThreeDimInput, buildNodeThreeDim } from './node-dims';

export interface NodeCompositeProps {
  /** 焦点节点的三维 RAW 读模型（node-page wire 平铺字段的结构子集）。 */
  input: NodeThreeDimInput;
}

export function NodeComposite({ input }: NodeCompositeProps) {
  const [open, setOpen] = useState(false);
  const three = buildNodeThreeDim(input);
  const comp = three.composite;
  const compBand = comp.unknown ? UNKNOWN_BAND_LABEL : A5_BANDS[comp.band];

  return (
    <div className="kd-composite">
      <div className="kd-composite-main">
        <div className="kd-composite-head">
          <span className="kd-composite-band">{compBand}</span>
          <span className="kd-composite-cap">
            三维折叠为单标量 · R 记忆 · p(L) 掌握 · difficulty 难度
          </span>
        </div>
        <BandChipView view={comp} />

        {three.coldNote && (
          <div className="kd-cold-note">
            <LoomIcon name="alert" size={14} />
            {three.coldNote}
          </div>
        )}

        <button
          type="button"
          className={`kd-dim-toggle${open ? ' open' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <LoomIcon name="chevronDown" size={14} />
          {open ? '收起三维' : '展开三维 · R 记忆 / p(L) 掌握 / difficulty 难度'}
        </button>

        {open && (
          <div className="kd-dims">
            {three.dims.map((d) => (
              <div key={d.key} className="kd-dim">
                <div className="kd-dim-row">
                  <span className="kd-dim-label">{d.label}</span>
                  <BandChipView view={d.view} labels={d.labels} unknownLabel={d.unknownLabel} />
                </div>
                {d.note && <div className="kd-dim-note">{d.note}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── transfer credit (RT2) — 诚实空态 ──
// borrowed-θ 软层 dark-ship（flag 默认 OFF）→ 当前无 transfer 项可识别。接 borrowed-θ
// 是 flag-gated future（后续片 / flag 翻转后），本片不假造迁移来源。
export function TransferList() {
  return <div className="quiet-empty">暂无可识别的迁移来源。</div>;
}

// ── diagnostic drill-down (CDM 属性画像 / IRT 区分度) — 诚实空态 ──
// 无后端读路径（CDM/IRT 软轨指标尚未热起来）→ 渲设计的诚实空态，不显示假精度。
// 接 CDM/IRT 是无后端 follow-up，本片不假造诊断数字。
export function DiagnosticDrill() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`kd-diag${open ? ' open' : ''}`}>
      <button
        type="button"
        className="kd-diag-bar"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="kd-diag-ic">
          <LoomIcon name="graph" size={17} />
        </span>
        <span>
          <span className="kd-diag-t">诊断下钻 · CDM 属性画像 / IRT 区分度</span>
          <span className="kd-diag-s">证据不足，慢热期暂不出诊断</span>
        </span>
        <LoomIcon name="chevronDown" size={18} className="kd-diag-chev" />
      </button>
      {open && (
        <div className="kd-diag-body">
          <div className="kd-diag-empty">
            <LoomIcon name="eye" size={16} />
            证据不足 / 低置信 —— 软轨指标（a / c / CDM /
            KT）还没热起来，这里不显示假精度。练几道就会逐步出现。
          </div>
        </div>
      )}
    </div>
  );
}
