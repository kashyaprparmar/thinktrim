# @thinktrim/telemetry

Local decision traces for ThinkTrim hosts. This package writes JSON files under `<workspace>/.thinktrim/traces/` and has no analytics service, network client, or repository-content exporter. Trace files are ignored by Git and are readable through `thinktrim trace`.

```ts
import { LocalTraceStore } from "@thinktrim/telemetry";

const store = new LocalTraceStore(workspaceRoot);
await store.record({
  host: "mcp",
  placement: "pre_read",
  result: decisionResult,
  candidateCounts: { retrieved: 30, ranked: 20, selected: 5 },
});
```

`record` returns the saved metadata record; `list` returns saved filenames. Hosts must call this API explicitly. The package copies only fixed host/category/backend labels, decision kind/outcome/provenance, stage names and timings, candidate counts, calibrated confidence, cache hit, escalation outcome, and usage counts. Unknown category/backend/unit strings become `other`. It generates a new trace ID rather than copying request IDs. It does not copy tasks, file paths, source, errors, free-form reason/stage text, model versions, or candidate IDs.

`usage.decisionBackend` is separate from optional `usage.measuredFrontier`. Pass `measuredFrontierUsage` only for actual host/provider reported token counts. The trace does not compute or claim token savings. Use `placement: "post_read"` when the host already read repository context.

The store checks that its workspace and trace directories are real directories, writes same-directory temporary files, then renames them. It caps each JSON record at 64 KiB. On POSIX it requests private directory/file modes; on Windows, access follows the workspace ACL. Retention and export are not part of this V1 package.
