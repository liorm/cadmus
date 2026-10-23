import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import { JustBashNamespace } from "../src/tools-env/namespace.js";

describe("just-bash in workerd", () => {
	it("runs echo and creates a symlink", async () => {
		const bash = new Bash({ cwd: "/workspace" });
		const echoed = await bash.exec("echo hi");
		expect(echoed.exitCode).toBe(0);
		expect(echoed.stdout.trim()).toBe("hi");
		const linked = await bash.exec("ln -s ../workspace /workspace/linkdir");
		expect(linked.exitCode).toBe(0);
		expect(linked.stderr).toBe("");
	});

	it("runs gzip and gunzip in JustBashNamespace under hardened profile", async () => {
		const ns = await JustBashNamespace.create({ persist: false });
		const result = await ns.exec({
			callId: "test-gzip",
			command: "echo 'testing gzip compression' | gzip -c | gunzip",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.exitCode).toBe(0);
			expect(result.value.stdout.trim()).toBe("testing gzip compression");
			expect(result.value.stderr).toBe("");
		}
	});
});
