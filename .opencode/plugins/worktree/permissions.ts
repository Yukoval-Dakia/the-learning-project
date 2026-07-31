import { chmod } from "node:fs/promises"

const REQUESTED_EXECUTABLE_SCRIPT_MODE = 0o755

/** Return the executable mode requested for a temp script without broadening the process umask. */
export function executableScriptMode(umask: number): number {
	return REQUESTED_EXECUTABLE_SCRIPT_MODE & ~umask
}

/** Add script execute bits while retaining the caller's current permission policy. */
export async function makeTempScriptExecutable(scriptPath: string): Promise<void> {
	await chmod(scriptPath, executableScriptMode(process.umask()))
}
