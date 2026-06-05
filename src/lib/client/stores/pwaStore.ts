import { signal } from "@preact/signals-core";
import { Workbox } from "workbox-window";
import { clientLog } from "../clientLog";
import { runClientUnscoped } from "../runtime";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let wbInstance: Workbox | null = null;

export const installPromptState = signal<BeforeInstallPromptEvent | null>(null);
export const isAppInstalledState = signal<boolean>(false);
export const isUpdateAvailableState = signal<boolean>(false);

export const initPWA = () => {
    if (typeof window === "undefined") return;

  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) {
    isAppInstalledState.value = true;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    runClientUnscoped(clientLog("info", "[PWA] Installation trigger captured"));
    installPromptState.value = e as BeforeInstallPromptEvent;
  });

  window.addEventListener("appinstalled", () => {
    runClientUnscoped(clientLog("info", "[PWA] Application successfully installed"));
    installPromptState.value = null;
    isAppInstalledState.value = true;
  });

  // Register Service Worker in production mode
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    runClientUnscoped(clientLog("info", "[PWA] Registering production Service Worker..."));
    wbInstance = new Workbox("/sw.js");

    wbInstance.addEventListener("waiting", () => {
      runClientUnscoped(clientLog("info", "[PWA] New service worker is waiting. Update available!"));
      isUpdateAvailableState.value = true;
    });

    wbInstance.addEventListener("controlling", () => {
      runClientUnscoped(clientLog("info", "[PWA] New service worker has taken control. Reloading page..."));
      window.location.reload();
    });

    wbInstance.register().catch((err: unknown) => {
      runClientUnscoped(clientLog("error", "[PWA] Service worker registration failed", err));
    });
  }
};

export const promptInstall = async () => {
  const promptEvent = installPromptState.value;
  if (!promptEvent) return;

  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  runClientUnscoped(clientLog("info", `[PWA] Installation outcome: ${outcome}`));
  installPromptState.value = null;
};

export const applyAppUpdate =  () => {
  if (wbInstance) {
    runClientUnscoped(clientLog("info", "[PWA] Requesting waiting service worker to skip waiting..."));
    wbInstance.messageSkipWaiting();
  }
};
