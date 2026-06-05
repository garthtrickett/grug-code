import { signal, type Signal } from "@preact/signals-core";
import { createStore, get, set, del } from "idb-keyval";
import { Effect } from "effect";
import { clientLog } from "../clientLog";

const DB_NAME = "bedrock-lang-storage-v1";
const STORE_NAME = "collections";
const localDBStore = createStore(DB_NAME, STORE_NAME);

export interface LocalStore<T> {
  readonly state: Signal<T[]>;
  readonly load: () => Effect.Effect<void, Error>;
  readonly put: (item: T) => Effect.Effect<void, Error>;
  readonly putAll: (items: T[]) => Effect.Effect<void, Error>;
  readonly remove: (id: string) => Effect.Effect<void, Error>;
  readonly clear: () => Effect.Effect<void, Error>;
}

export interface Identifiable {
  readonly id: string;
}

export function createLocalStore<T extends Identifiable>(
  collectionName: string,
  sortFn?: (a: T, b: T) => number
): LocalStore<T> {
  const state = signal<T[]>([]);
  const storageKey = `store:${collectionName}`;

  const load = () =>
    Effect.gen(function* () {
      yield* clientLog("debug", `[LocalStore:${collectionName}] Hydrating from IndexedDB...`);
      const cached = yield* Effect.tryPromise({
        try: () => get<T[]>(storageKey, localDBStore),
        catch: (e) => new Error(`Failed to read collection ${collectionName}: ${String(e)}`),
      });

      const items = cached || [];
      if (sortFn) {
        items.sort(sortFn);
      }
      state.value = items;
      yield* clientLog("debug", `[LocalStore:${collectionName}] Hydrated ${items.length} items.`);
    });

  const put = (item: T) =>
    Effect.gen(function* () {
      const current = [...state.peek()];
      const index = current.findIndex((i) => i.id === item.id);
      
      if (index !== -1) {
        current[index] = item;
      } else {
        current.push(item);
      }

      if (sortFn) {
        current.sort(sortFn);
      }

      yield* Effect.tryPromise({
        try: () => set(storageKey, current, localDBStore),
        catch: (e) => new Error(`Failed to write item to ${collectionName}: ${String(e)}`),
      });

      state.value = current;
    });

  const putAll = (items: T[]) =>
    Effect.gen(function* () {
      const current = [...state.peek()];
      
      for (const item of items) {
        const index = current.findIndex((i) => i.id === item.id);
        if (index !== -1) {
          current[index] = item;
        } else {
          current.push(item);
        }
      }

      if (sortFn) {
        current.sort(sortFn);
      }

      yield* Effect.tryPromise({
        try: () => set(storageKey, current, localDBStore),
        catch: (e) => new Error(`Failed to batch write items to ${collectionName}: ${String(e)}`),
      });

      state.value = current;
    });

  const remove = (id: string) =>
    Effect.gen(function* () {
      const filtered = state.peek().filter((i) => i.id !== id);

      yield* Effect.tryPromise({
        try: () => set(storageKey, filtered, localDBStore),
        catch: (e) => new Error(`Failed to delete item ${id} from ${collectionName}: ${String(e)}`),
      });

      state.value = filtered;
    });

  const clear = () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => del(storageKey, localDBStore),
        catch: (e) => new Error(`Failed to clear collection ${collectionName}: ${String(e)}`),
      });
      state.value = [];
    });

  return {
    state,
    load,
    put,
    putAll,
    remove,
    clear,
  };
}
