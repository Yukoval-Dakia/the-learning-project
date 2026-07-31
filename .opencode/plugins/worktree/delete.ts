import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PendingDelete } from "./state"

export interface GitCommandSuccess {
	readonly ok: true
	readonly value: string
}

export interface GitCommandFailure {
	readonly ok: false
	readonly error: string
}

export type GitCommandResult = GitCommandSuccess | GitCommandFailure

export type DeleteWorkflowResult =
	| { readonly ok: true; readonly preservedPath: string }
	| {
			readonly ok: false
			readonly stage: "inspect" | "dirty" | "pre-delete-hook" | "preserve" | "remove" | "state"
			readonly error: string
	  }

export interface DeleteWorkflowDependencies {
	readonly repoRoot: string
	readonly runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
	readonly runPreDeleteHooks: (worktreePath: string) => Promise<GitCommandResult>
	readonly completeState: (pendingDelete: PendingDelete) => boolean
	readonly findPreservedWorktree?: (worktreePath: string) => Promise<string | null>
	readonly preserveWorktree?: (worktreePath: string) => Promise<string>
}

type InspectionResult =
	| { readonly ok: true }
	| Extract<DeleteWorkflowResult, { readonly ok: false }>

interface PreservationRecord {
	readonly version: 1
	readonly originalPath: string
	readonly preservationRoot: string
	readonly retainedWorktree: string
}

const DIRTY_WORKTREE_ERROR =
	"Worktree has uncommitted, untracked, or ignored files; commit or remove them explicitly before cleanup."
const PRESERVATION_SUFFIX = ".preserved-by-opencode"
const PRESERVATION_RECORD = "preservation.json"
const RETAINED_WORKTREE_DIRECTORY = "worktree"

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		return await lstat(path)
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null
		}
		throw error
	}
}

function preservationRecord(worktreePath: string): PreservationRecord {
	const preservationRoot = `${worktreePath}${PRESERVATION_SUFFIX}`
	return {
		version: 1,
		originalPath: worktreePath,
		preservationRoot,
		retainedWorktree: join(preservationRoot, RETAINED_WORKTREE_DIRECTORY),
	}
}

function parsePreservationRecord(raw: string, expected: PreservationRecord): PreservationRecord {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(`Invalid OpenCode preservation marker at ${expected.originalPath}.`)
	}

	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("version" in parsed) ||
		parsed.version !== expected.version ||
		!("originalPath" in parsed) ||
		parsed.originalPath !== expected.originalPath ||
		!("preservationRoot" in parsed) ||
		parsed.preservationRoot !== expected.preservationRoot ||
		!("retainedWorktree" in parsed) ||
		parsed.retainedWorktree !== expected.retainedWorktree
	) {
		throw new Error(`Mismatched OpenCode preservation marker at ${expected.originalPath}.`)
	}

	return expected
}

