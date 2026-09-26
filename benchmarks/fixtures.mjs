import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cases = {
  "bug-fix": {
    "src/math.mjs": "export function sum(a, b) { return a - b; }\n",
    "tests/math.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/math.mjs";
test("adds two numbers", () => assert.equal(sum(2, 3), 5));
`,
  },
  "small-feature": {
    "src/slug.mjs": "export function slugify(input) { throw new Error('Not implemented'); }\n",
    "tests/slug.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";
test("slugifies words", () => assert.equal(slugify("Hello World!"), "hello-world"));
`,
  },
  "multi-file-bug": {
    "src/discount.mjs":
      "export function discountedUnitPrice(cents, percent) { return cents + Math.round(cents * percent / 100); }\n",
    "src/cart.mjs": `import { discountedUnitPrice } from "./discount.mjs";
export function totalCents(items, discountPercent) {
  return items.reduce((sum, item) => sum + discountedUnitPrice(item.priceCents, discountPercent), 0);
}
`,
    "tests/cart.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { totalCents } from "../src/cart.mjs";
test("quantity and discount", () => assert.equal(totalCents([{ priceCents: 1000, quantity: 2 }], 10), 1800));
`,
  },
  refactor: {
    "src/labels.mjs": `export function displayUser(user) { return user.name.trim().toLowerCase(); }
export function displayAdmin(admin) { return admin.name.trim().toLowerCase(); }
`,
    "tests/labels.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { displayUser, displayAdmin } from "../src/labels.mjs";
test("labels", () => {
  assert.equal(displayUser({ name: " Ada " }), "ada");
  assert.equal(displayAdmin({ name: " Grace " }), "grace");
});
`,
  },
  "test-addition": {
    "src/positive.mjs": "export function isPositive(value) { return value > 0; }\n",
  },
  "dependency-failure": {
    "src/pad.mjs": `import leftPad from "left-pad";
export function padCode(value, width) { return leftPad(String(value), width, "0"); }
`,
    "tests/pad.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { padCode } from "../src/pad.mjs";
test("pads a code", () => assert.equal(padCode(7, 3), "007"));
`,
  },
  "configuration-issue": {
    "config/app.json": '{ "port": 0, "mode": "debug" }\n',
    "tests/config.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile(new URL("../config/app.json", import.meta.url), "utf8"));
test("production config", () => {
  assert.equal(config.port, 8080);
  assert.equal(config.mode, "production");
});
`,
  },
  "repo-navigation": {
    "src/auth/session.mjs":
      "export function refreshSession(token) { return { token, refreshed: true }; }\n",
    "src/auth/token.mjs":
      "export function parseToken(token) { return String(token).split('.'); }\n",
  },
  "ambiguous-issue": {
    "src/cache.mjs": "export const cache = new Map();\n",
  },
  "large-repository-task": {
    "src/modules/invoice-299.mjs":
      "export function totalWithTax(subtotal, taxRate) { return subtotal - subtotal * taxRate; }\n",
    "tests/invoice.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { totalWithTax } from "../src/modules/invoice-299.mjs";
test("tax increases total", () => assert.equal(totalWithTax(100, 0.1), 110));
`,
  },
};

export async function createFixture(taskId, root) {
  const files = cases[taskId];
  if (!files) throw new TypeError(`Unknown fixture: ${taskId}`);
  const entries = {
    "package.json":
      '{ "name": "thinktrim-benchmark-fixture", "private": true, "type": "module" }\n',
    ...files,
  };
  if (taskId === "large-repository-task") {
    for (let index = 0; index < 300; index += 1) {
      const name = `src/modules/module-${String(index).padStart(3, "0")}.mjs`;
      if (!(name in entries)) entries[name] = `export const value${index} = ${index};\n`;
    }
  }
  for (const [name, contents] of Object.entries(entries)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}
