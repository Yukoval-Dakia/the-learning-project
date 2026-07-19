# YUK-697 — jyeoo-rs producer hardening: patch proposals

> 日期：2026-07-19
> 状态：**提案**。`~/jyeoo-rs/` 是 owner 本地代码（非 git、只读）——本 lane **未改动**它。
> 下列统一 diff 供 owner 过目后自行落。行号基于 2026-07-18 快照的源文件。
> 关联：`docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md` §5（VIP、ID 漂移）、
> `~/jyeoo-rs/docs/DESIGN.md` §9（已知限制）。

## 背景：两处确定性缺口（loom 侧无法弥补，必须在 producer 修）

1. **detail cache 无 TTL → ID 漂移下旧题顶包**。`cache.rs::load_cached` 命中即返回（仅查
   文件 >50 字节）。但 detail ID 会漂移（同一 ID 数小时后映射到同考卷另一题，DESIGN §9），
   陈旧 cache 会把**已改指的 ID** 返回成旧题。loom 侧对此无能为力（它只看 producer 输出的
   题面）。修法：cache 加 24h TTL（过期即 miss，重抓）。

2. **非 VIP / VIP 过期 → 有洞 reference_md 被产出**。非 VIP 详情页的 analysis/solution/comment
   被服务端随机抽稀（**语义级错误**，非单纯残缺）；`client.rs::html_checked` 只检 `游客模式/
   loginform/Recharge`（→ Auth exit 3），**不检 VIP 过期**——一个 cookie 有效但非 VIP 的账号
   会静默产出有洞题面。loom 侧只能做**兜底**（见下「loom 侧已实现的对接闸」），但**权威闸必须
   在 producer**：详情页模板 `var vip = 'False' == 'True'` 命中即整体失败、绝不入 parse/cache。
   新增专用退出码 **6 = VIP required/expired**（区别于 3 = auth，让 loom 侧确定性分类）。

---

## Patch 1 — `src/cache.rs`：detail cache 加 24h TTL

```diff
--- a/src/cache.rs
+++ b/src/cache.rs
@@
 //! 磁盘 cache：`.cache/{ques_id}.json`（RawQuestion），断点续传。
 
 use crate::model::RawQuestion;
 use crate::Result;
 use std::path::Path;
+use std::time::Duration;
+
+/// YUK-697 — detail ID 会漂移（同一 ID 数小时后指向同考卷另一题，DESIGN §9）。
+/// 陈旧 cache 会把已改指的 ID 返回成旧题。任何超过此 TTL 的条目视为 miss（重抓）。
+const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
 
 /// 命中且文件 >50 字节且可解析则返回；否则 None（损坏不报错，重抓）。
 pub fn load_cached(cache_dir: &Path, ques_id: &str) -> Option<RawQuestion> {
     let path = cache_dir.join(format!("{ques_id}.json"));
     let meta = std::fs::metadata(&path).ok()?;
     if !meta.is_file() || meta.len() <= 50 {
         return None;
     }
+    // YUK-697 — 过期即 miss（ID 漂移防旧题顶包）。mtime 不可读时保守当过期（重抓）。
+    match meta.modified().ok().and_then(|m| m.elapsed().ok()) {
+        Some(age) if age <= CACHE_TTL => {}
+        _ => return None,
+    }
     let text = std::fs::read_to_string(&path).ok()?;
     serde_json::from_str(&text).ok()
 }
```

测试建议（cache.rs `mod tests`）：写一条 cache，用 `filetime`/`std::fs::set_... ` 或直接
在测试里把 mtime 回拨 25h（或注入 TTL）后断言 `load_cached` 返回 `None`。

---

## Patch 2 — `src/error.rs`：新增 `Vip` 变体 → exit 6

