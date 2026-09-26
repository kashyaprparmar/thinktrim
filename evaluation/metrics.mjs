export function binaryMetrics(rows) {
  const tp = rows.filter((row) => row.gold && row.predicted).length;
  const fp = rows.filter((row) => !row.gold && row.predicted).length;
  const fn = rows.filter((row) => row.gold && !row.predicted).length;
  const tn = rows.filter((row) => !row.gold && !row.predicted).length;
  const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
  };
}

export function rankingMetrics(cases, k = 3) {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError("k must be positive");
  const scored = cases.map(({ ranked, grades }) => {
    const relevant = Object.entries(grades)
      .filter(([, grade]) => grade >= 2)
      .map(([id]) => id);
    const hits = ranked.slice(0, k).filter((id) => relevant.includes(id)).length;
    const first = ranked.findIndex((id) => relevant.includes(id));
    const dcg = (ids) =>
      ids
        .slice(0, k)
        .reduce((sum, id, index) => sum + (2 ** (grades[id] ?? 0) - 1) / Math.log2(index + 2), 0);
    const ideal = Object.keys(grades).sort((a, b) => grades[b] - grades[a]);
    const idealDcg = dcg(ideal);
    return {
      reciprocalRank: relevant.length && first >= 0 ? 1 / (first + 1) : null,
      ndcg: idealDcg ? dcg(ranked) / idealDcg : null,
      topKRecall: relevant.length ? hits / relevant.length : null,
      missedRelevant: relevant.filter((id) => !ranked.slice(0, k).includes(id)),
      relevantCount: relevant.length,
    };
  });
  const mean = (field) => {
    const values = scored.map((row) => row[field]).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    k,
    cases: scored.length,
    mrr: mean("reciprocalRank"),
    ndcg: mean("ndcg"),
    topKRecall: mean("topKRecall"),
    details: scored,
  };
}

/** Use only independently evaluated probabilities for correctness or a binary label. */
export function calibrationMetrics(rows, bins = 10) {
  if (!Number.isSafeInteger(bins) || bins < 2 || bins > 100)
    throw new RangeError("bins must be 2..100");
  if (!rows.length) return { sampleCount: 0, brier: null, ece: null };
  for (const row of rows) {
    if (
      !Number.isFinite(row.probability) ||
      row.probability < 0 ||
      row.probability > 1 ||
      typeof row.correct !== "boolean"
    ) {
      throw new TypeError("Calibration rows need measured probabilities and binary labels");
    }
  }
  const brier =
    rows.reduce((sum, row) => sum + (row.probability - Number(row.correct)) ** 2, 0) / rows.length;
  let ece = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const members = rows.filter(
      (row) => Math.min(bins - 1, Math.floor(row.probability * bins)) === bin,
    );
    if (!members.length) continue;
    const confidence = members.reduce((sum, row) => sum + row.probability, 0) / members.length;
    const accuracy = members.filter((row) => row.correct).length / members.length;
    ece += (members.length / rows.length) * Math.abs(confidence - accuracy);
  }
  return { sampleCount: rows.length, brier, ece };
}

export function classificationMetrics(rows) {
  const classes = [...new Set(rows.flatMap((row) => [row.gold, row.predicted]))].sort();
  const perClass = Object.fromEntries(
    classes.map((category) => [
      category,
      binaryMetrics(
        rows.map((row) => ({ gold: row.gold === category, predicted: row.predicted === category })),
      ),
    ]),
  );
  const f1Values = Object.values(perClass).map((value) => value.f1 ?? 0);
  return {
    count: rows.length,
    accuracy: rows.length
      ? rows.filter((row) => row.gold === row.predicted).length / rows.length
      : null,
    macroF1: f1Values.length
      ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length
      : null,
    perClass,
  };
}
