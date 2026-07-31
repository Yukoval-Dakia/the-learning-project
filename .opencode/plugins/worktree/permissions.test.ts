import { describe, expect, it } from "bun:test"
import { executableScriptMode } from "./permissions"

describe("executableScriptMode", () => {
	it.each([
		[0o022, 0o755],
		[0o027, 0o750],
		[0o077, 0o700],
	])("applies umask %o to the requested executable mode", (umask, expected) => {
		expect(executableScriptMode(umask)).toBe(expected)
	})
})
