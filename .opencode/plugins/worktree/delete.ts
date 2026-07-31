import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { privateDirectoryMode, privateFileMode } from "./permissions"
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
	readonly runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
	readonly runPreDeleteHooks: (worktreePath: string) => Promise<GitCommandResult>
	readonly completeState: (pendingDelete: PendingDelete) => boolean
	readonly findPreservedWorktree?: (worktreePath: string) => Promise<string | null>
	readonly preserveWorktree?: (worktreePath: string) => Promise<string>
	readonly readGitAdminCwd?: (preservationRoot: string) => Promise<string | null>
	readonly recordGitAdminCwd?: (preservationRoot: string, gitAdminCwd: string) => Promise<void>
	readonly resolveGitAdminCwd?: (worktreePath: string) => Promise<string>
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
const GIT_ADMIN_CWD_RECORD = "git-admin-cwd"
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

async function readGitAdminCwd(preservationRoot: string): Promise<string | null> {
	let value: string
	try {
		value = (await readFile(join(preservationRoot, GIT_ADMIN_CWD_RECORD), "utf8")).trim()
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null
		}
		throw error
	}

	if (!value || !isAbsolute(value)) {
		throw new Error(`Invalid surviving Git admin cwd recorded at ${preservationRoot}.`)
	}
	return value
}

