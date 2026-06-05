import { Otlp } from "@effect/opentelemetry";
import { FetchHttpClient } from "@effect/platform";
import { Layer, Logger, LogLevel } from "effect";

const getLogLevelFromEnv = (): LogLevel.LogLevel => {
  const level = process.env.LOG_LEVEL?.toLowerCase() ?? "info";
  switch (level) {
    case "debug":
      return LogLevel.Debug;
    case "warn":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "info":
    default:
      return LogLevel.Info;
  }
};

const otlpProviderLayer = Otlp.layer({
  baseUrl: process.env.OTLP_BASE_URL || "http://localhost:4318",
  resource: {
    serviceName: "bedrock-lang-backend",
    serviceVersion: "0.1.0",
  },
  loggerExportInterval: "1 second",
  tracerExportInterval: "5 seconds",
  metricsExportInterval: "10 seconds",
});

const logLevelLayer = Logger.minimumLogLevel(getLogLevelFromEnv());

export const ObservabilityLive = otlpProviderLayer.pipe(
  Layer.provide(logLevelLayer),
  Layer.provide(FetchHttpClient.layer),
);
