// File: ./src/lib/server/observability.ts
// ==============================================================================
import { Otlp } from "@effect/opentelemetry";
import { FetchHttpClient } from "@effect/platform";
import { Layer, Logger, LogLevel } from "effect";

const getLogLevelFromEnv = (): LogLevel.LogLevel => {
  const level = process.env.LOG_LEVEL?.toLowerCase() ?? "info";
  switch (level) {
    case "debug":
      return LogLevel.Debug;
    case "warn":
    case "warning":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "info":
    default:
      return LogLevel.Info;
  }
};

const logLevelLayer = Logger.minimumLogLevel(getLogLevelFromEnv());

// Safe conditional wrapper for OpenTelemetry
const makeObservabilityLayer = () => {
  // Disable OTel tracing by default in development/test/Tauri sidecar modes 
  // to avoid runtime exceptions in compiled binaries and missing collector environments.
  const enableOtlp = process.env.ENABLE_OTLP === "true" || process.env.NODE_ENV === "production";
  
  if (!enableOtlp) {
    return logLevelLayer;
  }

  try {
    const otlpProviderLayer = Otlp.layer({
      baseUrl: process.env.OTLP_BASE_URL || "http://localhost:4318",
      resource: {
        serviceName: "grug-code-backend",
        serviceVersion: "0.1.0",
      },
      loggerExportInterval: "1 second",
      tracerExportInterval: "5 seconds",
      metricsExportInterval: "10 seconds",
    });

    return otlpProviderLayer.pipe(
      Layer.provide(logLevelLayer),
      Layer.provide(FetchHttpClient.layer),
    );
  } catch (e) {
    console.error("[Observability] Failed to load OpenTelemetry layer synchronously:", e);
    return logLevelLayer;
  }
};

export const ObservabilityLive = makeObservabilityLayer().pipe(
  Layer.orElse(() => logLevelLayer)
);
