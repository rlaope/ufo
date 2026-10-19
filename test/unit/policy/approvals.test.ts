import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApprovalSubject,
  approvalDigest,
  canonicalJson,
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
const CARD_A = { id: "toy.a", source: "dir:cards", sha256: hashConfig("card a") };
const CARD_B = { id: "toy.b", source: "ufo-agents@0.0.0", sha256: hashConfig("card b") };

function subject(
  config = CONFIG,
  cards = [CARD_B, CARD_A],
  optIns: ApprovalSubject["optIns"] = [],
  env: string[] = [],
): ApprovalSubject {
  return { configHash: hashConfig(config), cards, optIns, env };
}

let home: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "ufo-approvals-")));
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

describe("approvalDigest", () => {
  it("encodes canonically: key order and card order do not matter, content does", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"e":2,"f":1}]},"b":1}',
    );
    expect(approvalDigest(subject())).toBe(approvalDigest(subject(CONFIG, [CARD_A, CARD_B])));
    expect(approvalDigest(subject(CONFIG, [CARD_A]))).not.toBe(approvalDigest(subject()));
    const edited = { ...CARD_A, sha256: hashConfig("card a, edited") };
    expect(approvalDigest(subject(CONFIG, [edited, CARD_B]))).not.toBe(approvalDigest(subject()));
    const moved = { ...CARD_A, source: "dir:elsewhere" };
    expect(approvalDigest(subject(CONFIG, [moved, CARD_B]))).not.toBe(approvalDigest(subject()));
  });

  it("covers the opt-ins and the environment names (F5, F9)", () => {
    const base = approvalDigest(subject());
    expect(approvalDigest(subject(CONFIG, undefined, ["lossy"]))).not.toBe(base);
    expect(approvalDigest(subject(CONFIG, undefined, [], ["API_TOKEN"]))).not.toBe(base);
    expect(approvalDigest(subject(CONFIG, undefined, ["upgrade", "lossy"], ["B", "A"]))).toBe(
      approvalDigest(subject(CONFIG, undefined, ["lossy", "upgrade"], ["A", "B"])),
    );
  });
});

