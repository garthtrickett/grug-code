import { Context, Effect, Layer, Stream, Chunk } from "effect";
import { clientLog } from "./clientLog";

export interface ILocationService {
  readonly pathname: Stream.Stream<string>;
  readonly navigate: (path: string) => Effect.Effect<void>;
}

export class LocationService extends Context.Tag("app/LocationService")<
  LocationService,
  ILocationService
>() {}

export const LocationLive: Layer.Layer<LocationService> = Layer.sync(
  LocationService,
  () => {
    const implementation: ILocationService = {
      pathname: Stream.async<string>((emit) => {
        const emitPath = () =>
          void emit(Effect.succeed(Chunk.of(window.location.pathname)));

        const locationChangedHandler = () => {
          clientLog("debug", "Received custom 'location-changed' event.");
          emitPath();
        };

        window.addEventListener("popstate", emitPath);
        window.addEventListener("location-changed", locationChangedHandler);
        emitPath();

        return Effect.sync(() => {
          window.removeEventListener("popstate", emitPath);
          window.removeEventListener("location-changed", locationChangedHandler);
        });
      }).pipe(Stream.changes),

      navigate: (path: string) =>
        Effect.sync(() => {
          if (window.location.pathname === path) return;

          const doNavigation = () => {
            window.history.pushState({}, "", path);
            window.dispatchEvent(new CustomEvent("location-changed"));
          };
          
          if (document.startViewTransition) {
            const transition = document.startViewTransition(doNavigation);
            transition.ready.catch(() => {});
            transition.finished.catch(() => {});
            transition.updateCallbackDone.catch(() => {});
          } else {
            doNavigation();
          }
        }),
    };
    return implementation;
  },
);
