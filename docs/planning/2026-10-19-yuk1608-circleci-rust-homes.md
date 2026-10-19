# YUK-1608 — CircleCI Rust parity 安装权限

交付阶段：第一天能用。审计根项：YUK-1608 / CI 的真实 native、WASM、JS 一致性门禁。

## 原始失败与边界

PR #1837 exact c2b80ee433f376b5106c5eecf9c067d0e4700600 的 CircleCI job 152，
workflow 6e43af8d-61a9-470b-8a13-0a1b5f47eac4，在 rustup toolchain install 写
`/usr/local/rustup/tmp` 时返回 EACCES。日志 SHA256：
`044fc621ba80b568c0022036946dada4c668da10eaa675819e8df578b65a0869`。

CircleCI 实际把 `.github/workflows/ci-gate.yml` 转为 `ubuntu-2404:gha` machine
上的 Actions 执行。toolchain 安装先于 Swatinem/rust-cache，因此本次不是恢复的
Cargo cache 导致。旧日志没有实际 UID/目录 owner，不能伪称已读到它们；修复步骤
会打印 id 与仅 Rust 目录的 owner/mode，供真实 runner 回执核对。

## 修复

只在 parity lane 的原 toolchain action 之前，将 RUSTUP_HOME、CARGO_HOME 指向
RUNNER_TEMP 下由当前用户创建的专用目录，验证可写后用 GITHUB_ENV 传到后续步骤，
并保留 Cargo bin 的 PATH 接线。不更改 HOME，不 sudo/chown 系统目录。

原 Rust action commit、stable/wasm32-wasip1-threads、Cargo cache action、数值测试、
native/WASM 构建、REQUIRE_RUST_PARITY=1、文件存在门、四个 parity suites 及最终
Gate 依赖均不变。不增加或修改测试代码。

## 验收

需新固定 head 的 CircleCI 日志证明：实际用户/目录、Rust 安装成功、native/WASM
产物存在、全部现有 parity suites 执行成功。GitHub 同 head 的成功不能替代它。
旧 job 152 原始失败保留，不盲重跑旧代码。#1837 的 GitHub architecture baseline
差异由 #1830 另行处理，不能归因本 runner 权限，也不在此修改 baseline。

当前：实现与本机静态验证进行中，真实修复后 CircleCI parity 尚未运行。
