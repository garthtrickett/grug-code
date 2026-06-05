import * as fs from "node:fs";
import { Elysia } from "elysia";

const SESSION_FILE = ".grug-session.json";

export const generateGrugSessionToken = (): string => {
  const token = crypto.randomUUID();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ token }, null, 2), "utf-8");
  return token;
};

export const loadGrugSessionToken = (): string => {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const fileContent = fs.readFileSync(SESSION_FILE, "utf-8");
      const data = JSON.parse(fileContent) as unknown;
      if (
        data &&
        typeof data === "object" &&
        "token" in data &&
        typeof (data).token === "string"
      ) {
        return (data as { token: string }).token;
      }
    }
  } catch {
    // Fallback if parsing fails
  }
  return generateGrugSessionToken();
};

const activeToken = loadGrugSessionToken();

export const getActiveToken = () => activeToken;

const isLoopbackHost = (host: string | null): boolean => {
  if (!host) return false;
  const hostName = host.split(":")[0]?.toLowerCase() || "";
  return hostName === "localhost" || hostName === "127.0.0.1" || hostName === "[::1]" || hostName === "::1";
};

const isLoopbackOrigin = (origin: string | null): boolean => {
  if (!origin) return true; // Non-CORS direct requests are permitted
  try {
    const url = new URL(origin);
    const hostName = url.hostname.toLowerCase();
    return hostName === "localhost" || hostName === "127.0.0.1" || hostName === "[::1]" || hostName === "::1";
  } catch {
    return false;
  }
};

export const securityMiddleware = (app: Elysia) =>
  app.onBeforeHandle(({ request, set }) => {
    let host = request.headers.get("host");
    if (!host && request.url) {
      try {
        host = new URL(request.url).host;
      } catch {
        host = null;
      }
    }
    const origin = request.headers.get("origin");
    const method = request.method;

    const isStateChanging = ["POST", "PUT", "DELETE", "PATCH"].includes(method);

    // Double-gated loopback check to protect workspace from DNS rebinding and cross-site scripting
    if (isStateChanging) {
      if (!isLoopbackHost(host) || !isLoopbackOrigin(origin)) {
        console.warn(`[Security] Blocked non-loopback state-changing request on method ${method}. Host: ${host}, Origin: ${origin}`);
        set.status = 403;
        return { error: "Forbidden: External request origin or host detected on sensitive loopback operations" };
      }
    }

    const token = request.headers.get("X-Grug-Token");
    if (token !== activeToken) {
      set.status = 401;
      return { error: "Unauthorized: Invalid or missing Grug Token" };
    }
  });
