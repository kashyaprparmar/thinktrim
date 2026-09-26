import { FakeBackend } from "../src/index.js";
import { runBackendContract } from "./backend-contract.js";

runBackendContract("FakeBackend", (prediction) => {
  const backend = new FakeBackend();
  backend.enqueue(prediction);
  return backend;
});
