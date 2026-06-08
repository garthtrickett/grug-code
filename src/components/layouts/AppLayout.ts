import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { effect } from "@preact/signals-core";
import { localeState, t } from "../../lib/client/stores/i18nStore";


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
            <a href="/" class="text-lg font-bold text-zinc-50 tracking-tight hover:text-white transition-colors">Grug Code</a>
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

        
      </div>
    `;
  }
}
