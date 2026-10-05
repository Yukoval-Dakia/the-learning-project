// YUK-980 — 独立 worker 进程的启动生命周期 owner（从 scripts/worker.ts 的 main()
// 抽出，worker.ts 只保留进程级纪律：loadEnv / runtime pre-flight / last-resort
// handlers / 顶层 catch）。抽出动机：启动尾段（markBossStarted 之后、
// startBossWorker 返回之前）的 SIGTERM 协调必须在【真实 wiring】上可测——
// 测试直接驱动本函数，而不是在测试里手工复刻 worker.ts 的装配。
//
// 顺序契约（与原 main() 等价，YUK-980 修正 boss 可见性后）：
//   1. shutdown handler 先于一切装配安装；
//   2. registerCapabilityTools 在任何 boss/db 装配前完成（fail-fast，YUK-328）；
//   3. @/db/client 与 @/server/boss/start-worker 必须 loadEnv() 之后动态 import
//      （db client 在模块顶层读 DATABASE_URL，YUK-365）；
//   4. 日志行逐字保留（'[worker] capability tools registered' /
//      '[worker] running, handlers registered'）——容器日志与 QA 脚本依赖它们。
//
// YUK-980 startup-tail 修正：boss getter 用进程单例 getRunningBoss()，而不是本
// 函数的局部变量——startBossWorker 在 boss.start() 后、挂 consumers 前就
// markBossStarted，注册尾段全程 shutdown handler 都能看到 boss；旧 wiring 里局部
// boss 要等 startBossWorker 返回才赋值，尾段窗口内 SIGTERM 走 null 分支，伪造
// "no jobs drainable" 的 exit(1)，掐断 in-flight job。配合 shutdown handler 的
// 有界 tail 等待 + ownsExit 单一退出 owner（见 shutdown.ts）。

import { capabilities } from '@/capabilities';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getRunningBoss } from '@/server/boss/client';
import { installBootShutdownHandler } from '@/server/boss/shutdown';

export type BootWorkerOptions = {
  /** Test-only: shrink the shutdown handler's bounded startup-tail wait (default 9s). */
  startupTailWaitMs?: number;
};

export async function bootWorker(options: BootWorkerOptions = {}): Promise<void> {
  let startup: Promise<unknown> | null = null;
  const shutdown = installBootShutdownHandler(
    () => getRunningBoss(),
    () => startup,
    options.startupTailWaitMs,
  );

  // YUK-328：独立 worker 不经过 server/index.ts，必须在注册 handlers 前自行装配
  // 完整 DomainTool inventory；任何 manifest/load 错误让进程 fail-fast，避免任务在
  // 消费后才因缺工具失败并进入重投。
  await registerCapabilityTools(capabilities);
  console.log('[worker] capability tools registered');

  // Dynamic import AFTER loadEnv(): @/db/client reads DATABASE_URL at module top
  // (throws if unset), and start-worker pulls the client in transitively. Mirrors
  // server/index.ts's RW_WORKER=1 branch, which dynamic-imports for the same reason.
  const [{ db }, { startBossWorker }] = await Promise.all([
    import('@/db/client'),
    import('@/server/boss/start-worker'),
  ]);
  try {
    // The assignment is synchronous with the call, and startBossWorker only
    // marks the boss started after its first internal awaits — getStartup()
    // can never observe null while the boss is already visible.
    startup = startBossWorker(db);
    await startup;
    // Ready: drop the (resolved) startup reference so a later signal takes the
    // plain graceful path instead of logging a startup-tail wait for a boot
    // that already finished (the common deployment-stop case).
    startup = null;
  } catch (err) {
    // Exit has one owner: once a signal is being handled, the shutdown handler
    // alone decides the exit code (it is draining this boot's boss). A tail
    // rejection here — including registration hitting the boss the handler is
    // already stopping after the bounded wait timed out — is expected.
    if (shutdown.ownsExit()) {
      console.error(
        '[worker] startup failed during shutdown — exit owned by the shutdown handler',
        err,
      );
      return;
    }
    throw err;
  }
  console.log('[worker] running, handlers registered');
}
