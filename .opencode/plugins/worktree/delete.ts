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
	| { readonly ok: true }
	| {
			readonly ok: false
			readonly stage: "inspect" | "dirty" | "pre-delete-hook" | "remove" | "state"
			readonly error: string
	  }

export interface DeleteWorkflowDependencies {
	readonly repoRoot: string
	readonly runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
	readonly runPreDeleteHooks: (worktreePath: string) => Promise<GitCommandResult>
	readonly completeState: (pendingDelete: PendingDelete) => boolean
}

const DIRTY_WORKTREE_ERROR =
	"Worktree has uncommitted, untracked, or ignored files; commit or remove them explicitly before cleanup."

async function inspectCleanWorktree(
	worktreePath: string,
	runGit: DeleteWorkflowDependencies["runGit"],
): Promise<DeleteWorkflowResult> {
	let statusResult: GitCommandResult
	try {
		statusResult = await runGit(
			["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
			worktreePath,
		)
	} catch (error) {
		return {
			ok: false,
			stage: "inspect",
			error: error instanceof Error ? error.message : String(error),
		}
	}

	if (!statusResult.ok) {
		return { ok: false, stage: "inspect", error: statusResult.error }
	}
	if (statusResult.value.trim().length > 0) {
		return { ok: false, stage: "dirty", error: DIRTY_WORKTREE_ERROR }
	}
	return { ok: true }
}

/**
 * Remove one pending worktree without ever staging, committing, or forcing.
 *
 * State completion is deliberately last: any dirty check, explicit pre-delete
 * hook, or git removal failure leaves the pending operation and session intact.
 */
export async function processPendingDelete(
	pendingDelete: PendingDelete,
	dependencies: DeleteWorkflowDependencies,
): Promise<DeleteWorkflowResult> {
	const initialInspection = await inspectCleanWorktree(pendingDelete.path, dependencies.runGit)
	if (!initialInspection.ok) return initialInspection

	let hookResult: GitCommandResult
	try {
		hookResult = await dependencies.runPreDeleteHooks(pendingDelete.path)
	} catch (error) {
		return {
			ok: false,
			stage: "pre-delete-hook",
			error: error instanceof Error ? error.message : String(error),
		}
	}
	if (!hookResult.ok) {
		return { ok: false, stage: "pre-delete-hook", error: hookResult.error }
	}

	// Hooks are explicit user code and may mutate the lane. Re-check before removal.
	const postHookInspection = await inspectCleanWorktree(pendingDelete.path, dependencies.runGit)
	if (!postHookInspection.ok) return postHookInspection

	let removeResult: GitCommandResult
	try {
		removeResult = await dependencies.runGit(
			["worktree", "remove", pendingDelete.path],
			dependencies.repoRoot,
		)
	} catch (error) {
		return {
			ok: false,
			stage: "remove",
			error: error instanceof Error ? error.message : String(error),
		}
	}
	if (!removeResult.ok) {
		return { ok: false, stage: "remove", error: removeResult.error }
	}

	try {
		if (!dependencies.completeState(pendingDelete)) {
			return {
				ok: false,
				stage: "state",
				error: "Pending delete changed before state completion; session state was preserved.",
			}
		}
	} catch (error) {
		return {
			ok: false,
			stage: "state",
			error: error instanceof Error ? error.message : String(error),
		}
	}

	return { ok: true }
}
