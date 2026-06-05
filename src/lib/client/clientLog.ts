import { Effect } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
      if (import.meta.env.VITE_SILENT_CLIENT_LOGGING === "true") {
        return;
      }

      const payload = {
        level,
        timestamp: new Date().toISOString(),
        message: typeof args[0] === "string" ? args[0] : "Client Log Event",
        data: args.length > 1 ? args.slice(1) : args[0] ?? {},
        url: window.location.href,
      };

      yield* Effect.tryPromise({
        try: () => fetch("/api/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        catch: () => undefined,
      });
    });

    yield* Effect.fork(forwardEffect);
  });
