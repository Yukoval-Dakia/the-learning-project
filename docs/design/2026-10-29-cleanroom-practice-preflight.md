# 完整做题界面 cleanroom preflight

2026-10-29。候选，尚无 live consumer，所有运行验收 NOT_RUN。

## 授权与输入

唯一产品输入：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1473-cleanroom-m3e-20261029/requirements.md`，已完整阅读。
其「输入隔离」摘录方向 §1：
> Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。
其「交付与自我反驳」：
> 没有浏览器或业务执行就标NOT_RUN

类型：page + complementary 非模态伙伴面板；可选 native dialog 仅用于父方明确的阻断确认。

## 写入范围（全部新建）

- src/ui-next/cleanroom-practice/contracts.ts
- src/ui-next/cleanroom-practice/PracticePage.tsx
- src/ui-next/cleanroom-practice/practice.css
- docs/design/2026-10-29-cleanroom-practice-preflight.md
- docs/design/2026-10-29-cleanroom-practice-handoff.md

## 设计决定

阅读 → 作答 → 保存事实 → 提交事实 → 结果与下一步，采用稳定文档流；题目不包进反复嵌套卡片。宽窗将伙伴放在右侧独立容器；窄窗伙伴位于题目前方，可明确返回作答，不在数屏长题后寻找帮助。仅一个主任务 filled 动作；支持动作 tonal / outlined，恢复动作就地出现。静态导航只包括本页已授权目的地和返回入口。

用角色色、分组容器、字号和 rounded→pressed 形状反馈体现层次。48px 命中区，40px 按钮视觉面；中文正文增大行高。无主题字体网络请求，无旧 token 依赖。CSS scope `[data-ui-next].un-cr`，所有类/变量 `un-` 前缀。父后续决定与 UiNextRoot 真实组合；本次不读/导入旧实现。

主题和业务状态完全受控。仅 DOM 焦点属于呈现；不创建业务状态机、定时器、网络、恢复 owner。作答输入不拦截 Enter，仅显式按钮提交；伙伴消息依完整性补充使用 Enter 发送 / Shift+Enter 换行及 IME 保护。

Google 规范站为 JS 壳，参数以 AndroidX revision `9b2acdf2ecd36aa5ddf9c43ebfc288ed11d2c49e` 官方源码补足；映射和无法验证的范围详列 handoff。没有物理 spring 引擎，不把 CSS easing 声称为官方 spring。

运行配置已只读确认：codex / gpt-6-astra / high / serviceTier default。没有改模型/供应商/档位，没有委派。

## 完整性续作 preflight

完整读取 `completeness-amendment.md`（与 requirements.md 同目录）。本轮仍 page + complementary + 可选阻断 dialog，原五文件写权不变；不提交。
补充原文：「结果揭晓之前存在可跳过的“你有几分把握”步骤」「给专用作答区域独立安全slot接口」「由父提供navigation items/current位置与intent」「不能用一个互斥枚举丢掉正在处理的事实」。
据此将呈现事实拆为独立 recording/grading/continuation/revelation；把握在 concealed 阶段，自评在 revealed 阶段；小问把内容与输入放一起。伙伴恢复 Enter 发送及 IME 保护，补用途/引用/教学/新会话入口。正常保存/连接/空 Stop 降噪，完整导航放原生 disclosure。给父显式节点 refs，不要求重新挂载。motion 不再用自选 easing 冒充完成，保留准确未完成项；不新增物理引擎或业务 owner。
