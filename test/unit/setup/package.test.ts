import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { processRunner } from "../../../src/setup/hosts.js";
import {
  compareVersions,
  installedIntegrity,
  isExactVersion,
  nodeCommand,
  readTarball,
} from "../../../src/setup/package.js";
import { tarball } from "./sandbox.js";

describe("package versions", () => {
  it("accept only an exact semver", () => {
    for (const version of ["1.2.3", "0.0.0", "1.0.0-rc.1", "2.0.0+build.5"]) {
      expect(isExactVersion(version)).toBe(true);
    }
    for (const version of ["^1.2.3", "1.2", "latest", "01.2.3", "1.2.3 ", "../1.2.3"]) {
      expect(isExactVersion(version)).toBe(false);
    }
  });

  it("order by semver precedence", () => {
    const sorted = [
      "1.10.0",
      "1.2.3",
      "1.0.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta",
      "1.0.0-alpha.beta",
      "2.0.0",
    ].sort(compareVersions);
    expect(sorted).toEqual([
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0",
      "1.2.3",
      "1.10.0",
      "2.0.0",
    ]);
    expect(compareVersions("1.2.3", "1.2.3+other")).toBe(0);
  });
});

describe("reading a tarball", () => {
  it("lists its regular files by name", () => {
    const files = readTarball(tarball({ "package.json": "{}", "skills/x/SKILL.md": "s" }));
    expect([...files.keys()]).toEqual(["package/package.json", "package/skills/x/SKILL.md"]);
    expect(files.get("package/skills/x/SKILL.md")?.toString()).toBe("s");
  });
});

describe("an installed copy", () => {
  it("counts only when its package.json names the version and its CLI exists", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "ufo-prefix-"));
    try {
      const pkg = path.join(prefix, "node_modules", "ufo-agents");
      await mkdir(path.join(pkg, "dist", "cli"), { recursive: true });
      await writeFile(path.join(pkg, "dist", "cli", "index.js"), "");
      await writeFile(path.join(pkg, "package.json"), '{"name":"ufo-agents","version":"1.2.3"}');
      const lock = { packages: { "node_modules/ufo-agents": { integrity: "sha512-x" } } };
      await writeFile(path.join(prefix, "package-lock.json"), JSON.stringify(lock));
      expect(await installedIntegrity(prefix, "1.2.3")).toBe("sha512-x");
      expect(await installedIntegrity(prefix, "1.2.4")).toBeUndefined();
      await rm(path.join(pkg, "dist", "cli", "index.js"));
      expect(await installedIntegrity(prefix, "1.2.3")).toBeUndefined();
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
});

describe("the node a host starts", () => {
  it("is the node on PATH when it is this binary, else this binary's own path", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ufo-node-"));
    try {
      await symlink(process.execPath, path.join(bin, "node"));
      const any = () => true;
      expect(await nodeCommand({ PATH: bin }, process.execPath, any)).toBe(path.join(bin, "node"));
      expect(await nodeCommand({ PATH: bin }, "/elsewhere/node", any)).toBe("/elsewhere/node");
      expect(await nodeCommand({ PATH: "" }, process.execPath, any)).toBe(process.execPath);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe("a command that runs past its time", () => {
  it("is reported by the signal that stopped it, not as a missing program", async () => {
    const result = await processRunner("/bin/sleep", ["5"], {
      cwd: os.tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ code: -1, signal: "SIGTERM" });
  });
});