function serializedPreservationRecord(record: PreservationRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`
}

async function readRootRecord(record: PreservationRecord): Promise<void> {
	const raw = await readFile(join(record.preservationRoot, PRESERVATION_RECORD), "utf8")
	parsePreservationRecord(raw, record)
}

async function ensureOriginalPathBlocked(record: PreservationRecord): Promise<void> {
	const original = await statOrNull(record.originalPath)
	if (!original) {
		await writeFile(record.originalPath, serializedPreservationRecord(record), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		})
		return
	}

	if (!original.isFile()) {
		throw new Error(
			`The original path was recreated while cleanup was being preserved: ${record.originalPath}.`,
		)
	}

	const raw = await readFile(record.originalPath, "utf8")
	parsePreservationRecord(raw, record)
}

/**
 * Return a previously quarantined lane so cleanup can resume after a crash.
 * The original pathname is occupied by an audit marker, preventing ordinary
 * path-based writers from recreating a directory that Git could remove.
 */
export async function findPreservedWorktree(worktreePath: string): Promise<string | null> {
	const record = preservationRecord(worktreePath)
	const preservationRoot = await statOrNull(record.preservationRoot)
	if (!preservationRoot) return null
	if (!preservationRoot.isDirectory()) {
		throw new Error(`Preservation path is not a directory: ${record.preservationRoot}.`)
	}

	await readRootRecord(record)
	const retainedWorktree = await statOrNull(record.retainedWorktree)
	if (!retainedWorktree) {
		// A prior attempt reserved the preservation root but did not move the lane.
		return null
	}
	if (!retainedWorktree.isDirectory()) {
		throw new Error(`Retained worktree is not a directory: ${record.retainedWorktree}.`)
	}

	await ensureOriginalPathBlocked(record)
	return record.preservationRoot
}

/**
 * Atomically move the entire lane beneath a deterministic preservation root.
 * Nothing under that root is ever deleted automatically. Writers holding an
 * open cwd follow the rename and therefore keep writing into retained storage.
 */
export async function preserveWorktree(worktreePath: string): Promise<string> {
	const record = preservationRecord(worktreePath)
	const existingRoot = await statOrNull(record.preservationRoot)
	if (!existingRoot) {
		// Reserving a directory first gives us no-overwrite semantics that
		// node:fs.rename alone cannot provide portably.
		await mkdir(record.preservationRoot, { mode: 0o700 })
		await writeFile(
			join(record.preservationRoot, PRESERVATION_RECORD),
			serializedPreservationRecord(record),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		)
	} else {
		if (!existingRoot.isDirectory()) {
			throw new Error(`Preservation path is not a directory: ${record.preservationRoot}.`)
		}
		await readRootRecord(record)
	}

	const retainedWorktree = await statOrNull(record.retainedWorktree)
	if (!retainedWorktree) {
		const original = await statOrNull(record.originalPath)
		if (!original?.isDirectory()) {
			throw new Error(`Worktree path is not a directory: ${record.originalPath}.`)
		}
		await rename(record.originalPath, record.retainedWorktree)
	} else if (!retainedWorktree.isDirectory()) {
		throw new Error(`Retained worktree is not a directory: ${record.retainedWorktree}.`)
	}

	await ensureOriginalPathBlocked(record)
	return record.preservationRoot
}

async function inspectCleanWorktree(
	worktreePath: string,
	runGit: DeleteWorkflowDependencies["runGit"],
): Promise<InspectionResult> {
	let statusResult: GitCommandResult
	try {
		statusResult = await runGit(
			["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
			worktreePath,
		)
	} catch (error) {
		return { ok: false, stage: "inspect", error: errorMessage(error) }
	}

	if (!statusResult.ok) {
		return { ok: false, stage: "inspect", error: statusResult.error }
	}
	if (statusResult.value.trim().length > 0) {
		return { ok: false, stage: "dirty", error: DIRTY_WORKTREE_ERROR }
	}
	return { ok: true }
}

function isPendingWorktreeRegistered(worktreeList: string, pendingDelete: PendingDelete): boolean {
	const expectedBranch = `branch refs/heads/${pendingDelete.branch}`
	return worktreeList
		.split(/\n\n+/)
		.some((entry) =>
			entry
				.split("\n")
				.some((line) => line === expectedBranch || line === `worktree ${pendingDelete.path}`),
		)
}

function preservedError(error: string, preservedPath: string): string {
	return `${error} Files remain preserved at ${preservedPath}.`
}

/**
 * Fail-closed cleanup for one pending worktree.
 *
 * A clean lane is atomically moved to an auditable preservation path before
 * Git metadata is unregistered. The retained directory is never recursively
 * deleted, so ignored files created by a concurrent writer cannot be lost.
 * State completion remains last; every earlier failure retains pending/session
 * state and reports the preservation path when the move already happened.
 */
export async function processPendingDelete(
	pendingDelete: PendingDelete,
	dependencies: DeleteWorkflowDependencies,
): Promise<DeleteWorkflowResult> {
	const findPreserved = dependencies.findPreservedWorktree ?? findPreservedWorktree
	const preserve = dependencies.preserveWorktree ?? preserveWorktree
	let preservedPath: string | null

	try {
		preservedPath = await findPreserved(pendingDelete.path)
	} catch (error) {
		return { ok: false, stage: "preserve", error: errorMessage(error) }
	}

	if (!preservedPath) {
		const initialInspection = await inspectCleanWorktree(pendingDelete.path, dependencies.runGit)
		if (!initialInspection.ok) return initialInspection

		let hookResult: GitCommandResult
		try {
			hookResult = await dependencies.runPreDeleteHooks(pendingDelete.path)
		} catch (error) {
			return { ok: false, stage: "pre-delete-hook", error: errorMessage(error) }
		}
		if (!hookResult.ok) {
			return { ok: false, stage: "pre-delete-hook", error: hookResult.error }
		}

		// Hooks are explicit user code and may mutate the lane. Re-check before
		// the atomic move; everything after that point is retained, not deleted.
		const postHookInspection = await inspectCleanWorktree(pendingDelete.path, dependencies.runGit)
		if (!postHookInspection.ok) return postHookInspection

		try {
			preservedPath = await preserve(pendingDelete.path)
		} catch (error) {
			return {
				ok: false,
				stage: "preserve",
				error: preservedError(errorMessage(error), `${pendingDelete.path}${PRESERVATION_SUFFIX}`),
			}
		}
	}

	let pruneResult: GitCommandResult
	try {
		// `prune` unregisters missing worktree metadata without recursively
		// deleting the retained directory. `worktree remove` is intentionally
		// forbidden here because it can silently delete late ignored files.
		pruneResult = await dependencies.runGit(
			["worktree", "prune", "--expire", "now"],
			dependencies.repoRoot,
		)
	} catch (error) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(errorMessage(error), preservedPath),
		}
	}
	if (!pruneResult.ok) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(pruneResult.error, preservedPath),
		}
	}

	let listResult: GitCommandResult
	try {
		listResult = await dependencies.runGit(
			["worktree", "list", "--porcelain"],
			dependencies.repoRoot,
		)
	} catch (error) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(errorMessage(error), preservedPath),
		}
	}
	if (!listResult.ok) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(listResult.error, preservedPath),
		}
	}
	if (isPendingWorktreeRegistered(listResult.value, pendingDelete)) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError("Git still reports the worktree as registered.", preservedPath),
		}
	}

	try {
		if (!dependencies.completeState(pendingDelete)) {
			return {
				ok: false,
				stage: "state",
				error: preservedError(
					"Pending delete changed before state completion; session state was preserved.",
					preservedPath,
				),
			}
		}
	} catch (error) {
		return {
			ok: false,
			stage: "state",
			error: preservedError(errorMessage(error), preservedPath),
		}
	}

	return { ok: true, preservedPath }
}
