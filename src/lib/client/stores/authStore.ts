import { signal, computed } from "@preact/signals-core";
import { Effect } from "effect";
import { clientLog } from "../clientLog.ts";
import { runClientPromise } from "../runtime.ts";

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly display_name?: string | null;
  readonly avatar_url?: string | null;
  readonly permissions: string[];
}

const getSanitizedToken = (): string | null => {
  if (typeof localStorage === "undefined") return null;
  const t = localStorage.getItem("jwt");
  if (!t || t === "null" || t === "undefined" || t.trim() === "") return null;
  return t;
};

export const tokenState = signal<string | null>(getSanitizedToken());

export const userState = signal<UserProfile | null>(null);

export const loginErrorState = signal<string | null>(null);

export const signupErrorState = signal<string | null>(null);

export const isAuthenticated = computed(() => tokenState.value !== null);

export const initAuth = () => {
  const effect = Effect.gen(function* () {
    const token = tokenState.value;
    yield* clientLog("debug", `[AuthStore:initAuth] Initializing authentication. Raw token state: "${token}"`);
    if (!token) {
      yield* clientLog("info", "[AuthStore:initAuth] No valid token found during session initialization.");
      return;
    }

    yield* clientLog("info", "[AuthStore] Restoring session from storage...");

    const fetchResult = yield* Effect.tryPromise({
      try: () => {
        const apiBase = import.meta.env.VITE_API_BASE_URL || "";
        const url = apiBase ? `${apiBase}/api/auth/me` : "/api/auth/me";
        return fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      },
      catch: (e) => new Error(`Authorization check failed: ${String(e)}`),
    }).pipe(Effect.either);

    if (fetchResult._tag === "Left") {
      yield* clientLog(
        "warn",
        `[AuthStore] Network connection offline or server unreachable. Proceeding in offline mode: ${fetchResult.left.message}`
      );
      return;
    }

    const response = fetchResult.right;

    if (response.ok) {
      const dataResult = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ user: UserProfile }>,
        catch: (e) => new Error("Failed to parse user profile: " + String(e)),
      }).pipe(Effect.either);

      if (dataResult._tag === "Right") {
        userState.value = dataResult.right.user;
        yield* clientLog("info", "[AuthStore] Session recovered successfully: " + dataResult.right.user.email);
      } else {
        yield* clientLog("error", "[AuthStore] Failed to decode user profile: " + dataResult.left.message);
      }
    } else {
      yield* clientLog("warn", `[AuthStore] Restored token is expired or invalid (HTTP ${response.status}). Purging cache.`);
      logout();
    }
  });

  return effect;
};

export const login = (email: string, password: string) => {
  const effect = Effect.gen(function* () {
    loginErrorState.value = null;
    yield* clientLog("info", `[AuthStore] Dispatching login request: ${email}`);

    const response = yield* Effect.tryPromise({
      try: () => {
        const apiBase = import.meta.env.VITE_API_BASE_URL || "";
        const url = apiBase ? `${apiBase}/api/auth/login` : "/api/auth/login";
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
      },
      catch: (e) => new Error(`Auth request connection failed: ${String(e)}`),
    });

    yield* clientLog("debug", `[AuthStore:login] Login HTTP response status: ${response.status}`);

    if (!response.ok) {
      const errorResponse = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ error: string }>,
        catch: () => ({ error: "Unknown network error" }),
      });
      loginErrorState.value = errorResponse.error;
      yield* clientLog("error", `[AuthStore:login] Login rejected by server: ${errorResponse.error}`);
      return yield* Effect.fail(new Error(errorResponse.error));
    }

    const data = (yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ token: string; user: UserProfile }>,
      catch: (e) => e,
    }));

    yield* clientLog("debug", `[AuthStore:login] Parsed response data. Token present: ${!!data.token}, User present: ${!!data.user}`);

    tokenState.value = data.token;
    userState.value = data.user;
    localStorage.setItem("jwt", data.token);

    yield* clientLog("info", `[AuthStore] Session authenticated successfully for user: ${data.user?.email}`);

    yield* clientLog("debug", "[AuthStore:login] Dynamically importing router...");
    const { navigate } = yield* Effect.promise(() => import("../router.ts"));
    yield* clientLog("debug", "[AuthStore:login] Router imported. Triggering navigation to '/'...");
    yield* navigate("/");
    yield* clientLog("debug", "[AuthStore:login] Navigation effect triggered successfully.");
  });

  return effect;
};

export const signup = (email: string, password: string) => {
  const effect = Effect.gen(function* () {
    signupErrorState.value = null;
    yield* clientLog("info", `[AuthStore] Dispatching signup request: ${email}`);

    const response = yield* Effect.tryPromise({
      try: () => {
        const apiBase = import.meta.env.VITE_API_BASE_URL || "";
        const url = apiBase ? `${apiBase}/api/auth/signup` : "/api/auth/signup";
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
      },
      catch: (e) => new Error(`Signup connection failed: ${String(e)}`),
    });

    yield* clientLog("debug", `[AuthStore:signup] Signup HTTP response status: ${response.status}`);

    if (!response.ok) {
      const errorResponse = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ error: string }>,
        catch: () => ({ error: "Signup process failed" }),
      });
      signupErrorState.value = errorResponse.error;
      yield* clientLog("error", `[AuthStore:signup] Signup rejected by server: ${errorResponse.error}`);
      return yield* Effect.fail(new Error(errorResponse.error));
    }

    yield* clientLog("info", "[AuthStore] Account created successfully. Dynamically importing router for redirection...");
    const data = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ id: string; email: string }>,
      catch: (e) => new Error(`Failed to parse signup response: ${String(e)}`),
    });

    const { navigate } = yield* Effect.promise(() => import("../router.ts"));
    yield* clientLog("debug", "[AuthStore:signup] Router imported. Triggering navigation to '/login'...");
    yield* navigate("/login");
    yield* clientLog("debug", "[AuthStore:signup] Navigation to '/login' effect triggered successfully.");

    return data;
  });

  return effect;
};

export const logout = () => {
  tokenState.value = null;
  userState.value = null;
  localStorage.removeItem("jwt");
  void runClientPromise(clientLog("info", "[AuthStore] Session terminated. Navigating to login."));

  void import("../router.ts").then(({ navigate }) => {
    void runClientPromise(navigate("/login"));
  });
};
