import { describe, expect, it } from "vitest";
import { SetupError } from "../../../src/setup/errors.js";
import {
  insertJsonEntry,
  locateJsonEntry,
  removeJsonEntry,
  replaceJsonEntry,
} from "../../../src/setup/json-edit.js";
import { undoEdit } from "../../../src/setup/span.js";

const ENTRY = { type: "stdio", command: "npx", args: ["-y", "ufo-agents@1.2.3", "mcp"] };
const LABEL = "mcp.json";

const locate = (text: string) => locateJsonEntry(text, "mcpServers", "ufo", LABEL);
const insert = (text: string | undefined) =>
  insertJsonEntry(text, "mcpServers", "ufo", ENTRY, LABEL);
const remove = (text: string, parentCreated = false) =>
  removeJsonEntry(text, "mcpServers", "ufo", parentCreated, LABEL);

/** The `ufo` member as setup writes it at `indent`, with two-space steps. */
const member = (indent: string, eol = "\n") =>
  `"ufo": ${JSON.stringify(ENTRY, null, 2)}`.split("\n").join(eol + indent);

const CURSOR = `{
  "mcpServers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--port", "9000"]
    }
  },
  "theme":   "dark"
}
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

describe("the Cursor JSON span edit", () => {
  it("appends the member after the last server and keeps every other byte", () => {
    const { text, edit, parentCreated } = insert(CURSOR);
    const expected = CURSOR.replace(
      '"args": ["--port", "9000"]\n    }',
      `"args": ["--port", "9000"]\n    },\n    ${member("    ")}`,
    );
    expect(text).toBe(expected);
    expect(parentCreated).toBe(false);
    expect(locate(text)).toMatchObject({ found: true, value: ENTRY });
    expect(undoEdit(text, edit)).toBe(CURSOR);
    expect(remove(text)).toBe(CURSOR);
  });

  it("creates the file, or mcpServers, when missing", () => {
    const created = insert(undefined);
    expect(JSON.parse(created.text)).toEqual({ mcpServers: { ufo: ENTRY } });
    expect(created.text.endsWith("}\n")).toBe(true);
    expect(created.parentCreated).toBe(true);

    const text = '{\n\t"theme": "dark"\n}\n';
    const added = insert(text);
    expect(added.parentCreated).toBe(true);
    expect(JSON.parse(added.text)).toEqual({ theme: "dark", mcpServers: { ufo: ENTRY } });
    // Tabs, as the file indents.
    expect(added.text).toContain('\n\t"mcpServers": {\n\t\t"ufo": {\n\t\t\t"type": "stdio"');
    expect(remove(added.text, true)).toBe(text);
  });

  it("fills an empty mcpServers and gives it back empty", () => {
    const text = '{"mcpServers": {}, "x": 1}';
    const { text: next, edit } = insert(text);
    expect(JSON.parse(next)).toEqual({ mcpServers: { ufo: ENTRY }, x: 1 });
    expect(remove(next)).toBe(text);
    // Whitespace inside the empty object comes back through the recorded edit.
    const spaced = '{\n  "mcpServers": {\n  }\n}\n';
    const inserted = insert(spaced);
    expect(undoEdit(inserted.text, inserted.edit)).toBe(spaced);
    expect(edit.replaced).toBe("");
  });

  it("writes one line into an object written on one line", () => {
    const text = '{"mcpServers":{"docs":{"command":"d"}}}';
    const next = insert(text).text;
    expect(next).toBe(`{"mcpServers":{"docs":{"command":"d"}, "ufo": ${JSON.stringify(ENTRY)}}}`);
    expect(remove(next)).toBe(text);
  });

  it("writes CRLF into a CRLF file", () => {
    const text = CURSOR.replaceAll("\n", "\r\n");
    const next = insert(text).text;
    expect(next).toContain(`},\r\n    ${member("    ", "\r\n")}`);
    expect(next.replaceAll("\r\n", "")).not.toContain("\n");
    expect(remove(next)).toBe(text);
  });

  it("removes only the ufo member after the host added a server after it and edited others", () => {
    const { text } = insert(CURSOR);
    const edited = text
      .replace('"theme":   "dark"', '"theme": "light"')
      .replace(
        `${member("    ")}\n  }`,
        `${member("    ")},\n    "later": { "command": "l" }\n  }`,
      );
    expect(remove(edited)).toBe(
      CURSOR.replace('"theme":   "dark"', '"theme": "light"').replace(
        '"args": ["--port", "9000"]\n    }\n',
        '"args": ["--port", "9000"]\n    },\n    "later": { "command": "l" }\n',
      ),
    );
  });

  it("removes a created mcpServers left empty, and keeps one the host still uses", () => {
    const text = '{\n  "theme": "dark"\n}\n';
    const { text: next } = insert(text);
    expect(remove(next, true)).toBe(text);
    const shared = next.replace(`${member("    ")}\n`, `${member("    ")},\n    "later": {}\n`);
    expect(JSON.parse(remove(shared, true))).toEqual({ theme: "dark", mcpServers: { later: {} } });
  });

  it("re-pins the member in place", () => {
    const { text } = insert(CURSOR);
    const next = { ...ENTRY, args: ["-y", "ufo-agents@2.0.0", "mcp"] };
    const replaced = replaceJsonEntry(text, "mcpServers", "ufo", next, LABEL);
    expect(replaced.text).toBe(text.replace("ufo-agents@1.2.3", "ufo-agents@2.0.0"));
    expect(replaced.before).toBe(member("    "));
    expect(locate(replaced.text)).toMatchObject({ found: true, value: next });
  });

  it("keeps a byte order mark", () => {
    const text = `﻿${CURSOR}`;
    const next = insert(text).text;
    expect(next.startsWith("﻿{")).toBe(true);
    expect(remove(next)).toBe(text);
  });

  it("refuses a file that is not JSON, or whose shape setup cannot edit", () => {
    for (const [text, message] of [
      ['{ "mcpServers": { } // comment\n}', "not valid JSON"],
      ["[]", "does not hold a JSON object"],
      ['{"mcpServers": []}', "not an object"],
      ['{"mcpServers": {}, "mcpServers": {}}', "more than once"],
      ['{"mcpServers": {"ufo": {}, "ufo": {}}}', "more than once"],
    ] as const) {
      const error = refusal(() => locate(text));
      expect(error.code).toBe("host_config_invalid");
      expect(error.message).toContain(message);
    }
  });
});
