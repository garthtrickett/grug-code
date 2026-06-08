import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, ManagedRuntime, Layer } from "effect";
import { z } from "zod";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "./features/ResearchLoop.ts";
import { AiServiceLive } from "./lib/AiService.ts";
import { TreeSitterParserLive } from "./lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "./features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "./lib/TokenEstimator.ts";

// Prevent global stdout logging from corrupting standard JSON-RPC streams
console.info = (...args: unknown[]) => {
  console.error("[Redirected stdout]:", ...args);
};

const DaemonLive = SurgicalRouterLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectStructureMapperLive,
      ResearchLoopLive,
      AiServiceLive,
      TreeSitterParserLive,
      TokenEstimatorLive
    )
  )
);

const daemonRuntime = ManagedRuntime.make(DaemonLive);

export const server = new McpServer({
  name: "grug-code-mcp",
  version: "0.1.0",
});

server.tool(
  "grug_map_project",
  "Recursively lists all files in the project workspace, ignoring standard dependency folders.",
  {
    cwd: z.string().optional().describe("Root directory path of the workspace to index")
  },
  async ({ cwd }) => {
    const effect = Effect.flatMap(ProjectStructureMapper, (mapper) =>
      mapper.mapProject({ cwd })
    );
    const result = await daemonRuntime.runPromise(Effect.either(effect));
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.right }],
    };
  }
);

server.tool(
  "grug_skeletal_research",
  "Executes the Stage 1 skeletal pre-planning research loop to scan candidate signatures and build task checklists.",
  {
    userPrompt: z.string().describe("User prompt describing the desired code change or feature implementation"),
    projectStructure: z.string().describe("A JSON-encoded string array containing files representing active project mapping"),
    cwd: z.string().optional().describe("Root directory path of the active project workspace"),
    provider: z.enum(["gemini", "openai", "deepseek"]).optional().default("openai").describe("LLM provider to execute the planning loop"),
    mode: z.enum(["standard", "discussion"]).optional().default("standard").describe("Select standard autopilot planning or interactive advisory discussion mode"),
    history: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string()
      })
    ).optional().default([]).describe("Conversation Turn History array used in advisory discussion mode")
  },
  async ({ userPrompt, projectStructure, cwd, provider, mode, history }) => {
    const effect = Effect.flatMap(ResearchLoop, (loop) =>
      loop.run({
        userPrompt,
        projectStructure,
        cwd,
        provider,
        mode,
        history,
      })
    );
    const result = await daemonRuntime.runPromise(Effect.either(effect));
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

if (import.meta.main) {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("[Daemon] Stdio server connected successfully.");
  }).catch((err) => {
    console.error("[Daemon] Stdio server failed:", err);
  });
}
