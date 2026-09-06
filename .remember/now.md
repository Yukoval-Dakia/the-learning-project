# 当前 handoff — 2026-09-06，完整重构goal active

## 当前949收口；下一条948/950统一持续会话

- Owner最新决定：Copilot消息不分前后台，默认不中断，对标ChatGPT；旧Mission按钮提案撤回。
  后端复用copilot_run唯一owner，HTTP断线仅取消订阅；关闭/刷新可从服务端恢复，不依赖sessionStorage。
  后续消息必须持久接纳同一会话并顺序消费；不接受session_busy409或“先Stop再发”降级。
  显式Stop、安全/预算限制仍有效；需补teaching与945原生compaction到worker，不能丢已有能力。
  不做shared SDK卷/亲和部署；worker只恢复本进程确实拥有的SDK session，否则事件cold start。
  Linear948 In Progress、950 Todo已对齐。新UI代码未实施，旧UI preflight已撤回。

- 964工作树 /Volumes/YukovalSBak/yukoval-projects/tlp-wt-mimo-cost-truth，codex/yuk-964-mimo-cost-truth。
  实施25ae0dc4，PR1343；37unit/24runnerDB/reviewPASS/typecheck/lint/build/audit通过。
  正数MiMo SDK派生USD改为catalog公开卡estimated，未知保持null；不重写历史/不改其它provider。
  10条945实际wire免费回放与新成本owner完全相符，无新付费；已合入main8e534d3c，待最新exactCI。
  CI389b365d的4条失败均为旧failed/partial SDK费用断言；改为estimated数值且保留状态/usage/恢复保护。
  root扩大AI目录scoped unit：32files/418tests全绿；PR1343 exactc1afae75 CI34036794558全绿。
  已于13:51:49Z合并main9e02c48b，Linear Done；不删这些高价值失败测试。

- /Volumes/YukovalSBak/yukoval-projects/tlp-wt-native-compaction，codex/yuk-945-native-compaction。
- 产品18702ab9经143scoped/唯一复审PASS；草稿PR1339旧exact821184ac CI34031520139绿。
- 新实际harness8f7a438a、长样本de18fcaa；真实摘要质量已通过两样本。
  PR1339 exact60429d44 CI34035583914全绿，已于13:27:30Z合并main8e534d3c，Linear Done。
  最终集成148scoped/typecheck/lint/build通过，无生产部署。
- 短样本session8e50d9a1-b8dc-42ff-91d3-e2017a703754：1057→1388，不称降本；
  长样本session8709f3db-a35e-4b87-91d3-c2a3981dbf93：11977→1590。
  120个过期学习记录，保留现行3节点/关系方向/数值/来源/未知vs零/未批准更正；
  同session续问有更新learner且不重发旧fixture。native manual compact，不是auto阈值或队列E2E。
- 新$10池估算花费$0.0130696878，保守请求预留$0.90823；此前$0.28771982另列。
  估算基于官方公开USD卡，不是账户账单；旧未知timeout/child仍未知。没有其他新付费调用。
- .env.local无key预检0调用；正确凭据源是原树.env，仅加载不打印/修改。
- 初稿scripts/ai/native-compaction-actual.ts因缺预算/输出/保留验收被root撤掉；
  正式tests/acceptance/native-compaction.ts有5请求/字节/output/90s/预留限制及失败证据。
- SDK autoCompactWindow最低100000；不能用非法小窗口或合成usage声称真实节省。
  learner每轮注入、proposal digest、原权限/6轮/预算不变，rawCoT/summary不写产品usage。

## 949独立实施

- /Volumes/YukovalSBak/yukoval-projects/tlp-wt-primary-view-owner；ADR0061在799ea23c。
- Owner明确FULL，允许按需短control交互；保留3source/agent意图，server最终验证；不提预算、不改UI。
- ea8367c7初稿未完成：初审5P1（read丢hero/任意ref+legacy绕过/durable丢pv/
  删除944prompt关键约束/4个新增lint错误），已在81eb7f3e修复；该agent提交clean并释放。