async function recordGitAdminCwd(preservationRoot: string, gitAdminCwd: string): Promise<void> {
	if (!isAbsolute(gitAdminCwd)) {
		throw new Error(`Git admin cwd must be absolute: ${gitAdminCwd}.`)
	}

	const existing = await readGitAdminCwd(preservationRoot)
	if (existing) {
		if (existing !== gitAdminCwd) {
			throw new Error(`Git admin cwd changed for preservation root ${preservationRoot}.`)
		}
		return
	}

	await writeFile(join(preservationRoot, GIT_ADMIN_CWD_RECORD), `${gitAdminCwd}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: privateFileMode(),
	})
}

async function resolveGitAdminCwd(
	worktreePath: string,
	runGit: DeleteWorkflowDependencies["runGit"],
): Promise<string> {
	const result = await runGit(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		worktreePath,
	)
	if (!result.ok) throw new Error(result.error)

	const gitAdminCwd = result.value.trim()
	if (!gitAdminCwd || !isAbsolute(gitAdminCwd)) {
		throw new Error(`Git returned an invalid common directory for ${worktreePath}.`)
	}
	return gitAdminCwd
}

async function readRootRecord(record: PreservationRecord): Promise<void> {
	const raw = await readFile(join(record.preservationRoot, PRESERVATION_RECORD), "utf8")
	parsePreservationRecord(raw, record)
}

async function readOrRecoverRootRecord(record: PreservationRecord): Promise<void> {
	try {
		await readRootRecord(record)
	} catch (error) {
		const entries = await readdir(record.preservationRoot)
		const original = await statOrNull(record.originalPath)
		if (entries.length !== 0 || !original?.isDirectory()) throw error

		// Recover a crash after the exclusive root reservation but before its
		// audit record was written. The empty root contains no user data.
		await chmod(record.preservationRoot, privateDirectoryMode())
		await writeFile(
			join(record.preservationRoot, PRESERVATION_RECORD),
			serializedPreservationRecord(record),
			{ encoding: "utf8", flag: "wx", mode: privateFileMode() },
		)
	}
}

async function ensureOriginalPathBlocked(record: PreservationRecord): Promise<void> {
	const original = await statOrNull(record.originalPath)
	if (!original) {
		await writeFile(record.originalPath, serializedPreservationRecord(record), {
			encoding: "utf8",
			flag: "wx",
			mode: privateFileMode(),
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

	await readOrRecoverRootRecord(record)
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
		await mkdir(record.preservationRoot, { mode: privateDirectoryMode() })
		await writeFile(
			join(record.preservationRoot, PRESERVATION_RECORD),
			serializedPreservationRecord(record),
			{ encoding: "utf8", flag: "wx", mode: privateFileMode() },
		)
	} else {
		if (!existingRoot.isDirectory()) {
			throw new Error(`Preservation path is not a directory: ${record.preservationRoot}.`)
		}
		await readOrRecoverRootRecord(record)
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

interface WorktreeListEntry {
	readonly path: string | null
	readonly branch: string | null
	readonly prunable: boolean
}

function parseWorktreeList(worktreeList: string): WorktreeListEntry[] {
	return worktreeList
		.split(/\n\n+/)
		.map((block) => block.split("\n").filter(Boolean))
		.filter((lines) => lines.length > 0)
		.map((lines) => ({
			path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? null,
			branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null,
			prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
		}))
}

function isPendingWorktree(entry: WorktreeListEntry, pendingDelete: PendingDelete): boolean {
	return entry.path === pendingDelete.path || entry.branch === `refs/heads/${pendingDelete.branch}`
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
	const loadGitAdminCwd = dependencies.readGitAdminCwd ?? readGitAdminCwd
	const persistGitAdminCwd = dependencies.recordGitAdminCwd ?? recordGitAdminCwd
	const resolveSurvivingGitCwd =
		dependencies.resolveGitAdminCwd ??
		((worktreePath: string) => resolveGitAdminCwd(worktreePath, dependencies.runGit))
	let preservedPath: string | null
	let gitAdminCwd: string

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
			// Resolve an absolute common-dir cwd while the linked worktree still
			// exists. Unlike the lane path, this directory survives the rename.
			gitAdminCwd = await resolveSurvivingGitCwd(pendingDelete.path)
		} catch (error) {
			return { ok: false, stage: "inspect", error: errorMessage(error) }
		}

		try {
			preservedPath = await preserve(pendingDelete.path)
			// Persist before any prune. A retry after Git metadata is gone must not
			// depend on the retained worktree's now-dangling .git pointer.
			await persistGitAdminCwd(preservedPath, gitAdminCwd)
		} catch (error) {
			return {
				ok: false,
				stage: "preserve",
				error: preservedError(errorMessage(error), `${pendingDelete.path}${PRESERVATION_SUFFIX}`),
			}
		}
	} else {
		try {
			const recordedGitAdminCwd = await loadGitAdminCwd(preservedPath)
			gitAdminCwd =
				recordedGitAdminCwd ??
				(await resolveSurvivingGitCwd(join(preservedPath, RETAINED_WORKTREE_DIRECTORY)))
			await persistGitAdminCwd(preservedPath, gitAdminCwd)
		} catch (error) {
			return {
				ok: false,
				stage: "remove",
				error: preservedError(errorMessage(error), preservedPath),
			}
		}
	}

	let beforePruneResult: GitCommandResult
	try {
		beforePruneResult = await dependencies.runGit(["worktree", "list", "--porcelain"], gitAdminCwd)
	} catch (error) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(errorMessage(error), preservedPath),
		}
	}
	if (!beforePruneResult.ok) {
		return {
			ok: false,
			stage: "remove",
			error: preservedError(beforePruneResult.error, preservedPath),
		}
	}

	const beforePruneEntries = parseWorktreeList(beforePruneResult.value)
	const targetEntry = beforePruneEntries.find((entry) => isPendingWorktree(entry, pendingDelete))
	if (targetEntry) {
		if (!targetEntry.prunable) {
			return {
				ok: false,
				stage: "remove",
				error: preservedError(
					"Git does not report the preserved worktree as safely prunable.",
					preservedPath,
				),
			}
		}

		const otherPrunableEntries = beforePruneEntries.filter(
			(entry) => entry.prunable && !isPendingWorktree(entry, pendingDelete),
		)
		if (otherPrunableEntries.length > 0) {
			const labels = otherPrunableEntries
				.map((entry) => entry.path ?? entry.branch ?? "unknown worktree")
				.join(", ")
			return {
				ok: false,
				stage: "remove",
				error: preservedError(
					`Refused repository-global prune because other prunable worktrees exist: ${labels}.`,
					preservedPath,
				),
			}
		}

		let pruneResult: GitCommandResult
		try {
			// `prune` unregisters missing worktree metadata without recursively
			// deleting the retained directory. `worktree remove` is intentionally
			// forbidden here because it can silently delete late ignored files.
			pruneResult = await dependencies.runGit(["worktree", "prune", "--expire", "now"], gitAdminCwd)
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

		let afterPruneResult: GitCommandResult
		try {
			afterPruneResult = await dependencies.runGit(["worktree", "list", "--porcelain"], gitAdminCwd)
		} catch (error) {
			return {
				ok: false,
				stage: "remove",
				error: preservedError(errorMessage(error), preservedPath),
			}
		}
		if (!afterPruneResult.ok) {
			return {
				ok: false,
				stage: "remove",
				error: preservedError(afterPruneResult.error, preservedPath),
			}
		}
		if (
			parseWorktreeList(afterPruneResult.value).some((entry) =>
				isPendingWorktree(entry, pendingDelete),
			)
		) {
			return {
				ok: false,
				stage: "remove",
				error: preservedError("Git still reports the worktree as registered.", preservedPath),
			}
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
