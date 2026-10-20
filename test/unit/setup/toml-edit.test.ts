import { describe, expect, it } from "vitest";
import { SetupError } from "../../../src/setup/errors.js";
import { undoEdit } from "../../../src/setup/span.js";
import {
  insertTomlEntry,
  locateTomlEntry,
  removeTomlEntry,
  replaceTomlEntry,
} from "../../../src/setup/toml-edit.js";

const ENTRY = { command: "npx", args: ["-y", "ufo-agents@1.2.3", "mcp"], startup_timeout_sec: 60 };
const TABLE = `[mcp_servers.ufo]
command = "npx"
args = ["-y", "ufo-agents@1.2.3", "mcp"]
startup_timeout_sec = 60
`;

const locate = (text: string) => locateTomlEntry(text, "mcp_servers", "ufo", "config.toml");
const insert = (text: string | undefined) => insertTomlEntry(text, "mcp_servers", "ufo", ENTRY);
const remove = (text: string) => removeTomlEntry(text, "mcp_servers", "ufo", "config.toml");

/** A config the way people write them: comments, odd spacing, strings that look like TOML. */
const USER_CONFIG = `# Codex settings
model   =   "o3"  # the default
approval_policy = 'on-request'

notes = """
[mcp_servers.ufo]
not a table, just text
"""

[mcp_servers.docs]
command = "docs-mcp"
args = [
  "--port", # inline comment
  "9000",
]
env = { TOKEN_FILE = "~/.docs-token", RETRIES = 3 }

[profiles.fast]
model = "o4-mini"
started = 1979-05-27 07:32:00Z
ratio = 0.5
`;

function refusal(fn: () => unknown): SetupError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error("expected a SetupError");
}

