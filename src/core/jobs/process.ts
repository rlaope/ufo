import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/** Linux allows PIDs up to 2^22; the bound only rejects nonsense. */
export const PidSchema = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/**
 * A process group id UFO may signal. `kill(-1)` and `kill(0)` address every process and the
 * caller's own group, and pid 1 is init, so ids below 2 are never valid.
 */
export const PgidSchema = PidSchema.min(2);

/** Opaque per-process start time, compared to tell a live process from one that reused its PID. */
export const StartTimeSchema = z.string().min(1).max(64);

export function isPidAlive(pid: number): boolean {
  if (!PidSchema.safeParse(pid).success) return false;
  return probe(pid);
}

export function isProcessGroupAlive(pgid: number): boolean {
  if (!PgidSchema.safeParse(pgid).success) return false;
  return probe(-pgid);
}

function probe(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The start time `ps` reports for `pid` (one-second resolution), or `undefined` when the process
 * does not exist or the platform has no `ps`. The fixed locale and time zone make the value
 * comparable across processes with different environments.
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "win32" || !PidSchema.safeParse(pid).success) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
