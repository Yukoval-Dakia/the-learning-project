# O1：长任务能否追踪到交付

| 流程 | 学习者可见状态 | 刷新／离开／新tab | 失败／超时／provider错误 | success≠交付 | 重试／处置入口 | 实测墙钟时间 |
|---|---|---|---|---|---|---|
| 照片：OCR→结构→auto-enroll | 有session抽取状态、识别块；结束后仍“等待处理进度” | session/2块恢复；6个textarea全空、0KC，复审状态错 | 坏PNG上传201后异步失败；错误刷新可见。provider超时未注入 | 抽取/auto_enroll成功≠题已准入：2题withheld/container_only，无attempt | 重新上传可见；未重复调用付费extract | 抽取5.725s；auto-enroll7.352s；坏图首次失败5.968s |
| PDF文件导入 | 有session抽取/识别状态 | 同session/1块恢复，表单仍空、复审称尚未自动录入 | PDF成功路径；DOCX/大文件/provider失败unknown | 1题withheld/container_only，无attempt；不能把安全准入门叫评分失败 | 页面重新上传；未验证复试 | 抽取5.751s；auto-enroll7.712s（含初次入库） |
| LearningIntent→accept→笔记fanout | outline复用已有pending；note页只有draft/version与空笔记，无job状态 | 产物可按URL读；没有生成义务/失败状态的恢复证明 | parse失败→retry耗尽→DLQ，页面仍空；651.913s provider terminated仅DB有回执 | **确认**：NoteGenerateTask success后业务parse失败；ready还有needs_review层 | 未见learner失败重试；operator恢复路径未执行 | accept187/235ms；首篇可读长笔记1293.026s（21分33秒） |
| Copilot turn | 有streaming/排队/停止/回答状态 | 刷新、导航、新tab重新认证均恢复3ask/2answer/1停止 | 排队B取消回执可见；运行中cancel/provider失败unknown；C取消already_settled | 本次A/C均有已提交reply，不能据此保证工具副作用 | 停止按钮验证排队case；付费重试未执行 | A回答提交14.282s；C20.283s含队列；B取消约34ms |
| hint | 有“正在想下一阶提示”、H0正文 | **失败**：完成后刷新重开同题变“尚未开始”；DB帮助原件仍在 | timeout/provider错误unknown；未测试pending中刷新 | 本次已返回正文；帮助状态丢失是恢复问题 | 可见重新发起提示；未再付费验证同阶去重 | POST→正文201：3.797s |
| coach_daily | Today有昨夜未出计划的降级文字，非逐job状态 | 降级/历史摘要可读；无逐job恢复证据 | Admin能看模型失败聚类；2 failed+2 DLQ；模型success后的parse问题不出现在该失败清单 | **确认**：唯一CoachTask success对应today_plan=null、plan_parse_error=true | 历史operator路径有静态CLI；未见页面DLQ重放按钮、未运行CLI | 已有成功模型任务145.218s；不是learner交付时间 |
| Memory Brief | 摘要文字可读，非regen进度/失败状态 | 摘要跨导航可读；不能算job跟踪恢复 | 有既有失败/DLQ；本次自然regen有完成回执 | 当前摘要确被UI消费；不保证所有scope同时更新 | 未见逐scope的失败/重放入口 | math最新证据→刷新22.747s；global例149.913s（排队+生成） |
| Mem0 ingest/reconcile | 没有逐事实准入/等待/失败状态 | PG lineage可查；无learner job恢复面 | 历史11 failed+11 DLQ；SDK wire/usage/cost不全 | 源撤回后仍有迟到memory出生，不能等同业务有效记忆；检索质量未测 | operator replay CLI静态存在但未演练 | provider操作start/finish封存；不能据其内部时长冒充交付时长 |
| Dreaming/maintenance | 无learner逐job状态；Admin模型日志可读 | 无逐job恢复证据 | Dreaming2 failed+2 DLQ；maintenance1 failed+1 DLQ | 任务成功未穷尽校验派生消费，不作统一交付结论 | 未见DLQ重放按钮；未重启/恢复 | 已有Dreaming成功模型211.894s；maintenance交付时间unknown |
| placement starter | 有“备题中”，后续终态不一致 | URL恢复同session/claim；耗尽后仍“子图还冷” | 3次schema-invalid→EXHAUSTED/failed/DLQ，UI不显示失败 | **确认**：3次QuizGenTask success，0题，无法开始定位 | “改为上传”/“重新查询”可见；未验证后者付费重试 | 创建job→失败617.949s（10分18秒） |

口径：10类流程中，**5/10有job或session级状态，4/10验证能恢复相同追踪身份，1/10（hint）确认恢复失败，另5/10没有相应追踪面或未验证**。照片/PDF身份恢复不代表内容恢复；placement恢复的是错误的“仍在备题”状态。**3类确认模型success不等于业务交付：笔记、Coach、placement。** 这组数字不是10类端到端PASS率，也不是故障率估计。失败、超时、取消、provider错误分别注明，未跑的路径不补成PASS。


Source: YUK-1388 stage4/R01/report.md (2026-10-10). These are audit observations, not current delivery status.
