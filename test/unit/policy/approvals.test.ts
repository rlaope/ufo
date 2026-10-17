import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkApproval,
  hashConfig,
  isApproved,
  PolicyError,
  readApproval,
  recordApproval,
  requireTty,
} from "../../../src/core/policy/index.js";

const REPO = "0123456789abcdef";
const OTHER_REPO = "fedcba9876543210";
const CONFIG = "version: 1\nobjective:\n  scenario: GET / at 50 rps\n";

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "ufo-approvals-"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("hashConfig", () => {
  it("is the sha256 of the bytes and changes with any edit", () => {
    expect(hashConfig("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashConfig(Buffer.from(CONFIG))).toBe(hashConfig(CONFIG));
    expect(hashConfig(`${CONFIG} `)).not.toBe(hashConfig(CONFIG));
    expect(hashConfig(CONFIG.replace("50", "51"))).not.toBe(hashConfig(CONFIG));
  });
});

describe("approval store (AC 18)", () => {
  it("does not approve a repository that was never approved", async () => {
    expect(await isApproved(OTHER_REPO, hashConfig(CONFIG), { home })).toBe(false);
    expect(await checkApproval(OTHER_REPO, hashConfig(CONFIG), { home })).toMatchObject({
      rule: "unapproved_config",
    });
  });

  it("approves exactly the recorded hash and refuses a modified config", async () => {
    const approval = await recordApproval(REPO, hashConfig(CONFIG), ["lossy"], {
      home,
      now: new Date("2026-10-17T12:00:00Z"),
    });
    expect(approval).toEqual({
      version: 1,
      repoId: REPO,
      configHash: hashConfig(CONFIG),
      optIns: ["lossy"],
      approvedAt: "2026-10-17T12:00:00.000Z",
    });
    expect(await readApproval(REPO, { home })).toEqual(approval);
    expect(await isApproved(REPO, hashConfig(CONFIG), { home })).toBe(true);
    const modified = hashConfig(`${CONFIG}targets: [10.0.0.5]\n`);
    expect(await isApproved(REPO, modified, { home })).toBe(false);
    expect(await checkApproval(REPO, modified, { home })).toMatchObject({ rule: "config_changed" });
  });

  it("writes the file with mode 0600 and replaces it without leaving temporary files", async () => {
    await recordApproval(REPO, hashConfig("first"), [], { home });
    await recordApproval(REPO, hashConfig("second"), ["upgrade"], { home });
    const dir = path.join(home, "approvals");
    expect(readdirSync(dir).filter((f) => f.startsWith(REPO) || f.startsWith(`.${REPO}`))).toEqual([
      `${REPO}.json`,
    ]);
    expect(statSync(path.join(dir, `${REPO}.json`)).mode & 0o777).toBe(0o600);
    expect((await readApproval(REPO, { home }))?.optIns).toEqual(["upgrade"]);
    expect(await isApproved(REPO, hashConfig("first"), { home })).toBe(false);
  });

  it("treats a corrupt or foreign approval file as no approval", async () => {
    const corruptHome = mkdtempSync(path.join(tmpdir(), "ufo-approvals-corrupt-"));
    try {
      mkdirSync(path.join(corruptHome, "approvals"));
      const file = path.join(corruptHome, "approvals", `${REPO}.json`);
      writeFileSync(file, "{ not json");
      expect(await readApproval(REPO, { home: corruptHome })).toBeUndefined();
      const foreign = await recordApproval(OTHER_REPO, hashConfig(CONFIG), [], {
        home: corruptHome,
      });
      writeFileSync(file, JSON.stringify(foreign));
      expect(await isApproved(REPO, hashConfig(CONFIG), { home: corruptHome })).toBe(false);
    } finally {
      rmSync(corruptHome, { recursive: true, force: true });
    }
  });

  it("refuses repository ids that could escape the approvals directory", async () => {
    await expect(recordApproval("../evil", hashConfig(CONFIG), [], { home })).rejects.toThrow(
      RangeError,
    );
    await expect(readApproval("../../etc/passwd", { home })).rejects.toThrow(RangeError);
  });

  it("refuses an invalid hash or opt-in", async () => {
    await expect(recordApproval(REPO, "not-a-hash", [], { home })).rejects.toThrow();
    await expect(
      recordApproval(REPO, hashConfig(CONFIG), ["lossy", "lossy"], { home }),
    ).rejects.toThrow();
  });
});

describe("requireTty (AC 18)", () => {
  it.each([
    ["a pipe", { isTTY: false }],
    ["a stream without isTTY", {}],
    ["an explicit undefined", { isTTY: undefined }],
  ])("refuses %s", (_label, stdin) => {
    try {
      requireTty(stdin);
      expect.unreachable("requireTty accepted a non-TTY stdin");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).violation.rule).toBe("non_tty_approval");
    }
  });

  it("accepts an interactive terminal", () => {
    expect(() => requireTty({ isTTY: true })).not.toThrow();
  });
});
