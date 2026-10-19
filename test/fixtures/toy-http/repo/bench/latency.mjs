// Workload for UFO: starts the server on an ephemeral loopback port, sends a fixed number of
// sequential requests, and prints one JSON line with the median latency and the error rate.
// The median, not the mean: a few requests stalled by a busy machine do not move it.
// TOY_NOISE (e.g. 0.4) scales the reported latency by a fixed per-sample pattern, so tests
// can inject noise above the refusal threshold deterministically.
import { once } from "node:events";
import { createApp } from "../server.mjs";

const REQUESTS = 15;
const NOISE_PATTERN = [-1, 1, -0.5, 0.5, 0];

const server = createApp();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

const latencies = [];
let errors = 0;
for (let i = 0; i < REQUESTS; i++) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/items`);
  await response.arrayBuffer();
  latencies.push(performance.now() - started);
  if (response.status >= 400) errors++;
}
server.close();

latencies.sort((a, b) => a - b);
const middle = Math.floor(REQUESTS / 2);
let latencyMs =
  REQUESTS % 2 === 1 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2;
const noise = Number(process.env.TOY_NOISE ?? 0);
if (noise > 0) {
  const index = Number(process.env.UFO_SAMPLE_INDEX ?? 0);
  latencyMs *= 1 + noise * (NOISE_PATTERN[index % NOISE_PATTERN.length] ?? 0);
}
process.stdout.write(
  `${JSON.stringify({ latency_ms: Number(latencyMs.toFixed(4)), error_rate: errors / REQUESTS })}\n`,
);
process.exit(0);