```diff
--- a/src/error.rs
+++ b/src/error.rs
@@ pub enum JyeooError {
     /// HTML 解析失败（DOM 结构漂移）—— exit 5
     #[error("parse error: {0}")]
     Parse(String),
 
+    /// VIP 过期 / 非 VIP：详情页模板 `var vip = 'False' == 'True'` —— exit 6。
+    /// 非 VIP 响应的 analysis/solution/comment 被服务端随机抽稀（语义级错误），
+    /// 必须整体失败退出、绝不产出有洞 reference_md（YUK-697 / DESIGN §9）。
+    #[error("vip required: {0}")]
+    Vip(String),
+
     /// cookie 文件/配置问题 —— exit 3
     #[error("cookie error: {0}")]
     Cookie(String),
@@ impl JyeooError {
     pub fn exit_code(&self) -> i32 {
         match self {
             Self::Auth(_) | Self::Cookie(_) => 3,
             Self::Http(_) | Self::Io(_) => 4,
             Self::Parse(_) => 5,
+            Self::Vip(_) => 6,
         }
     }
 }
```

---

## Patch 3 — `src/fetch.rs`：`fetch_question` 在 parse/cache 前做 VIP 硬闸

```diff
--- a/src/fetch.rs
+++ b/src/fetch.rs
@@ pub async fn fetch_question(
     let url = format!("{BASE}/{subject}/ques/detail/{ques_id}");
     let html = client.get_html(&url).await?;
+    // YUK-697 — VIP 硬闸（DESIGN §9）。非 VIP 会话拿到的详情页 analysis/solution/comment
+    // 被随机抽稀（语义级损坏，非单纯截断）。模板非 VIP 时带 `var vip = 'False' == 'True'`。
+    // 命中即整体失败（exit 6）于 parse/cache 之前——有洞内容永不产出、永不入 cache。
+    if html.contains("var vip = 'False'") {
+        return Err(JyeooError::Vip(format!(
+            "cookie 账号非 VIP 或 VIP 已过期，详情页字段被抽稀: {url}"
+        )));
+    }
     let raw = parse::parse_question(&html, ques_id, subject)
         .ok_or_else(|| JyeooError::Parse(format!("结构解析失败: {ques_id}")))?;
```

> 注：`batch_fetch`（fetch.rs:213）已对 `Auth` error「立即整体返回 Err，不产半拉数据」。
> `Vip` 与 `Auth` 同为「立即整体失败」语义——建议把 fetch.rs:249 的
> `Err(e @ JyeooError::Auth(_))` 早退分支扩为 `Err(e @ (JyeooError::Auth(_) | JyeooError::Vip(_)))`，
> 使 batch 中途遇 VIP 过期也立即整体退出（不产半拉数据）。

---

## Patch 4 — `src/model.rs` + `src/loom.rs`：信封带 `jyeoo.vip: true`（loom 侧兜底闸）

producer 落 Patch 3 后，非 VIP 永不产行（exit 6）。为给 loom handler 一个**per-line 兜底信号**
（防御未来「部分 VIP 抽稀」形态，或 owner 未落 Patch 3 前的过渡期），在信封的 `jyeoo` 扩展块
恒带 `vip: true`（仅在 VIP 校验通过后才走到产出，故恒真）。

```diff
--- a/src/model.rs
+++ b/src/model.rs
@@ pub struct JyeooMeta {
     /// 抓取时刻（loom metadata.web_sourced.fetched_at 用）
     pub fetched_at: DateTime<Utc>,
+    /// VIP 确认标记（YUK-697）。恒 true：本工具仅在 VIP 校验通过后才产出信封
+    /// （非 VIP → exit 6，永不产行）。loom handler 用它做 per-line 兜底闸。
+    pub vip: bool,
 }
```

```diff
--- a/src/loom.rs
+++ b/src/loom.rs
@@         jyeoo: JyeooMeta {
             id: raw.id.clone(),
             subject: raw.subject.clone(),
             knowledge_hints,
             kind_source,
             difficulty_source,
             seq: raw.seq.clone(),
             fetched_at,
+            vip: true,
         },
```

