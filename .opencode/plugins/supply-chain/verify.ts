import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
	loadInventory,
	loadJson,
	localOpenCodeBinary,
	pluginsRoot,
	repositoryRoot,
	validateBunLock,
	validateOhMyOpenagentConfig,
	validatePackageManifest,
	validateProjectConfig,
	validateResolvedConfig,
	validateTrackedLocks,
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
	env.DO_NOT_TRACK = "1"
	return env
}

async function main() {
	const inventory = await loadInventory()
	const projectConfigPath = resolve(repositoryRoot, inventory.projectConfig)
	const projectConfig = await loadJson(projectConfigPath)
	const compatibilityConfigs = await Promise.all(
		inventory.compatibility.ohMyOpenagentConfigs.map((filepath) =>
			loadJson(resolve(repositoryRoot, filepath)),
		),
	)
	const manifest = (await loadJson(resolve(pluginsRoot, "package.json"))) as Parameters<
		typeof validatePackageManifest
	>[0]
	const lock = await readFile(resolve(pluginsRoot, "bun.lock"), "utf8")

	validateProjectConfig(projectConfig, inventory)
	for (const compatibilityConfig of compatibilityConfigs) {
		validateOhMyOpenagentConfig(compatibilityConfig, inventory)
	}
	invariant(
		compatibilityConfigs.every(
			(config) => JSON.stringify(config) === JSON.stringify(compatibilityConfigs[0]),
		),
		"Oh My OpenAgent compatibility configs must remain identical",
	)
	validatePackageManifest(manifest, inventory)
	validateBunLock(lock, inventory)

	const tracked = Bun.spawnSync({
		cmd: ["git", "ls-files", ".opencode"],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	invariant(tracked.exitCode === 0, `git ls-files failed: ${tracked.stderr.toString().trim()}`)
	validateTrackedLocks(tracked.stdout.toString().split("\n").filter(Boolean))

	const home = await mkdtemp(join(tmpdir(), "yukoval-opencode-inventory-"))
	try {
		const configDir = join(home, ".config", "opencode")
		await mkdir(configDir, { recursive: true })
		// Reproduce the real user overlay without copying any user-owned config or credentials.
		// OpenCode 1.18.10 deduplicates npm plugins by package name and keeps the later project source.
		await writeFile(
			join(configDir, "opencode.json"),
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				plugin: ["oh-my-openagent@latest", "@cortexkit/opencode-magic-context@latest"],
			}),
		)

		const opencode = localOpenCodeBinary()
		const env = safeEnvironment(home)
		const version = Bun.spawnSync({ cmd: [opencode, "--version"], cwd: repositoryRoot, env })
		invariant(version.exitCode === 0, "pinned OpenCode binary did not start")
		invariant(
			version.stdout.toString().trim() === inventory.opencode.version,
			"OpenCode version mismatch",
		)

		const result = Bun.spawnSync({
			cmd: [opencode, "debug", "config", "--pure"],
			cwd: repositoryRoot,
			env,
			stdout: "pipe",
			stderr: "pipe",
		})
		invariant(
			result.exitCode === 0,
			`opencode debug config --pure failed: ${result.stderr.toString().trim()}`,
		)
		const resolved = JSON.parse(result.stdout.toString()) as { plugin?: unknown }
		validateResolvedConfig(resolved, inventory)
	} finally {
		await rm(home, { recursive: true, force: true })
	}

	console.log(
		`OpenCode supply-chain inventory verified: ${inventory.npmPlugins.length} exact npm plugins, ` +
			`${inventory.localPlugins.length} local plugin, one tracked Bun lock.`,
	)
}

await main()
