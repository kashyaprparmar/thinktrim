import type { JevBackend } from "./jev-backend.js";
import type { LayaHTTPBackend } from "./laya-http-backend.js";
import type { LayaLocalBackend } from "./laya-local-backend.js";

export type ProviderBackend = LayaLocalBackend | LayaHTTPBackend | JevBackend;
