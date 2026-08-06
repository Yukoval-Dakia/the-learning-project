import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseJsonc } from "jsonc-parser"

export type NpmPluginInventory = {
	id: string
	package: string
	version: string
	specifier: string
	integrity: string
	runtimePackageCount: number
	runtimeGraphSha256: string
	license: string
	upstream: string
	requiredToolIds: string[]
}

export type LocalPluginInventory = {
	id: string
	path: string
	version: string
	requiredToolIds: string[]
}

export type PluginInventory = {
	schemaVersion: number
	owner: string
	projectConfig: string
	packageManager: string
	opencode: {
		version: string
		package: string
		integrity: string
	}
	compatibility: {
		ohMyOpenagentConfigs: string[]
		disabledHooks: string[]
		openCodeCompactionAuto: boolean
	}
	overrides: Record<string, string>
	npmPlugins: NpmPluginInventory[]
	localPlugins: LocalPluginInventory[]
	forbiddenSpecifiers: string[]
}

export type PackageManifest = {
	packageManager?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	overrides?: Record<string, string>
}

export type ResolvedConfig = {
	plugin?: unknown
}

type RuntimePackageRow = {
	path: string
	name: string
	version: string
	integrity: string
}

export const pluginsRoot = resolve(import.meta.dir, "..")
export const repositoryRoot = resolve(import.meta.dir, "../../..")

