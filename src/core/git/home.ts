import { homedir } from "node:os";
import path from "node:path";

/** UFO's per-user state directory: `$UFO_HOME`, or `~/.ufo` when it is unset. */
export function ufoHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.UFO_HOME;
  return configured ? path.resolve(configured) : path.join(homedir(), ".ufo");
}
