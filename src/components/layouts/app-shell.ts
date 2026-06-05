import { render, html } from "lit-html";
import { Stream, Effect, Fiber, Chunk } from "effect";
import { matchRoute } from "../../lib/client/router";
import { clientLog } from "../../lib/client/clientLog";
import { runClientUnscoped, runClientPromise } from "../../lib/client/runtime";
import { LocationService } from "../../lib/client/LocationService";
import "./AppLayout";

const processStateChange = (
  appRoot: HTMLElement,
  { path }: { path: string },
) =>
  Effect.gen(function* () {
    yield* clientLog("info", "[app-shell] state change evaluated", { path });

    const route = yield* matchRoute(path);
    const { template: pageTemplate } = route.view(...route.params);

    yield* Effect.sync(() =>
      render(
        html`
          <app-layout
            .content=${pageTemplate}
            .currentPath=${path}
          ></app-layout>
        `,
        appRoot,
      ),
    );
  });

export class AppShell extends HTMLElement {
  private mainFiber?: Fiber.RuntimeFiber<unknown, unknown>;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    const mainAppStream = Stream.async<{ path: string }>((emit) => {
      const locationEffect = Effect.gen(function* () {
        const location = yield* LocationService;
                yield* Stream.runForEach(location.pathname, (path) => {
          void emit(Effect.succeed(Chunk.of({ path })));
          return Effect.void;
        });
      });
      runClientUnscoped(locationEffect);
    }).pipe(
      Stream.flatMap(
        (state) => Stream.fromEffect(processStateChange(this, state)),
        { switch: true },
      ),
    );

    this.mainFiber = runClientUnscoped(Stream.runDrain(mainAppStream));
  }

  disconnectedCallback() {
    if (this.mainFiber) {
      void runClientPromise(Fiber.interrupt(this.mainFiber));
    }
  }
}

customElements.define("app-shell", AppShell);
