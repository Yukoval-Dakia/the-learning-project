import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type DeleteWorkflowDependencies,
	type GitCommandResult,
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

function workflow(overrides: Partial<DeleteWorkflowDependencies> = {}) {
	const gitCalls: Array<{ args: string[]; cwd: string }> = []
	let stateCompleted = false
	const dependencies: DeleteWorkflowDependencies = {
		repoRoot: "/repo",
		runGit: async (args, cwd) => {
			gitCalls.push({ args, cwd })
			return ok()
		},
		runPreDeleteHooks: async () => ok(),
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

	it("preserves pending/session state when non-force worktree removal fails", async () => {
		const test = workflow({
			runGit: async (args, cwd) => {
				test.gitCalls.push({ args, cwd })
				return args[0] === "worktree" ? fail("worktree removal refused") : ok()
			},
		})

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result).toEqual({ ok: false, stage: "remove", error: "worktree removal refused" })
		expect(test.stateCompleted()).toBeFalse()
		const remove = test.gitCalls.at(-1)
		expect(remove).toEqual({
			args: ["worktree", "remove", pending.path],
			cwd: "/repo",
		})
		expect(remove?.args).not.toContain("--force")
	})

	it("never stages or commits and clears state only after a clean non-force removal", async () => {
		const test = workflow()

		const result = await processPendingDelete(pending, test.dependencies)

		expect(result).toEqual({ ok: true })
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
				args: ["worktree", "remove", pending.path],
				cwd: "/repo",
			},
		])
		const allArgs = test.gitCalls.flatMap((call) => call.args)
		expect(allArgs).not.toContain("add")
		expect(allArgs).not.toContain("commit")
		expect(allArgs).not.toContain("--force")
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

it("keeps real dirty and ignored files, then removes the worktree after explicit cleanup", async () => {
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
		const dependencies: DeleteWorkflowDependencies = {
			repoRoot: repository,
			runGit: realGit,
			runPreDeleteHooks: async () => ok(),
			completeState: () => {
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
		const cleanResult = await processPendingDelete(actualPending, dependencies)
		expect(cleanResult).toEqual({ ok: true })
		expect(completed).toBeTrue()
		expect(await stat(worktreePath).catch(() => null)).toBeNull()
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
