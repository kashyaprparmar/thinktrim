import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.op === "health" && process.env.THINKTRIM_MOCK_HANG_HEALTH === "1") continue;
  if (request.op === "crash") process.exit(7);
  if (request.op === "invalidJson") {
    process.stdout.write("not json\n");
    continue;
  }
  if (request.op === "hang") continue;
  if (request.op === "stderr") process.stderr.write("diagnostic\n");
  const result =
    request.op === "health"
      ? { status: "ready" }
      : request.op === "predict"
        ? { pid: process.pid, echo: request.params }
        : { pid: process.pid };
  const reply = JSON.stringify({ v: 1, id: request.id, ok: true, result }) + "\n";
  if (request.op === "shutdown") {
    process.stdout.write(reply, () => process.exit(0));
    break;
  }
  process.stdout.write(reply);
}
