export type SidecarOperation =
  | "health"
  | "capabilities"
  | "version"
  | "preload"
  | "predict"
  | "predictBatch"
  | "shutdown";

export interface SidecarClientOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onDiagnostic?: (event: { readonly kind: "stderr"; readonly bytes: number }) => void;
}

export interface SidecarRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class SidecarError extends Error {
  readonly code: string;
}

export class LayaSidecarClient {
  constructor(options?: SidecarClientOptions);
  start(): Promise<void>;
  request(op: SidecarOperation | string, params?: unknown, options?: SidecarRequestOptions): Promise<unknown>;
  shutdown(): Promise<void>;
}
