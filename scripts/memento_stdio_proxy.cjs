#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const sdkRoot = path.join(__dirname, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs");

const { Client } = require(path.join(sdkRoot, "client", "index.js"));
const { StreamableHTTPClientTransport } = require(path.join(sdkRoot, "client", "streamableHttp.js"));
const { Server } = require(path.join(sdkRoot, "server", "index.js"));
const { StdioServerTransport } = require(path.join(sdkRoot, "server", "stdio.js"));
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema
} = require(path.join(sdkRoot, "types.js"));

function logError(message, error) {
  const detail = error ? `\n${error.stack || error.message || String(error)}` : "";
  process.stderr.write(`[memento-stdio-proxy] ${message}${detail}\n`);
}

function readDotEnvValue(key) {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) {
    return "";
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const currentKey = line.slice(0, idx).trim();
    if (currentKey === key) {
      return line.slice(idx + 1).trim();
    }
  }
  return "";
}

async function main() {
  const remoteUrl = process.env.MEMENTO_REMOTE_URL || "http://127.0.0.1:57332/mcp";
  const bearerToken =
    process.env.MEMENTO_MCP_BEARER_TOKEN ||
    process.env.MEMENTO_ACCESS_KEY ||
    readDotEnvValue("MEMENTO_ACCESS_KEY");

  if (!bearerToken) {
    throw new Error("Missing MEMENTO_MCP_BEARER_TOKEN or MEMENTO_ACCESS_KEY");
  }

  const remoteClient = new Client(
    { name: "memento-stdio-proxy", version: "1.0.0" },
    {
      capabilities: {
        roots: { listChanged: false },
        sampling: {}
      }
    }
  );

  remoteClient.onerror = (error) => logError("remote client error", error);

  const remoteTransport = new StreamableHTTPClientTransport(new URL(remoteUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`
      }
    }
  });

  remoteTransport.onerror = (error) => logError("remote transport error", error);
  let remoteConnectPromise = null;

  async function ensureRemoteConnected() {
    if (!remoteConnectPromise) {
      remoteConnectPromise = remoteClient.connect(remoteTransport).catch((error) => {
        remoteConnectPromise = null;
        throw error;
      });
    }
    return remoteConnectPromise;
  }

  const server = new Server(
    { name: "memento-stdio-proxy", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false }
      },
      instructions: "Proxy for the local memento HTTP server. Use the exposed memory tools normally."
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.listTools(request.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.callTool({
      name: request.params.name,
      arguments: request.params.arguments || {}
    });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.listPrompts(request.params);
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.getPrompt(request.params);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.listResources(request.params);
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.listResourceTemplates(request.params);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await ensureRemoteConnected();
    return remoteClient.readResource(request.params);
  });

  const stdioTransport = new StdioServerTransport();
  stdioTransport.onerror = (error) => logError("stdio transport error", error);
  server.onerror = (error) => logError("proxy server error", error);

  const shutdown = async () => {
    try {
      await server.close();
    } catch (error) {
      logError("server close error", error);
    }
    try {
      await remoteClient.close();
    } catch (error) {
      logError("remote client close error", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(stdioTransport);
}

main().catch((error) => {
  logError("startup failed", error);
  process.exit(1);
});
