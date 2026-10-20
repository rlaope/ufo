import { z } from "zod";

/** A language, runtime, framework, build tool, or service a technique card can apply to. */
export const StackIdSchema = z.enum([
  "jvm",
  "spring-boot",
  "gradle",
  "maven",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "typescript",
  "nextjs",
  "vite",
  "webpack",
  "python",
  "django",
  "fastapi",
  "flask",
  "sqlalchemy",
  "go",
  "rust",
  "cargo",
  "docker",
  "postgres",
  "mysql",
  "hibernate",
  "llama-cpp",
  "vllm",
  "pytorch",
  "openai-client",
]);
export type StackId = z.infer<typeof StackIdSchema>;
