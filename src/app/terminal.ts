import { once } from "node:events";
import { closeSync, openSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { isatty, ReadStream } from "node:tty";
import { PolicyError, violation } from "../core/policy/index.js";

/**
 * Asks the human at the controlling terminal: opens `/dev/tty` itself, prints `prompt` there,
 * and reads one line from it. A pipe, a redirected stdin, or a caller-supplied stream cannot
 * answer. Refuses (`non_tty_approval`) when there is no terminal to open.
 */
export async function askTerminal(prompt: string): Promise<string> {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new PolicyError(
      violation("non_tty_approval", "no interactive terminal (/dev/tty) to ask the human on"),
    );
  }
  if (!isatty(fd)) {
    closeSync(fd);
    throw new PolicyError(violation("non_tty_approval", "/dev/tty is not a terminal"));
  }
  const input = new ReadStream(fd);
  const rl = createInterface({ input, terminal: false });
  try {
    writeSync(fd, prompt);
    const line = once(rl, "line").then(([text]) => String(text));
    const closed = once(rl, "close").then(() => "");
    return await Promise.race([line, closed]);
  } finally {
    rl.close();
    // Destroying the stream closes the descriptor.
    input.destroy();
  }
}

/**
 * The production human gate of `ufo approve` and `ufo extend-budget`: stdin must be a TTY, and
 * the answer is read from `/dev/tty`, never from a caller.
 */
export function terminalGate() {
  return { stdin: process.stdin, confirm: askTerminal };
}
