import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type DeleteWorkflowDependencies,
	type GitCommandResult,
	findPreservedWorktree,
	preserveWorktree,
	processPendingDelete,
} from "./delete"
import {
	type PendingDelete,
	completePendingDelete,
	getPendingDelete,
	reservePendingDelete,
} from "./state"

function ok(value = ""): GitCommandResult {
	return { ok: true, value }
}

function fail(error: string): GitCommandResult {
	return { ok: false, error }
}

function prunableEntry(candidate: PendingDelete): string {
	return [
		`worktree ${candidate.path}`,
		"HEAD 0000000000000000000000000000000000000000",
		`branch refs/heads/${candidate.branch}`,
		"prunable gitdir file points to non-existent location",
		"",
	].join("\n")
}

function workflow(overrides: Partial<DeleteWorkflowDependencies> = {}) {
	const gitCalls: Array<{ args: string[]; cwd: string }> = []
	let stateCompleted = false
	let targetRegistered = true
	const dependencies: DeleteWorkflowDependencies = {
		runGit: async (args, cwd) => {
			gitCalls.push({ args, cwd })
			if (args[0] === "worktree" && args[1] === "list") {
				return ok(targetRegistered ? prunableEntry(pending) : "")
			}
			if (args[0] === "worktree" && args[1] === "prune") {
				targetRegistered = false
			}
			return ok()
		},
		runPreDeleteHooks: async () => ok(),
		findPreservedWorktree: async () => null,
		preserveWorktree: async (worktreePath) => `${worktreePath}.preserved-by-opencode`,
		readGitAdminCwd: async () => null,
		recordGitAdminCwd: async () => {},
		resolveGitAdminCwd: async () => "/repo/.git",
		completeState: () => {
			stateCompleted = true
			return true
		},
		...overrides,
	}

	return {
		dependencies,
		gitCalls,
		stateCompleted: () => stateCompleted,
	}
}

const pending: PendingDelete = {
	branch: "codex/yuk-810-delete",
	path: "/worktrees/yuk-810-delete",
}

describe("processPendingDelete", () => {
	it("fails closed when the worktree is dirty and preserves pending/session state", async () => {
		const test = workflow({
			runGit: async (args, cwd) => {
				test.gitCalls.push({ args, cwd })
				return args[0] === "status" ? ok(" M src/dirty.ts") : ok()
			},
		})

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result).toEqual({
			ok: false,
			stage: "dirty",
			error:
				"Worktree has uncommitted, untracked, or ignored files; commit or remove them explicitly before cleanup.",
		})
		expect(test.gitCalls).toHaveLength(1)
		expect(test.stateCompleted()).toBeFalse()
	})

	it.each(["git add failed", "git commit failed"])(
		"preserves worktree and state when an explicit pre-delete hook reports %s",
		async (hookError) => {
			const test = workflow({
				runPreDeleteHooks: async () => fail(hookError),
			})

			const result = await processPendingDelete(pending, test.dependencies)

			expect(result).toEqual({ ok: false, stage: "pre-delete-hook", error: hookError })
			expect(test.gitCalls.map((call) => call.args[0])).toEqual(["status"])
			expect(test.stateCompleted()).toBeFalse()
		},
	)

	it("preserves pending/session state when non-destructive unregister fails", async () => {
		const test = workflow({
			runGit: async (args, cwd) => {
				test.gitCalls.push({ args, cwd })
				if (args[1] === "list") return ok(prunableEntry(pending))
				return args[1] === "prune" ? fail("worktree unregister refused") : ok()
			},
		})

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result).toEqual({
			ok: false,
			stage: "remove",
			error:
				"worktree unregister refused Files remain preserved at /worktrees/yuk-810-delete.preserved-by-opencode.",
		})
		expect(test.stateCompleted()).toBeFalse()
		const unregister = test.gitCalls.at(-1)
		expect(unregister).toEqual({
			args: ["worktree", "prune", "--expire", "now"],
			cwd: "/repo/.git",
		})
		expect(unregister?.args).not.toContain("--force")
	})

	it("never stages, commits, or deletes files and clears state only after quarantine", async () => {
		const test = workflow()

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result).toEqual({
			ok: true,
			preservedPath: "/worktrees/yuk-810-delete.preserved-by-opencode",
		})
		expect(test.stateCompleted()).toBeTrue()
		expect(test.gitCalls).toEqual([
			{
				args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
				cwd: pending.path,
			},
			{
				args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
				cwd: pending.path,
			},
			{
				args: ["worktree", "list", "--porcelain"],
				cwd: "/repo/.git",
			},
			{
				args: ["worktree", "prune", "--expire", "now"],
				cwd: "/repo/.git",
			},
			{
				args: ["worktree", "list", "--porcelain"],
				cwd: "/repo/.git",
			},
		])
		const allArgs = test.gitCalls.flatMap((call) => call.args)
		expect(allArgs).not.toContain("add")
		expect(allArgs).not.toContain("commit")
		expect(allArgs).not.toContain("--force")
		expect(allArgs).not.toContain("remove")
	})

	it("resumes an already-preserved cleanup without running hooks again", async () => {
		let hookCalls = 0
		const test = workflow({
			findPreservedWorktree: async () => `${pending.path}.preserved-by-opencode`,
			runPreDeleteHooks: async () => {
				hookCalls += 1
				return ok()
			},
		})

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result.ok).toBeTrue()
		expect(hookCalls).toBe(0)
		expect(test.gitCalls.map((call) => call.args.slice(0, 2))).toEqual([
			["worktree", "list"],
			["worktree", "prune"],
			["worktree", "list"],
		])
	})

	it("refuses a global prune while another worktree is also prunable", async () => {
		const other = { branch: "codex/other", path: "/worktrees/other" }
		const test = workflow({
			runGit: async (args, cwd) => {
				test.gitCalls.push({ args, cwd })
				if (args[1] === "list") return ok(`${prunableEntry(pending)}\n${prunableEntry(other)}`)
				return ok()
			},
		})

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result.ok).toBeFalse()
		if (result.ok) throw new Error("Expected unrelated prunable worktree to block cleanup")
		expect(result.stage).toBe("remove")
		expect(result.error).toContain("other prunable worktrees")
		expect(result.error).toContain(other.path)
		expect(
			test.gitCalls.map((call) => (call.args[0] === "status" ? "status" : call.args[1])),
		).toEqual(["status", "status", "list"])
		expect(test.stateCompleted()).toBeFalse()
	})
})

