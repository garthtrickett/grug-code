import type { ReactiveController, ReactiveControllerHost } from "lit";

type Update<Model, Action> = (model: Model, action: Action) => Model;

export class SamController<T extends ReactiveControllerHost, Model, Action>
  implements ReactiveController
{
  public model: Model;

  constructor(
    private host: T,
    initialModel: Model,
    private update: Update<Model, Action>,
  ) {
    this.model = initialModel;
    host.addController(this);
  }

  propose = (action: Action): void => {
    this.model = this.update(this.model, action);
    this.host.requestUpdate();
  };

  hostConnected() {}
  hostDisconnected() {}
}
