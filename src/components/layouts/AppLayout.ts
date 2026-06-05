import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { effect } from "@preact/signals-core";
import { localeState, t } from "../../lib/client/stores/i18nStore";
import { isUpdateAvailableState, applyAppUpdate } from "../../lib/client/stores/pwaStore.ts";

@customElement("app-layout")
export class AppLayout extends LitElement {
  @property({ attribute: false })
  content?: TemplateResult;

  @property({ type: String })
  currentPath = "";

  private _disposeEffect?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this._disposeEffect = effect(() => {
      void localeState.value;
      void isUpdateAvailableState.value;
      this.requestUpdate();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disposeEffect?.();
  }

  protected override createRenderRoot() {
    return this; 
  }

  override render() {
    return html`
      <div class="flex h-screen flex-col overflow-hidden bg-zinc-900 text-zinc-100 font-sans">
        <header class="z-10 flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-4 shadow-md">
          <div class="flex items-center gap-4">
            <a href="/" class="text-lg font-bold text-zinc-50 tracking-tight hover:text-white transition-colors">Bedrock Lang</a>
          </div>
          <div class="flex items-center gap-4 text-sm font-medium text-zinc-400">
            <span>${t("common.language")}: ${localeState.value.toUpperCase()}</span>
          </div>
        </header>

        <div class="relative flex flex-1 min-h-0">
          <div class="flex min-w-0 flex-1 flex-col bg-zinc-900">
            <main class="flex-1 overflow-auto p-6">
              ${this.content}
            </main>
          </div>
        </div>

        <!-- Controlled Update Prompt Toast -->
        ${isUpdateAvailableState.value
          ? html`
              <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-950/95 p-4 shadow-xl backdrop-blur-sm animate-fade-in max-w-md w-full mx-4">
                <span class="text-2xl">⚡</span>
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-semibold text-white">Update Available</h4>
                  <p class="text-xs text-zinc-400 mt-0.5">A new version is ready. Click below to upgrade.</p>
                </div>
                <button
                  @click=${() => { void applyAppUpdate(); }}
                  class="shrink-0 px-3.5 py-1.5 bg-green-650 hover:bg-green-600 active:bg-green-700 text-white font-bold rounded text-xs transition-colors cursor-pointer"
                >
                  Reload
                </button>
              </div>
            `
          : ""}
      </div>
    `;
  }
}
