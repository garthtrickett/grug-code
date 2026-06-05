import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { effect } from "@preact/signals-core";
import { Effect } from "effect";
import { signup, signupErrorState } from "../lib/client/stores/authStore.ts";
import { clientLog } from "../lib/client/clientLog.ts";
import { runClientUnscoped } from "../lib/client/runtime.ts";

@customElement("signup-view")
export class SignupView extends LitElement {
  private _disposeEffect?: () => void;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    signupErrorState.value = null;

    this._disposeEffect = effect(() => {
      void signupErrorState.value;
      this.requestUpdate();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disposeEffect?.();
  }

    private handleSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;

    runClientUnscoped(
      Effect.gen(function* () {
        yield* clientLog("info", `[SignupView] Submission received for email: ${email}`);
        yield* signup(email, password);
        yield* clientLog("info", `[SignupView] Signup success for email: ${email}`);
      }).pipe(
        Effect.catchAll((err: unknown) => {
          let msg = "Unknown signup error";
          if (err instanceof Error) {
            msg = err.message;
          } else if (err !== null && typeof err === "object" && "error" in err) {
            const errorObj = err;
            msg = String(errorObj.error);
          } else {
            msg = String(err);
          }
          return clientLog("error", `[SignupView] Signup operation failed: ${msg}`, { email, err });
        })
      )
    );
  }

  override render() {
    const error = signupErrorState.value;

    return html`
      <div class="flex min-h-[60vh] items-center justify-center px-4">
        <div class="w-full max-w-md space-y-6 bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md">
          <div class="space-y-2 text-center">
            <h1 class="text-2xl font-bold tracking-tight text-white">Create Account</h1>
            <p class="text-sm text-zinc-400">Get started with offline-first learning.</p>
          </div>

          ${error
            ? html`
                <div class="p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-xs text-center animate-fade-in">
                  ⚠️ ${error}
                </div>
              `
            : ""}
          
          <form @submit=${this.handleSubmit} class="space-y-4">
            <div class="space-y-1">
              <label for="email" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Email Address</label>
              <input 
                id="email" 
                name="email" 
                type="email" 
                required 
                placeholder="you@example.com" 
                class="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-600 text-sm"
              />
            </div>
            <div class="space-y-1">
              <label for="password" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Password</label>
              <input 
                id="password" 
                name="password" 
                type="password" 
                required 
                placeholder="••••••••" 
                class="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-600 text-sm"
              />
            </div>
            <button 
              type="submit" 
              class="w-full py-2 bg-zinc-100 hover:bg-white text-zinc-900 font-medium rounded text-sm transition-colors cursor-pointer"
            >
              Sign Up
            </button>
          </form>

          <div class="text-center text-sm">
            <span class="text-zinc-400">Already registered?</span>
            <a href="/login" class="font-medium text-zinc-250 hover:text-white transition-colors ml-1">Log in</a>
          </div>
        </div>
      </div>
    `;
  }
}
