import { spawn } from "node:child_process";
import readline from "node:readline";

export async function deleteThreadsForCwd({ codexHome, cwd }) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_000); });

  let nextId = 1;
  const pending = new Map();
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const request = pending.get(String(message.id));
    if (!request) return;
    pending.delete(String(message.id));
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(String(id), { reject, resolve });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  try {
    await request("initialize", {
      clientInfo: { name: "chatgpt-linux-live-test", version: "1" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const listed = await request("thread/list", {
      cwd,
      limit: 100,
      sortKey: "created_at",
      sortDirection: "desc",
    });
    const ids = listed.data.map(thread => thread.id);
    for (const threadId of ids) await request("thread/delete", { threadId });
    return ids;
  } catch (error) {
    throw new Error(`codex app-server cleanup failed: ${stderr || error.message}`, { cause: error });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    lines.close();
  }
}
