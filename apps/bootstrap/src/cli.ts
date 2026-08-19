#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runBootstrap } from "./runtime-bootstrap.js";

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

try {
  const result = await runBootstrap(process.argv.slice(2), {
    interactive,
    ...(interactive ? {
      prompt: async (message: string) => {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await prompt.question(message);
          return ["y", "yes"].includes(answer.trim().toLowerCase());
        } finally {
          prompt.close();
        }
      },
    } : {}),
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exit_code;
} catch (error) {
  process.stderr.write(`Urdira runtime preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
