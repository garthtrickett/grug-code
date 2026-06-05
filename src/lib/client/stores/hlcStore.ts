import { signal } from "@preact/signals-core";
import { get, set, createStore } from "idb-keyval";
import { Effect } from "effect";
import { Hlc, packHlc, tickHlc, receiveHlc, initHlc } from "../../shared/hlc";
import { clientLog } from "../clientLog";

const DB_NAME = "bedrock-lang-hlc-v1";
const STORE_NAME = "hlc_metadata";
const hlcDBStore = createStore(DB_NAME, STORE_NAME);

const HLC_STATE_KEY = "hlc_state";

export const hlcSignal = signal<Hlc>({ physical: 0, counter: 0, nodeId: "initial" });

export const hlcStore = {
  load: () =>
    Effect.gen(function* () {
      yield* clientLog("debug", "[hlcStore] Loading local HLC state...");
      const cached = yield* Effect.tryPromise({
        try: () => get<Hlc>(HLC_STATE_KEY, hlcDBStore),
        catch: (e) => new Error(`Failed to load HLC state: ${String(e)}`),
      });

      if (cached) {
        hlcSignal.value = cached;
        yield* clientLog("debug", `[hlcStore] HLC state loaded: ${packHlc(cached)}`);
      } else {
        const nodeId = crypto.randomUUID();
        const initial = initHlc(nodeId, Date.now());
        yield* Effect.tryPromise({
          try: () => set(HLC_STATE_KEY, initial, hlcDBStore),
          catch: (e) => new Error(`Failed to save initial HLC state: ${String(e)}`),
        });
        hlcSignal.value = initial;
        yield* clientLog("info", `[hlcStore] Generated new stable nodeId and HLC: ${packHlc(initial)}`);
      }
    }),

  getPacked: () => packHlc(hlcSignal.peek()),

  tick: () =>
    Effect.gen(function* () {
      const current = hlcSignal.peek();
      const next = tickHlc(current, Date.now());
      yield* Effect.tryPromise({
        try: () => set(HLC_STATE_KEY, next, hlcDBStore),
        catch: (e) => new Error(`Failed to save ticked HLC state: ${String(e)}`),
      });
      hlcSignal.value = next;
      yield* clientLog("debug", `[hlcStore] Clock ticked: ${packHlc(next)}`);
      return packHlc(next);
    }),

  updateWithRemote: (remotePacked: string) =>
    Effect.gen(function* () {
      const current = hlcSignal.peek();
      const next = receiveHlc(current, remotePacked, Date.now());
      yield* Effect.tryPromise({
        try: () => set(HLC_STATE_KEY, next, hlcDBStore),
        catch: (e) => new Error(`Failed to save received HLC state: ${String(e)}`),
      });
      hlcSignal.value = next;
      yield* clientLog("debug", `[hlcStore] Clock updated with remote ${remotePacked}. New: ${packHlc(next)}`);
    }),

  clear: () =>
    Effect.gen(function* () {
      const nodeId = crypto.randomUUID();
      const initial = initHlc(nodeId, Date.now());
      yield* Effect.tryPromise({
        try: () => set(HLC_STATE_KEY, initial, hlcDBStore),
        catch: (e) => new Error(`Failed to clear HLC state: ${String(e)}`),
      });
      hlcSignal.value = initial;
    }),
};
