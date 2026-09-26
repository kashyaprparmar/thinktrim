import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { ContextRankingPolicy } from "../dist/index.js";

const { cases } = JSON.parse(await readFile(new URL("./fixtures.json", import.meta.url), "utf8"));
const large = {
  name: "32 candidate shortlist",
  task: "update sdk auth token refresh",
  candidates: Array.from({ length: 32 }, (_, index) => ({
    path: index === 17 ? "packages/sdk/src/auth/refresh.ts" : `packages/app/src/module-${index}.ts`,
    symbols: [{ name: index === 17 ? "refreshSdkToken" : `module${index}`, kind: "function" }],
    imports: [],
    retrievalScore: index === 17 ? 0.7 : 0.8,
    gold: index === 17 ? 3 : 0,
  })),
};
const scenarios = [...cases.filter((entry) => entry.name !== "ambiguous task"), large];

function metadata(raw) {
  return {
    id: `file:${createHash("sha256").update(raw.path).digest("hex").slice(0, 32)}`,
    path: raw.path,
    language: "typescript",
    symbols: raw.symbols.map((symbol) => ({
      id: `${raw.path}#${symbol.name}:1`,
      filePath: raw.path,
      name: symbol.name,
      kind: symbol.kind,
      line: 1,
    })),
    imports: raw.imports.map((specifier) => ({ specifier, line: 1, resolvedPath: null })),
    contentFingerprint: createHash("sha256").update(raw.path).digest("hex"),
    score: raw.retrievalScore,
    sources: ["lexical"],
    matchedTerms: [],
    description: `${raw.path}\nSymbols: ${raw.symbols.map((item) => item.name).join(", ") || "none"}\nImports: ${raw.imports.join(", ") || "none"}`,
  };
}

function ndcgAt3(paths, gold) {
  const dcg = paths
    .slice(0, 3)
    .reduce((sum, name, index) => sum + (2 ** (gold.get(name) ?? 0) - 1) / Math.log2(index + 2), 0);
  const ideal = [...gold.values()]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

function rerank(base, values) {
  const position = new Map(base.map((name, index) => [name, index]));
  return [...base].sort(
    (a, b) => (values.get(b) ?? 0) - (values.get(a) ?? 0) || position.get(a) - position.get(b),
  );
}

const totals = Object.fromEntries(
  ["deterministic", "binary", "score", "small_choice", "pairwise", "listwise"].map((name) => [
    name,
    { ndcg: 0, calls: 0 },
  ]),
);
const policy = new ContextRankingPolicy();
for (const scenario of scenarios) {
  const candidates = scenario.candidates.map(metadata);
  const result = await policy.rank({
    task: scenario.task,
    candidates,
    ...(scenario.changedFiles ? { changedFiles: scenario.changedFiles } : {}),
    ...(scenario.currentEvidence ? { currentEvidence: scenario.currentEvidence } : {}),
  });
  const base = result.ranked.map((item) => item.path);
  const gold = new Map(scenario.candidates.map((item) => [item.path, item.gold]));
  const binary = new Map([...gold].map(([name, grade]) => [name, grade >= 2 ? 1 : 0]));
  const scored = new Map(
    [...gold].map(([name, grade]) => [name, grade === 0 ? 0 : grade === 1 ? 0.5 : 1]),
  );
  const choices = new Map(base.map((name) => [name, 0]));
  for (let start = 0; start < base.length; start += 4) {
    const group = base.slice(start, start + 4);
    const winner = [...group].sort((a, b) => (gold.get(b) ?? 0) - (gold.get(a) ?? 0))[0];
    if (winner) choices.set(winner, 1);
  }
  const wins = new Map(base.map((name) => [name, 0]));
  for (let i = 0; i < base.length; i++)
    for (let j = i + 1; j < base.length; j++) {
      const a = base[i],
        b = base[j];
      if ((gold.get(a) ?? 0) > (gold.get(b) ?? 0)) wins.set(a, wins.get(a) + 1);
      else if ((gold.get(b) ?? 0) > (gold.get(a) ?? 0)) wins.set(b, wins.get(b) + 1);
    }
  const rankings = {
    deterministic: base,
    binary: rerank(base, binary),
    score: rerank(base, scored),
    small_choice: rerank(base, choices),
    pairwise: rerank(base, wins),
    listwise: rerank(base, gold),
  };
  const n = base.length;
  const calls = {
    deterministic: 0,
    binary: n,
    score: Math.ceil(n / 16),
    small_choice: Math.ceil(n / 4),
    pairwise: (n * (n - 1)) / 2,
    listwise: Math.ceil(n / 16),
  };
  for (const [name, order] of Object.entries(rankings)) {
    totals[name].ndcg += ndcgAt3(order, gold);
    totals[name].calls += calls[name];
  }
}
for (const [name, value] of Object.entries(totals)) {
  process.stdout.write(
    JSON.stringify({
      strategy: name,
      fixtures: scenarios.length,
      oracleNdcgAt3: Number((value.ndcg / scenarios.length).toFixed(3)),
      totalCalls: value.calls,
      nativeProviderSupport: ["binary", "score", "small_choice"].includes(name),
    }) + "\n",
  );
}
process.stdout.write(
  "Oracle labels simulate information available to each strategy; results do not measure model quality or calibration.\n",
);
