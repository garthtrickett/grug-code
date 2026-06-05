import { signal } from "@preact/signals-core";

export const isOnlineState = signal<boolean>(
  typeof navigator !== "undefined" ? navigator.onLine : true
);

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    isOnlineState.value = true;
  });
  window.addEventListener("offline", () => {
    isOnlineState.value = false;
  });
}
