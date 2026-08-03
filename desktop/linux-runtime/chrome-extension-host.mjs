#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { APP_SERVER_RUNTIME_METHODS, ChromeExtensionRuntime } from "./chrome-app-server.mjs";

export const EXTENSION_HOST_PROTOCOL_VERSION = 2;
export const EXTENSION_HOST_MANIFEST_SCHEMA_VERSION = 2;
export const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
// Chrome's native-messaging limits are directional: an extension may send up
// to 64 MiB to a host, while a host may send at most 1 MiB back to Chrome.
export const MAX_CHROME_TO_HOST_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_HOST_TO_CHROME_MESSAGE_BYTES = 1024 * 1024;
export const MAX_NATIVE_MESSAGE_BYTES = MAX_CHROME_TO_HOST_MESSAGE_BYTES;

export function encodeNativeMessage(message, endianness = os.endianness(), maximumBytes = MAX_NATIVE_MESSAGE_BYTES) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > maximumBytes) throw new Error(`Native message exceeds ${maximumBytes} bytes`);
  const header = Buffer.allocUnsafe(4);
  if (endianness === "LE") header.writeUInt32LE(payload.length);
  else header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export class NativeMessageDecoder {
  constructor(options = {}) {
    this.endianness = options.endianness || os.endianness();
    this.maximumBytes = options.maximumBytes || MAX_NATIVE_MESSAGE_BYTES;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.endianness === "LE" ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (length > this.maximumBytes) throw new Error(`Native message exceeds ${this.maximumBytes} bytes`);
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const message = JSON.parse(payload.toString("utf8"));
      if (message == null || typeof message !== "object" || Array.isArray(message)) throw new Error("Native message must be an object");
      messages.push(message);
    }
    return messages;
  }
}

export function validateExtensionOrigin(origin, extensionId = EXTENSION_ID) {
  return origin === `chrome-extension://${extensionId}/`;
}

export function extensionHostHello() {
  return {
    manifestSchemaVersion: EXTENSION_HOST_MANIFEST_SCHEMA_VERSION,
    nativeHostProtocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
    supportedProtocolVersions: [EXTENSION_HOST_PROTOCOL_VERSION],
    supportedMethods: APP_SERVER_RUNTIME_METHODS,
  };
}

function runtimeErrorResponse(message, error) {
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
      data: { type: error?.runtimeErrorType || "app_server_runtime_error" },
    },
  };
}

export function handleRuntimeRequest(message, runtime = null) {
  if (message?.method === "codexRuntime/hello") {
    return { jsonrpc: "2.0", id: message.id, result: extensionHostHello() };
  }
  if (message?.method === "ping") {
    return { jsonrpc: "2.0", id: message.id, result: "pong" };
  }
  if (typeof message?.method === "string" && message.method.startsWith("codexRuntime/")) {
    if (!runtime) return runtimeErrorResponse(message, new Error("The Chrome side-panel runtime is unavailable."));
    return Promise.resolve(runtime.handleRequest(message.method, message.params))
      .then(result => ({ jsonrpc: "2.0", id: message.id, result }))
      .catch(error => runtimeErrorResponse(message, error));
  }
  return null;
}

async function prepareSocketDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Browser Use socket directory is unsafe");
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw new Error("Browser Use socket directory has a different owner");
  await chmod(directory, 0o700);
}

export async function serveExtensionHost(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const socketDirectory = options.socketDirectory || "/tmp/codex-browser-use";
  const runtime = options.runtime || new ChromeExtensionRuntime({
    extensionId: options.extensionId || EXTENSION_ID,
    spawnProcess: options.spawnProcess,
    workingDirectory: options.workingDirectory,
    configPath: options.configPath,
    extensionHostPath: options.extensionHostPath,
    assetOptions: options.assetOptions,
    token: options.appServerToken,
  });
  await prepareSocketDirectory(socketDirectory);
  const socketPath = path.join(socketDirectory, `${randomUUID()}.sock`);
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket);
    const decoder = new NativeMessageDecoder({ maximumBytes: MAX_NATIVE_MESSAGE_BYTES });
    socket.on("data", chunk => {
      try {
        for (const message of decoder.push(chunk)) {
          output.write(encodeNativeMessage(message, os.endianness(), MAX_HOST_TO_CHROME_MESSAGE_BYTES));
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("close", () => clients.delete(socket));
    socket.once("error", () => clients.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  const decoder = new NativeMessageDecoder({ maximumBytes: MAX_CHROME_TO_HOST_MESSAGE_BYTES });
  let nativeResponseQueue = Promise.resolve();
  input.on("data", chunk => {
    try {
      for (const message of decoder.push(chunk)) {
        const isRuntimeRequest = message?.method === "ping" ||
          (typeof message?.method === "string" && message.method.startsWith("codexRuntime/"));
        if (isRuntimeRequest) {
          nativeResponseQueue = nativeResponseQueue.then(async () => {
            const resolved = await handleRuntimeRequest(message, runtime);
            output.write(encodeNativeMessage(resolved, os.endianness(), MAX_HOST_TO_CHROME_MESSAGE_BYTES));
          });
          nativeResponseQueue.catch(error => {
            process.stderr.write(`Chrome native runtime response failed: ${error instanceof Error ? error.message : String(error)}\n`);
          });
        } else {
          const frame = encodeNativeMessage(message);
          for (const client of clients) client.write(frame);
        }
      }
    } catch (error) {
      process.stderr.write(`Chrome native messaging protocol error: ${error instanceof Error ? error.message : String(error)}\n`);
      input.destroy();
    }
  });

  let closePromise = null;
  const close = async () => {
    if (closePromise) return await closePromise;
    closePromise = (async () => {
      for (const client of clients) client.destroy();
      await new Promise(resolve => server.close(resolve));
      await runtime.close?.();
      await rm(socketPath, { force: true });
    })();
    return await closePromise;
  };
  input.once("end", () => { void close(); });
  input.once("close", () => { void close(); });
  return { close, server, socketPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.argv.find(argument => argument.startsWith("chrome-extension://"));
  if (origin == null || !validateExtensionOrigin(origin)) process.exit(1);
  serveExtensionHost().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
