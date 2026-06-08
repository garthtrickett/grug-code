import { signal } from "@preact/signals-core";
import { Effect } from "effect";
import * as select from "@zag-js/select";
import { VanillaMachine } from "@zag-js/vanilla";
import { clientLog } from "../clientLog";
import { McpClientService } from "../McpClientService.ts";

export const directoriesSignal = signal<readonly string[]>([]);
export const selectedScopeSignal = signal<string>("");

export const fetchWorkspaceDirectories = (cwd?: string) =>
  Effect.gen(function* () {
    yield* clientLog("info", "[directoryStore] Fetching workspace directories via MCP...");
    const mcp = yield* McpClientService;

    const responseResult = yield* mcp.callTool("list_directories", { cwd }).pipe(Effect.either);

    if (responseResult._tag === "Left") {
      return yield* Effect.fail(new Error(`Failed to fetch directories: ${responseResult.left.message}`));
    }

        const res = responseResult.right;
    const firstContent = res.content[0];
    const text = firstContent?.text;
    if (!text) {
      return yield* Effect.fail(new Error("Failed to parse directories: empty response"));
    }

    const data = (JSON.parse(text) as unknown) as readonly string[];
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
