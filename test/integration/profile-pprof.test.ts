import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cancelRun,
  listTechniques,
  type ProfileResult,
  profileTarget,
  startRun,
} from "../../src/app/index.js";
import { approveToy, git, makeToy, TIMEOUT_MS, waitDone } from "./helpers.js";

// M5 V3: a profile job whose command writes a Go pprof file, as `go test -cpuprofile` or a
// fetch from net/http/pprof would, read by the worker and ranking the Go cards by its frames.

const FIXTURE = fileURLToPath(new URL("../fixtures/profiles/toy.pprof", import.meta.url));

/** The measured command: copies the profile in a profile job only, then prints its line. */
const COMMAND = `import { copyFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.UFO_PROFILE_DIR;
if (dir !== undefined) copyFileSync(process.env.TOY_PPROF, path.join(dir, "cpu.pprof"));
console.log(JSON.stringify({ latency_ms: 1, error_rate: 0 }));
`;

describe("a pprof profile", { timeout: TIMEOUT_MS }, () => {
  it("comes back as hot spots and ranks the Go allocation card", async () => {
    const toy = makeToy({
      env: { TOY_PPROF: FIXTURE },
      config: (yaml) => {
        const start = yaml.indexOf("workload:\n");
        const end = yaml.indexOf("cards:\n");
        const workload = [
          "workload:",
          "  command: node bench.mjs",
          "  profile:",
          "    format: pprof",
          "oracles: []",
          "",
        ].join("\n");
        return `${yaml.slice(0, start)}${workload}${yaml.slice(end)}env:\n  - TOY_PPROF\n`;
      },
    });
    try {
      writeFileSync(path.join(toy.repo, "bench.mjs"), COMMAND);
      git(toy.repo, "add", "--all");
      git(toy.repo, "commit", "--quiet", "--message", "bench");
      await approveToy(toy);
      const run = await startRun(toy.context);
      expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
      const queued = await profileTarget(toy.context, { runId: run.runId });
      const job = await waitDone(toy, run.runId, queued.jobId);
      expect(job.status, job.error?.message).toBe("succeeded");
      const { hotspots } = job.result as unknown as ProfileResult;
      expect(hotspots).toMatchObject({ format: "pprof", omitted: 0 });
      expect(hotspots?.files).toMatchObject([
        {
          file: "cpu.pprof",
          valid: true,
          unit: "nanoseconds",
          self: expect.arrayContaining([{ frame: "toyprof.mix", pct: 40.9 }]),
        },
      ]);
      const ranked = await listTechniques(toy.context, {
        stack: "go",
        profileJobId: queued.jobId,
      });
      expect(ranked.cards[0]).toMatchObject({
        id: "server.go-reduce-allocations",
        evidence: expect.arrayContaining([
          { hint: "runtime.mallocgc", frame: "runtime.mallocgc", share: 0.065, kind: "total" },
        ]),
      });
      await cancelRun(toy.context, { runId: run.runId });
    } finally {
      await toy.cleanup();
    }
  });
});
