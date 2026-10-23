import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	confinedExecArgv,
	confinePath,
	startupDecision,
	TRUST_WARNING,
} from "../src/confine.js";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "cadmus-jail-")));
}

describe("daemon confinement", () => {
	it("rejects .., an absolute path outside, and a symlink realpath outside", () => {
		const root = scratch();
		const outside = scratch();
		try {
			writeFileSync(join(outside, "secret"), "nope");
			mkdirSync(join(root, "nested"));
			symlinkSync(join(outside, "secret"), join(root, "leak"));
			const escaped = confinePath(root, "../escape");
			expect(escaped.ok).toBe(false);
			if (!escaped.ok) expect(escaped.error.code).toBe("permission_denied");
			const absolute = confinePath(root, join(outside, "secret"));
			expect(absolute.ok).toBe(false);
			if (!absolute.ok) expect(absolute.error.code).toBe("permission_denied");
			const link = confinePath(root, join(root, "leak"));
			expect(link.ok).toBe(false);
			if (!link.ok) expect(link.error.code).toBe("permission_denied");
			const inside = confinePath(root, join(root, "nested", "note.txt"));
			expect(inside.ok).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects a dangling symlink whose target is outside the workspace", () => {
		const root = scratch();
		const outside = scratch();
		try {
			const target = join(outside, "malicious");
			symlinkSync(target, join(root, "leak"));
			const link = confinePath(root, "leak");
			expect(link.ok).toBe(false);
			if (!link.ok) expect(link.error.code).toBe("permission_denied");
			const relative = confinePath(root, join(root, "leak"));
			expect(relative.ok).toBe(false);
			expect(existsSync(target)).toBe(false);
			symlinkSync(join(root, "nested", "new.txt"), join(root, "alias"));
			const inside = confinePath(root, "alias");
			expect(inside.ok).toBe(true);
			if (inside.ok) expect(inside.path).toBe(join(root, "alias"));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps the full basename when the missing segment's parent is /", () => {
		const name = `cadmus-missing-${process.pid}-${Date.now()}`;
		const single = confinePath("/", name);
		expect(single.ok).toBe(true);
		if (single.ok) expect(single.path).toBe(`/${name}`);
		const nested = confinePath("/", `${name}/child`);
		expect(nested.ok).toBe(true);
		if (nested.ok) expect(nested.path).toBe(`/${name}/child`);
	});

	it("ro-binds /lib, /lib64, and /etc for bwrap when they exist", () => {
		const argv = confinedExecArgv({
			mechanism: "bwrap",
			workspace: "/tmp/cadmus-ws",
			command: "true",
		});
		for (const dir of ["/lib", "/lib64", "/etc"]) {
			if (!existsSync(dir)) {
				expect(argv).not.toContain(dir);
				continue;
			}
			const at = argv.indexOf(dir);
			expect(argv[at - 1]).toBe("--ro-bind");
			expect(argv[at + 1]).toBe(dir);
		}
	});

	it("refuses to start when confinement is on and no mechanism exists", () => {
		const refused = startupDecision({
			confineToWorkspace: true,
			detector: { bwrap: false, sandboxExec: false },
		});
		expect(refused.start).toBe(false);
		if (!refused.start) {
			expect(refused.reason).toBe(
				"No confinement mechanism (bwrap or sandbox-exec). Refusing to start.",
			);
			expect(refused.reason).not.toContain("landlock");
		}
		const ready = startupDecision({
			confineToWorkspace: true,
			detector: { bwrap: true, sandboxExec: false },
		});
		expect(ready).toEqual({ start: true, capability: true });
	});

	it("warns only when confinement is off and omits the capability", () => {
		const open = startupDecision({
			confineToWorkspace: false,
			detector: { bwrap: false, sandboxExec: false },
		});
		expect(open).toEqual({
			start: true,
			capability: false,
			warning: TRUST_WARNING,
		});
		const confined = startupDecision({
			confineToWorkspace: true,
			detector: { bwrap: false, sandboxExec: true },
		});
		expect(confined.start).toBe(true);
		if (confined.start) expect(confined.warning).toBeUndefined();
	});
});
