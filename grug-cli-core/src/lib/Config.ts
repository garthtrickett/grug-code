import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// Zero-dependency, upwards .env file locator to support executing the CLI
// from any subdirectory while reading the root workspace environment keys
const loadEnvUpwards = () => {
  try {
    let dir = process.cwd();
    while (true) {
      const envPath = path.join(dir, ".env");
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key && !process.env[key]) {
              // Strip enclosing single or double quotes if present
              process.env[key] = val.replace(/^["']|["']$/g, "");
            }
          }
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (e) {
    console.warn("[Config] Non-fatal error loading .env upwards:", e);
  }
};

loadEnvUpwards();

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
  },
  network: {
    daemonPort: parseInt(getEnvOrDefault("DAEMON_PORT", "3010"), 10),
  },
};
