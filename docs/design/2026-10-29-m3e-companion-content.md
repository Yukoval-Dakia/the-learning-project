# 学习伙伴内容层级与状态呈现

服务「第一天能用」，YUK-1473 / YUK-1351。基线 `47176204165eb29dd53df75d1b98bcf85d8b355f`。
本片是现役组件的项目 M3E 呈现实现，不是整面板或真实业务验收。

## UI preflight

组件类型：other，现役 CompanionPanel，保留 side / float / sheet 及原 dialog/complementary 语义。
正式依据 `docs/design/2026-10-27-m3e-direction-and-migration.md` §5 L87：
「一次只推进一个有界 UI 产品片。Astra 是该片唯一 UI writer」。
同节精确交接 Companion 原文：「关闭/卸载读取与显式 Stop 是不同动作」；
「视觉不得自建恢复 owner、重发未知 turn 或把流文本当持久提交」。

Owned：`CompanionPanel.tsx` 仅现有根增加静态标记；同目录 `companion.css` 追加局部呈现；
`src/ui-next/tokens.css` 让同一已核 M3E tokens 在 companion-content 标记下可用；本文。
MessageStream / MessageRow / SummaryCard / Composer / RunFooter 是现役样式消费者，源码不改。
2026-10-29 已读 #2157 ef81be83 的真实文件清单，和上述文件无交集，不重派或接管其审查。
不写 controller/use-companion/run-tracker/turn-actions、client、context、frontdoor、业务 schema 或任何发送/Stop/撤销/paid 逻辑。
旧 dirty 树原样保留；独立父 writer，Astra standard/default，无 Fast。

## Google 依据与映射

实读 [Google Expressive 研究](https://design.google/library/expressive-material-design-google-research)：
强调关键动作、相关内容分组，同时保留熟悉交互和标签。
[Google Web focus](https://web.dev/learn/accessibility/focus/) 要求可见焦点和逻辑顺序；本片不调整 DOM/Tab 顺序。
[Material color](https://m3.material.io/styles/color/the-color-system) 直读仅 JS 提示，完整组件规范缺口保留。
具体数值沿已核 AndroidX `0d64d21b2ee80232c76e8ee2c6b8d5373ab03a06` 的
ColorLight/Dark、Palette、TypeScale、Shape、FilledCard 与 OutlinedTextField tokens，
见已合 `2026-10-27-m3e-practice-page.md` 与原始官方文件；没有另造品牌色或 Web spring 参数。

| 现役消费者 | 本片呈现映射 | 合同边界 |
| --- | --- | --- |
| CompanionPanel / MessageStream | surfaceContainerLow 面板、lowest 对话区域；头部与底部有明确边界，取消 float 内容透光 | 位置/尺寸/滚动/visit/焦点陷阱和开合全保 |
| SummaryCard | headlineSmall emphasized 欢迎语、titleMedium 节标题；lowest 摘要容器，折叠按钮保持原 aria-expanded | loading/error/已读摘要的内容条件原样，不把未知变为空 |
| MessageRow | bodyLarge 16/24 正文；用户 secondaryContainer 气泡，AI 直接正文，状态 bodyMedium 14/20 | streaming 仍显式「生成中 · 还未生效」，不把颜色变化当提交；tombstone/partial/错误文本保留 |
| RunFooter | quiet 低层容器、caution 次级容器、critical errorContainer；文本可换行，按钮原生语义保留 | 接纳未知、断流、Stop、重试分支和可用性不变，不创建进度百分比 |
| Composer | outlined 项目输入组合、surface/outline，focus-visible 明确描边；发送 primary/onPrimary | Enter/Shift+Enter/IME、disabled、消息用途保护、引用落点与 draft 不变 |

CSS 尺寸/字阶为项目 Web 映射，沿现有同源中文字体，不称官方现成 React/M3E 库。
只扩展显式 token opt-in 选择器，未改现有 practice 取值/主题优先级，不重绑全站旧 aliases。
工具卡/教学卡/历史列表、动作按钮/Chip/Segmented完整 M3E 状态、motion physics 不是本片完成声明。
旧 ui-next 视觉引用由当前 M3E 决定覆盖；作用域/同源/无业务逻辑约束保持。

## 验证边界

tests 零写零跑；browser/截图/视觉/键盘/读屏/窄屏/明暗实测、真实消息/DB/provider/runtime/paid/部署均 NOT_RUN。
静态 AST/选择器/颜色核对不能替代上述验收；只按原预算一次独立 Astra R1 与新 exact-head CI 收口。
