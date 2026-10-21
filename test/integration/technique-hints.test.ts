import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelRun,
  listTechniques,
  type ProfileResult,
  profileTarget,
  startRun,
} from "../../src/app/index.js";
import { writeJob } from "../../src/core/jobs/index.js";
import { displayName } from "../../src/core/profile/index.js";
import { approveToy, lightWorkload, makeToy, TIMEOUT_MS, type Toy, waitDone } from "./helpers.js";

// M5 V1: list_techniques ranked by a profile job of the active run. The toy has no
// workload.profile, so its profile has no hot spots until the test writes them into the artifact
// the way a profiled job would.

let toy: Toy;

beforeAll(async () => {
  toy = makeToy({ config: lightWorkload() });
  await approveToy(toy);
});

afterAll(async () => {
  await toy.cleanup();
});

describe("listing techniques by a profile", { timeout: TIMEOUT_MS }, () => {
  it("ranks the cards its hot frames point at, and refuses what is not its profile", async () => {
    const run = await startRun(toy.context);
    let other: string | undefined;
    try {
      expect((await waitDone(toy, run.runId, run.baselineJobId)).status).toBe("succeeded");
      const queued = await profileTarget(toy.context, { runId: run.runId });
      const job = await waitDone(toy, run.runId, queued.jobId);
      expect(job.status, job.error?.message).toBe("succeeded");

      // A profile without hot spots: the plain listing, and why it is not ranked.
      const plain = await listTechniques(toy.context);
      const unranked = await listTechniques(toy.context, { profileJobId: queued.jobId });
      expect(unranked.cards).toEqual(plain.cards);
      expect(unranked.note).toBe(
        `profile ${queued.jobId} has no hot spots (ufo.yaml has no workload.profile); the listing is not ranked`,
      );

      // Not a profile of this run: usage.
      for (const [jobId, message] of [
        [run.baselineJobId, `${run.baselineJobId} is a baseline job`],
        ["job-000099", `no job job-000099 in run ${run.runId}`],
        ["../run.json", `no job ../run.json in run ${run.runId}`],
      ] as const) {
        await expect(listTechniques(toy.context, { profileJobId: jobId })).rejects.toMatchObject({
          code: "usage",
          message: expect.stringContaining(message),
        });
      }

      // A profile that did not succeed has no hot spots to rank by.
      const runDir = toy.runDir(run.runId);
      await writeJob(runDir, {
        ...job,
        jobId: "job-000050",
        seq: 50,
        status: "failed",
        result: undefined,
        error: { message: "workload setup fails" },
      });
      await expect(
        listTechniques(toy.context, { profileJobId: "job-000050" }),
      ).rejects.toMatchObject({
        code: "usage",
        message: "profile job-000050 is failed; wait for it with get_job, or profile again",
      });

      // The artifact as a profiled job writes it: async-profiler's slashed JVM names.
      const file = path.join(runDir, (job.result as unknown as ProfileResult).artifact);
      const artifact = JSON.parse(readFileSync(file, "utf8")) as ProfileResult;
      const hotspot = (self: [string, number][], total: [string, number][]) => ({
        file: "app.collapsed",
        valid: true as const,
        unit: "samples",
        weight: 1000,
        self: self.map(([frame, pct]) => ({ frame, pct })),
        total: total.map(([frame, pct]) => ({ frame, pct })),
        stacks: [],
      });
      artifact.hotspots = {
        format: "collapsed",
        dir: "artifacts/profile",
        files: [
          hotspot(
            [
              ["com/fasterxml/jackson/databind/ObjectMapper.<init>", 21.5],
              ["java/lang/ClassLoader.defineClass1", 10],
            ],
            [
              ["com/fasterxml/jackson/databind/ObjectMapper.<init>", 34.2],
              [
                // Cut as a summary shows it, its start and end kept.
                displayName(
                  "org/springframework/beans/factory/support/DefaultListableBeanFactory.preInstantiateSingletons",
                ),
                29.9,
              ],
            ],
          ),
          { file: "broken.collapsed", valid: false, reason: "invalid profile" },
        ],
        omitted: 0,
      };
      writeFileSync(file, JSON.stringify(artifact));
      const ranked = await listTechniques(toy.context, { profileJobId: queued.jobId });
      expect(ranked.note).toBeUndefined();
      expect(ranked.cards[0]).toMatchObject({
        id: "jvm.jackson-mapper-reuse",
        expectedEffect: expect.any(String),
        evidence: [
          {
            hint: "ObjectMapper.<init>",
            frame: "com/fasterxml/jackson/databind/ObjectMapper.<init>",
            share: 0.342,
            kind: "total",
          },
        ],
      });
      // Shares below a weak hint's minimum point at nothing: class loading at 10% of 15%, lazy
      // initialization's singletons at 29.9% of 30%.
      expect(ranked.cards.filter((entry) => entry.evidence !== undefined)).toHaveLength(1);
      expect(ranked.cards.map((entry) => entry.id).sort()).toEqual(
        plain.cards.map((entry) => entry.id).sort(),
      );
      // A bottleneck filter the card is outside of leaves it out, evidence or not.
      const startup = await listTechniques(toy.context, {
        bottleneck: "startup",
        profileJobId: queued.jobId,
      });
      expect(startup.cards.some((entry) => entry.id === "jvm.jackson-mapper-reuse")).toBe(false);
      expect(startup.note).toBe(
        `no listed card's frame hints are among the hot frames of profile ${queued.jobId}`,
      );
      // An artifact that is not what a summary writes ranks nothing.
      const long = artifact.hotspots?.files[0] as { self: { frame: string; pct: number }[] };
      long.self.push({ frame: "x".repeat(81), pct: 1 });
      writeFileSync(file, JSON.stringify(artifact));
      expect(await listTechniques(toy.context, { profileJobId: queued.jobId })).toEqual({
        cards: plain.cards,
        note: `the artifact of profile ${queued.jobId} cannot be read; the listing is not ranked`,
      });
      other = queued.jobId;
    } finally {
      await cancelRun(toy.context, { runId: run.runId }).catch(() => undefined);
    }

    // The profile of a run that ended is not the active run's: once no run is active,
    // run_not_active; in the next run its id names no job, or not that one.
    await expect(listTechniques(toy.context, { profileJobId: other })).rejects.toMatchObject({
      code: "run_not_active",
    });
    const next = await startRun(toy.context);
    try {
      expect((await waitDone(toy, next.runId, next.baselineJobId)).status).toBe("succeeded");
      await expect(listTechniques(toy.context, { profileJobId: other })).rejects.toMatchObject({
        code: "usage",
        message: `no job ${other} in run ${next.runId}`,
      });
    } finally {
      await cancelRun(toy.context, { runId: next.runId }).catch(() => undefined);
    }
  });
});
