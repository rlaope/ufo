import path from "node:path";
import picomatch from "picomatch";
import type { OptIn, RiskClass } from "../../domain/index.js";
import { parseDiffPaths } from "./diff-paths.js";
import { type PolicyViolation, preview, violation } from "./rules.js";

// Globs are relative to the repository root. A glob protects the paths it matches and everything
// under a directory it matches, so `**/tests` covers `pkg/tests/a/b.py`.

/** What no change may touch: tests, benchmarks, UFO's config, CI, environment and secret files. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  // UFO's own configuration.
  "**/ufo.yaml",
  "**/ufo.yml",
  // Tests, their data, and snapshots.
  "**/test",
  "**/tests",
  "**/__tests__",
  "**/spec",
  "**/specs",
  "**/testdata",
  "**/test-data",
  "**/fixtures",
  "**/__fixtures__",
  "**/__snapshots__",
  "**/e2e",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*_spec.*",
  "**/test_*.py",
  "**/conftest.py",
  // Test runner configuration, which can deselect tests.
  "**/jest.config.*",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/pytest.ini",
  "**/tox.ini",
  "**/phpunit.xml*",
  // Benchmarks and workload drivers.
  "**/bench",
  "**/benches",
  "**/benchmark",
  "**/benchmarks",
  "**/jmh",
  "**/*.bench.*",
  "**/*_bench.*",
  // Git attributes and submodules: they choose filters and what a checkout contains.
  "**/.gitattributes",
  "**/.gitmodules",
  // CI definitions, which hold the test steps.
  ".github/workflows",
  ".github/actions",
  ".gitlab-ci.yml",
  ".circleci",
  ".buildkite",
  ".travis.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
  // Environment and secrets.
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.aws",
  "**/.ssh",
  "**/.docker/config.json",
  "**/*.tfvars",
  "**/credentials",
  "**/credentials.json",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
];

/** Dependency lockfiles. Only an approved `upgrade` card may change them. */
export const LOCKFILE_PATHS: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/uv.lock",
  "**/pdm.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/gradle.lockfile",
  "**/packages.lock.json",
  "**/Package.resolved",
  "**/Podfile.lock",
  "**/pubspec.lock",
  "**/mix.lock",
  "**/flake.lock",
];

/** The protected set for one change: defaults, lockfiles unless the card may upgrade, and `extra`. */
export function protectedPathsFor(
  riskClass: RiskClass,
  approvedOptIns: readonly OptIn[],
  extra: readonly string[] = [],
): string[] {
  const upgrading = riskClass === "upgrade" && approvedOptIns.includes("upgrade");
  return [...DEFAULT_PROTECTED_PATHS, ...(upgrading ? [] : LOCKFILE_PATHS), ...extra];
}

type Matcher = (candidate: string) => boolean;

function matcher(globs: readonly string[], nocase: boolean): Matcher {
  const patterns = globs.map((g) => g.replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true, nocase });
}

/** True when `file` or one of its parent directories matches. */
function matchesSelfOrParent(file: string, isMatch: Matcher): boolean {
  const parts = file.split("/");
  for (let n = 1; n <= parts.length; n++) {
    if (isMatch(parts.slice(0, n).join("/"))) return true;
  }
  return false;
}

/**
 * Checks repository-relative paths against the protected globs and, for a monorepo, the scope.
 * Protected globs ignore case, since macOS file systems do. A path that leaves the repository
 * counts as protected.
 */
export function checkPaths(
  paths: readonly string[],
  protectedGlobs: readonly string[],
  scopeGlobs: readonly string[] = [],
): PolicyViolation | undefined {
  const isProtected = matcher(protectedGlobs, true);
  const normalized = paths.map((p) => path.posix.normalize(p).replace(/^(?:\.\/)+/, ""));
  const touched = normalized.filter(
    (p) =>
      p === ".." || p.startsWith("../") || p.startsWith("/") || matchesSelfOrParent(p, isProtected),
  );
  if (touched.length > 0) {
    return violation(
      "protected_path",
      `the patch touches protected paths: ${preview(touched)}`,
      touched,
    );
  }
  if (scopeGlobs.length === 0) return undefined;
  const inScope = matcher(scopeGlobs, false);
  const outside = normalized.filter((p) => !matchesSelfOrParent(p, inScope));
  return outside.length > 0
    ? violation(
        "out_of_scope",
        `the patch touches paths outside the scope: ${preview(outside)}`,
        outside,
      )
    : undefined;
}

/**
 * Rejects a patch before it is applied when it touches a protected or out-of-scope path. A diff
 * whose file names cannot be read is rejected as well: what it touches is unknown.
 */
export function checkProtectedPaths(
  diff: string,
  protectedGlobs: readonly string[],
  scopeGlobs: readonly string[] = [],
): PolicyViolation | undefined {
  const { paths, problems } = parseDiffPaths(diff);
  if (problems.length > 0) {
    return violation("protected_path", `cannot tell which files the patch touches: ${problems[0]}`);
  }
  return checkPaths(paths, protectedGlobs, scopeGlobs);
}
