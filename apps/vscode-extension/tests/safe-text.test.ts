import { expect, it } from "vitest";
import { safeLogPath, safeMarkdownPath } from "../src/safe-text.js";

it("renders malicious repository paths as inert log and Markdown text", () => {
  const path = "src/file.ts\n[Run this](command:workbench.action.terminal.new)\u001b[31m";
  expect(safeLogPath(path)).not.toContain("\n");
  expect(safeLogPath(path)).toContain("\\u001b");
  const markdown = safeMarkdownPath(path);
  expect(markdown).not.toContain("\n");
  expect(markdown).not.toContain("[Run this](command:");
  expect(markdown).toContain("\\[Run this\\]\\(command:");
});
