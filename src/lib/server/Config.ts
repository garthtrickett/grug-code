// File: src/lib/server/Config.ts
// ==============================================================================
import * as path from "node:path";
import * as fs from "node:fs";

// Zero-dependency, upwards .env file locator to support executing the sidecar
// from any subdirectory while reading the root workspace environment keys
const loadEnvUpwards = () => {
  try {
    let dir = process.env.WORKSPACE_ROOT || process.cwd();
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
            let val = trimmed.slice(eqIdx + 1).trim();
            
            // Remove trailing inline comments if present
            let cleanVal = "";
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = 0; i < val.length; i++) {
              const char = val[i];
              if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
              } else if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
              } else if (char === "#" && !inSingleQuote && !inDoubleQuote) {
                break;
              }
              cleanVal += char;
            }
            val = cleanVal.trim();

            if (key && process.env[key] === undefined) {
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

const getEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getEnvOrDefault = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

export const config = {
  db: {
    url: getEnv("DATABASE_URL"),
  },
  s3: {
    bucketName: getEnvOrDefault("BUCKET_NAME", "life-io"),
    publicAvatarUrl: getEnvOrDefault("PUBLIC_AVATAR_URL", "http://localhost:9000/life-io"),
    endpointUrl: getEnvOrDefault("AWS_ENDPOINT_URL_S3", "http://localhost:9000"),
    accessKeyId: getEnvOrDefault("AWS_ACCESS_KEY_ID", "minioadmin"),
    secretAccessKey: getEnvOrDefault("AWS_SECRET_ACCESS_KEY", "minioadmin"),
    region: getEnvOrDefault("AWS_REGION", "us-east-1"),
    forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === "true" || process.env.AWS_FORCE_PATH_STYLE === undefined,
  },
  app: {
    nodeEnv: process.env.NODE_ENV || "development",
    isProduction: process.env.NODE_ENV === "production",
    rootDomain: process.env.ROOT_DOMAIN || "life-io.xyz",
  },
  jwt: {
    secret: getEnvOrDefault("JWT_SECRET", "Few4D1oru8s1GEZJY2mmg1hjdC2nszByiLuUba1bcbA="),
  },
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
    surgicalRouterEnabled: getEnvOrDefault("SURGICAL_ROUTER_ENABLED", "true") === "true",
    fileLimit: parseInt(getEnvOrDefault("SURGICAL_ROUTER_FILE_LIMIT", "3"), 10),
    tokenLimit: parseInt(getEnvOrDefault("SURGICAL_ROUTER_TOKEN_LIMIT", "20000"), 10),
    socketPath: getEnvOrDefault("SURGICAL_ROUTER_SOCKET_PATH", "/tmp/grug-mcp.sock"),
  },
};
