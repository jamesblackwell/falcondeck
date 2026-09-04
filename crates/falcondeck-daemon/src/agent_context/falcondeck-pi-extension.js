// FalconDeck Pi Agent Extension
// Bridges FalconDeck MCP tools (control plane, extensions, connectors) into Pi sessions.

import { spawn } from "node:child_process";
import * as readline from "node:readline";

class StdioMcpClient {
  constructor(name, command, args, env) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  start() {
    if (this.child) return;
    try {
      this.child = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (err) {
      console.error(`[falcondeck-pi-bridge] Failed to spawn ${this.name} (${this.command}):`, err);
      this.closed = true;
      return;
    }

    this.child.on("error", (err) => {
      console.error(`[falcondeck-pi-bridge] MCP server ${this.name} error:`, err);
      for (const [, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(`MCP server ${this.name} exited with code ${code} signal ${signal}`);
      for (const [, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // non-JSON line on stdout, ignore
      }
    });

    const cleanup = () => {
      if (this.child && !this.closed) {
        try {
          this.child.kill();
        } catch {}
      }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  request(method, params = {}) {
    if (this.closed || !this.child) {
      return Promise.reject(new Error(`MCP server ${this.name} is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(req, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async init() {
    this.start();
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "falcondeck-pi-bridge", version: "1.0.0" },
    });
    if (this.child && this.child.stdin.writable) {
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
      );
    }
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return res?.tools || [];
  }

  async callTool(name, args) {
    const res = await this.request("tools/call", {
      name,
      arguments: args || {},
    });
    return res;
  }
}

function parseServers() {
  const rawJson = process.env.FALCONDECK_MCP_SERVERS;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => {
          let env = {};
          if (Array.isArray(s.env)) {
            for (const item of s.env) {
              if (item && item.name && item.value != null) {
                env[item.name] = String(item.value);
              }
            }
          } else if (s.env && typeof s.env === "object") {
            env = s.env;
          }
          return {
            name: s.name,
            command: s.command,
            args: s.args || [],
            env,
          };
        });
      }
    } catch (e) {
      console.error("[falcondeck-pi-bridge] Failed to parse FALCONDECK_MCP_SERVERS:", e);
    }
  }

  const daemonUrl = process.env.FALCONDECK_DAEMON_URL;
  if (daemonUrl) {
    const exe = process.env.FALCONDECK_DAEMON_EXECUTABLE || "falcondeck-daemon";
    const servers = [
      {
        name: "falcondeck",
        command: exe,
        args: ["mcp"],
        env: {
          FALCONDECK_DAEMON_URL: daemonUrl,
          FALCONDECK_CONTROL_PROVIDER: process.env.FALCONDECK_CONTROL_PROVIDER || "pi",
          FALCONDECK_CONTROL_WORKSPACE: process.env.FALCONDECK_CONTROL_WORKSPACE || process.cwd(),
        },
      },
    ];
    if (process.env.FALCONDECK_EXTENSION_CAPABILITY) {
      servers.push({
        name: "falcondeck-extensions",
        command: exe,
        args: ["mcp-extensions"],
        env: {
          FALCONDECK_DAEMON_URL: daemonUrl,
          FALCONDECK_EXTENSION_WORKSPACE: process.env.FALCONDECK_CONTROL_WORKSPACE || process.cwd(),
          FALCONDECK_EXTENSION_CAPABILITY: process.env.FALCONDECK_EXTENSION_CAPABILITY,
        },
      });
    }
    return servers;
  }

  return [];
}

export default async function (api) {
  const serverConfigs = parseServers();
  if (!serverConfigs || serverConfigs.length === 0) {
    return;
  }

  for (const config of serverConfigs) {
    if (!config.command) continue;
    try {
      const client = new StdioMcpClient(
        config.name,
        config.command,
        config.args,
        config.env
      );
      await client.init();
      const tools = await client.listTools();

      for (const tool of tools) {
        const schema =
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} };
        if (!schema.type) {
          schema.type = "object";
        }

        api.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description || "",
          parameters: schema,
          execute: async (_toolCallId, params) => {
            try {
              const res = await client.callTool(tool.name, params);
              let content = res?.content;
              if (!content || !Array.isArray(content)) {
                content = [
                  {
                    type: "text",
                    text: typeof res === "string" ? res : JSON.stringify(res),
                  },
                ];
              }
              return {
                content,
                isError: res?.isError ?? false,
              };
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              return {
                content: [
                  {
                    type: "text",
                    text: errMsg,
                  },
                ],
                isError: true,
              };
            }
          },
        });
      }
    } catch (err) {
      console.error(`[falcondeck-pi-bridge] Failed to initialize MCP server ${config.name}:`, err);
    }
  }
}
