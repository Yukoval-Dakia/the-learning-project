// Claude Code refuses `--dangerously-skip-permissions` when its parent process
// runs as root. Loom's Agent SDK runner deliberately uses that permission mode
// for its allowlisted server-side tools, so a root app/worker is guaranteed to
// fail every AI task before the first provider request. Fail at boot with the
// real operator action instead of presenting a healthy container plus an opaque
// `Claude Code process exited with code 1` for every run.

export function assertAgentSdkRuntimeUser(
  getuid: (() => number) | undefined = process.getuid,
): void {
  if (getuid?.() !== 0) return;

  throw new Error(
    '[ai-runtime] app/worker must not run as root: Claude Code rejects ' +
      '--dangerously-skip-permissions for uid 0. Run the container as the node user.',
  );
}
