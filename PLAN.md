# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-27 凌晨（三版：mass-ulw 连续推进日终态，main @ 82196ffa）

## NOW

- **mass-ulw 连续推进日收官**：全天累计 **28 PR 合并 / 31 票 Done + 12 Canceled**，
  开放 PR = 0。主线纪事（按序）：
  - 纠偏四连：Buildkite 停止（916/917/918 Canceled）→ 工具链移出 required gate
    （#1262）→ 产品三连（#1250/1251/1252）→ YUK-898 移除项目级插件声明（#1264，
    treadmill 终结）+ YUK-846 结案（凭证过期）。
  - 批准件落地：903 更正 picker（#1267）/ 596 收口盘点（#1268）/ A 包五张
    （915 #1269 / 919 #1270 / 911 #1276 / 339 #1278 / 913 #1279 / 340 #1284 /
    784 #1285）。
  - 工程面：522 PDF abort（#1271）/ 909 Biome ratchet 上线基线 337（#1272）/
    605+555 quiz_gen 手动端点（#1273）/ 893 judge lane 语义分离（#1274）/
    739 rating/cause 进 SubjectProfile（#1281）/ 496 calibration genesis（#1280）/
    plan-then-generate 对齐 ADR-0038（#1282）/ ADR-0038 solve_check 修订（#1277）。
  - **YUK-839 双轮 burn-in**：工程落地（#1275）→ R1 产品预算 FAIL → R2 owner 授权
    诊断（1h/leg + thinking cap 16k）**acceptance #6 机械层 PASS**——resume 获真实
    流量铁证（digest 前缀保持 / accepted 零重提 / 续跑 usage），报告 #1283+#1286，
    spend $8.08。产品 480s 预算下维持不可达判定。

## NEXT

1. **在飞**（mass-ulw wave-7，session 内推进）：YUK-390 residual（脏 kind 清理 +
   词表收敛，解锁 391/392 链）/ YUK-537 item1（边 un-archive 仅 reactivate 清除）。
2. **待 owner 五件**：
   - ① glm-5.3-flash 是否进生产 validator lane（需 ≥25min 预算 vs 产品 480s，
     YUK-839 留 In Review）；
   - ② copilot 回复语气基调（YUK-340 唯一停下的分叉）；
   - ③ YUK-679 二选一：LIGHT（ADR-0046 豁免段成文）vs FULL（port 进 crate，
     需 Rust 线 owner lane）；
   - ④ YUK-371 关闭或改写（其「零-LLM 确定判定」验收与 ADR-0038 修订冲突）；
   - ⑤ 多 provider 方案一重启时点（YUK-921 停放中，开放问题已记录在票）。
3. **工程池后续**：YUK-391/392（判分镜像收敛/生成端塌缩，依赖 390 residual）。

## PARKED

- **多 provider 方案一**（YUK-921）：方向已批、实施搁置待 owner 重启；内部耦合
  地图完成（runner.ts 唯一硬绑点，生命周期/记账/durable 层全中立）；市场调研因
  agent 循环止损，不作决策依赖。
- A3 裁决维持：确认关票包 8 张 Canceled、human-gated 除 887/859/856 外先躺、
  strategic ~40 张不动；记录 `.remember/a3-backlog-triage-2026-08-16.md` 附录。
- 本地 main 脏树残余 = `.codex/config.toml` + 未跟踪工具目录（无害）。
- YUK-360 blocked-on-upstream（mem0 usage API）；yuk-822 worktree 待 owner。

## BLOCKED-ON

- 887 / 859 / 856：生产部署授权闸（Architecture Deepening 收口条件，不变）。
- Production rollout / observation：无授权不起（不变）。
