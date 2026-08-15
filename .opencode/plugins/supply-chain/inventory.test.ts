import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
	collectBunResolutions,
	loadInventory,
	loadJson,
	normalizeResolvedPlugin,
	pluginsRoot,
	repositoryRoot,
	runtimeGraphSha256,
	runtimePackageGraph,
	validateBunLock,
	validateOhMyOpenagentConfig,
	validatePackageManifest,
	validateProjectConfig,
	validateResolvedConfig,
	validateRuntimePackageLock,
	validateTrackedLocks,
} from "./inventory"

const inventory = await loadInventory()
const bunLock = await readFile(resolve(pluginsRoot, "bun.lock"), "utf8")
const approvedResolutions = collectBunResolutions(bunLock)

function projectConfig(plugin = inventory.npmPlugins.map((item) => item.specifier)) {
	return {
		$schema: "https://opencode.ai/config.json",
		compaction: { auto: false },
		plugin,
	}
}

describe("OpenCode plugin supply-chain inventory", () => {
	it("keeps the project config, manifest, and Bun integrity lock aligned", async () => {
		const config = await loadJson(resolve(repositoryRoot, inventory.projectConfig))
		const compatibilityConfigs = await Promise.all(
			inventory.compatibility.ohMyOpenagentConfigs.map((filepath) =>
				loadJson(resolve(repositoryRoot, filepath)),
			),
		)
		const manifest = (await loadJson(resolve(pluginsRoot, "package.json"))) as Parameters<
			typeof validatePackageManifest
		>[0]

		expect(() => validateProjectConfig(config, inventory)).not.toThrow()
		for (const compatibilityConfig of compatibilityConfigs) {
			expect(() => validateOhMyOpenagentConfig(compatibilityConfig, inventory)).not.toThrow()
		}
		expect(compatibilityConfigs[0]).toEqual(compatibilityConfigs[1])
		expect(() => validatePackageManifest(manifest, inventory)).not.toThrow()
		expect(() => validateBunLock(bunLock, inventory)).not.toThrow()
	})

	it("rejects floating, accidental, missing, or reordered project plugins", () => {
		const expected = inventory.npmPlugins.map((plugin) => plugin.specifier)
		expect(() => validateProjectConfig(projectConfig(expected), inventory)).not.toThrow()
		expect(() => validateProjectConfig(projectConfig(["list", ...expected]), inventory)).toThrow(
			"project config plugin order mismatch",
		)
		expect(() =>
			validateProjectConfig(
				projectConfig(expected.map((specifier) => specifier.replace(/@[0-9].*$/, "@latest"))),
				inventory,
			),
		).toThrow("project config plugin order mismatch")
		expect(() => validateProjectConfig(projectConfig([...expected].reverse()), inventory)).toThrow(
			"project config plugin order mismatch",
		)
		expect(() =>
			validateProjectConfig({ ...projectConfig(expected), compaction: { auto: true } }, inventory),
		).toThrow("auto-compaction must be disabled")
	})

	it("pins the cross-plugin compaction boundary", () => {
		expect(() =>
			validateOhMyOpenagentConfig(
				{ disabled_hooks: inventory.compatibility.disabledHooks },
				inventory,
			),
		).not.toThrow()
		expect(() =>
			validateOhMyOpenagentConfig(
				{ disabled_hooks: inventory.compatibility.disabledHooks.slice(1) },
				inventory,
			),
		).toThrow("compatibility hooks mismatch")
	})

	it("normalizes only repository-owned file URLs in the resolved snapshot", () => {
		const local = pathToFileURL(resolve(repositoryRoot, ".opencode/plugins/worktree.ts")).href
		expect(normalizeResolvedPlugin(local)).toBe(".opencode/plugins/worktree.ts")
		expect(normalizeResolvedPlugin("file:///private/tmp/external-plugin.ts")).toBe(
			"file:///private/tmp/external-plugin.ts",
		)
	})

	it("requires the complete resolved npm and local plugin inventory", () => {
		const plugin = [
			...inventory.npmPlugins.map((item) => item.specifier),
			pathToFileURL(resolve(repositoryRoot, inventory.localPlugins[0]?.path ?? "missing")).href,
		]
		expect(() => validateResolvedConfig({ plugin }, inventory)).not.toThrow()
		expect(() => validateResolvedConfig({ plugin: plugin.slice(0, -1) }, inventory)).toThrow(
			"resolved plugin inventory mismatch",
		)
	})

	it("allows one tracked Bun lock and rejects a second package-manager lock", () => {
		expect(() => validateTrackedLocks([".opencode/plugins/bun.lock"])).not.toThrow()
		expect(() =>
			validateTrackedLocks([".opencode/plugins/bun.lock", ".opencode/package-lock.json"]),
		).toThrow("tracked OpenCode lockfiles mismatch")
	})

	it("checks every runtime package path against the approved Bun resolution graph", () => {
		const plugin = inventory.npmPlugins[0]
		expect(plugin).toBeDefined()
		if (!plugin) return
		const lock = {
			packages: {
				"": { dependencies: { [plugin.package]: plugin.version } },
				[`../../isolated-cache/node_modules/${plugin.package}`]: {
					version: plugin.version,
					integrity: plugin.integrity,
				},
			},
		}
		const rows = runtimePackageGraph(lock)
		const fixturePlugin = {
			...plugin,
			runtimePackageCount: rows.length,
			runtimeGraphSha256: runtimeGraphSha256(rows),
		}
		expect(() => validateRuntimePackageLock(lock, fixturePlugin, approvedResolutions)).not.toThrow()
		expect(() =>
			validateRuntimePackageLock(
				{
					packages: {
						[`node_modules/${plugin.package}`]: {
							version: "0.0.0",
							integrity: plugin.integrity,
						},
					},
				},
				fixturePlugin,
				approvedResolutions,
			),
		).toThrow("loaded version 0.0.0")
		expect(() =>
			validateRuntimePackageLock(
				{
					packages: {
						[`node_modules/${plugin.package}`]: {
							version: plugin.version,
							integrity: plugin.integrity,
						},
						[`node_modules/parent/node_modules/${plugin.package}`]: {
							version: plugin.version,
							integrity: plugin.integrity,
						},
					},
				},
				fixturePlugin,
				approvedResolutions,
			),
		).toThrow("runtime package count drifted")
		expect(() =>
			validateRuntimePackageLock(
				{
					packages: {
						[`node_modules/${plugin.package}`]: {
							version: plugin.version,
							integrity: plugin.integrity,
						},
						"node_modules/unreviewed": {
							version: "1.0.0",
							integrity: "sha512-unreviewed",
						},
					},
				},
				fixturePlugin,
				approvedResolutions,
			),
		).toThrow("runtime package is not in bun.lock")
	})
})