describe("approval store (AC 18)", () => {
  it("does not approve a repository that was never approved", async () => {
    expect(await isApproved(OTHER_REPO, subject(), { home })).toBe(false);
    expect(await checkApproval(OTHER_REPO, subject(), { home })).toMatchObject({
      rule: "unapproved_config",
    });
  });

  it("approves exactly the recorded config and cards and refuses a modified config", async () => {
    const granted = subject(CONFIG, undefined, ["lossy"], ["API_BASE"]);
    const approval = await recordApproval(REPO, granted, {
      home,
      now: new Date("2026-10-17T12:00:00Z"),
    });
    expect(approval).toEqual({
      version: 3,
      repoId: REPO,
      configHash: hashConfig(CONFIG),
      cards: [CARD_A, CARD_B],
      optIns: ["lossy"],
      env: ["API_BASE"],
      digest: approvalDigest(granted),
      approvedAt: "2026-10-17T12:00:00.000Z",
    });
    expect(await readApproval(REPO, { home })).toEqual(approval);
    expect(await isApproved(REPO, granted, { home })).toBe(true);
    // Fewer or more opt-ins, or other environment names, are not what was approved.
    for (const other of [
      subject(),
      subject(CONFIG, undefined, ["lossy", "upgrade"], ["API_BASE"]),
      subject(CONFIG, undefined, ["lossy"], ["API_BASE", "AWS_SECRET_ACCESS_KEY"]),
    ]) {
      expect(await checkApproval(REPO, other, { home })).toMatchObject({
        rule: "config_changed",
        detail: expect.stringContaining("opt-ins or environment names"),
      });
    }
    await recordApproval(REPO, subject(), { home });
    const modified = subject(`${CONFIG}targets: [10.0.0.5]\n`);
    expect(await isApproved(REPO, modified, { home })).toBe(false);
    expect(await checkApproval(REPO, modified, { home })).toMatchObject({
      rule: "config_changed",
      detail: expect.stringContaining("ufo.yaml changed"),
    });
  });

  it("refuses a changed, moved, or missing card, naming it", async () => {
    await recordApproval(REPO, subject(), { home });
    const edited = { ...CARD_A, sha256: hashConfig("card a, edited") };
    expect(await checkApproval(REPO, subject(CONFIG, [edited, CARD_B]), { home })).toEqual({
      rule: "config_changed",
      detail: "technique card toy.a changed since it was approved; run `ufo approve` in a terminal",
      subjects: ["toy.a"],
    });
    const moved = { ...CARD_B, source: "dir:vendor/cards" };
    expect(await checkApproval(REPO, subject(CONFIG, [CARD_A, moved]), { home })).toMatchObject({
      rule: "config_changed",
      detail: expect.stringContaining(
        "toy.b (now from dir:vendor/cards, approved from ufo-agents@0.0.0)",
      ),
      subjects: ["toy.b"],
    });
    expect(await checkApproval(REPO, subject(CONFIG, [CARD_A]), { home })).toMatchObject({
      detail: expect.stringContaining("toy.b (missing)"),
      subjects: ["toy.b"],
    });
  });

  it("writes the file with mode 0600 under the private root and replaces it without temporary files", async () => {
    await recordApproval(REPO, subject("first"), { home });
    await recordApproval(REPO, subject("second", undefined, ["upgrade"]), { home });
    const dir = path.join(home, "private", "approvals");
    expect(readdirSync(dir).filter((f) => f.startsWith(REPO) || f.startsWith(`.${REPO}`))).toEqual([
      `${REPO}.json`,
    ]);
    expect(statSync(path.join(dir, `${REPO}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(home, "private")).mode & 0o777).toBe(0o700);
    expect((await readApproval(REPO, { home }))?.optIns).toEqual(["upgrade"]);
    expect(await isApproved(REPO, subject("first"), { home })).toBe(false);
  });

  it("treats a corrupt, foreign, or tampered approval file as no approval", async () => {
    const corruptHome = mkdtempSync(path.join(tmpdir(), "ufo-approvals-corrupt-"));
    try {
      mkdirSync(path.join(corruptHome, "private", "approvals"), { recursive: true });
      const file = path.join(corruptHome, "private", "approvals", `${REPO}.json`);
      writeFileSync(file, "{ not json");
      expect(await readApproval(REPO, { home: corruptHome })).toBeUndefined();
      const foreign = await recordApproval(OTHER_REPO, subject(), { home: corruptHome });
      writeFileSync(file, JSON.stringify(foreign));
      expect(await isApproved(REPO, subject(), { home: corruptHome })).toBe(false);
      // A card swapped in by hand without a matching digest approves nothing.
      const own = await recordApproval(REPO, subject(), { home: corruptHome });
      const swapped = { ...CARD_A, sha256: hashConfig("card a, edited") };
      writeFileSync(file, JSON.stringify({ ...own, cards: [swapped, CARD_B] }));
      expect(await readApproval(REPO, { home: corruptHome })).toBeUndefined();
      expect(
        await checkApproval(REPO, subject(CONFIG, [swapped, CARD_B]), { home: corruptHome }),
      ).toMatchObject({ rule: "unapproved_config" });
      // Opt-ins widened by hand without a matching digest approve nothing either.
      writeFileSync(file, JSON.stringify({ ...own, optIns: ["lossy", "upgrade"] }));
      expect(await readApproval(REPO, { home: corruptHome })).toBeUndefined();
    } finally {
      rmSync(corruptHome, { recursive: true, force: true });
    }
  });

  it("does not read or write an approval through a planted symlink", async () => {
    const linkHome = realpathSync(mkdtempSync(path.join(tmpdir(), "ufo-approvals-link-")));
    try {
      mkdirSync(path.join(linkHome, "real"));
      const own = await recordApproval(REPO, subject(), { home: path.join(linkHome, "real") });
      const elsewhere = path.join(linkHome, "elsewhere.json");
      writeFileSync(elsewhere, JSON.stringify(own));
      mkdirSync(path.join(linkHome, "home", "private", "approvals"), { recursive: true });
      symlinkSync(elsewhere, path.join(linkHome, "home", "private", "approvals", `${REPO}.json`));
      await expect(readApproval(REPO, { home: path.join(linkHome, "home") })).rejects.toMatchObject(
        { code: "unsafe_state" },
      );
      mkdirSync(path.join(linkHome, "home3", "private"), { recursive: true });
      symlinkSync(
        path.join(linkHome, "real", "private", "approvals"),
        path.join(linkHome, "home3", "private", "approvals"),
      );
      await expect(
        recordApproval(REPO, subject(), { home: path.join(linkHome, "home3") }),
      ).rejects.toMatchObject({ code: "unsafe_state" });
      // Security N8: every directory on the read path is checked, not only the file's parent:
      // here `private` is the symlink and `approvals` below it is a real directory.
      mkdirSync(path.join(linkHome, "home4"));
      symlinkSync(path.join(linkHome, "real", "private"), path.join(linkHome, "home4", "private"));
      await expect(
        readApproval(REPO, { home: path.join(linkHome, "home4") }),
      ).rejects.toMatchObject({ code: "unsafe_state" });
    } finally {
      rmSync(linkHome, { recursive: true, force: true });
    }
  });

  it("refuses repository ids that could escape the approvals directory", async () => {
    await expect(recordApproval("../evil", subject(), { home })).rejects.toThrow(RangeError);
    await expect(readApproval("../../etc/passwd", { home })).rejects.toThrow(RangeError);
  });

  it("refuses an invalid hash, card, or opt-in", async () => {
    await expect(
      recordApproval(REPO, { ...subject(), configHash: "not-a-hash" }, { home }),
    ).rejects.toThrow();
    await expect(
      recordApproval(REPO, subject(CONFIG, [CARD_A, CARD_A]), { home }),
    ).rejects.toThrow();
    await expect(
      recordApproval(REPO, subject(CONFIG, undefined, ["lossy", "lossy"]), { home }),
    ).rejects.toThrow();
    await expect(
      recordApproval(REPO, subject(CONFIG, undefined, [], ["UFO_HOME"]), { home }),
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