async function realGit(args: string[], cwd: string): Promise<GitCommandResult> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	])
	return exitCode === 0 ? ok(stdout.trim()) : fail(stderr.trim() || `git ${args[0]} failed`)
}

function mustGit(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" })
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString())
	}
}

it("keeps real dirty, ignored, and late-arriving files in an auditable preservation path", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "yuk810-worktree-delete-"))
	const repository = join(fixtureRoot, "repository")
	const worktreePath = join(fixtureRoot, "lane")
	await mkdir(repository)

	try {
		mustGit(["init", "-b", "main"], repository)
		mustGit(["config", "user.email", "yuk810@example.invalid"], repository)
		mustGit(["config", "user.name", "YUK-810 test"], repository)
		await writeFile(join(repository, "tracked.txt"), "tracked\n")
		await writeFile(join(repository, ".gitignore"), "*.secret\n")
		mustGit(["add", "tracked.txt", ".gitignore"], repository)
		mustGit(["commit", "-m", "test: YUK-810 fixture"], repository)
		mustGit(["worktree", "add", "-b", "codex/yuk-810-fixture", worktreePath], repository)

		const actualPending = { branch: "codex/yuk-810-fixture", path: worktreePath }
		let completed = false
		let allowCompletion = false
		let hookCalls = 0
		const preservationPath = `${worktreePath}.preserved-by-opencode`
		const gitAdminResult = await realGit(
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			worktreePath,
		)
		if (!gitAdminResult.ok) throw new Error(gitAdminResult.error)
		const gitAdminCwd = gitAdminResult.value
		const postPreservationGitCwds: string[] = []
		const dependencies: DeleteWorkflowDependencies = {
			runGit: async (args, cwd) => {
				if (args[0] === "worktree") postPreservationGitCwds.push(cwd)
				if (args[0] === "worktree" && args[1] === "prune") {
					// Simulate a background process whose cwd followed the atomic rename.
					await writeFile(
						join(preservationPath, "worktree", "late.secret"),
						"arrived during cleanup\n",
					)
				}
				return realGit(args, cwd)
			},
			runPreDeleteHooks: async () => {
				hookCalls += 1
				return ok()
			},
			completeState: () => {
				if (!allowCompletion) return false
				completed = true
				return true
			},
		}

		await writeFile(join(worktreePath, "uncommitted.txt"), "preserve me\n")
		const dirtyResult = await processPendingDelete(actualPending, dependencies)
		expect(dirtyResult.ok).toBeFalse()
		expect(completed).toBeFalse()
		expect((await stat(worktreePath)).isDirectory()).toBeTrue()

		await unlink(join(worktreePath, "uncommitted.txt"))
		await writeFile(join(worktreePath, "valuable.secret"), "ignored but valuable\n")
		const ignoredResult = await processPendingDelete(actualPending, dependencies)
		expect(ignoredResult.ok).toBeFalse()
		expect(completed).toBeFalse()
		expect((await stat(join(worktreePath, "valuable.secret"))).isFile()).toBeTrue()

		await unlink(join(worktreePath, "valuable.secret"))
		const interruptedResult = await processPendingDelete(actualPending, dependencies)
		expect(interruptedResult.ok).toBeFalse()
		if (interruptedResult.ok) throw new Error("Expected state completion to fail closed")
		expect(interruptedResult.stage).toBe("state")
		expect(completed).toBeFalse()
		expect(hookCalls).toBe(1)

		allowCompletion = true
		const cleanResult = await processPendingDelete(actualPending, dependencies)
		expect(cleanResult).toEqual({ ok: true, preservedPath: preservationPath })
		expect(completed).toBeTrue()
		expect(hookCalls).toBe(1)
		expect((await stat(preservationPath)).isDirectory()).toBeTrue()
		expect(await readFile(join(preservationPath, "worktree", "late.secret"), "utf8")).toBe(
			"arrived during cleanup\n",
		)
		expect(await readFile(join(preservationPath, "git-admin-cwd"), "utf8")).toBe(`${gitAdminCwd}\n`)
		expect(postPreservationGitCwds.length).toBeGreaterThan(0)
		expect(postPreservationGitCwds.every((cwd) => cwd === gitAdminCwd)).toBeTrue()
		expect(postPreservationGitCwds).not.toContain(worktreePath)
		expect((await stat(worktreePath)).isFile()).toBeTrue()
		expect(await readFile(worktreePath, "utf8")).toContain(preservationPath)
		const worktreeList = await realGit(["worktree", "list", "--porcelain"], repository)
		expect(worktreeList.ok).toBeTrue()
		if (!worktreeList.ok) throw new Error(worktreeList.error)
		expect(worktreeList.value).not.toContain("refs/heads/codex/yuk-810-fixture")
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true })
	}
})

