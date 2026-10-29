# Cleanroom 做题页接入（进行中）

Owner要求完整页面M3E，不保留旧外壳后称全页完成；cleanroom作者只读需求和Google规范完成V2，父线负责现役owner接入。
基线：46b680bbea3156f760b7640754a8708b92e466e5。

## Preflight与精确边界

`2026-10-27-m3e-direction-and-migration.md` §1：
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。

§5 Companion：
> 关闭/卸载读取与显式 Stop 是不同动作

类型：page / navigation / complementary，与既有modal安全层。
父owned：新cleanroom-practice目录及其设计文档；PracticeSolo呈现、PracticeFacePage标题focus接缝；RootShell练习分支呈现；CompanionMount纯variant下传与CompanionPanel/Composer/MessageStream/RunFooter的可见呈现。
不修改usePracticeSubmit/controller/transport/Start routes/业务schema。
RootShell的现有theme、query、快捷键、常驻CompanionMount不迁移；PracticeFacePage题级key和next/back不迁移。

## 当前实际修改

- 从V2原样复制后封存candidate-v2.json，原作者树不写。
- PracticeContent拆为独立纯出口，页面数据不用伪造伙伴状态。
- 节点refs为签发placeholder、pagehide、submit快捷键、结果通知、quotable各自保留落点；由owner按真实状态条件传入，不能在错误视图挂签发ref。
- 高级题面使用互斥可见questionBody slot；冲突、历史、选区动作、浮层保有真实可见slot。不得挂隐藏旧UI驱动业务。
- 伙伴删去显示枚举自行推导的额外禁发，只消费owner availability；保留4000字符限制。
- 新PracticeNavigation消费原NAV投影；RootShell仅practice分支使用新scope/header，保留同一ShellMain和常驻CompanionMount位置。搜索、主题、开合仍回调原owner。

## 当前集成与证据边界

PracticeSolo现已消费新PracticePresentation → PracticeContent；原hook逐字未改。高级题面、原生response、附件与冲突仍使用原安全/确定性renderer，呈现样式限制在新scope。RootShell只替换practice分支chrome；唯一CompanionMount保持原位，Panel通过CompanionSurface承载原MessageStream/RunFooter/Composer，不重新推断消息、队列或多run状态。提示/大图portal、搜索与toast补足局部明暗作用域。选项仅对letter标记显示层复用原withoutLabelPrefix一次；number/none正文原样保留，不改存储/option ID，不递归剥离重复前缀。

实际本机typecheck、lint、build、capability-boundaries、architecture-deepening均exit0；lint166既有warnings。初次边界审计失败于将REASONING_TRACE_MAX_LEN移到新adapter；已把原依赖保留在原PracticeSolo并显式传显示参数，无新增kernel边。未改测试，未跑测试。

真实页面：5174既有Vite开发入口，恢复已有item与已有伙伴session，不创建新demo。实看题干/公式/未选择答案、禁用提交、摘要与空composer、桌面亮/暗、390×844伙伴sheet与题页、Esc退出；未答题/提交/发消息/provider。snapshot工具随后多次超时，最后一次portal样式改动后的完整截图未取得；不宣称最终exact-head全状态浏览器通过。

motion：已将AndroidX固定9b2acdf2e的fast spatial (mass1,stiffness800,dampingRatio.6)解析采样为CSS linear()变量，rest→rest 421ms/103points，但按钮尚未消费此transition/easing，不能称动效已接入。CSS中断不保持解析速度连续，不称完整Web物理引擎。伙伴/结果不加空间入场，避免干扰阅读；移除旧flight装饰。整题引用仍接原intent，但旧式passage材料缺少选区引用标记与显式材料引用操作，尚未恢复。

首次独立R1（6b3fc8616）发现1项P1：数字标记会把1.5显示为5；已将number/none恢复为原文，并取消第二次剥离，修复验证审与exactCI待完成。另2项P2（按钮spring未接线、旧式材料引用入口缺失）不在本轮P1修复中扩写，留原1473完整页面验收继续跟进，不称已修或整页完成。真实判分/流式/unknown/错误恢复、读屏/IME/全部布局及外部iframe内部主题仍NOT_RUN；生成内容iframe安全边界保留，不注入主题脚本。原1473继续InProgress。

证据：/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/cleanroom-integration-20261029/（checks.json、五项log、browser-evidence.json与实际PNG）。
只读接缝及动效来源：/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1473-cleanroom-m3e-20261029/{integration-seams.md,web-motion-mapping.md,motion-samples.json}。
