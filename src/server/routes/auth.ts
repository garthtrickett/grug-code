import { Elysia } from "elysia";
import { userContext } from "../context.ts";
import { loginRoute } from "./auth/login.ts";
import { signupRoute } from "./auth/signup.ts";
import { verifyRoute } from "./auth/verify.ts";
import { passwordRoutes } from "./auth/password.ts";
import { effectPlugin } from "../middleware/effect-plugin.ts";

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  .use(effectPlugin)
  .use(loginRoute)
  .use(signupRoute)
  .use(verifyRoute)
  .use(passwordRoutes)
  .use(userContext)
  .get("/me", ({ user, tenant, currentRole, set }: { user: unknown; tenant: unknown; currentRole: string; set: { status?: number | string | undefined } }) => {
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return {
      user,
      tenant,      
      role: currentRole 
    };
  });
