import * as vscode from "vscode";

export type BackendChoice = "deterministic" | "laya-http" | "jev";

export interface ThinkTrimConfiguration {
  readonly backend: BackendChoice;
  readonly layaEndpoint: string;
  readonly maxCandidates: number;
}

export function readConfiguration(): ThinkTrimConfiguration {
  const config = vscode.workspace.getConfiguration("thinktrim");
  const configuredBackend = config.get<string>("backend", "deterministic");
  const backend: BackendChoice =
    configuredBackend === "laya-http" || configuredBackend === "jev"
      ? configuredBackend
      : "deterministic";
  const configuredCount = config.get<number>("maxCandidates", 30);
  return {
    backend,
    layaEndpoint: config.get<string>("laya.endpoint", "http://127.0.0.1:8000"),
    maxCandidates:
      Number.isSafeInteger(configuredCount) && configuredCount >= 1 && configuredCount <= 40
        ? configuredCount
        : 30,
  };
}