- root当前独占949工作树，ed693e16已合入main9e02c48b，保留945/964。唯一验证审原5P1已修，
  新发现storage kind无UI导航；root将owner lookup改为canonical ref发布，6DB导航契约与76unit绿。
  208集成unit、49durableDB、typecheck绿。新增4个opt-in actualcases，preflight通过、尚无新付费。
  以上为actual前状态，当前更新：root59156663，唯一验证审PASS（原5P1+canonical-ref均收口）。
  8个shipped浏览器case三类/none、inline/durable与刷新重放均绿；本地server82638已停止。
  949实际7回合estimated $0.0214406071，预留$2.8；新$10池总estimate $0.0345102949、
  reserve $3.70823，安全剩$6.29177。没有付费调用运行中，旧池$0.28771982仍单列。
  成功：process/nohero、tool_result精确真实call_id、author_artifact真实保存后artifact。
  未通过语义：HTML三次错误称关闭消失/未持久化/未写入持久存储，原始模型失败保留。
  只读咨询后root081471e4实施shared commit-owned说明，不做regex删句/模型评估/新增paid。
  writer检查输入hash→追加固定权威保存说明→reseal；durable repair/replay共享，前台清理不一致SDK cursor。
  三条真实终文免费重放policy全部通过；当前322unit/56DB/typecheck/lint/build绿；无第三轮review。
  首个tool actual因root harness JSON键序误判失败，改isDeepStrictEqual复验过；首失败也计费并保留。
  docs/planning/evidence/2026-09-06-presentation-control-actual.json封存全部7个原始终文/digests/runIDs，
  不把结构script pass当人工semantic pass，不持久化CoT。
  PR1345已推cc3afecd；CI34039845298其余lane绿，DB2运行30分钟后取消，未合并。
  新advisory P1确认为同一行题目+答案绕过校验；三例RED，补句首直接指令识别后58unit绿。
  保留实际报告/修辞问句不误拦；等待新提交与fresh exact CI，无新付费、无第三轮review。
- 原implement_primary_view_owner已停止；review_primary_view_owner初审已用，唯一验证审正在收口最后canonical-ref问题，不开启第三轮。
  不信任原worker的完成或“lint错误已有”说法，后者被实际diff和review否证。

## 已交付与下一步

- 961 PR1340 exact69542b2d CI34032977403绿，main50ba305b，48DB/reviewPASS，LinearDone。
- 963 PR1342 exact417623b5 CI34034266076绿，main4034859c，70unit/reviewPASS，LinearDone。
- 962 PR1341 exacta522a60f CI34034085071绿，mainc43d51be，59unit/reviewPASS，LinearDone；
  617unit/426DB共1043文件，不删断言、不移动尚有传递DB依赖或Bun独立测试。
- 944 PR1338 main db5a57b1；五读取actual核心通过，40410vs40401不证降本；960仍开放。
- 964已去重登记：更新MiMo本地占位估算卡与来源，官方价格页2026-08-06已公开分模型费率。
- 既有Pipeline/Goal/Knowledge/Import/execution/ReviewSettlement/客户端状态/测试退休均有合并证据。
  946仅原生catalog/body渐进加载验证Done，不建第二catalog、不删quiz。
- 下一条948/950统一持续会话、960分类器与全业务扩展验收继续；不是当前PR即整体完成。
  960已在独立tlp-wt-report-question-boundary修复并推PR1344 exact960d0b64：29unit+全部localgates+唯一复审。
  CI34038363273初次仅旧proposal-tools归因DB超时60s+后续preparedstatement错误；精确两例本机通过，
  已重跑failed lane，同类原762已去重重开Todo。两次worker把新format errors错说baseline，被root纠正。
  PR1344同exact失败lane重跑后全绿，已合并3791bf4d，root已合入949树。
  210c6051恢复原mid-line问句锚避免无意扩大检测；与949一起交付，不改变实际报告修复。
- 依赖438/0/47与5capability SCC/20命令消费者保留；不为数字重做已封装learning-intent。
- 不动原始脏main、不部署/改SoT/backfill/删历史；887需独立生产副本授权，
  951需完整drain窗口；921/572/832HOLD不解锁。
