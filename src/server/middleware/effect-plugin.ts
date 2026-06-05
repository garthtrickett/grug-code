import { Elysia } from "elysia";
import { Effect, Tracer, Context } from "effect";
import { serverRuntime } from "../../lib/server/server-runtime";

const getParentSpanContext = (
  headers: Headers,
): Tracer.ExternalSpan | undefined => {
  const traceParent = headers.get("traceparent");
  if (!traceParent) return undefined;

  const parts = traceParent.split("-");
  if (parts.length < 4) return undefined;

  const [_version, traceId, spanId, flags] = parts as [string, string, string, string];

  if (!traceId || !spanId) return undefined;

  return {
    _tag: "ExternalSpan",
    traceId,
    spanId,
    sampled: flags === "01",
    context: Context.empty(),
  };
};

export const effectPlugin = (app: Elysia) => app.derive(
  { as: "global" },
  ({ request }) => {
    return {
      runEffect: <A, E>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effect: Effect.Effect<A, E, any>,
        options?: { name?: string; attributes?: Record<string, unknown> },
      ): Promise<A> => {
        const method = request.method;
        const url = new URL(request.url);
        const spanName = options?.name || `HTTP ${method} ${url.pathname}`;

        const parentContext = getParentSpanContext(request.headers);

        const instrumentedEffect = Effect.makeSpan(spanName, {
          kind: "server",
          attributes: {
            "http.method": method,
            "http.url": request.url,
            "http.path": url.pathname,
            ...options?.attributes,
          },
          parent: parentContext,
        }).pipe(
          Effect.flatMap((span) =>
            effect.pipe(
              Effect.annotateLogs("traceId", span.traceId),
              Effect.annotateLogs("spanId", span.spanId),
            ),
          ),
        );

        return serverRuntime.runPromise(
          instrumentedEffect as unknown as Effect.Effect<A, E, never>,
        );
      },
    };
  },
);
