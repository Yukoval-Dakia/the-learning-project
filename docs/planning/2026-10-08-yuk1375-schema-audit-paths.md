# YUK-1375：schema audit 仓库相对路径

修复提交4370670a69a588ba5e04f6d12902d93379647bf6仅改审计脚本与测试。文件发现返回绝对路径，原过滤规则误匹配工作树祖先名test-storage，排除了生产源码。现在在发现边界把map key规范为仓库相对路径；真实test/spec/fixture/rehearsal/generated/d.ts排除、AST分析器和allowlist保持。

同一真实文件树分别置于ordinary/test-storage/spec-worktree/fixtures祖先下的结果一致；包含跨文件alias/caller追踪、嵌套字段不冒充顶层写入、fixture调用方不能供应生产证据，以及historical-retained表非法写入。回归先RED后GREEN。

实施验证：四个scoped文件123测试、typecheck/lint/build退出0；两改动文件Biome无诊断，全仓297既有warnings。父核32项SHA清单，并独立复跑audit文件54测试通过。父真实CLI产生170467字节非空JSON，与子任务结果完全一致：885字段、0未豁免stub、41已有allowed stub，无allowlist hygiene或retention问题。原准确基线731未豁免/119allowed；恢复809个原stub的生产写入证据，另10字段增加既有写入计数。未通过改allowlist掩盖结果。

证据：/tmp/yuk1375-evidence.md、/tmp/yuk1375-sha256.txt、/tmp/yuk1375-comparison.json、/tmp/yuk1375-parent-unit.log、/tmp/yuk1375-parent-cli.json。审计仍是有界静态语法证据，不证明运行时行为或完整迁移完成。未修改产品/schema/dependencies，未操作runtime，无需为此工具修复重部署应用。

当前独立只读review仍在进行，exact-head CI待push；不能先记Done。没有新暴露的未豁免stub或需独立建票的缺陷，41已有allowed项保持原归属。下一实施票1376承接/mistakes非UI迁移，主线负责最终挂载。
