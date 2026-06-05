import { Effect } from "effect";
import { runClientUnscoped } from "./lib/client/runtime.ts";
import { clientLog } from "./lib/client/clientLog.ts";
import { initializeGrugToken } from "./lib/client/stores/taskStore.ts";

// Register custom elements
import "./components/layouts/app-shell.ts";

const bootstrapApp = Effect.gen(function* () {
  // Extract and scrub security tokens on early page instantiation before any APIs run
  yield* Effect.sync(() => {
    initializeGrugToken();
  });

  yield* clientLog("info", "[Main] Initiating Grug Code bootstrap sequence...");

  // 1. Hydrate local HLC state to ensure clock validity during early mutations
  yield* clientLog("info", "[Main] Hydrating local HLC state from IndexedDB...");
  const { hlcStore } = yield* Effect.promise(() => import("./lib/client/stores/hlcStore.ts"));
  yield* hlcStore.load();
  yield* clientLog("debug", `[Main] HLC state hydrated: hlc=${hlcStore.getPacked()}`);

  // 3. Hydrate User Preferences storage from IndexedDB
  yield* clientLog("info", "[Main] Hydrating User Preferences storage from IndexedDB...");
  const { userPreferencesStore } = yield* Effect.promise(() => import("./lib/client/stores/userPreferencesStore.ts"));
  yield* userPreferencesStore.load();
  yield* clientLog("debug", `[Main] User preferences hydrated: reviewLimit=${userPreferencesStore.dailyReviewLimit.value}`);

  // 4. Attempt session restoration
  const { initAuth } = yield* Effect.promise(() => import("./lib/client/stores/authStore.ts"));
  yield* clientLog("info", "[Main] Attempting session restoration...");
  yield* initAuth();

  yield* clientLog("info", "[Main] Application successfully bootstrapped.");
}).pipe(
  Effect.catchAll((err) =>
    clientLog("error", "[Main] Catastrophic failure occurred during the application boot process", err)
  )
);

runClientUnscoped(bootstrapApp);
