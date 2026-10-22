# 架构防回退方案（2026-10-20 协调批准）

依据：owner 2026-10-20 20:24「架构深化改革在做，新代码不能质量低回去」。固定基线 main `58289c05603da53c3846bd141921f6b79a51ab4b`（#1830 已合）。协调已批准实施；不授权改测试，已有拆分继续。只扩既有 `audit:capability-boundaries` / `audit:architecture-deepening` 及其数据文件，不新增 audit 命令、CI job 或新框架。

## 1. 同一事实源、双重比较

复用 #1830 的 `CAPABILITY_BASE_SHA` / `readBaselineBase`、结构化 `changes`、append-only 校验和 `--tighten`。CI 比较精确 base 与 head 的真实源码事实，同时核 head 台账；不能靠同时抬数字与台账过门。base 缺失/不可读沿用 fail-closed。主线数字是上限，不要求每个功能 PR 必须减数；不变可以过，真实下降必须同 PR 收紧。

- capability→server、cross-capability value：各自总数不得上涨；不能跨维度互抵。owner pair 的重组沿用现有“同维度真实抵消+无净增长”判定，但每条新增边仍须逐条来源登记，不能只写净减。**拟取消以普通结构化 ruling 上调这两项总数的通道**；历史记录保留，不追罚已合提交。同PR不能抵消的真实产品需求仅owner可明确批准，必须在PR引用owner原话；changes须有可追溯批准引用和原话，普通协调ruling不够，没有原话硬失败。
- SCC：复用真实图与成员集合比较；每个新 SCC 必须是某个旧 SCC 的子集，参与非平凡 SCC 的成员总数和最大 SCC 成员数不得上升。SCC 个数只报告，不独立拦截；一个大环拆成多个较小独立环可以是改进。SCC=0 后禁止复活。
- 超过1500行源码：count 不上涨，且不得新增 >1500 的源码路径（重命名按 git rename/旧 blob 身份识别，不以换名清零）。存量逐步降，不能删一个 god 文件再加另一个换额度。复用既有扫描器与同一 baseline，统计口径固定且版本化。
- >1000 行增长：base 已>1000的文件只要增长，必须有结构化登记 `{path, baseBlob, from, to, issue, responsibilityReason}`，数值与真实 diff 不符/理由缺失即失败；跨入>1000或新建>1000也登记，防止临界值绕过。登记是追踪责任，不代表证明设计优雅。生成文件/测试沿用现有明确排除口径，不能由 PR 任意追加排除。

## 2. 新依赖来源与薄包装识别

复用现有 import 解析、解析后模块去重与 public-cycle 数据；以 base→head 新增依赖为对象（含动态 literal import、re-export；type-only单列，不假装运行依赖）。跨 capability 只允许既有 public/ui-public 规则，其他共享领域实现经 kernel；manifest/task-catalog 的现有组合根路径保持严格固定，不扩成任意 service locator。新增边须登记调用方、真实目标、拥有的完整操作/事实、消费符号与 issue；记录必须与源码边一一对应。kernel 不得反向转发至 capability/server 来隐藏原依赖。

在 `audit-architecture-deepening` 现有扫描流程扩 AST 检查，禁止仅靠 regex/文件名：
- 新增纯 `export ... from` / `export * from` 别名文件，或新增函数只原样/重排参数调用另一函数并返回（包括 `return await`），无决策、转换、错误边界或状态拥有者：报具体源符号与转发目标，阻断。
- type 声明、schema 实体组合、真实 DTO 转换、协议错误边界不因“很短”自动判薄；只对可确定的转发形态给硬失败。无法静态证明深度的情况交独立审查，不把机器通过写成深模块证明。
- 当前已合的兼容出口按固定 base 存量处理，不能无限增加存量白名单。**新兼容 shim 同样先失败**；协调可逐条特批，但changes必须具备真实旧consumer文件:行、退出条件、Linear票及最长14天截止期；到期硬失败，不能自填字段冒充批准。不放松原门禁，也不删除测试规避兼容需求。base既有兼容口不追罚且只许减少；现有豁免不能扩成新增无期限白名单。

## 3. AGENTS.md 短审查清单（批准后加入）

独立审查逐项给源码证据或 NOT_APPLICABLE：①完整事实/操作只有一个 owner；②窄接口隐藏决策、状态和恢复复杂度，拒绝 pass-through/时序耦合；③两个真实变化场景的理解/修改范围局部，不以行数/import代替收益；④不新增 god 文件，不把业务规则塞进 UI，调用方不重写内部顺序；⑤事务、锁序、幂等、部分完成/恢复与兼容契约清楚，静态/CI/真实运行分开；⑥新依赖来源与所有 ratchet 变化符合机器输出。词汇沿用 codebase-design / ADR-0051 的 deep module、information hiding、complete product operation；不另建长审计框架。

## 4. 实施与验收顺序（已批准）

一份完整职责 PR：先整合最新 main/#1830，再扩既有事实采集/台账和比较规则，最后接 AST 规则与短 AGENTS 清单。原 CI job/required Gate不变，只增加既有audit内判定；PR列出每项语义变化及影响线。现有 source 重构不夹带这些新规则。

不新增/修改/删除测试。先以真实仓库固定 revision 对照旧/新事实，验证存量基线可解释；负例从真实历史 diff/已存在薄包装形态静态核验，不造 synthetic-input 脚本假称运行验收。原有 audit、自身 typecheck/lint/build、独立初审+一次验证审（本片两轮必做）、新 exact Gate按现行流程。若某条新判定缺少可靠负例证据，明确未验证项并补文本方案交 owner；不偷偷写测试或降级为自动放行。

批准范围：总数无普通ruling上调、owner原话例外；SCC子集/总成员/最大成员硬门（个数仅报告）；>1500禁止新增与>1000增长登记；AST新增薄包装阻断及四条件/最长14天兼容特批；AGENTS六项短清单。测试零改。PR逐项列新旧语义，证明不放宽既有门；合入后通知主线、界面线和迁移线，Grok由协调通知。
