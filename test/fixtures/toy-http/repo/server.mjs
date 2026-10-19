import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

/** Routes the test suite covers, one test each. */
export const ROUTES = ["/health", "/items"];

/** The slow consistency check in the test suite runs only while this is true. */
export const RUN_SLOW_CHECKS = true;

const ITEMS = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));

function readProperties() {
  const text = readFileSync(new URL("./toy.properties", import.meta.url), "utf8");
  const entries = text
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return Object.fromEntries(entries);
}

export function formatItems(items) {
  return JSON.stringify({ count: items.length, items });
}

export function createApp() {
  const extraDelayMs = Number(readProperties()["items.extra_delay_ms"] ?? 0);
  return createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/items") {
      await sleep(5);
      if (extraDelayMs > 0) await sleep(extraDelayMs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(formatItems(ITEMS));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
