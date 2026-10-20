import { z } from "zod";

/**
 * What limits a target, in the categories every technique card and every diagnosis use.
 * `allocation` covers GC and memory pressure, `contention` locks, pools, and concurrency,
 * `bundle` the size of a payload shipped to a client, `caching` work repeated that could be reused.
 */
export const BottleneckSchema = z.enum([
  "startup",
  "cpu",
  "allocation",
  "io",
  "network",
  "contention",
  "query",
  "serialization",
  "build",
  "bundle",
  "rendering",
  "inference",
  "data_loading",
  "caching",
]);
export type Bottleneck = z.infer<typeof BottleneckSchema>;
