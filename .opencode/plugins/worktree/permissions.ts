import { chmod } from "node:fs/promises"

const REQUESTED_EXECUTABLE_SCRIPT_MODE = 0o755
const REQUESTED_PRIVATE_DIRECTORY_MODE = 0o700
const REQUESTED_PRIVATE_FILE_MODE = 0o600

function modeWithUmask(requestedMode: number, umask: number): number {
	return requestedMode & ~umask
}

/** Return the executable mode requested for a temp script without broadening the process umask. */
export function executableScriptMode(umask: number): number {
	return modeWithUmask(REQUESTED_EXECUTABLE_SCRIPT_MODE, umask)
}

/** Return a private directory mode narrowed by the current permission policy. */
export function privateDirectoryMode(umask = process.umask()): number {
	return modeWithUmask(REQUESTED_PRIVATE_DIRECTORY_MODE, umask)
}

/** Return a private file mode narrowed by the current permission policy. */
export function privateFileMode(umask = process.umask()): number {
	return modeWithUmask(REQUESTED_PRIVATE_FILE_MODE, umask)
}

/** Add script execute bits while retaining the caller's current permission policy. */
export async function makeTempScriptExecutable(scriptPath: string): Promise<void> {
	await chmod(scriptPath, executableScriptMode(process.umask()))
}
