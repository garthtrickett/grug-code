import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Dev Container Sandbox E2E", () => {
  let tempDir: string;
  let sessionToken: string;
  let logFile: string;
  let devcontainerPath: string;

  test.beforeAll(async () => {
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;

    await fs.writeFile(".grug-mock-ai", "true");

    logFile = path.join(os.tmpdir(), `devcontainer-e2e-${crypto.randomUUID()}.log`);
    const devcontainerScript = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const logFile = ${JSON.stringify(logFile)};`,
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');",
      "if (args.includes('tsc')) {",
      "  if (fs.existsSync(logFile + '.fail')) {",
      "    console.error('TS2322: Type mismatch error in Dev Container.');",
      "    process.exit(1);",
      "  }",
      "  process.exit(0);",
      "}",
      "process.exit(0);"
    ].join("\n");

    const binDir = path.join(process.cwd(), "node_modules", ".bin");
    devcontainerPath = path.join(binDir, "devcontainer");
    await fs.writeFile(devcontainerPath, devcontainerScript, "utf-8");
    await fs.chmod(devcontainerPath, 0o755);
  });

  test.afterAll(async () => {
    await fs.unlink(".grug-mock-ai").catch(() => {});
    await fs.unlink(devcontainerPath).catch(() => {});
  });

  test.beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-e2e-devcontainer-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug DevContainer Test'", { cwd: tempDir });
    await execPromise("git config user.email 'devcontainer@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "main.ts"), "export const x: number = 42;\\n");
    await fs.writeFile(path.join(tempDir, ".devcontainer.json"), "{}");
    
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'Initial DevContainer Commit'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(logFile).catch(() => {});
    await fs.unlink(logFile + ".fail").catch(() => {});
  });

  test("should register project, detect uses_devcontainer as true, execute step through devcontainer tool, and self-correct on compile errors", async ({ request }) => {
    const projectRes = await request.post("/api/projects", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        name: "E2E DevContainer Project",
        root_path: tempDir,
      },
    });

    expect(projectRes.status()).toBe(200);
        const project = (await projectRes.json()) as { id: string; uses_devcontainer: boolean };
    expect(project.uses_devcontainer).toBe(true);

    const taskId = `e2e-devcontainer-${crypto.randomUUID().slice(0, 8)}`;

    const initResponse = await request.post("/api/workspace/init", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        taskId,
        cwd: tempDir,
      },
    });

    expect(initResponse.status()).toBe(200);
        const tx = (await initResponse.json()) as { id: string; baseBranch: string; ephemeralBranch: string; checkpoints: string[] };

    await fs.writeFile(logFile + ".fail", "");

    const executeResponse = await request.post("/api/workspace/execute-step", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        targetFiles: ["main.ts"],
        instructions: JSON.stringify({
          files: [
            {
              file_path: "main.ts",
              code_diff: "<<<<<<< SEARCH\\nexport const x: number = 42;\\n=======\\nexport const x: number = 'broken';\\n>>>>>>> REPLACE"
            }
          ]
        }),
        cwd: tempDir,
      },
    });

    expect(executeResponse.status()).toBe(200);
        const asyncRes = (await executeResponse.json()) as { status: string; worktreePath: string };
    expect(asyncRes.status).toBe("running");

    const worktreePath = asyncRes.worktreePath;
    let completed = false;
    for (let i = 0; i < 40; i++) {
      const exists = await fs.stat(worktreePath).then(() => true).catch(() => false);
      if (!exists && i > 5) {
        completed = true;
        break;
      }
      if (i === 12) {
        await fs.unlink(logFile + ".fail").catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(completed).toBe(true);

    const logContent = await fs.readFile(logFile, "utf-8");
    expect(logContent).toContain("exec");
    expect(logContent).toContain("--workspace-folder");
    expect(logContent).toContain(worktreePath);

    const finalContent = await fs.readFile(path.join(tempDir, "main.ts"), "utf-8");
    expect(finalContent).toBe("export const x: number = 42;\\n");

    const deleteRes = await request.delete(`/api/projects/${project.id}`, {
      headers: {
        "X-Grug-Token": sessionToken,
      },
    });
    expect(deleteRes.status()).toBe(200);
  });
});
