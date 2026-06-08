import { Effect } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

const pendingLogRequests: (() => Promise<void>)[] = [];
let activeLogRequests = 0;
const MAX_CONCURRENT_LOGS = 2;

const processLogQueue = () => {
  if (activeLogRequests >= MAX_CONCURRENT_LOGS || pendingLogRequests.length === 0) {
    return;
  }

  const nextLog = pendingLogRequests.shift();
  if (nextLog) {
    activeLogRequests++;
    nextLog()
      .catch(() => {})
      .finally(() => {
        activeLogRequests--;
        processLogQueue();
      });
  }
};

export const clientLog = (
  level: LogLevel,
  ...args: unknown[]
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (level) {
      case "info":
        console.info(...args);
        break;
      case "warn":
        console.warn(...args);
        break;
      case "error":
        console.error(...args);
        break;
      case "debug":
        if (import.meta.env.DEV) {
          console.debug(...args);
        }
        break;
    }

    const forwardEffect = Effect.gen(function* () {
      if (
        import.meta.env.VITE_SILENT_CLIENT_LOGGING === "true" ||
        import.meta.env.MODE === "test"
      ) {
        return;
      }

      const payload = {
        level,
        timestamp: new Date().toISOString(),
        message: typeof args[0] === "string" ? args[0] : "Client Log Event",
        data: args.length > 1 ? args.slice(1) : args[0] ?? {},
        url: window.location.href,
      };

      const apiBase = import.meta.env.VITE_API_BASE_URL || "";
      const logUrl = apiBase ? `${apiBase}/api/log` : "/api/log";

      const sendRequest = () =>
        fetch(logUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then(() => {});

      yield* Effect.sync(() => {
        pendingLogRequests.push(sendRequest);
        processLogQueue();
      });
    });

    yield* forwardEffect;
  });
