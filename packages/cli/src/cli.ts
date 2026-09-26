#!/usr/bin/env node
import { runCli } from "./index.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected CLI error";
  process.stderr.write(`thinktrim: ${message}\n`);
  process.exitCode = 1;
}
