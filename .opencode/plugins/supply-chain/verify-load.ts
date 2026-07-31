import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
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

function safeEnvironment(home: string, password: string) {
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
	env.OPENCODE_SERVER_PASSWORD = password
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

async function freePort() {
	return new Promise<number>((resolvePort, reject) => {
		const server = createServer()
		server.unref()
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (!address || typeof address === "string") {
				server.close()
				reject(new Error("failed to allocate a local verification port"))
				return
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)))
		})
	})
}

async function waitForPort(port: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolveConnection) => {
			const socket = createConnection({ host: "127.0.0.1", port })
			socket.once("connect", () => {
				socket.end()
				resolveConnection(true)
			})
			socket.once("error", () => resolveConnection(false))
		})
		if (connected) return
		await Bun.sleep(100)
	}
	throw new Error(`OpenCode server did not listen within ${timeoutMs}ms`)
}

async function stopProcess(process: Bun.Subprocess) {
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

function sanitizedTail(value: string) {
	return value
		.split("\n")
		.filter(Boolean)
		.slice(-40)
		.join("\n")
		.replace(/(password|token|authorization|api[_-]?key)=[^\s]+/gi, "$1=<redacted>")
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
	const workspace = await createIsolatedWorkspace(home)
	const password = randomUUID()
	const port = await freePort()
	const serverProcess = Bun.spawn({
		cmd: [localOpenCodeBinary(), "serve", "--hostname", "127.0.0.1", "--port", String(port)],
		cwd: workspace,
		env: safeEnvironment(home, password),
		stdout: "pipe",
		stderr: "pipe",
	})
	const stdout = new Response(serverProcess.stdout).text()
	const stderr = new Response(serverProcess.stderr).text()
	let failure: unknown

	try {
		await waitForPort(port, 15_000)
		const url = new URL(`http://127.0.0.1:${port}/experimental/tool/ids`)
		url.searchParams.set("directory", workspace)
		const auth = Buffer.from(`opencode:${password}`).toString("base64")
		const response = await fetch(url, {
			headers: { authorization: `Basic ${auth}` },
			signal: AbortSignal.timeout(600_000),
		})
		invariant(response.ok, `OpenCode tool inventory endpoint returned ${response.status}`)
		const ids = await response.json()
		invariant(
			Array.isArray(ids) && ids.every((id) => typeof id === "string"),
			"tool inventory was not a string array",
		)
		const loaded = new Set(ids as string[])
		for (const plugin of [...inventory.npmPlugins, ...inventory.localPlugins]) {
			for (const id of plugin.requiredToolIds) {
				invariant(loaded.has(id), `${plugin.id} did not register required tool ${id}`)
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
		await stopProcess(serverProcess)
	}

	const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
	await rm(home, { recursive: true, force: true })
	const statusAfter = repositoryStatus()
	if (statusAfter !== statusBefore && !failure)
		failure = new Error("actual-load check changed repository status")
	if (failure) {
		const output = sanitizedTail(`${stdoutText}\n${stderrText}`)
		throw new Error(
			`${failure instanceof Error ? failure.message : String(failure)}${output ? `\n${output}` : ""}`,
		)
	}

	console.log(
		`OpenCode actual-load verified at ${inventory.opencode.version}: ${inventory.npmPlugins.length + inventory.localPlugins.length} plugins registered required tools, complete npm graphs matched the tracked Bun resolution superset, and the repository stayed unchanged.`,
	)
}

await main()
