import { signal, computed } from "@preact/signals-core";
import { Effect } from "effect";

export interface UserPreferences {
  readonly dailyReviewLimit: number;
  readonly dailyNewRuleLimit: number;
  readonly enforceMasteryGates: boolean;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  dailyReviewLimit: 20,
  dailyNewRuleLimit: 3,
  enforceMasteryGates: true,
};

const getStoredPreferences = (): UserPreferences => {
  if (typeof localStorage === "undefined") return DEFAULT_PREFERENCES;
  const stored = localStorage.getItem("grug-user-preferences");
  if (!stored) return DEFAULT_PREFERENCES;
  try {
    return JSON.parse(stored) as UserPreferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
};

const preferencesSignal = signal<UserPreferences>(getStoredPreferences());

export const userPreferencesStore = {
  load: () =>
    Effect.gen(function* () {
      const prefs = getStoredPreferences();
      preferencesSignal.value = prefs;
    }),

  updateLimits: (dailyReviewLimit: number, dailyNewRuleLimit: number, enforceMasteryGates: boolean = true) =>
    Effect.gen(function* () {
      const updated: UserPreferences = {
        dailyReviewLimit,
        dailyNewRuleLimit,
        enforceMasteryGates,
      };
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-user-preferences", JSON.stringify(updated));
      }
      preferencesSignal.value = updated;
    }),

  clear: () =>
    Effect.gen(function* () {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("grug-user-preferences");
      }
      preferencesSignal.value = DEFAULT_PREFERENCES;
    }),

  dailyReviewLimit: computed(() => preferencesSignal.value.dailyReviewLimit),
  dailyNewRuleLimit: computed(() => preferencesSignal.value.dailyNewRuleLimit),
  enforceMasteryGates: computed(() => preferencesSignal.value.enforceMasteryGates),
};
