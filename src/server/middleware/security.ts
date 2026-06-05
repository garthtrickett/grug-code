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

export const securityMiddleware = (app: Elysia) =>
  app.onBeforeHandle(({ request, set }) => {
    const token = request.headers.get("X-Grug-Token");
    if (token !== activeToken) {
      set.status = 401;
      return { error: "Unauthorized: Invalid or missing Grug Token" };
    }
  });
