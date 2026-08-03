import readline from "node:readline";

const SERVER_PROTOCOL_VERSION = "2025-06-18";

function messageId(message) {
  return typeof message === "object" && message != null && Object.hasOwn(message, "id")
    ? message.id
    : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class McpServer {
  constructor({ name, version, tools, callTool }) {
    this.name = name;
    this.version = version;
    this.tools = tools;
    this.callTool = callTool;
  }

  async handle(message) {
    const id = messageId(message);
    if (typeof message !== "object" || message == null || typeof message.method !== "string") {
      return id === undefined ? null : this.error(id, -32600, "Invalid JSON-RPC request");
    }

    if (message.method === "initialize") {
      return this.result(id, {
        protocolVersion: message.params?.protocolVersion || SERVER_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: this.name, version: this.version },
      });
    }
    if (message.method === "ping") return this.result(id, {});
    if (message.method === "tools/list") return this.result(id, { tools: this.tools });
    if (message.method === "tools/call") {
      if (id === undefined) return null;
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== "string" || typeof args !== "object" || args == null || Array.isArray(args)) {
        return this.error(id, -32602, "tools/call requires a tool name and object arguments");
      }
      try {
        return this.result(id, await this.callTool(name, args));
      } catch (error) {
        return this.result(id, {
          content: [{ type: "text", text: errorMessage(error) }],
          isError: true,
        });
      }
    }
    if (message.method.startsWith("notifications/")) return null;
    return id === undefined ? null : this.error(id, -32601, `Method not found: ${message.method}`);
  }

  result(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  error(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

export function serveStdio(server) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async line => {
    if (!line.trim()) return;
    let response;
    try {
      response = await server.handle(JSON.parse(line));
    } catch (error) {
      response = server.error(null, -32700, `Parse error: ${errorMessage(error)}`);
    }
    if (response != null) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  input.on("close", () => process.exit(0));
}
