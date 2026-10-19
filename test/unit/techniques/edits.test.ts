import { describe, expect, it } from "vitest";
import type { RecipeEdit, TechniqueCard } from "../../../src/domain/index.js";
import {
  applyEdit,
  applyRecipeEdits,
  defaultParams,
  RecipeEditError,
  substitute,
} from "../../../src/techniques/index.js";

const params = new Map<string, number | boolean | string>([
  ["threads", 8],
  ["flash", true],
]);

function setProperty(key: string, value: string): RecipeEdit {
  return { op: "set_property", file: "app.properties", key, value };
}

describe("substitute", () => {
  it("fills placeholders and refuses unknown ones", () => {
    expect(substitute("-t {{threads}} --flash={{flash}}", params)).toBe("-t 8 --flash=true");
    expect(() => substitute("{{nope}}", params)).toThrow(RecipeEditError);
  });
});

describe("applyEdit set_property", () => {
  it("rewrites the one line that sets the key, keeping its spacing", () => {
    const content = "# pool\npool.size = 2\npool.sizeMax=9\n";
    expect(applyEdit(content, setProperty("pool.size", "{{threads}}"), params)).toBe(
      "# pool\npool.size = 8\npool.sizeMax=9\n",
    );
  });

  it("appends a missing key, adding the newline the file lacked", () => {
    expect(applyEdit("a=1", setProperty("b", "2"), params)).toBe("a=1\nb=2\n");
    expect(applyEdit("", setProperty("b", "2"), params)).toBe("b=2\n");
  });

  it("treats the key literally and refuses a key that is set twice", () => {
    expect(applyEdit("aXb=1\n", setProperty("a.b", "2"), params)).toBe("aXb=1\na.b=2\n");
    expect(() => applyEdit("k=1\nk=2\n", setProperty("k", "3"), params)).toThrow(/2 times/);
  });
});

describe("applyEdit replace_text", () => {
  const edit = (find: string, replace: string): RecipeEdit => ({
    op: "replace_text",
    file: "server.js",
    find,
    replace,
  });

  it("replaces exactly one occurrence, with $ patterns taken literally", () => {
    expect(applyEdit("a sleep(5); b", edit("sleep(5);", "$& x{{threads}}"), params)).toBe(
      "a $& x8 b",
    );
  });

  it("refuses zero or several occurrences", () => {
    expect(() => applyEdit("abc", edit("x", "y"), params)).toThrow(/found 0/);
    expect(() => applyEdit("xx", edit("x", "y"), params)).toThrow(/found 2/);
  });
});

describe("applyRecipeEdits", () => {
  const card = (edits: RecipeEdit[]): Pick<TechniqueCard, "id" | "params" | "edits"> => ({
    id: "toy.recipe",
    params: [{ name: "threads", type: "integer", min: 1, max: 64, default: 4 }],
    edits,
  });

  it("chains edits on one file with default params and reads each file once", async () => {
    const reads: string[] = [];
    const files = await applyRecipeEdits(
      card([setProperty("a", "{{threads}}"), setProperty("b", "x")]),
      async (file) => {
        reads.push(file);
        return "a=1\n";
      },
    );
    expect(Object.fromEntries(files)).toEqual({ "app.properties": "a=4\nb=x\n" });
    expect(reads).toEqual(["app.properties"]);
    expect(defaultParams(card([]))).toEqual(new Map([["threads", 4]]));
  });

  it("fails for a missing file or a card without edits", async () => {
    await expect(
      applyRecipeEdits(card([setProperty("a", "1")]), async () => undefined),
    ).rejects.toThrow(/not a regular file/);
    await expect(applyRecipeEdits(card([]), async () => "")).rejects.toThrow(/no edits/);
  });
});
