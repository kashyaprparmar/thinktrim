import { DecisionBackendFailure } from "./errors.js";

export interface DecisionAbortScope {
  readonly signal: AbortSignal;
  readonly failureCode: "timeout" | "cancelled";
  dispose(): void;
}

export function createAbortScope(
  external: AbortSignal | undefined,
  deadlineMs: number,
): DecisionAbortScope {
  const controller = new AbortController();
  let failureCode: "timeout" | "cancelled" = "cancelled";

  const onExternalAbort = (): void => {
    failureCode = "cancelled";
    controller.abort();
  };

  if (external?.aborted) {
    onExternalAbort();
  } else {
    external?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      failureCode = "timeout";
      controller.abort();
    }
  }, deadlineMs);

  return {
    signal: controller.signal,
    get failureCode() {
      return failureCode;
    },
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/** The race lets the engine return even when an adapter ignores cancellation. */
export async function runAbortable<T>(
  scope: DecisionAbortScope,
  operation: () => Promise<T>,
): Promise<T> {
  if (scope.signal.aborted) {
    throw new DecisionBackendFailure(scope.failureCode);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DecisionBackendFailure(scope.failureCode));
    scope.signal.addEventListener("abort", onAbort, { once: true });
    if (scope.signal.aborted) {
      onAbort();
    }
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (scope.signal.aborted) {
          throw new DecisionBackendFailure(scope.failureCode);
        }
        return operation();
      }),
      aborted,
    ]);
  } finally {
    if (onAbort) {
      scope.signal.removeEventListener("abort", onAbort);
    }
  }
}
