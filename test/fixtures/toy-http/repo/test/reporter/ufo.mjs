// node:test reporter that prints the one JSON line UFO's test_pass_set oracle reads:
// {"ufoTestResults":1,"tests":[{"id":"<file> > <name>","outcome":"pass"|"fail"|"skip"}]}
import path from "node:path";

export default async function* ufoReporter(source) {
  const tests = [];
  const seen = new Map();
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { data } = event;
    if (data.details?.type === "suite") continue;
    const file = data.file ? path.relative(process.cwd(), data.file) : "";
    const base = `${file} > ${data.name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const skipped = data.skip !== undefined || data.todo !== undefined;
    tests.push({
      id: count === 1 ? base : `${base} #${count}`,
      outcome: skipped ? "skip" : event.type === "test:pass" ? "pass" : "fail",
    });
  }
  yield `${JSON.stringify({ ufoTestResults: 1, tests })}\n`;
}
