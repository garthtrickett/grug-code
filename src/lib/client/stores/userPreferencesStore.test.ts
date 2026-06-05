import { describe, it, expect, beforeEach } from "vitest";
import { userPreferencesStore } from "./userPreferencesStore.ts";
import { runClientPromise } from "../runtime.ts";

describe("userPreferencesStore Default Fallbacks", () => {
    beforeEach(async () => {
    // Clear out the state to simulate a fresh, offline-first load
    await runClientPromise(userPreferencesStore.clear());
  });

    it("should fall back to a daily review limit of 20, daily new rule limit of 3, and enforceMasteryGates of true when uninitialized", () => {
    expect(userPreferencesStore.dailyReviewLimit.value).toBe(20);
    expect(userPreferencesStore.dailyNewRuleLimit.value).toBe(3);
    expect(userPreferencesStore.enforceMasteryGates.value).toBe(true);
  });

    it("should initialize settings store with 20, 3, and true on first load if settings are empty", async () => {
    await runClientPromise(userPreferencesStore.load());
    expect(userPreferencesStore.dailyReviewLimit.value).toBe(20);
    expect(userPreferencesStore.dailyNewRuleLimit.value).toBe(3);
    expect(userPreferencesStore.enforceMasteryGates.value).toBe(true);
  });

  it("should update and persist custom values including enforceMasteryGates when updateLimits is called", async () => {
    await runClientPromise(userPreferencesStore.load());
    await runClientPromise(userPreferencesStore.updateLimits(40, 5, false));
    expect(userPreferencesStore.dailyReviewLimit.value).toBe(40);
    expect(userPreferencesStore.dailyNewRuleLimit.value).toBe(5);
    expect(userPreferencesStore.enforceMasteryGates.value).toBe(false);
  });
});