it("keeps both real lanes registered and retained when another worktree is prunable", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "yuk810-worktree-global-prune-"))
	const repository = join(fixtureRoot, "repository")
	const targetPath = join(fixtureRoot, "target")
	const otherPath = join(fixtureRoot, "other")
	const otherRetainedPath = join(fixtureRoot, "other-retained")
	await mkdir(repository)

	try {
		mustGit(["init", "-b", "main"], repository)
		mustGit(["config", "user.email", "yuk810@example.invalid"], repository)
		mustGit(["config", "user.name", "YUK-810 test"], repository)
		await writeFile(join(repository, "tracked.txt"), "tracked\n")
		mustGit(["add", "tracked.txt"], repository)
		mustGit(["commit", "-m", "test: YUK-810 fixture"], repository)
		mustGit(["worktree", "add", "-b", "codex/yuk-810-target", targetPath], repository)
		mustGit(["worktree", "add", "-b", "codex/yuk-810-other", otherPath], repository)
		await rename(otherPath, otherRetainedPath)

		let stateCompleted = false
		const result = await processPendingDelete(
			{ branch: "codex/yuk-810-target", path: targetPath },
			{
				runGit: realGit,
				runPreDeleteHooks: async () => ok(),
				completeState: () => {
					stateCompleted = true
					return true
				},
			},
		)

		expect(result.ok).toBeFalse()
		if (result.ok) throw new Error("Expected global prune preflight to fail closed")
		expect(result.stage).toBe("remove")
		expect(result.error).toContain("other prunable worktrees")
		expect(stateCompleted).toBeFalse()
		expect(
			await readFile(
				join(`${targetPath}.preserved-by-opencode`, "worktree", "tracked.txt"),
				"utf8",
			),
		).toBe("tracked\n")
		expect(await readFile(join(otherRetainedPath, "tracked.txt"), "utf8")).toBe("tracked\n")
		const worktreeList = await realGit(["worktree", "list", "--porcelain"], repository)
		expect(worktreeList.ok).toBeTrue()
		if (!worktreeList.ok) throw new Error(worktreeList.error)
		expect(worktreeList.value).toContain("refs/heads/codex/yuk-810-target")
		expect(worktreeList.value).toContain("refs/heads/codex/yuk-810-other")
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true })
	}
})

