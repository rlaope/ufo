import { z } from "zod";

/** One week. A larger value is almost certainly a unit mistake (seconds for minutes). */
export const MAX_WALL_CLOCK_MINUTES = 7 * 24 * 60;
/** Ten times the default technique cap. */
export const MAX_TECHNIQUES = 100;

export const BudgetSchema = z.strictObject({
  wallClockMinutes: z.number().int().min(1).max(MAX_WALL_CLOCK_MINUTES).default(120),
  maxTechniques: z.number().int().min(1).max(MAX_TECHNIQUES).default(10),
});
export type Budget = z.infer<typeof BudgetSchema>;
