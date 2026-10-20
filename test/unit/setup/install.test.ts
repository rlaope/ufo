import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupError, type SetupOptions, setup, uninstall } from "../../../src/setup/index.js";
import { fakePackage, put, type Sandbox, SKILL_TEXT, sandbox, VERSION } from "./sandbox.js";

// The installed copy hosts start (step D re-review: DC-N3 to DC-N6, DC-N8, DS-N1 to DS-N3, DS-L).

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
  await mkdir(path.join(box.home, ".codex"));
});
afterEach(async () => {
  await box.cleanup();
});

const options = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
  ...box.environment,
  hosts: ["codex"],
  print: () => {},
  yes: true,
  ...extra,
});

const codexFile = () => path.join(box.home, ".codex", "config.toml");
const pkgRoot = () => path.join(box.ufoHome, "pkg");
const setupDir = () => path.join(box.ufoHome, "private", "setup");
const npmCalls = () => box.fakes.calls.filter((call) => call.program === "npm");

async function refusal(promise: Promise<unknown>): Promise<SetupError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error("expected a SetupError");
}

/** A machine lock a run holds: its run state cannot show that the run ended. */
async function holdMachineLock(): Promise<void> {
  const runId = "20261020-120000-a1b2c3";
  const repoId = "0123456789abcdef";
  const lock = { runId, repoId, acquiredAt: "2026-10-20T12:00:00.000Z" };
  await put(path.join(box.ufoHome, "private", "lock"), JSON.stringify(lock));
  await put(path.join(box.ufoHome, "private", "runs", repoId, runId, "run.json"), "{}");
}

describe("installing the copy hosts start", () => {
  it("DC-N3: says so plainly when npm writes no lockfile (an .npmrc's package-lock=false)", async () => {
    box.fakes.npmNoLockfile = true;
    const error = await refusal(setup(options()));
    expect(error.code).toBe("install_failed");
    expect(error.message).toBe(
      "npm wrote no package-lock.json, so UFO cannot check what it installed; nothing was set up",
    );
    expect(await readdir(pkgRoot())).toEqual([]);
    expect(existsSync(codexFile())).toBe(false);
  });

  it("DS-N2: refuses a dependency npm took from another registry", async () => {
    box.fakes.npmResolvesZodFrom = "https://registry.example.com/zod/-/zod-4.6.7.tgz";
    const error = await refusal(setup(options()));
    expect(error.code).toBe("integrity_mismatch");
    expect(error.message).toContain(
      "npm resolved zod from https://registry.example.com/zod/-/zod-4.6.7.tgz, not https://registry.npmjs.org/",
    );
    expect(await readdir(pkgRoot())).toEqual([]);
  });

  it("DC-N8: reports an npm stopped at its time limit by the signal", async () => {
    box.fakes.npmResult = { code: -1, signal: "SIGTERM", stdout: "", stderr: "" };
    const error = await refusal(setup(options()));
    expect(error.message).toBe(`npm install ufo-agents@${VERSION} was killed by SIGTERM`);
  });

  it("DC-N4: a second setup does not ask the registry when the copy is in place", async () => {
    await setup(options());
    const offline = { ...options() };
    const report = await setup({
      ...offline,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(report.changed).toBe(false);
    // With the copy gone, the registry is needed again.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(pkgRoot(), VERSION), { recursive: true });
    const error = await refusal(
      setup({
        ...offline,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect(error.message).toBe("could not reach https://registry.npmjs.org/: offline");
  });

  it("DC-N5: sweeps what an interrupted install left in pkg/", async () => {
    await mkdir(path.join(pkgRoot(), ".install-AbCdEf"), { recursive: true });
    await mkdir(path.join(pkgRoot(), `${VERSION}.old-0a1b2c3d`), { recursive: true });
    await setup(options());
    expect(await readdir(pkgRoot())).toEqual([VERSION]);
  });

  it("DC-N6: refuses to replace or remove a copy while a run holds the machine lock", async () => {
    const file = path.join(box.root, "ufo.tgz");
    await writeFile(file, fakePackage("0.0.0").tarball);
    await setup(options({ package: file }));
    await holdMachineLock();
    await writeFile(file, fakePackage("0.0.0", `${SKILL_TEXT}Rebuilt.\n`).tarball);
    const replace = await refusal(setup(options({ package: file })));
    expect(replace.failure).toMatchObject({ code: "run_in_progress", exitCode: 1 });
    expect(replace.message).toBe(
      "UFO run 20261020-120000-a1b2c3 holds the machine lock, and its worker may be running from ~/.ufo/pkg/0.0.0; finish or cancel the run first (ufo status, ufo cancel), then run this again",
    );
    expect((await refusal(uninstall(options()))).code).toBe("run_in_progress");
    // A new version installs beside it.
    await setup(options());
    expect((await readdir(pkgRoot())).sort()).toEqual(["0.0.0", VERSION]);
  });

  it("DS-N1: refuses to register a node from the project or from node_modules", async () => {
    const work = box.environment.cwd ?? "";
    for (const execPath of [
      path.join(work, "bin", "node"),
      path.join(box.root, "x", "node_modules", ".bin", "node"),
    ]) {
      const error = await refusal(setup(options({ execPath })));
      expect(error.failure).toMatchObject({ code: "node_untrusted", exitCode: 1 });
      expect(error.message).toContain("run ufo setup with a node outside the project");
    }
    expect(npmCalls()).toEqual([]);
    expect(existsSync(codexFile())).toBe(false);
  });

  it("DS-N3: refuses a UFO home inside the working directory's project", async () => {
    const ufoHome = path.join(box.environment.cwd ?? "", ".ufo");
    await expect(setup(options({ ufoHome }))).rejects.toMatchObject({ code: "unsafe_home" });
    expect(existsSync(ufoHome)).toBe(false);
  });

  it("DS-L: a record naming a copy by something other than a version is unsafe_state", async () => {
    await setup(options());
    const file = path.join(setupDir(), "setup.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.packages["../elsewhere"] = record.packages[VERSION];
    await writeFile(file, JSON.stringify(record));
    expect((await refusal(uninstall(options()))).code).toBe("unsafe_state");
  });
});
