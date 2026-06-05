import { signal } from "@preact/signals-core";
import { Effect } from "effect";
import * as select from "@zag-js/select";
import { VanillaMachine } from "@zag-js/vanilla";
import { clientLog } from "../clientLog";

export const directoriesSignal = signal<readonly string[]>([]);
export const selectedScopeSignal = signal<string>("");

export const fetchWorkspaceDirectories = (cwd?: string) =>
  Effect.gen(function* () {
    yield* clientLog("info", "[directoryStore] Fetching workspace directories...");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const { grugTokenState } = yield* Effect.promise(() => import("./taskStore"));
    const token = grugTokenState.value;
    if (token) {
      headers["X-Grug-Token"] = token;
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("/api/workspace/directories", {
          method: "POST",
          headers,
          body: JSON.stringify({ cwd }),
        }),
      catch: (e) => new Error(`Failed to fetch directories from server: ${String(e)}`),
    });

    if (!response.ok) {
      return yield* Effect.fail(new Error(`Failed to fetch directories: HTTP ${response.status}`));
    }

    const data = yield* Effect.tryPromise({
      try: () => response.json() as Promise<readonly string[]>,
      catch: (e) => new Error(`Failed to parse directories data: ${String(e)}`),
    });

    directoriesSignal.value = data;
    yield* clientLog("debug", `[directoryStore] Subdirectories hydrated: ${data.length} items`);
    return data;
  });

export const createDirectorySelectMachine = (items: readonly string[], onSelect: (val: string) => void) => {
  const collection = select.collection({
    items: [...items],
    itemToString: (item) => item,
    itemToValue: (item) => item,
  });

  return new VanillaMachine(select.machine, {
    id: "directory-select",
    collection,
        onValueChange(details: select.ValueChangeDetails<string>) {
      const selectedValue = details.value[0] || "";
      onSelect(selectedValue);
    },
  });
};
