import { describe, expect, it } from "vitest";
import { isSensitiveKey, type RedactOptions, redact } from "../../../src/core/evidence/index.js";

// Planted secrets are assembled at runtime so no secret-shaped literal sits in the repository.
const fake = (prefix: string, body: string, times: number) => prefix + body.repeat(times);
const ENV_TOKEN = fake("envtoken-", "Q7", 8);

const options: RedactOptions = {
  homeDir: "/home/alice",
  username: "alice",
  hostname: "alices-laptop.local",
  env: { GITHUB_TOKEN: ENV_TOKEN, PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc" },
};
const r = (text: string) => redact(text, options);

describe("redact", () => {
  it.each([
    ["DB_PASSWORD=hunter2hunter2 npm start", "DB_PASSWORD=<redacted:secret> npm start"],
    ['export OPENAI_API_KEY="abc def"', 'export OPENAI_API_KEY="<redacted:secret>"'],
    ["psql --password=abc123 -h db", "psql --password=<redacted:secret> -h db"],
    ['{"apiKey": "abc123", "port": 8080}', '{"apiKey": "<redacted:secret>", "port": 8080}'],
    ["client_secret: abc123", "client_secret: <redacted:secret>"],
    ["PGPASSWORD='x y' psql", "PGPASSWORD='<redacted:secret>' psql"],
    ["env: DB_PASSWORD=x1", "env: DB_PASSWORD=<redacted:secret>"],
    [
      "max_tokens=256 PWD=/tmp TOKENS=5 KEY_COUNT=2",
      "max_tokens=256 PWD=/tmp TOKENS=5 KEY_COUNT=2",
    ],
  ])("redacts sensitive assignments: %s", (input, expected) => {
    expect(r(input)).toBe(expected);
  });

  it.each([
    ["postgres://app:s3cr3t@db:5432/app", "postgres://<redacted:credentials>@db:5432/app"],
    ["mysql://root:p@ss@word@127.0.0.1/db", "mysql://<redacted:credentials>@127.0.0.1/db"],
    [
      "mongodb+srv://user:p%40ss@cluster0.example.net/db",
      "mongodb+srv://<redacted:credentials>@cluster0.example.net/db",
    ],
    ["redis://:hunter2@cache:6379/0", "redis://<redacted:credentials>@cache:6379/0"],
    ["DATABASE_URL=postgres://db:5432/app", "DATABASE_URL=postgres://db:5432/app"],
  ])("redacts connection string credentials: %s", (input, expected) => {
    expect(r(input)).toBe(expected);
  });

  it.each([
    ["Authorization: Bearer abc.def.ghi", "Authorization: <redacted:authorization>"],
    [
      "curl -H 'Proxy-Authorization: Basic Zm9vOmJhcg==' http://127.0.0.1",
      "curl -H 'Proxy-Authorization: <redacted:authorization>' http://127.0.0.1",
    ],
    ['{"authorization": "token xyz"}', '{"authorization": "<redacted:authorization>"}'],
    ["sent Bearer abcdefgh12345678 upstream", "sent Bearer <redacted:token> upstream"],
    ["the Authorization header is missing", "the Authorization header is missing"],
  ])("redacts auth headers and bearer tokens: %s", (input, expected) => {
    expect(r(input)).toBe(expected);
  });

  it.each([
    fake("sk-", "a1B2", 8),
    fake("sk-ant-api03-", "Zz9_", 8),
    fake("ghp_", "A1b2", 9),
    fake("gho_", "A1b2", 9),
    fake("github_pat_", "11AB_cd", 6),
    fake("xoxb-", "123-abc", 4),
    fake("AKIA", "FAKE", 4),
    fake("AIza", "Sy-_x", 7),
    `${fake("eyJ", "hbGciOi", 2)}.${fake("eyJ", "zdWIiOi", 2)}.${fake("", "sig_", 4)}`,
  ])("redacts API key %#", (key) => {
    expect(r(`key=${key} and "${key}"`)).toBe('key=<redacted:api_key> and "<redacted:api_key>"');
  });

  it("leaves identifiers that only contain a key prefix", () => {
    expect(r("task-abcdefghijklmnopqrstuv")).toBe("task-abcdefghijklmnopqrstuv");
  });

  it("redacts private key blocks", () => {
    const block = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      fake("", "b3BlbnNzaC1rZXk", 4),
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(r(`key:\n${block}\ndone`)).toBe("key:\n<redacted:private_key>\ndone");
  });

  it("replaces the home directory with ~ only at a path boundary", () => {
    expect(r("cd /home/alice/projects/x && make")).toBe("cd ~/projects/x && make");
    expect(r("HOME=/home/alice")).toBe("HOME=~");
    expect(r("stored in /home/alice.")).toBe("stored in ~.");
    expect(r("/home/alicex/y /home/alice.bak")).toBe("/home/alicex/y /home/alice.bak");
  });

  it("redacts the username and hostname as whole names", () => {
    expect(r("run by alice. Alice approved")).toBe(
      "run by <redacted:username>. <redacted:username> approved",
    );
    expect(r("malice alice_bot")).toBe("malice alice_bot");
    expect(r("http://alices-laptop.local:8080 on alices-laptop")).toBe(
      "http://<redacted:hostname>:8080 on <redacted:hostname>",
    );
  });

  it("skips usernames too short to be distinctive", () => {
    expect(redact("a b al", { ...options, username: "al" })).toBe("a b al");
  });

  it("redacts values of sensitive environment variables wherever they appear", () => {
    expect(r(`echo ${ENV_TOKEN} | login`)).toBe("echo <redacted:secret> | login");
    expect(r("abc /usr/bin:/bin")).toBe("abc /usr/bin:/bin");
  });

  // Verifier V1: a host puts its session id (a UUID in CLAUDE_CODE_SESSION_ID) in directory
  // names; a path with a placeholder in it no longer names anything.
  it("keeps a UUID value of a sensitive variable where it is a whole path segment", () => {
    const session = "d9a950be-08f9-4dbc-a589-13aba8e8bbbc";
    const env = { CLAUDE_CODE_SESSION_ID: session, GITHUB_TOKEN: ENV_TOKEN };
    const withSession = (text: string) => redact(text, { ...options, env });
    expect(withSession(`/tmp/claude-501/${session}/scratchpad/toy`)).toBe(
      `/tmp/claude-501/${session}/scratchpad/toy`,
    );
    expect(withSession(`/tmp/${session}`)).toBe(`/tmp/${session}`);
    expect(withSession(`session ${session} resumed`)).toBe("session <redacted:secret> resumed");
    expect(withSession(`/tmp/x${session}/y`)).toBe("/tmp/x<redacted:secret>/y");
    // Any other value stays redacted inside a path too.
    expect(withSession(`/tmp/${ENV_TOKEN}/y`)).toBe("/tmp/<redacted:secret>/y");
  });

  // Security S2-5: only a host's session id, only in a local path, never in a URL.
  it("redacts a UUID value in a URL, or in any other sensitive variable", () => {
    const uuid = "0b9e2f4c-6a1d-4e8b-9c3f-7d5a2e1b4c6f";
    const withEnv = (env: NodeJS.ProcessEnv, text: string) => redact(text, { ...options, env });
    const session = { CODEX_SESSION_ID: uuid };
    expect(withEnv(session, `/tmp/${uuid}/x`)).toBe(`/tmp/${uuid}/x`);
    expect(withEnv(session, `rmdir '/tmp/${uuid}'`)).toBe(`rmdir '/tmp/${uuid}'`);
    for (const url of [
      `https://example.com/${uuid}/x`,
      `file:///tmp/${uuid}/x`,
      `/go?to=https://example.com/${uuid}`,
      `/proxy/https://example.com/${uuid}`,
    ]) {
      expect(withEnv(session, url)).toBe(url.replace(uuid, "<redacted:secret>"));
    }
    // Not a local absolute path.
    expect(withEnv(session, `example.com/${uuid}`)).toBe("example.com/<redacted:secret>");
    expect(withEnv({ API_TOKEN: uuid }, `/tmp/${uuid}/x`)).toBe("/tmp/<redacted:secret>/x");
    expect(withEnv({ ...session, API_TOKEN: uuid }, `/tmp/${uuid}/x`)).toBe(
      "/tmp/<redacted:secret>/x",
    );
  });

  it("is deterministic and idempotent", () => {
    const input = `postgres://u:p@h/db Authorization: x ${fake("ghp_", "A1b2", 9)} /home/alice/x`;
    expect(r(input)).toBe(r(input));
    expect(r(r(input))).toBe(r(input));
  });

  it("redacts keys and string leaves of nested values and keeps other leaves", () => {
    const value = {
      env: { GITHUB_TOKEN: "anything", NODE_ENV: "production" },
      paths: ["/home/alice/a", { "/home/alice/b": 1 }],
      count: 3,
      ok: true,
      none: null,
    };
    expect(redact(value, options)).toEqual({
      env: { GITHUB_TOKEN: "<redacted:secret>", NODE_ENV: "production" },
      paths: ["~/a", { "~/b": 1 }],
      count: 3,
      ok: true,
      none: null,
    });
    expect(value.env.GITHUB_TOKEN).toBe("anything");
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "apiKey",
    "x-api-key",
    "AWS_SECRET_ACCESS_KEY",
    "PGPASSWORD",
    "DB_PASS",
    "client_secret",
    "accessToken",
    "SESSION",
  ])("flags %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["PWD", "OLDPWD", "max_tokens", "PATH", "HOME", "GIT_AUTHOR_NAME", "port"])(
    "allows %s",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});
