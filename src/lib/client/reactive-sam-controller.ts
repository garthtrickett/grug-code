import { Effect, Fiber, Queue, Stream } from "effect";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { runClientUnscoped } from "./runtime";
import type { BaseClientContext } from "./runtime";
import { clientLog } from "./clientLog";

type Update<Model, Action> = (model: Model, action: Action) => Model;

type HandleAction<Model, Action, E, R> = (
  action: Action,
  model: Model,
  propose: (action: Action) => void,
) => Effect.Effect<void, E, R>;

export class ReactiveSamController<
  T extends ReactiveControllerHost,
  Model,
  Action,
  E,
  R extends BaseClientContext = BaseClientContext,
> implements ReactiveController
{
    private readonly _actionQueue = Effect.runSync(Queue.unbounded<Action>());
  private _mainFiber?: Fiber.RuntimeFiber<unknown, unknown>;
  public model: Model;

  constructor(
    private host: T,
    initialModel: Model,
    private update: Update<Model, Action>,
    private handleAction: HandleAction<Model, Action, E, R>,
  ) {
    this.model = initialModel;
    host.addController(this);
  }

  propose = (action: Action): void => {
    runClientUnscoped(Queue.offer(this._actionQueue, action));
  };

  private readonly _run = Stream.fromQueue(this._actionQueue).pipe(
    Stream.runForEach((action) => {
      this.model = this.update(this.model, action);
      this.host.requestUpdate();

      return this.handleAction(action, this.model, this.propose).pipe(
        Effect.catchAll((err) =>
          clientLog(
            "error",
            `[ReactiveSamController] Action processing failed for "${
              (action as { type: string }).type
            }"`,
            err,
          ),
        ),
      );
    }),
  );

  hostConnected() {
    this._mainFiber = runClientUnscoped(this._run);
  }

  hostDisconnected() {
    if (this._mainFiber) {
      runClientUnscoped(Fiber.interrupt(this._mainFiber));
    }
  }
}
