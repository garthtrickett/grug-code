import * as os from "node:os";
import * as path from "node:path";

const getEnvOrDefault = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

export const config = {
  gemini: {
    apiKey: getEnvOrDefault("GEMINI_API_KEY", ""),
  },
  openai: {
    apiKey: getEnvOrDefault("OPENAI_API_KEY", ""),
  },
  deepseek: {
    apiKey: getEnvOrDefault("DEEPSEEK_API_KEY", ""),
  },
  surgical: {
    fileLimit: parseInt(getEnvOrDefault("SURGICAL_ROUTER_FILE_LIMIT", "3"), 10),
    tokenLimit: parseInt(getEnvOrDefault("SURGICAL_ROUTER_TOKEN_LIMIT", "20000"), 10),
    socketPath: getEnvOrDefault("SURGICAL_ROUTER_SOCKET_PATH", (() => {
      try {
        return path.join(os.tmpdir(), "grug.sock");
      } catch {
        return "/tmp/grug.sock";
      }
    })()),
  },
};