# YUK-1389 配置公共领域出口

## 范围与现状

基线main d609c7b66。主线明确本线程独占observability配置领域出口，Start鉴权、epoch和canonical facts/writer注入仍由主线负责。1358子票与配置相关票查重后建立YUK-1389；1007继续负责配置产品剩余功能，本slice不关闭整个设置页或迁移。

允许修改api/admin-config.ts、api/admin-config-write.ts、server/config-read-model.ts、server/admin-config-writer.ts的接口/类型、必要同目录typed operation、public.ts及scoped tests。body schemas复用或导出，不改约束。若边界引用实测减少，只按实际计数收紧baseline。禁止Start/boot/index/manifest/package/kernel/配置持久化/subject写入/hydration/UI/runtime。

## 保留契约与验收

复用现有builder、snapshot store和runtime facts，不伪造Db|Tx reader。HTTP JSON解析留适配器；领域操作用原schema并调用现有注入writer。畸形JSON返回invalid_json400；结构无效返回invalid_config_request400；仅合法输入遇未注入writer才503。RESET一次映射clear并单次调用，note与下游错误完整保留。epoch receipt区分提交与快照，snapshot_current不是worker确认。

验证完整读取DTO、已注册key与secret排除、缺少facts真实状态、输入限制和负例、下游错误和无重复writer调用。先Node24 scoped unit/typecheck/lint/build及相关audit；确需DB由父重新核锁协调后验收。独立R1、exact-head CI和合并仍待，不宣称运行或部署通过。

## 实施与证据

实施待唯一writer交回。父负责最终验收、PR/CI/合并与接口交接。
