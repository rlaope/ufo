import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, draftConfigFor } from "./config.js";
import { type AppContext, repoOf } from "./context.js";
import { detectStacks } from "./detect.js";
import { AppError } from "./errors.js";

export interface InitResult {
  path: string;
  created: true;
}

/**
 * Writes a draft `ufo.yaml` at the repository root, built from the stacks detected there. An
 * existing file is never overwritten.
 */
export async function init(context: AppContext): Promise<InitResult> {
  const repo = await repoOf(context);
  const file = path.join(repo.root, CONFIG_FILE);
  try {
    await writeFile(file, draftConfigFor(await detectStacks(repo.root)), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AppError("config_exists", `${CONFIG_FILE} already exists; edit it instead`);
    }
    throw error;
  }
  return { path: file, created: true };
}