export function localOpenCodeBinary() {
	const platforms: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
	const platform = platforms[process.platform]
	invariant(platform, `unsupported OpenCode verification platform: ${process.platform}`)
	const architectures: Record<string, string> = { arm64: "arm64", x64: "x64" }
	const architecture = architectures[process.arch]
	invariant(architecture, `unsupported OpenCode verification architecture: ${process.arch}`)
	const binary = process.platform === "win32" ? "opencode.exe" : "opencode"
	return resolve(pluginsRoot, "node_modules", `opencode-${platform}-${architecture}`, "bin", binary)
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function asStringArray(value: unknown, name: string): string[] {
	invariant(Array.isArray(value), `${name} must be an array`)
	invariant(
		value.every((item) => typeof item === "string"),
		`${name} must contain only strings`,
	)
	return value
}

function sameList(actual: string[], expected: string[], name: string) {
	invariant(
		actual.length === expected.length && actual.every((value, index) => value === expected[index]),
		`${name} mismatch\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
	)
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function packageResolutionKey(name: string, version: string, integrity: string) {
	return JSON.stringify([name, version, integrity])
}

function parseBunPackageVersion(value: string) {
	const separator = value.lastIndexOf("@")
	invariant(separator > 0, `invalid bun.lock package resolution: ${value}`)
	return { name: value.slice(0, separator), version: value.slice(separator + 1) }
}

export function collectBunResolutions(lock: string) {
	const parsed = parseJsonc(lock) as { packages?: unknown }
	invariant(parsed.packages && typeof parsed.packages === "object", "bun.lock packages are missing")
	const resolutions = new Set<string>()
	for (const value of Object.values(parsed.packages as Record<string, unknown>)) {
		invariant(Array.isArray(value) && typeof value[0] === "string", "invalid bun.lock package row")
		const integrity = value.at(-1)
		if (typeof integrity !== "string" || !integrity.startsWith("sha")) continue
		const resolution = parseBunPackageVersion(value[0])
		resolutions.add(packageResolutionKey(resolution.name, resolution.version, integrity))
	}
	invariant(resolutions.size > 0, "bun.lock contains no integrity resolutions")
	return resolutions
}

export function runtimePackageGraph(lock: Record<string, unknown>) {
	const packages = lock.packages
	invariant(packages && typeof packages === "object", "runtime package-lock is missing packages")
	const rows: RuntimePackageRow[] = []
	const normalizedPaths = new Set<string>()
	for (const [rawPath, rawValue] of Object.entries(packages as Record<string, unknown>)) {
		if (rawPath === "") continue
		const nodeModules = rawPath.indexOf("node_modules/")
		invariant(nodeModules >= 0, `runtime package-lock contains an unexpected path: ${rawPath}`)
		const path = rawPath.slice(nodeModules)
		invariant(!normalizedPaths.has(path), `runtime package-lock contains duplicate path: ${path}`)
		normalizedPaths.add(path)
		invariant(
			rawValue && typeof rawValue === "object",
			`runtime package-lock row is invalid: ${path}`,
		)
		const value = rawValue as Record<string, unknown>
		invariant(typeof value.version === "string", `runtime package-lock version is missing: ${path}`)
		invariant(
			typeof value.integrity === "string",
			`runtime package-lock integrity is missing: ${path}`,
		)
		const packageMarker = path.lastIndexOf("node_modules/")
		const name = path.slice(packageMarker + "node_modules/".length)
		invariant(name.length > 0, `runtime package-lock package name is missing: ${path}`)
		rows.push({ path, name, version: value.version, integrity: value.integrity })
	}
	rows.sort((left, right) => left.path.localeCompare(right.path))
	return rows
}

export function runtimeGraphSha256(rows: RuntimePackageRow[]) {
	const canonical = rows.map(({ path, name, version, integrity }) => [
		path,
		name,
		version,
		integrity,
	])
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export function normalizeResolvedPlugin(specifier: string, root = repositoryRoot) {
	if (!specifier.startsWith("file://")) return specifier
	const filepath = fileURLToPath(specifier)
	const relativePath = relative(root, filepath)
	if (relativePath.startsWith(`..${sep}`) || relativePath === "..") return specifier
	return relativePath.split(sep).join("/")
}

export function validateProjectConfig(config: Record<string, unknown>, inventory: PluginInventory) {
	const keys = Object.keys(config).sort()
	sameList(keys, ["$schema", "compaction", "plugin"], "project config keys")
	invariant(config.$schema === "https://opencode.ai/config.json", "project config schema mismatch")
	const compaction = config.compaction
	invariant(compaction && typeof compaction === "object", "project compaction config is required")
	sameList(Object.keys(compaction).sort(), ["auto"], "project compaction config keys")
	invariant(
		(compaction as Record<string, unknown>).auto ===
			inventory.compatibility.openCodeCompactionAuto &&
			inventory.compatibility.openCodeCompactionAuto === false,
		"OpenCode auto-compaction must be disabled for Magic Context compatibility",
	)

	const actual = asStringArray(config.plugin, "project config plugin")
	const expected = inventory.npmPlugins.map((plugin) => plugin.specifier)
	sameList(actual, expected, "project config plugin order")

	for (const specifier of actual) {
		invariant(!specifier.includes("@latest"), `floating plugin version is forbidden: ${specifier}`)
		invariant(
			!inventory.forbiddenSpecifiers.includes(specifier),
			`forbidden plugin configured: ${specifier}`,
		)
	}
}

export function validateOhMyOpenagentConfig(
	config: Record<string, unknown>,
	inventory: PluginInventory,
) {
	sameList(Object.keys(config).sort(), ["disabled_hooks"], "Oh My OpenAgent project config keys")
	const actual = asStringArray(config.disabled_hooks, "Oh My OpenAgent disabled hooks")
	sameList(actual, inventory.compatibility.disabledHooks, "Oh My OpenAgent compatibility hooks")
}

export function validatePackageManifest(manifest: PackageManifest, inventory: PluginInventory) {
	invariant(
		manifest.packageManager === inventory.packageManager,
		"packageManager must match inventory",
	)

	const dependencies = manifest.dependencies ?? {}
	for (const plugin of inventory.npmPlugins) {
		invariant(
			dependencies[plugin.package] === plugin.version,
			`${plugin.package} must be an exact dependency at ${plugin.version}`,
		)
	}

	const devDependencies = manifest.devDependencies ?? {}
	invariant(
		devDependencies[inventory.opencode.package] === inventory.opencode.version,
		`${inventory.opencode.package} must pin OpenCode ${inventory.opencode.version}`,
	)

	for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies })) {
		invariant(!/[~^*]/.test(version) && version !== "latest", `${name} must use an exact version`)
	}

	invariant(
		JSON.stringify(manifest.overrides) === JSON.stringify(inventory.overrides),
		"transitive drift overrides must match inventory",
	)
}

export function validateBunLock(lock: string, inventory: PluginInventory) {
	for (const plugin of inventory.npmPlugins) {
		const prefix = `"${plugin.package}": ["${plugin.package}@${plugin.version}"`
		invariant(lock.includes(prefix), `bun.lock is missing ${plugin.specifier}`)
		const row = new RegExp(
			`"${escapeRegExp(plugin.package)}": \\["${escapeRegExp(plugin.specifier)}"[^\\n]*"${escapeRegExp(plugin.integrity)}"\\]`,
		).exec(lock)
		invariant(row, `bun.lock integrity mismatch for ${plugin.specifier}`)
	}

	const opencodePrefix = `"${inventory.opencode.package}": ["${inventory.opencode.package}@${inventory.opencode.version}"`
	invariant(lock.includes(opencodePrefix), `bun.lock is missing ${inventory.opencode.package}`)
	invariant(lock.includes(inventory.opencode.integrity), "bun.lock OpenCode integrity mismatch")
	invariant(
		!lock.includes('"list": ["list@'),
		"bun.lock must not contain the accidental list package",
	)
}

export function validateResolvedConfig(
	config: ResolvedConfig,
	inventory: PluginInventory,
	root = repositoryRoot,
) {
	const actual = asStringArray(config.plugin, "resolved config plugin").map((plugin) =>
		normalizeResolvedPlugin(plugin, root),
	)
	const expected = [
		...inventory.npmPlugins.map((plugin) => plugin.specifier),
		...inventory.localPlugins.map((plugin) => plugin.path),
	]
	sameList(actual, expected, "resolved plugin inventory")
}

export function validateTrackedLocks(paths: string[]) {
	const lockfiles = paths.filter((filepath) =>
		/(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
			filepath,
		),
	)
	sameList(lockfiles, [".opencode/plugins/bun.lock"], "tracked OpenCode lockfiles")
}

export function validateRuntimePackageLock(
	lock: Record<string, unknown>,
	plugin: NpmPluginInventory,
	approvedResolutions: ReadonlySet<string>,
) {
	const rows = runtimePackageGraph(lock)
	const row = rows.find((candidate) => candidate.path === `node_modules/${plugin.package}`)
	invariant(row, `${plugin.specifier} runtime package-lock is missing its package row`)
	invariant(
		row.version === plugin.version,
		`${plugin.package} loaded version ${String(row.version)}`,
	)
	invariant(row.integrity === plugin.integrity, `${plugin.package} loaded integrity mismatch`)
	for (const runtimePackage of rows) {
		const approved = approvedResolutions.has(
			packageResolutionKey(runtimePackage.name, runtimePackage.version, runtimePackage.integrity),
		)
		invariant(
			approved,
			`${plugin.specifier} runtime package is not in bun.lock: ${runtimePackage.path} -> ${runtimePackage.name}@${runtimePackage.version}`,
		)
	}
	invariant(
		rows.length === plugin.runtimePackageCount,
		`${plugin.specifier} runtime package count drifted: expected ${plugin.runtimePackageCount}, actual ${rows.length}`,
	)
	const digest = runtimeGraphSha256(rows)
	invariant(
		digest === plugin.runtimeGraphSha256,
		`${plugin.specifier} runtime graph drifted: expected ${plugin.runtimeGraphSha256}, actual ${digest}`,
	)
	return rows.length
}

export async function loadInventory(): Promise<PluginInventory> {
	return Bun.file(resolve(import.meta.dir, "inventory.json")).json()
}

export async function loadJson(filepath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(filepath, "utf8")) as Record<string, unknown>
}
