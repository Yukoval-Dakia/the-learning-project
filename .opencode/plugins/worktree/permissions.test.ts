import { describe, expect, it } from "bun:test"
import { executableScriptMode, privateDirectoryMode, privateFileMode } from "./permissions"

describe("permission modes", () => {
	it.each([
		[0o022, 0o755],
		[0o027, 0o750],
		[0o077, 0o700],
	])("applies umask %o to the requested executable mode", (umask, expected) => {
		expect(executableScriptMode(umask)).toBe(expected)
	})

	it.each([0o022, 0o027, 0o077])("keeps private preservation modes under umask %o", (umask) => {
		expect(privateDirectoryMode(umask)).toBe(0o700)
		expect(privateFileMode(umask)).toBe(0o600)
	})
})
