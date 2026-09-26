import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function load(root, relative) {
  return import(pathToFileURL(path.join(root, relative)).href);
}

async function checkBehavior(taskId, root, answer) {
  switch (taskId) {
    case "bug-fix": {
      const { sum } = await load(root, "src/math.mjs");
      requireValue(sum(2, 3) === 5 && sum(-4, 4) === 0, "sum behavior is incorrect");
      break;
    }
    case "small-feature": {
      const { slugify } = await load(root, "src/slug.mjs");
      requireValue(
        slugify("  Hello,   World! ") === "hello-world" && slugify("A__B") === "a-b",
        "slugify behavior is incorrect",
      );
      break;
    }
    case "multi-file-bug": {
      const { totalCents } = await load(root, "src/cart.mjs");
      requireValue(
        totalCents([{ priceCents: 1000, quantity: 2 }], 10) === 1800 &&
          totalCents([{ priceCents: 500, quantity: 1 }], 20) === 400,
        "cart or discount behavior is incorrect",
      );
      break;
    }
    case "refactor": {
      const { displayUser, displayAdmin } = await load(root, "src/labels.mjs");
      const source = await readFile(path.join(root, "src/labels.mjs"), "utf8");
      requireValue(
        displayUser({ name: " Ada " }) === "ada" && displayAdmin({ name: " Grace " }) === "grace",
        "label behavior changed",
      );
      requireValue(
        (source.match(/\.trim\(\)\.toLowerCase\(\)/g) ?? []).length === 1,
        "normalization remains duplicated",
      );
      break;
    }
    case "test-addition": {
      const source = await readFile(path.join(root, "tests/positive.test.mjs"), "utf8");
      requireValue(/node:test/.test(source) && /assert/.test(source), "test file lacks assertions");
      requireValue(/\b0\b/.test(source) && /-\s*\d/.test(source), "edge cases are missing");
      break;
    }
    case "dependency-failure": {
      const { padCode } = await load(root, "src/pad.mjs");
      const source = await readFile(path.join(root, "src/pad.mjs"), "utf8");
      requireValue(padCode(7, 3) === "007" && padCode(1234, 2) === "1234", "padCode failed");
      requireValue(!/left-pad/.test(source), "unavailable dependency remains");
      break;
    }
    case "configuration-issue": {
      const config = JSON.parse(await readFile(path.join(root, "config/app.json"), "utf8"));
      requireValue(config.port === 8080 && config.mode === "production", "config is incorrect");
      break;
    }
    case "repo-navigation":
      requireValue(
        /src[\\/]auth[\\/]session\.mjs/i.test(answer),
        "answer omits implementation path",
      );
      break;
    case "ambiguous-issue":
      requireValue(
        /\?/.test(answer) && /which|what|workload|latency|target|metric/i.test(answer),
        "answer does not ask a focused clarifying question",
      );
      break;
    case "large-repository-task": {
      const { totalWithTax } = await load(root, "src/modules/invoice-299.mjs");
      requireValue(
        Math.abs(totalWithTax(100, 0.1) - 110) < 1e-9 && totalWithTax(50, 0) === 50,
        "invoice tax behavior is incorrect",
      );
      break;
    }
    default:
      throw new TypeError(`Unknown benchmark task: ${taskId}`);
  }
}

export async function gradeTask(task, root, changedFiles, answer, patchValid) {
  const expected = new Set(task.expectedFiles);
  const changed = new Set(changedFiles);
  const missing = [...expected].filter((file) => !changed.has(file));
  const unexpected = changedFiles.filter(
    (file) => !expected.has(file) && !(task.tests && file.startsWith("tests/")),
  );
  const patchCorrect = patchValid && missing.length === 0 && unexpected.length === 0;
  let hiddenCheckPassed = false;
  let issue = null;
  try {
    await checkBehavior(task.id, root, answer);
    hiddenCheckPassed = true;
  } catch (error) {
    issue = error instanceof Error ? error.message.slice(0, 160) : "Hidden check failed";
  }
  return { patchCorrect, hiddenCheckPassed, missing, unexpected, issue };
}
