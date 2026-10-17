import { describe, expect, it } from "vitest";
import {
  isCrossHostRedirect,
  PolicyError,
  type ResolvedAddress,
  type Resolver,
  resolveAndCheckTarget,
} from "../../../src/core/policy/index.js";

/** A resolver backed by a fixed table that counts its lookups. */
function fakeResolver(table: Record<string, ResolvedAddress[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = async (hostname: string) => {
    calls.push(hostname);
    return table[hostname] ?? [];
  };
  return Object.assign(resolver, { calls });
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

const DNS = fakeResolver({
  localhost: [v6("::1"), v4("127.0.0.1")],
  "api.example.com": [v4("93.184.215.14")],
  "v6.example.com": [v6("2606:4700::6810:84e5")],
  "db.internal": [v4("10.1.2.3")],
  "app.docker": [v4("172.17.0.2")],
  "compose.docker": [v4("172.18.0.2")],
  "rebind.example.com": [v4("127.0.0.1"), v4("93.184.215.14")],
  "ula.internal": [v6("fd12:3456::1")],
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolicyError) return error.violation.rule;
    throw error;
  }
  return "allowed";
}

describe("resolveAndCheckTarget (AC 9)", () => {
  it("refuses a hostname that resolves to a public IP", async () => {
    expect(await refusal(resolveAndCheckTarget("api.example.com", [], DNS))).toBe(
      "target_not_allowed",
    );
    expect(await refusal(resolveAndCheckTarget("v6.example.com", [], DNS))).toBe(
      "target_not_allowed",
    );
    expect(await refusal(resolveAndCheckTarget("8.8.8.8", [], DNS))).toBe("target_not_allowed");
  });

  it("allows loopback and pins the first address", async () => {
    expect(await resolveAndCheckTarget("localhost", [], DNS)).toEqual({
      host: "localhost",
      address: "::1",
      family: 6,
    });
    expect((await resolveAndCheckTarget("127.9.9.9", [], DNS)).address).toBe("127.9.9.9");
    expect((await resolveAndCheckTarget("[::1]", [], DNS)).address).toBe("::1");
    expect((await resolveAndCheckTarget("::ffff:127.0.0.1", [], DNS)).family).toBe(6);
  });

  it("resolves a hostname exactly once", async () => {
    const dns = fakeResolver({ localhost: [v4("127.0.0.1")] });
    await resolveAndCheckTarget("localhost", [], dns);
    expect(dns.calls).toEqual(["localhost"]);
    await resolveAndCheckTarget("127.0.0.1", [], dns);
    expect(dns.calls).toEqual(["localhost"]);
  });

  it("allows the default Docker bridge but not other Docker networks", async () => {
    expect((await resolveAndCheckTarget("app.docker", [], DNS)).address).toBe("172.17.0.2");
    expect(await refusal(resolveAndCheckTarget("compose.docker", [], DNS))).toBe(
      "target_not_allowed",
    );
    expect(await refusal(resolveAndCheckTarget("compose.docker", ["172.18.0.0/16"], DNS))).toBe(
      "allowed",
    );
  });

  it("allows RFC 1918 and ULA addresses only when approved", async () => {
    expect(await refusal(resolveAndCheckTarget("db.internal", [], DNS))).toBe("target_not_allowed");
    expect(await refusal(resolveAndCheckTarget("db.internal", ["10.1.2.3"], DNS))).toBe("allowed");
    expect(await refusal(resolveAndCheckTarget("db.internal", ["10.0.0.0/8"], DNS))).toBe(
      "allowed",
    );
    expect(await refusal(resolveAndCheckTarget("db.internal", ["10.9.0.0/16"], DNS))).toBe(
      "target_not_allowed",
    );
    expect(await refusal(resolveAndCheckTarget("db.internal", ["DB.internal."], DNS))).toBe(
      "allowed",
    );
    expect(await refusal(resolveAndCheckTarget("ula.internal", [], DNS))).toBe(
      "target_not_allowed",
    );
    expect(await refusal(resolveAndCheckTarget("ula.internal", ["fd00::/8"], DNS))).toBe("allowed");
    expect(await refusal(resolveAndCheckTarget("192.168.1.10", [], DNS))).toBe(
      "target_not_allowed",
    );
  });

  it("refuses a public target even when it is listed, naming the deferral", async () => {
    const listed: Array<[string, string[]]> = [
      ["api.example.com", ["api.example.com"]],
      ["93.184.215.14", ["93.184.215.14"]],
      ["93.184.215.14", ["0.0.0.0/0"]],
      ["v6.example.com", ["::/0"]],
      ["::ffff:8.8.8.8", ["8.8.8.8"]],
      ["169.254.169.254", ["169.254.0.0/16"]],
    ];
    for (const [host, targets] of listed) {
      await expect(resolveAndCheckTarget(host, targets, DNS)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof PolicyError &&
          error.violation.rule === "target_not_allowed" &&
          error.violation.detail.includes("external targets are deferred"),
      );
    }
  });

  it("still allows a listed private hostname and pins its address", async () => {
    expect(await resolveAndCheckTarget("db.internal", ["db.internal"], DNS)).toEqual({
      host: "db.internal",
      address: "10.1.2.3",
      family: 4,
    });
  });

  it("refuses a hostname when any of its addresses is not allowed", async () => {
    expect(await refusal(resolveAndCheckTarget("rebind.example.com", [], DNS))).toBe(
      "target_not_allowed",
    );
  });

  it("refuses a hostname that does not resolve", async () => {
    expect(await refusal(resolveAndCheckTarget("missing.example.com", [], DNS))).toBe(
      "target_not_allowed",
    );
  });
});

describe("isCrossHostRedirect", () => {
  it.each([
    ["http://127.0.0.1:8080/a", "/b", false],
    ["http://127.0.0.1:8080/a", "http://127.0.0.1:8080/c?x=1", false],
    ["http://127.0.0.1:8080/a", "http://127.0.0.1:9090/a", true],
    ["http://127.0.0.1:8080/a", "https://127.0.0.1:8080/a", true],
    ["http://localhost:8080/a", "http://example.com/a", true],
    ["http://localhost:8080/a", "//example.com/a", true],
    ["http://localhost:8080/a", "http://[::1", true],
  ])("%s -> %s is cross-host: %s", (from, to, expected) => {
    expect(isCrossHostRedirect(from, to)).toBe(expected);
  });
});
