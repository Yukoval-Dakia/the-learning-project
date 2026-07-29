# YUK-820 affected-unit selector backfill

**日期**：2026-07-29  
**结论**：20/20 样本可计算 affected set，0 fallback、0 direct-test miss；切换 PR
required unit 为 affected，main push、global trigger 与 selector failure 继续 full。

## 方法

选择最近 20 个会被当前 lane planner 判为 `unit_selection=affected` 的已合并 PR。
每个样本使用 GitHub 保存的最终 PR head 与 `baseRefOid`：

1. 在 detached worktree checkout 最终 PR head；
2. 运行当前 selector：
   `vitest list --changed=<baseRefOid> --filesOnly --staticParse`；
3. 同一历史 checkout 列出当时的完整 unit test inventory；
4. 检查直接改动且属于 unit partition 的 test 是否全部进入 affected set；
5. 核对该最终 PR head 的历史 required full gate 为 success。

这不是把当前 HEAD 对旧文件清单做静态猜测；selector 和完整 inventory 都在对应历史
PR head 上求值。20 个样本覆盖 server/API/job、UI、AI prompt/registry、跨进程状态、
测试-only 与多文件重构。

## 结果

- 20/20 selector `effective_mode=affected`
- 20/20 final PR full gate success
- 0 selector fallback / 0 selector error
- 19 个直接改动 unit test files，0 漏选
- 累计选择 474 / 9,661 test files（4.91%）
- 单 PR selection ratio：median 3.31%，min 1.02%，max 11.70%
- selector + direct-test inventory guard：median 3,849 ms，min 3,190 ms，max 4,833 ms

| PR | head | base | selected / full | ratio | direct unit tests | misses | selector ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| [#1081](https://github.com/Yukoval-Dakia/the-learning-project/pull/1081) | `16ef0c9d` | `c6ac037e` | 18 / 504 | 3.57% | 1 | 0 | 3,849 |
| [#1075](https://github.com/Yukoval-Dakia/the-learning-project/pull/1075) | `97176c13` | `8bc8e2ee` | 6 / 500 | 1.20% | 0 | 0 | 3,857 |
| [#1071](https://github.com/Yukoval-Dakia/the-learning-project/pull/1071) | `74ea0de3` | `6f7b1d40` | 7 / 500 | 1.40% | 0 | 0 | 3,764 |
| [#1070](https://github.com/Yukoval-Dakia/the-learning-project/pull/1070) | `c901c605` | `9aae957c` | 15 / 495 | 3.03% | 0 | 0 | 3,765 |
| [#1059](https://github.com/Yukoval-Dakia/the-learning-project/pull/1059) | `fe61e225` | `f10cc6b6` | 5 / 492 | 1.02% | 0 | 0 | 3,322 |
| [#1057](https://github.com/Yukoval-Dakia/the-learning-project/pull/1057) | `814e5262` | `f10cc6b6` | 18 / 492 | 3.66% | 0 | 0 | 3,190 |
| [#1056](https://github.com/Yukoval-Dakia/the-learning-project/pull/1056) | `7cdb5a60` | `f10cc6b6` | 15 / 492 | 3.05% | 0 | 0 | 3,493 |
| [#1052](https://github.com/Yukoval-Dakia/the-learning-project/pull/1052) | `ce2c7524` | `28e2812c` | 57 / 487 | 11.70% | 1 | 0 | 3,751 |
| [#1045](https://github.com/Yukoval-Dakia/the-learning-project/pull/1045) | `48d263e8` | `ce648b9a` | 16 / 483 | 3.31% | 0 | 0 | 3,800 |
| [#1037](https://github.com/Yukoval-Dakia/the-learning-project/pull/1037) | `0499f0b0` | `c06871c0` | 15 / 480 | 3.13% | 0 | 0 | 4,098 |
| [#1036](https://github.com/Yukoval-Dakia/the-learning-project/pull/1036) | `00768cd9` | `c06871c0` | 35 / 481 | 7.28% | 3 | 0 | 3,850 |
| [#1025](https://github.com/Yukoval-Dakia/the-learning-project/pull/1025) | `7adad3f0` | `4cb5b966` | 52 / 475 | 10.95% | 3 | 0 | 3,460 |
| [#1022](https://github.com/Yukoval-Dakia/the-learning-project/pull/1022) | `06716adc` | `91dd6490` | 11 / 475 | 2.32% | 0 | 0 | 4,487 |
| [#1021](https://github.com/Yukoval-Dakia/the-learning-project/pull/1021) | `dcef1e00` | `91dd6490` | 6 / 475 | 1.26% | 1 | 0 | 4,003 |
| [#1020](https://github.com/Yukoval-Dakia/the-learning-project/pull/1020) | `92d75682` | `91dd6490` | 47 / 475 | 9.89% | 1 | 0 | 4,669 |
| [#1011](https://github.com/Yukoval-Dakia/the-learning-project/pull/1011) | `be93f9a0` | `5b26698d` | 14 / 471 | 2.97% | 2 | 0 | 4,300 |
| [#1010](https://github.com/Yukoval-Dakia/the-learning-project/pull/1010) | `4dbfd812` | `5b26698d` | 53 / 471 | 11.25% | 2 | 0 | 4,833 |
| [#1008](https://github.com/Yukoval-Dakia/the-learning-project/pull/1008) | `21d57577` | `5b26698d` | 52 / 471 | 11.04% | 2 | 0 | 4,447 |
| [#1007](https://github.com/Yukoval-Dakia/the-learning-project/pull/1007) | `06a0c036` | `5b26698d` | 17 / 471 | 3.61% | 1 | 0 | 3,547 |
| [#1002](https://github.com/Yukoval-Dakia/the-learning-project/pull/1002) | `2516ab1f` | `0a469897` | 15 / 471 | 3.18% | 2 | 0 | 3,532 |

## 证据边界与切换护栏

这些最终 PR head 都是 full-green，因此不能把“0 个 missed failing files”冒充故障注入
证明。它们证明的是：历史真实 diff 可稳定求值、直接改动 test 不漏、selected set 远小于
full，并且当时完整套件全绿。Comparator 的 missed-failure / fallback 行为另由
`scripts/ci/unit-shadow.test.ts` 的负控固定。

基于 owner 允许历史 backfill 代替等待 20 个未来 PR，切换仍保留：

- unknown/global/base/diff error → full；
- selector 缺失、无效、fallback 或空 affected set → full；
- main push → full canary；
- source-scanning invariant tests 永远并入 affected set；
- required affected run 的退出码仍由 aggregate gate 强制为 success。
