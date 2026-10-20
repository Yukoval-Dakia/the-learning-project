# 出题输出验证与材料职责归属（YUK-1572）

独立 writer：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-e0c956e0`。
base `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，branch
`arch/yuk-1572-quiz-gen-knowledge`；从 fetch 后的 origin/main 新建，未带父旧提交。
源码提交 `35399b53a0dbaca9bc64322864df1502f14d200e`，tree
`531821d1b5a86acf880816878525568685bb0cff`。父已核准旧出口删除与完整职责接入。

## 两个职责与真实消费者

- `server/quiz/quiz-gen-output.ts`：完整的 JSON 提取、schema 校验、持久形状
  判分契约验证、风险修复标记及解析错误类。唯一生产消费者是同 capability 的
  `jobs/quiz_gen.ts`：原 874 行解析及原 2037 行 catch 判别。错误类只定义一次；
  throw 与 instanceof 共享同一 binding，不复制、不包装、不改 reason/message。
- `server/quiz/quiz-gen-material.ts`：完整的材料题面呈现与同一材料的来源补全。
  job 原 946 行 composite stem、1287 行 flat prompt 调用嵌入；1273 行调用来源
  补全。render 与 copy-safety 必须看到同一原始材料，故属于同一材料职责。
- 不建 barrel、registry、白名单、stable 或 compat。两个旧材料 export 没有任何
  外部代码／测试 consumer，删除已获父核准；不保留无消费者重导出。

原 job 的完整直接 importer：manifest.ts（lazy buildQuizGenHandler）、
public.ts（QuizGenJobData 类型）、quiz_gen.test.ts（buildQuizGenHandler / runQuizGen）、
quiz_gen.typecheck.ts（QuizGenJobData）、scripts/dev/question-supply-spike.ts（动态 runQuizGen）。
这五处不需修改；没有其它材料或解析符号 importer。quiz_verify.ts 与一份旧 planning
只有材料函数名的解释性文本，不是代码绑定。

## 行为及受保护区

原 class / parse 完整实现仅增加内部模块导出声明；材料块逐字搬移。
JSON helper 保留原 import、调用参数与 warn 标签；risky repair 仍只认 jsonrepair，
schema 拒收仍经同一 placementSchemaFailure，判分契约异常仍直接外抛。
解析模块没有 DB/provider 操作，但调用的 JSON helper 有原存量 warn 日志，
不宣称完全无副作用。材料 trim、逐行 blockquote、空内容返回、500 UTF-16 code-unit
截段、URL/非空 snippet 去重、前插顺序与原 declared 数组／ref 对象身份均保留。

现有 job 仅删除原 302–414 职责块和它们独占的 imports、加入四个真实绑定
imports。原 415–EOF（包括所有调用）逐字不动；K1 save/submit、主 run、placement
admission/paid/fence、检索、persist/dispatch、预算及失败恢复顺序均保护。
不改 question-contract、placement helpers、schema、audit、baseline、CI、package、lock
或测试。JSON PR1912 尚未落在本 base，不能提前吞并其 import 改动。

## 两个真实维护场景与五标准

1. JSON 修复风险级别或 persisted judge-contract 校验规则变化：之前在混合 job 的
   parseOutput 内修改；之后只改输出验证模块。前后均是一个编辑点，job 的 raw text、
   subjectProfile、parsed/parseRepaired 及错误分类知识不减少。
2. 阅读材料展示格式或来源 snippet 去重／截段规则变化：之前改 job 内两个函数；
   之后改同一材料模块，仍是一个文件。job 继续负责 grounded/closed-book 分支及
   composite/flat 区别；这部分 caller 知识不减少，未把事务材料化职责迁出去。

五标准：责任按验证门／材料可见性与溯源分开；接口为 2+2 个有真实 consumer 的
绑定；既有解析和材料规则移入各自 owner、没有新增隐藏知识；变化局部性只改善
审读和归属、不减少编辑点；行为证据限于源码等价与静态语法，不冒称 runtime 验收。
这属于完整职责归位，不称新增算法深度，不以行数或迁址称接口深化。

## 验证与交接

静态实测：三个源码文件 node --check 及 git diff --check 均 returncode 0；
原 154–301、415–EOF 逐字相同（后者 SHA256
`6194b9ac1c42114483e339455df16ab663a36685d4c2c33188cb07b5667ed10c`）；
class / parse 除 export 声明、material 全块逐字相同。job 2055→1939 行，
output 69 行、material 56 行；仍超过 1500，不为尺寸触及保护段。
缺 node_modules，未 install/update/复制；源码与证明已报父请求串行一次 frozen install。
typecheck、lint、build、capability-boundaries 与 architecture-deepening：NOT_RUN。
没有实跑 audit，不预付指标收益；baseline 原样，若实测变化由父裁定登记。
全部 tests/vitest、DB、TEST、Docker、daemon、provider、runtime、demo、paid：NOT_RUN。
不 push、PR、watch、review、Linear 或清树。未发现范围外新 actionable 缺陷；
tracker capture、最终审查、CI、baseline 实测登记与整合由父负责。

源码证据：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/
YUK-1572/35399b53a0dbaca9bc64322864df1502f14d200e/quiz-gen/source-proof/`，
含 full diff、保护块比较、完整 caller census、语法 raw stdout/stderr、argv/UTC/真 rc；
sha256.json `351d97dc8f4c7610ba37a08394a463adb19d3edb767f3f307ec8b7e372adc11f`。
原 preflight seal 独立保留，未覆盖。待决仅父安装／五门、独立审查及 CI／整合；
不存在待批 compat、未知 caller 或范围扩张请求。源码与短文档提交后 clean 停止 writer。
