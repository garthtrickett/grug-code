import { Effect } from "effect";
import { runClientUnscoped } from "./lib/client/runtime.ts";
import { clientLog } from "./lib/client/clientLog.ts";
import { initializeGrugToken } from "./lib/client/stores/taskStore.ts";

// Register custom elements
import "./components/layouts/app-shell.ts";

// Register global error listeners to forward unhandled client exceptions to the server log
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    const err = event.error as unknown;
    const stack = err instanceof Error ? err.stack : undefined;
    const payload = {
      level: "error",
      timestamp: new Date().toISOString(),
      message: `[Unhandled Window Error] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      data: stack ? { stack: String(stack) } : {},
      url: window.location.href,
    };
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as unknown;
    const stack = reason instanceof Error ? reason.stack : undefined;
    const payload = {
      level: "error",
      timestamp: new Date().toISOString(),
      message: `[Unhandled Promise Rejection] ${String(event.reason)}`,
      data: stack ? { stack: String(stack) } : {},
      url: window.location.href,
    };
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  });
}

const bootstrapApp = Effect.gen(function* () {
  // Extract and scrub security tokens on early page instantiation before any APIs run
  yield* Effect.sync(() => {
    initializeGrugToken();
  });

  yield* clientLog("info", "[Main] Initiating Grug Code bootstrap sequence...");

    // Hydrate User Preferences storage from localStorage
  yield* clientLog("info", "[Main] Hydrating User Preferences storage...");
  const { userPreferencesStore } = yield* Effect.promise(() => import("./lib/client/stores/userPreferencesStore.ts"));
  yield* userPreferencesStore.load();
  yield* clientLog("debug", `[Main] User preferences hydrated: reviewLimit=${userPreferencesStore.dailyReviewLimit.value}`);

  // 4. Attempt session restoration
  const { initAuth } = yield* Effect.promise(() => import("./lib/client/stores/authStore.ts"));
  yield* clientLog("info", "[Main] Attempting session restoration...");
  yield* initAuth();

  // 5. Reconcile active workspace transaction state with server-side authoritativeness
  yield* clientLog("info", "[Main] Reconciling active workspace transaction state...");
  const { taskStore: tStore } = yield* Effect.promise(() => import("./lib/client/stores/taskStore.ts"));
  const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
  yield* tStore.reconcileActiveTransaction(cwd);

  yield* clientLog("info", "[Main] Application successfully bootstrapped.");
}).pipe(
  Effect.catchAll((err) =>
    clientLog("error", "[Main] Catastrophic failure occurred during the application boot process", err)
  )
);

runClientUnscoped(bootstrapApp);
