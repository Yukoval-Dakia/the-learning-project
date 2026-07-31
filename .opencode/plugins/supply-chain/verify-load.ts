import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
	collectBunResolutions,
	loadInventory,
	localOpenCodeBinary,
	pluginsRoot,
	repositoryRoot,
	validateRuntimePackageLock,
} from "./inventory"

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function safeEnvironment(home: string) {
	const env: Record<string, string> = {}
	for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE"]) {
		const value = process.env[key]
		if (value) env[key] = value
	}
	env.HOME = home
	env.XDG_CONFIG_HOME = join(home, ".config")
	env.XDG_CACHE_HOME = join(home, ".cache")
	env.XDG_DATA_HOME = join(home, ".local", "share")
	env.XDG_STATE_HOME = join(home, ".local", "state")
	env.TMPDIR = join(home, "tmp")
	env.TMP = env.TMPDIR
	env.TEMP = env.TMPDIR
	env.DO_NOT_TRACK = "1"
	return env
}

function repositoryStatus() {
	const result = Bun.spawnSync({
		cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	invariant(result.exitCode === 0, `git status failed: ${result.stderr.toString().trim()}`)
	return result.stdout.toString()
}

async function createIsolatedWorkspace(home: string) {
	const workspace = join(home, "workspace")
	const targetPlugins = join(workspace, ".opencode", "plugins")
	await mkdir(targetPlugins, { recursive: true })
	await mkdir(join(home, "tmp"), { recursive: true })
	for (const filepath of [
		".opencode/opencode.json",
		".opencode/oh-my-openagent.json",
		"oh-my-openagent.json",
		".opencode/plugins/worktree.ts",
	]) {
		await cp(resolve(repositoryRoot, filepath), resolve(workspace, filepath))
	}
	for (const directory of [".opencode/plugins/kdco-primitives", ".opencode/plugins/worktree"]) {
		await cp(resolve(repositoryRoot, directory), resolve(workspace, directory), { recursive: true })
	}
	await symlink(
		resolve(pluginsRoot, "node_modules"),
		join(targetPlugins, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	)
	const git = Bun.spawnSync({ cmd: ["git", "init", "--quiet"], cwd: workspace, stderr: "pipe" })
	invariant(git.exitCode === 0, `isolated git init failed: ${git.stderr.toString().trim()}`)
	return workspace
}

function sanitizedTail(value: string) {
	return value
		.split("\n")
		.filter(Boolean)
		.slice(-40)
		.join("\n")
		.replace(/(password|token|authorization|api[_-]?key)=[^\s]+/gi, "$1=<redacted>")
}

async function loadToolSnapshot(home: string, workspace: string) {
	const process = Bun.spawn({
		cmd: [localOpenCodeBinary(), "debug", "agent", "build"],
		cwd: workspace,
		env: safeEnvironment(home),
		stdout: "pipe",
		stderr: "pipe",
	})
	const stdout = new Response(process.stdout).text()
	const stderr = new Response(process.stderr).text()
	const exitCode = await Promise.race([
		process.exited,
		Bun.sleep(12 * 60_000).then(() => undefined),
	])
	if (exitCode === undefined) {
		process.kill("SIGTERM")
		const exited = await Promise.race([
			process.exited.then(() => true),
			Bun.sleep(5_000).then(() => false),
		])
		if (!exited) {
			process.kill("SIGKILL")
			await process.exited
		}
	}
	const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
	invariant(
		exitCode !== undefined,
		`OpenCode did not emit a finite tool snapshot and exit within 12 minutes\n${sanitizedTail(stderrText)}`,
	)
	invariant(
		exitCode === 0,
		`OpenCode tool snapshot exited ${exitCode}\n${sanitizedTail(stderrText)}`,
	)
	let snapshot: unknown
	try {
		snapshot = JSON.parse(stdoutText)
	} catch (error) {
		throw new Error(
			`OpenCode tool snapshot was not JSON: ${error instanceof Error ? error.message : String(error)}\n${sanitizedTail(`${stdoutText}\n${stderrText}`)}`,
		)
	}
	invariant(snapshot && typeof snapshot === "object", "OpenCode tool snapshot was not an object")
	const tools = (snapshot as Record<string, unknown>).tools
	invariant(tools && typeof tools === "object", "OpenCode tool snapshot did not contain tools")
	return tools as Record<string, unknown>
}

function cacheDirectory(home: string, specifier: string) {
	const safe =
		process.platform === "win32"
			? [...specifier]
					.map((character) =>
						character.charCodeAt(0) <= 31 || /[<>:"|?*]/.test(character) ? "_" : character,
					)
					.join("")
			: specifier
	return join(home, ".cache", "opencode", "packages", safe)
}

async function main() {
	const inventory = await loadInventory()
	const approvedResolutions = collectBunResolutions(
		await readFile(resolve(pluginsRoot, "bun.lock"), "utf8"),
	)
	const statusBefore = repositoryStatus()
	const home = await mkdtemp(join(tmpdir(), "yukoval-opencode-load-"))
	let failure: unknown

	try {
		const workspace = await createIsolatedWorkspace(home)
		const loaded = await loadToolSnapshot(home, workspace)
		for (const plugin of [...inventory.npmPlugins, ...inventory.localPlugins]) {
			for (const id of plugin.requiredToolIds) {
				invariant(loaded[id] === true, `${plugin.id} did not register enabled tool ${id}`)
			}
		}

		let runtimePackageCount = 0
		for (const plugin of inventory.npmPlugins) {
			const lockPath = join(cacheDirectory(home, plugin.specifier), "package-lock.json")
			const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>
			runtimePackageCount += validateRuntimePackageLock(lock, plugin, approvedResolutions)
		}
		invariant(runtimePackageCount > 0, "OpenCode runtime package graph was empty")
	} catch (error) {
		failure = error
	} finally {
		await rm(home, { recursive: true, force: true })
	}

	const statusAfter = repositoryStatus()
	if (statusAfter !== statusBefore && !failure)
		failure = new Error("actual-load check changed repository status")
	if (failure) throw failure

	console.log(
		`OpenCode actual-load verified at ${inventory.opencode.version}: ${inventory.npmPlugins.length + inventory.localPlugins.length} plugins registered required tools, complete npm graphs matched the tracked Bun resolution superset, and the repository stayed unchanged.`,
	)
}

await main()
