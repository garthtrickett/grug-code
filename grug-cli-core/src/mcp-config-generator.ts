import * as path from "node:path";

const absoluteDaemonPath = path.resolve("dist/grug-daemon");

const claudeConfig = {
  mcpServers: {
    "grug-code": {
      command: "bun",
      args: [path.resolve("src/daemon.ts")],
      env: {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || ""
      }
    }
  }
};

const compiledClaudeConfig = {
  mcpServers: {
    "grug-code": {
      command: absoluteDaemonPath,
      env: {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || ""
      }
    }
  }
};

console.error("Grug Config Generator:");
console.error("--------------------------------------------------");
console.error("For rapid hot-reloading development (Bun source):");
console.log(JSON.stringify(claudeConfig, null, 2));
console.error("--------------------------------------------------");
console.error("For optimized production use (Compiled binary):");
console.log(JSON.stringify(compiledClaudeConfig, null, 2));