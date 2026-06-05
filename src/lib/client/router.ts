import { Effect } from "effect";
import { html, type TemplateResult } from "lit-html";
import { clientLog } from "./clientLog.ts";
import { LocationService } from "./LocationService.ts";
import "../../components/LoginView.ts";
import "../../components/SignupView.ts";
import "../../components/GrugTaskBoard.ts";

const NotFoundView = (): ViewResult => ({
  template: html`
    <div class="flex flex-col items-center justify-center min-h-[50vh] text-center">
      <h1 class="text-3xl font-bold mb-2">404</h1>
      <p class="text-zinc-400">Page Not Found</p>
    </div>
  `
});

export interface ViewResult {
  template: TemplateResult;
  cleanup?: () => void;
}

export interface Route {
  pattern: RegExp;
  view: (...args: string[]) => ViewResult;
  meta: {
    requiresAuth?: boolean;
    isPublicOnly?: boolean;
  };
}

type MatchedRoute = Route & { params: string[] };

const homeView = (): ViewResult => {
  return {
    template: html`
      <div class="space-y-6">
        <div class="max-w-xl mx-auto py-4 text-center">
          <h1 class="text-2xl font-bold text-white tracking-tight flex items-center justify-center gap-2">
            <span>🥟</span> Grug Code Companion
          </h1>
        </div>
        <grug-task-board></grug-task-board>
      </div>
    `
  };
};

const loginView = (): ViewResult => {
  return {
    template: html`<login-view></login-view>`
  };
};

const signupView = (): ViewResult => {
  return {
    template: html`<signup-view></signup-view>`
  };
};

const routes: Route[] = [
  {
    pattern: /^\/$/,
    view: homeView,
    meta: { requiresAuth: true },
  },
  {
    pattern: /^\/login$/,
    view: loginView,
    meta: { isPublicOnly: true },
  },
  {
    pattern: /^\/signup$/,
    view: signupView,
    meta: { isPublicOnly: true },
  }
];

export const matchRoute = (path: string): Effect.Effect<MatchedRoute, never, LocationService> =>
  Effect.gen(function* () {
    const cleanPath = path.split('?')[0] || "/";
    yield* clientLog("debug", `[Router] Matching route for path: ${cleanPath}`);
    const { tokenState } = yield* Effect.promise(() => import("./stores/authStore.ts"));
    const isLoggedIn = tokenState.value !== null;
    yield* clientLog("debug", `[Router] User authentication status: isLoggedIn=${isLoggedIn}`);

    let matched: Route | null = null;
    let params: string[] = [];

    for (const route of routes) {
      const match = cleanPath.match(route.pattern);
      if (match) {
        matched = route;
        params = match.slice(1).filter(Boolean);
        break;
      }
    }

    if (!matched) {
      yield* clientLog("warn", `[Router] No route matched for: ${cleanPath}. Redirecting to 404.`);
      return { pattern: /^\/404$/, view: NotFoundView, meta: {}, params: [] };
    }

    // Redirect to login if route requires authentication and user is not logged in
    if (matched.meta.requiresAuth && !isLoggedIn) {
      yield* clientLog("info", "[Router] Route requires authentication. Redirecting to /login.");
      const location = yield* LocationService;
      yield* location.navigate("/login");
      return {
        pattern: /^\/login$/,
        view: loginView,
        meta: { isPublicOnly: true },
        params: []
      };
    }

    // Redirect to home if route is public-only and user is logged in
    if (matched.meta.isPublicOnly && isLoggedIn) {
      yield* clientLog("info", "[Router] Route is public-only and user is authenticated. Redirecting to /.");
      const location = yield* LocationService;
      yield* location.navigate("/");
      return {
        pattern: /^\/$/,
        view: homeView,
        meta: { requiresAuth: true },
        params: []
      };
    }

    yield* clientLog("debug", `[Router] Successfully matched route with pattern: ${String(matched.pattern)}`);
    return { ...matched, params };
  });

export const navigate = (
  path: string,
): Effect.Effect<void, Error, LocationService> =>
  Effect.gen(function* () {
    yield* clientLog("info", `Navigating route path: ${path}`, undefined, "router");
    const location = yield* LocationService;
    yield* location.navigate(path);
  });
