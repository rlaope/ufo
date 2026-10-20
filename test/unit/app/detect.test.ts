import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DetectedStack, detectStacks } from "../../../src/app/detect.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ufo-detect-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
}

const ids = (stacks: readonly DetectedStack[]) => stacks.map((stack) => stack.id);
const stackOf = (stacks: readonly DetectedStack[], id: string) =>
  stacks.find((stack) => stack.id === id);

describe("detectStacks", () => {
  it("finds nothing in an empty repository", async () => {
    expect(await detectStacks(root)).toEqual([]);
  });

  it("detects a Spring Boot Gradle project with its wrapper and test command", async () => {
    await put({
      "build.gradle.kts": `plugins {\n  id("org.springframework.boot") version "3.4.0"\n}\ndependencies {\n  implementation("org.springframework.boot:spring-boot-starter-data-jpa")\n  runtimeOnly("org.postgresql:postgresql")\n}\n`,
      "settings.gradle.kts": 'rootProject.name = "demo"\n',
      gradlew: "#!/bin/sh\n",
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["jvm", "spring-boot", "gradle", "postgres", "hibernate"]);
    expect(stackOf(stacks, "gradle")?.suggestions.testCommand).toBe("./gradlew test");
    expect(stackOf(stacks, "gradle")?.evidence).toEqual(["build.gradle.kts"]);
    expect(stackOf(stacks, "spring-boot")?.suggestions.workloadHint).toMatch(/startup/);
  });

  it("uses gradle test without a wrapper, and Maven's wrapper when there is one", async () => {
    await put({ "build.gradle": "apply plugin: 'java'\n" });
    expect(stackOf(await detectStacks(root), "gradle")?.suggestions.testCommand).toBe(
      "gradle test",
    );
    await put({
      "pom.xml":
        "<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>",
      mvnw: "#!/bin/sh\n",
    });
    const stacks = await detectStacks(root);
    expect(stackOf(stacks, "maven")?.suggestions.testCommand).toBe("./mvnw -q test");
    expect(ids(stacks)).toContain("spring-boot");
  });

  it("detects a Next.js app with TypeScript, pnpm, and a test script", async () => {
    await put({
      "package.json": JSON.stringify({
        packageManager: "pnpm@9.1.0",
        scripts: { test: "vitest run", build: "next build" },
        dependencies: { next: "15.0.0", react: "19.0.0", openai: "5.0.0" },
        devDependencies: { typescript: "5.6.0" },
      }),
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["node", "pnpm", "typescript", "nextjs", "openai-client"]);
    expect(stackOf(stacks, "node")?.suggestions.testCommand).toBe("pnpm test");
    expect(stackOf(stacks, "nextjs")?.evidence).toEqual(["package.json: dependency next"]);
    expect(stackOf(stacks, "nextjs")?.suggestions.workloadHint).toMatch(/JavaScript bytes/);
  });

  it("reads the package manager from a lockfile, and ignores npm init's placeholder test", async () => {
    await put({
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
        devDependencies: { vite: "6.0.0", webpack: "5.0.0" },
      }),
      "yarn.lock": "",
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["node", "yarn", "vite", "webpack"]);
    expect(stackOf(stacks, "node")?.suggestions.testCommand).toBeUndefined();
  });

  it("treats express and fastify as plain Node, and a broken package.json as Node", async () => {
    await put({
      "package.json": JSON.stringify({
        scripts: { test: "node --test" },
        dependencies: { express: "5.0.0", fastify: "5.0.0" },
      }),
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["node"]);
    expect(stacks[0]?.suggestions.testCommand).toBe("npm test");
    await put({ "package.json": "{ not json" });
    expect(ids(await detectStacks(root))).toEqual(["node"]);
  });

  it("detects a FastAPI and SQLAlchemy project with pytest configured", async () => {
    await put({
      "pyproject.toml": `[project]\nname = "api"\ndependencies = ["fastapi>=0.115", "sqlalchemy[asyncio]>=2", "asyncpg", "torchvision"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["python", "fastapi", "sqlalchemy", "postgres"]);
    expect(stackOf(stacks, "python")?.suggestions.testCommand).toBe("pytest");
  });

  it("detects Django, Flask, torch, and openai from requirements files only as whole names", async () => {
    await put({
      "requirements.txt": "Django==5.1\ntorch==2.5\nopenai>=1\nopenai-whisper\nflaskr\n",
      "requirements-dev.txt": "flask\npytest\npymysql\n",
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["python", "django", "flask", "mysql", "pytorch", "openai-client"]);
    expect(stackOf(stacks, "python")?.suggestions.testCommand).toBe("pytest");
    expect(stackOf(stacks, "flask")?.evidence).toEqual(["requirements-dev.txt: flask"]);
  });

  it("suggests no test command for a Python project without pytest", async () => {
    await put({ "requirements.txt": "flask\n" });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["python", "flask"]);
    expect(stackOf(stacks, "python")?.suggestions.testCommand).toBeUndefined();
  });

  it("detects a Cargo project", async () => {
    await put({ "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n' });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["rust", "cargo"]);
    expect(stackOf(stacks, "cargo")?.suggestions.testCommand).toBe("cargo test");
  });

  it("detects a Go module and its Postgres driver", async () => {
    await put({
      "go.mod": "module example.com/x\n\ngo 1.23\n\nrequire github.com/jackc/pgx/v5 v5.7.0\n",
    });
    const stacks = await detectStacks(root);
    expect(ids(stacks)).toEqual(["go", "postgres"]);
    expect(stackOf(stacks, "go")?.suggestions.testCommand).toBe("go test ./...");
  });

  it("detects Docker, database images in a compose file, and llama.cpp in a script", async () => {
    await put({
      Dockerfile: "FROM debian\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  my:\n    image: mariadb\n",
      "scripts/serve.sh": "#!/bin/sh\nexec llama-server -m model.gguf\n",
    });
    expect(ids(await detectStacks(root))).toEqual(["docker", "postgres", "mysql", "llama-cpp"]);
  });

  it("does not follow a symbolic link or read an oversized file", async () => {
    await put({ "outside/go.mod": "module x\n" });
    await symlink(path.join(root, "outside/go.mod"), path.join(root, "Cargo.toml"));
    await put({ "pom.xml": `${"x".repeat(300 * 1024)}spring-boot-starter` });
    const stacks = await detectStacks(root);
    // go.mod is outside the root's own files; Cargo.toml is a link; pom.xml is too large to read.
    expect(ids(stacks)).toEqual([]);
  });

  it("never reads outside the repository root", async () => {
    const nested = path.join(root, "repo");
    await mkdir(nested);
    await writeFile(path.join(root, "go.mod"), "module x\n");
    expect(await detectStacks(nested)).toEqual([]);
  });
});
