import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Target } from "../../domain/index.js";
import { PolicyError, violation } from "./rules.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injected so tests never touch DNS. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * A target resolved once, at run start; `address` is the first address it resolved to. In M1 it
 * reaches the workload as `UFO_TARGET_ADDR`; packs that own the load tool (M4) connect to it.
 */
export interface PinnedTarget {
  readonly host: string;
  readonly address: string;
  readonly family: 4 | 6;
}

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

// Loopback and the default Docker bridge are allowed without approval. `BlockList` matches
// IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) against the IPv4 rules.
const DEFAULT_ALLOWED = new BlockList();
DEFAULT_ALLOWED.addSubnet("127.0.0.0", 8, "ipv4");
DEFAULT_ALLOWED.addAddress("::1", "ipv6");
DEFAULT_ALLOWED.addSubnet("172.17.0.0", 16, "ipv4");

// The only ranges an approved target can open up: RFC 1918 and IPv6 unique local addresses.
// Everything else (public, link-local, CGNAT) is an external target, which v1 does not support.
const PRIVATE_RANGES = new BlockList();
PRIVATE_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6");

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function approvedSets(targets: readonly Target[]): {
  addresses: BlockList;
  hostnames: Set<string>;
} {
  const addresses = new BlockList();
  const hostnames = new Set<string>();
  for (const target of targets) {
    const slash = target.indexOf("/");
    const network = slash === -1 ? target : target.slice(0, slash);
    const family = isIP(network);
    if (family === 0) {
      hostnames.add(normalizeHostname(target));
    } else if (slash === -1) {
      addresses.addAddress(network, family === 6 ? "ipv6" : "ipv4");
    } else {
      addresses.addSubnet(network, Number(target.slice(slash + 1)), family === 6 ? "ipv6" : "ipv4");
    }
  }
  return { addresses, hostnames };
}

/**
 * Resolves `host` once and checks every address it resolves to. Loopback (127.0.0.0/8, ::1) and
 * the default Docker bridge (172.17.0.0/16) are allowed. A private address (RFC 1918, ULA) is
 * allowed only when an approved target lists it, a range containing it, or the hostname itself.
 * Any other address is refused even when listed: external targets are deferred past v1. Throws
 * `PolicyError` (`target_not_allowed`).
 */
export async function resolveAndCheckTarget(
  host: string,
  approvedTargets: readonly Target[],
  resolver: Resolver = systemResolver,
): Promise<PinnedTarget> {
  const name = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const literal = isIP(name);
  const resolved: readonly ResolvedAddress[] =
    literal === 0 ? await resolver(name) : [{ address: name, family: literal === 6 ? 6 : 4 }];
  const [first] = resolved;
  if (first === undefined) {
    throw new PolicyError(violation("target_not_allowed", `${host} did not resolve`, [host]));
  }
  const approved = approvedSets(approvedTargets);
  const hostApproved = literal === 0 && approved.hostnames.has(normalizeHostname(name));
  for (const { address, family } of resolved) {
    const type = family === 6 ? "ipv6" : "ipv4";
    if (DEFAULT_ALLOWED.check(address, type)) continue;
    if (!PRIVATE_RANGES.check(address, type)) {
      throw new PolicyError(
        violation(
          "target_not_allowed",
          `${host} resolves to ${address}, which is not loopback, the Docker bridge, or a private (RFC 1918 / ULA) address; external targets are deferred past v1`,
          [address],
        ),
      );
    }
    if (hostApproved || approved.addresses.check(address, type)) continue;
    throw new PolicyError(
      violation(
        "target_not_allowed",
        `${host} resolves to the private address ${address}, which no approved target lists`,
        [address],
      ),
    );
  }
  return { host, address: first.address, family: first.family };
}

/**
 * True when following a redirect from `from` to `to` would leave the pinned target: a different
 * scheme, host, or port. A location that does not parse counts as cross-host.
 */
export function isCrossHostRedirect(from: string | URL, to: string): boolean {
  try {
    const source = new URL(from);
    const target = new URL(to, source);
    return source.protocol !== target.protocol || source.host !== target.host;
  } catch {
    return true;
  }
}