---

## Patch 5 — `src/main.rs` + `docs/DESIGN.md`：exit-code 文档补 6

```diff
--- a/src/main.rs
+++ b/src/main.rs
@@
-//! 0 成功；2 参数错误（clap）；3 cookie 失效/游客模式；4 网络错误；5 解析失败。
+//! 0 成功；2 参数错误（clap）；3 cookie 失效/游客模式；4 网络错误；5 解析失败；6 VIP 过期/非 VIP。
```

`docs/DESIGN.md` §5 的 exit codes 段同步加一行 `6 VIP 过期/非 VIP（YUK-697）`。

---

## Patch 6（文档级）— exit 1 未使用，应显式声明为 reserved

**loom-side 裁决（PR #939 round-2 #5）**：exit 1 **不映射为 retryable**，保持 `unknown`（terminal，不重试）。

源码依据（jyeoo-rs 只读快照 2026-07-18）：

- `src/error.rs::exit_code()` 只产 `3`（Auth/Cookie）/ `4`（Http/Io）/ `5`（Parse）——**无 1**。
- `src/main.rs` 仅一处 `std::process::exit(code)`，`code` = `0`（Ok）或 `e.exit_code()`（∈ {3,4,5}）；`Cli::parse()` 失败由 clap 自身退 `2`。**无任何路径显式退 1**。
- 未映射的进程终止只剩 Rust panic（→ 退码 `101`，非 1）或外部信号（loom 侧 `classifyJyeooExit` 已按 `signal !== null` 归 `spawn`/terminal）。

因此 exit 1 在当前契约下**不会出现**；若真出现，它是一个**未定义的 generic 崩溃**，不是有语义的 transient——盲目映射成 `network`(retryable) 会让一个确定性崩溃进入 pg-boss 重试风暴。loom 侧 `classifyJyeooExit` 的 `default → 'unknown'`（retryable=false）是正确的保守处理。

**producer 侧建议（文档化，非代码）**：在 `docs/DESIGN.md` §5 exit-code 表显式加一行 `1 保留/未使用（generic failure；接入方按 terminal 处理，不重试）`，把「exit 1 无语义」变成契约的一部分，防止未来有人无意间用 exit 1 返回一个 transient 错误却被下游当 terminal 丢弃。

---

## loom 侧已实现的对接闸（本 PR，与上述提案对齐）

这些在 loom 仓本 PR 已落地，与 producer 提案严丝合缝——**Patch 未落时 loom 侧仍安全**（兜底）：

| producer 信号 | loom 侧处理（`src/server/question-supply/jyeoo-loom-adapter.ts` / `jyeoo-fetch.ts`） |
|---|---|
| exit 6（Patch 2/3） | `classifyJyeooExit` → `'vip'`（terminal，不重试）；handler 整体 fail、无 INSERT、发 failure 事件 |
| exit 3（既有 Auth） | `'auth'`（terminal）；整体 fail、无 INSERT |
| exit 4（既有 Http） | `'network'`（retryable）；throw → pg-boss 重投 |
| exit 5（既有 Parse） | `'parse'`（terminal）；整体 fail |
| 任意非零 exit / 信号杀 / stdout 截断 | 整体丢弃（**绝不 ingest 半拉/中途崩的批**） |
| `jyeoo.vip === false`（Patch 4 兜底） | 整体 fail `'vip'`、无 INSERT（belt-and-suspenders；Patch 3 落地后此路径不触发） |
| cache TTL（Patch 1） | loom 侧无对应——**只能在 producer 修**（loom 看不到 producer cache） |

loom 侧对 `jyeoo.vip` 是**可选**读取：`JyeooMeta.vip` 为 optional，Patch 4 未落时字段缺省，
handler 退回 exit-6 闸；落地后 per-line 兜底同时生效。二者叠加即「VIP 过期在任何 INSERT 前整体
fail」的完整保证（票面 P3 硬约束）。
