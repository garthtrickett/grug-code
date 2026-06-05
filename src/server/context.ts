import { Elysia } from "elysia";
import { db } from "../db/client";

export const userContext = (app: Elysia) => app.derive(({ request }) => {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  return {
    user: token ? { id: "mock-id", email: "mock@site.com", permissions: [] } : null,
    currentRole: "SUBSCRIBER",
    tenant: { id: "default-tenant", name: "Default Space", subdomain: "ja" },
    userDb: db,
  };
});
