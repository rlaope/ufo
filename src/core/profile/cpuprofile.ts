import { invalid, type Parsed, STACK_FRAMES, Tally } from "./summary.js";

/**
 * Call tree nodes of one `.cpuprofile`, about twice as many as `MAX_PROFILE_BYTES` holds of the
 * nodes `node --cpu-prof` writes; a larger tree is refused rather than cut.
 */
export const MAX_CPUPROFILE_NODES = 500_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `fn (url:line)`, the line 1-based; V8's own entries such as `(idle)` have no url. */
function frameOf(callFrame: Json): string {
  const name =
    typeof callFrame.functionName === "string" && callFrame.functionName !== ""
      ? callFrame.functionName
      : "(anonymous)";
  const url = typeof callFrame.url === "string" ? callFrame.url : "";
  if (url === "") return name;
  const line = callFrame.lineNumber;
  return typeof line === "number" && Number.isInteger(line) && line >= 0
    ? `${name} (${url}:${line + 1})`
    : `${name} (${url})`;
}

/**
 * A V8 CPU profile (`node --cpu-prof`, Chrome DevTools): `nodes` (the call tree), `samples`
 * (a node id per sample), and `timeDeltas` (microseconds since the previous sample). As
 * DevTools reads it, a sample lasts until the next one, the last until `endTime`. The tree's
 * root, V8's `(root)`, is no frame; `(idle)`, `(program)`, and `(garbage collector)` are.
 */
export function parseCpuprofile(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("not JSON");
  }
  if (!isObject(value) || !Array.isArray(value.nodes)) {
    return invalid("no nodes: not a V8 .cpuprofile");
  }
  const { nodes, samples, timeDeltas, startTime, endTime } = value;
  if (nodes.length === 0) return invalid("no nodes: not a V8 .cpuprofile");
  if (nodes.length > MAX_CPUPROFILE_NODES) {
    return invalid(`more than ${MAX_CPUPROFILE_NODES} nodes`);
  }
  if (!Array.isArray(samples) || !Array.isArray(timeDeltas)) {
    return invalid("no samples or timeDeltas");
  }
  if (samples.length !== timeDeltas.length) {
    return invalid("samples and timeDeltas differ in length");
  }
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
    return invalid("no startTime");
  }

  const count = nodes.length;
  const position = new Map<number, number>();
  const frames: string[] = [];
  for (const [i, node] of nodes.entries()) {
    if (!isObject(node) || !Number.isInteger(node.id) || !isObject(node.callFrame)) {
      return invalid(`node ${i} has no id or callFrame`);
    }
    if (position.has(node.id as number)) return invalid(`node id ${node.id} repeats`);
    position.set(node.id as number, i);
    frames.push(frameOf(node.callFrame));
  }
  // Each node has at most one parent, so a walk from the root visits each node once at most.
  const parent = new Int32Array(count).fill(-1);
  const children: number[][] = Array.from({ length: count }, () => []);
  const link = (child: unknown, of: number): string | undefined => {
    const at = typeof child === "number" ? position.get(child) : undefined;
    if (at === undefined) return `node ${String(child)} is not in nodes`;
    if (parent[at] !== -1 || at === of) return "the nodes do not form a tree";
    parent[at] = of;
    children[of]?.push(at);
    return undefined;
  };
  for (const [i, node] of (nodes as Json[]).entries()) {
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) return invalid(`node ${node.id} has bad children`);
      for (const child of node.children) {
        const problem = link(child, i);
        if (problem !== undefined) return invalid(problem);
      }
    }
  }
  // Older profiles name each node's parent instead of its children.
  if (children.every((list) => list.length === 0)) {
    for (const node of nodes as Json[]) {
      if (node.parent === undefined) continue;
      const of = typeof node.parent === "number" ? position.get(node.parent) : undefined;
      if (of === undefined) return invalid(`node ${String(node.parent)} is not in nodes`);
      const problem = link(node.id, of);
      if (problem !== undefined) return invalid(problem);
    }
  }
  const roots = [...parent.keys()].filter((i) => parent[i] === -1);
  const root = roots[0];
  if (root === undefined || roots.length !== 1) return invalid("the nodes do not form a tree");

  // Self weight of each node: the time from its sample to the next one.
  const self = new Float64Array(count);
  let previous = Number.NEGATIVE_INFINITY;
  let elapsed = startTime;
  const at = new Float64Array(timeDeltas.length);
  for (const [i, delta] of timeDeltas.entries()) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      return invalid(`timeDeltas[${i}] is not a number`);
    }
    elapsed += delta;
    // A negative delta (V8 emits a few) keeps the clock where it was.
    previous = Math.max(previous, elapsed);
    at[i] = previous;
  }
  for (const [i, id] of samples.entries()) {
    const node = typeof id === "number" ? position.get(id) : undefined;
    if (node === undefined) return invalid(`sample ${i} names no node`);
    const next =
      i + 1 < at.length
        ? (at[i + 1] ?? 0)
        : typeof endTime === "number" && Number.isFinite(endTime)
          ? Math.max(endTime, at[i] ?? 0)
          : (at[i] ?? 0);
    self[node] = (self[node] ?? 0) + (next - (at[i] ?? 0));
  }

  // Inclusive weight, children before parents, from a walk in pre-order.
  const order: number[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    order.push(node);
    // Only a cycle visits a node twice; one parent per node rules that out, and this backs it.
    if (order.length > count) return invalid("the nodes do not form a tree");
    for (const child of children[node] ?? []) pending.push(child);
  }
  if (order.length !== count) return invalid("the nodes do not form a tree");
  const inclusive = Float64Array.from(self);
  for (const node of order.toReversed()) {
    const up = parent[node] ?? -1;
    if (up !== -1) inclusive[up] = (inclusive[up] ?? 0) + (inclusive[node] ?? 0);
  }

  const tally = new Tally();
  tally.weight = self.reduce((sum, w) => sum + w, 0);
  // A frame's total is the inclusive weight of its outermost node on each path, so recursion
  // counts it once.
  const onPath = new Map<string, number>();
  // The path as stacks show it: a node of the same frame as its parent is not pushed.
  const shown: string[] = [];
  const walk: { node: number; next: number; pushed: boolean }[] = [];
  for (const child of children[root] ?? []) walk.push({ node: child, next: -1, pushed: false });
  while (walk.length > 0) {
    const top = walk.at(-1);
    if (top === undefined) break;
    const frame = frames[top.node] ?? "";
    if (top.next === -1) {
      top.next = 0;
      const depth = onPath.get(frame) ?? 0;
      if (depth === 0) tally.addTotal(frame, inclusive[top.node] ?? 0);
      onPath.set(frame, depth + 1);
      top.pushed = shown.at(-1) !== frame;
      if (top.pushed) shown.push(frame);
      const weight = self[top.node] ?? 0;
      if (weight > 0) {
        tally.addSelf(frame, weight);
        tally.addStack(shown.slice(-STACK_FRAMES), weight);
      }
    }
    const child = children[top.node]?.[top.next];
    if (child !== undefined) {
      top.next++;
      walk.push({ node: child, next: -1, pushed: false });
      continue;
    }
    walk.pop();
    if (top.pushed) shown.pop();
    onPath.set(frame, (onPath.get(frame) ?? 1) - 1);
  }
  const idle = frames.reduce(
    (sum, frame, i) => (frame === "(idle)" ? sum + (self[i] ?? 0) : sum),
    0,
  );
  return { valid: true, tally, unit: "microseconds", idle };
}