describe("the Codex TOML span edit", () => {
  it("finds no entry in an empty file or in one with other servers and look-alike strings", () => {
    expect(locate("")).toEqual({ found: false });
    expect(locate(USER_CONFIG)).toEqual({ found: false });
  });

  it("appends the table after one blank line and keeps every byte before it", () => {
    const { text, edit } = insert(USER_CONFIG);
    expect(text).toBe(`${USER_CONFIG}\n${TABLE}`);
    expect(edit).toEqual({ replaced: "", inserted: `\n${TABLE}` });
    expect(locate(text)).toMatchObject({ found: true, value: ENTRY });
  });

  it("creates the file content when there is none", () => {
    expect(insert(undefined).text).toBe(TABLE);
    expect(insert("").text).toBe(TABLE);
  });

  it("adds a line ending first when the file has none at its end", () => {
    const text = 'model = "o3"';
    const inserted = insert(text);
    expect(inserted.text).toBe(`model = "o3"\n\n${TABLE}`);
    // The exact edit is recorded, so uninstall can give the file back without the extra newline.
    expect(undoEdit(inserted.text, inserted.edit)).toBe(text);
  });

  it("writes CRLF into a CRLF file", () => {
    const text = 'model = "o3"\r\n';
    const { text: next } = insert(text);
    expect(next).toBe(`model = "o3"\r\n\r\n${TABLE.replaceAll("\n", "\r\n")}`);
    expect(locate(next)).toMatchObject({ found: true, value: ENTRY });
    expect(remove(next)).toBe(text);
  });

  it("removes the table and its blank line after the host edited other parts", () => {
    const { text } = insert(USER_CONFIG);
    // The host changes a setting above the table and appends its own server after it.
    const edited = `${text.replace('model   =   "o3"', 'model = "gpt-5"')}\n[mcp_servers.later]\ncommand = "later"\n`;
    expect(remove(edited)).toBe(
      `${USER_CONFIG.replace('model   =   "o3"', 'model = "gpt-5"')}\n[mcp_servers.later]\ncommand = "later"\n`,
    );
  });

  it("keeps comments and blank lines that follow the table's last key", () => {
    const text = `${TABLE}\n# the next table\n[other]\nx = 1\n`;
    expect(remove(text)).toBe("\n# the next table\n[other]\nx = 1\n");
  });

  it("re-pins the table in place", () => {
    const { text } = insert(USER_CONFIG);
    const next = { ...ENTRY, args: ["-y", "ufo-agents@2.0.0", "mcp"] };
    const replaced = replaceTomlEntry(text, "mcp_servers", "ufo", next, "config.toml");
    expect(replaced.text).toBe(`${USER_CONFIG}\n${TABLE.replace("1.2.3", "2.0.0")}`);
    expect(replaced.before).toBe(TABLE);
    expect(replaced.after).toBe(TABLE.replace("1.2.3", "2.0.0"));
    expect(locate(replaced.text)).toMatchObject({ found: true, value: next });
  });

  it("reads an entry written with other spacing and quoting as the same value", () => {
    const text = `[ mcp_servers . "ufo" ]\ncommand='npx'\nargs = [ "-y" , "ufo-agents@1.2.3",\n  "mcp" ]\nstartup_timeout_sec = 6_0\n`;
    expect(locate(text)).toMatchObject({ found: true, value: ENTRY });
    expect(remove(text)).toBe("");
  });

  it("reports a ufo entry spread over other sub-tables or dotted keys as not editable", () => {
    for (const text of [
      `${TABLE}[mcp_servers.ufo.env]\nPORT = 1\n`,
      `${TABLE}[mcp_servers.ufo.env]\nA.B = "x"\n`,
      `${TABLE}[mcp_servers.ufo.other]\nx = "y"\n`,
      `${TABLE}[mcp_servers.ufo.env.deeper]\nx = "y"\n`,
      '[mcp_servers.ufo.env]\nUFO_HOME = "/u"\n',
      '[mcp_servers]\nufo.command = "npx"\n',
      'mcp_servers.ufo = { command = "npx" }\n',
      `${TABLE}[[mcp_servers.ufo.tools]]\nname = "x"\n`,
    ]) {
      expect(locate(text)).toEqual({
        found: true,
        table: undefined,
        envTable: undefined,
        value: undefined,
      });
    }
    expect(
      refusal(() => locate(`${TABLE}env = { A = "1" }\n[mcp_servers.ufo.env]\nB = "2"\n`)).message,
    ).toContain("sets a key of [mcp_servers.ufo] twice");
    expect(
      refusal(() =>
        locate(`${TABLE}[mcp_servers.ufo.env]\nA = "1"\n[mcp_servers.ufo.env]\nB = "2"\n`),
      ).message,
    ).toContain("[mcp_servers.ufo.env] more than once");
  });

  it("H1: takes the [mcp_servers.ufo.env] table Codex writes an inline env as for UFO's own", () => {
    const inline = `${TABLE}env = { UFO_HOME = "/u" }\n`;
    // What `codex mcp add other ...` makes of it (codex-cli 0.163): its own table, then other.
    const rewritten = `a = 1\n\n${TABLE.replace("= 60\n", "= 60.0\n")}\n[mcp_servers.ufo.env]\nUFO_HOME = "/u"\n\n[mcp_servers.other]\ncommand = "o"\n`;
    const value = { ...ENTRY, env: { UFO_HOME: "/u" } };
    expect(locate(inline)).toMatchObject({ found: true, value });
    expect(locate(rewritten)).toMatchObject({ found: true, value });
    expect(remove(rewritten)).toBe('a = 1\n\n[mcp_servers.other]\ncommand = "o"\n');
    const repinned = replaceTomlEntry(rewritten, "mcp_servers", "ufo", value, "config.toml");
    expect(repinned.text).toBe(`a = 1\n\n${inline}\n[mcp_servers.other]\ncommand = "o"\n`);
    expect(locate(repinned.text)).toMatchObject({ found: true, value });
  });

  it("refuses a file that does not parse, naming the line", () => {
    for (const [text, line] of [
      ['model = "o3\n', 1],
      ["a = 1\n[table\n", 2],
      ["a = 1\nb = 2 3\n", 2],
      ["a = [1 2]\n", 1],
      ["a = nope\n", 1],
      ["= 1\n", 1],
      ['s = """\nnever closed\n', 3],
      ["t = { x = 1, x = 2 }\n", 1],
    ] as const) {
      const error = refusal(() => locate(text));
      expect(error.code).toBe("host_config_invalid");
      expect(error.message).toContain(`line ${line}`);
    }
  });

  it("reads the float Codex writes for UFO's timeout as the same number", () => {
    // codex 0.163 rewrites `startup_timeout_sec = 60` as `60.0` on its own `codex mcp add`.
    const rewritten = TABLE.replace("startup_timeout_sec = 60", "startup_timeout_sec = 60.0");
    expect(locate(rewritten)).toMatchObject({ found: true, value: ENTRY });
    expect(locate(TABLE.replace("= 60\n", "= 6e1\n"))).toMatchObject({ value: ENTRY });
    expect(locate(TABLE.replace("= 60\n", "= 60.5\n"))).not.toMatchObject({ value: ENTRY });
  });

  it("says what mcp_servers is when a table cannot be added to it", () => {
    expect(refusal(() => locate("mcp_servers = 3\n")).message).toBe(
      "config.toml sets mcp_servers to a value that is not a table, so a [mcp_servers.ufo] table cannot be added; add the ufo server by hand",
    );
  });

  it("refuses a table defined twice and a servers table that a new table cannot extend", () => {
    expect(refusal(() => locate(`${TABLE}${TABLE}`)).message).toContain("more than once");
    expect(refusal(() => locate('mcp_servers = { docs = { command = "d" } }\n')).message).toContain(
      "inline table",
    );
    expect(refusal(() => locate('[[mcp_servers]]\ncommand = "d"\n')).message).toContain(
      "array of tables",
    );
  });

  it("accepts the TOML forms Codex's parser reads", () => {
    const text = [
      "int = +1_000",
      "hex = 0xDEAD_beef",
      "flt = -3.14e+2",
      "inf = -inf",
      "date = 2026-10-20",
      "time = 07:32",
      "dt = 2026-10-20T07:32:00.5+09:00",
      'esc = "tab\\t \\u00e9 \\U0001F600 \\e \\x41"',
      "lit = '''",
      "C:\\path''''",
      'ml = """\\',
      '   joined"""',
      "inline = {\n  a = 1,\n  b.c = [true, false],\n}",
      "",
    ].join("\n");
    expect(locate(text)).toEqual({ found: false });
  });
});