it("does not unregister anything when an absolute-path writer recreates the original path", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "yuk810-worktree-race-"))
	const worktreePath = join(fixtureRoot, "lane")
	await mkdir(worktreePath)
	await writeFile(join(worktreePath, "tracked.txt"), "retained\n")

	try {
		const preservationPath = await preserveWorktree(worktreePath)
		await unlink(worktreePath)
		await mkdir(worktreePath)
		await writeFile(join(worktreePath, "late.secret"), "absolute writer won marker race\n")

		let gitCalls = 0
		let stateCompleted = false
		const result = await processPendingDelete(
			{ branch: "codex/yuk-810-race", path: worktreePath },
			{
				runGit: async () => {
					gitCalls += 1
					return ok()
				},
				runPreDeleteHooks: async () => ok(),
				completeState: () => {
					stateCompleted = true
					return true
				},
			},
		)

		expect(result.ok).toBeFalse()
		if (result.ok) throw new Error("Expected recreated path to fail closed")
		expect(result.stage).toBe("preserve")
		expect(gitCalls).toBe(0)
		expect(stateCompleted).toBeFalse()
		expect(await readFile(join(worktreePath, "late.secret"), "utf8")).toBe(
			"absolute writer won marker race\n",
		)
		expect(await readFile(join(preservationPath, "worktree", "tracked.txt"), "utf8")).toBe(
			"retained\n",
		)
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true })
	}
})

it("recovers an empty preservation root left before its audit record was written", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "yuk810-worktree-empty-root-"))
	const worktreePath = join(fixtureRoot, "lane")
	const preservationPath = `${worktreePath}.preserved-by-opencode`
	await mkdir(worktreePath)
	await writeFile(join(worktreePath, "tracked.txt"), "retained after restart\n")
	await mkdir(preservationPath)

	try {
		expect(await findPreservedWorktree(worktreePath)).toBeNull()
		expect(await preserveWorktree(worktreePath)).toBe(preservationPath)
		expect(await readFile(join(preservationPath, "worktree", "tracked.txt"), "utf8")).toBe(
			"retained after restart\n",
		)
		expect(await readFile(join(preservationPath, "preservation.json"), "utf8")).toContain(
			preservationPath,
		)
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true })
	}
})

function inMemoryStateDb(): Database {
	const database = new Database(":memory:")
	database.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			launch_mode TEXT,
			profile TEXT,
			ocx_bin TEXT
		);
		CREATE TABLE pending_operations (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			type TEXT NOT NULL,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			session_id TEXT
		);
	`)
	return database
}

describe("reservePendingDelete", () => {
	it("completes only the exact pending delete and matching session", () => {
		const database = inMemoryStateDb()
		database
			.prepare(
				"INSERT INTO sessions (id, branch, path, created_at) VALUES ($id, $branch, $path, $createdAt)",
			)
			.run({
				$id: "session-a",
				$branch: "codex/yuk-810-a",
				$path: "/worktrees/a",
				$createdAt: new Date().toISOString(),
			})
		const expected = { branch: "codex/yuk-810-a", path: "/worktrees/a" }
		expect(reservePendingDelete(database, expected).accepted).toBeTrue()

		expect(
			completePendingDelete(database, {
				branch: "codex/yuk-810-other",
				path: "/worktrees/other",
			}),
		).toBeFalse()
		expect(getPendingDelete(database)).toEqual(expected)
		expect(database.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 })

		expect(completePendingDelete(database, expected)).toBeTrue()
		expect(getPendingDelete(database)).toBeNull()
		expect(database.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 })
		database.close()
	})

	it("atomically keeps the first concurrent pending delete instead of replacing it", async () => {
		const database = inMemoryStateDb()
		const candidates: PendingDelete[] = [
			{ branch: "codex/yuk-810-a", path: "/worktrees/a" },
			{ branch: "codex/yuk-810-b", path: "/worktrees/b" },
		]

		const reservations = await Promise.all(
			candidates.map((candidate) =>
				Promise.resolve().then(() => reservePendingDelete(database, candidate)),
			),
		)

		expect(reservations.filter((reservation) => reservation.accepted)).toHaveLength(1)
		expect(reservations.filter((reservation) => !reservation.accepted)).toHaveLength(1)
		const winner = candidates[reservations.findIndex((reservation) => reservation.accepted)]
		expect(getPendingDelete(database)).toEqual(winner)
		database.close()
	})
})
