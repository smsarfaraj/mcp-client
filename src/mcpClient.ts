/**
 * mcpClient.ts
 *
 * This is the MCP CLIENT — the counterpart to the MCP server we built earlier.
 *
 * What it does:
 *  1. Spawns the mcp-supabase server as a child process
 *  2. Connects to it over stdio using the MCP SDK Client
 *  3. Fetches the list of available tools from the server
 *  4. Exposes callTool() so callers (Express routes) can invoke any tool by name
 *
 * The MCP SDK handles the JSON-RPC protocol layer — we just use the high-level API.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Shape of a tool as returned by the MCP server
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;

  constructor() {
    this.client = new Client(
      { name: "mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  /**
   * Connect to the MCP server by spawning it as a child process.
   * The server communicates over stdin/stdout (stdio transport).
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const serverPath = process.env.MCP_SERVER_PATH;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serverPath) throw new Error("MCP_SERVER_PATH not set in .env");
    if (!supabaseUrl) throw new Error("SUPABASE_URL not set in .env");
    if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in .env");

    // Spawn the MCP server as a child process, passing Supabase creds as env vars
    this.transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env as Record<string, string>,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
    });

    await this.client.connect(this.transport);
    this.connected = true;
    console.log("✅ MCP Client connected to mcp-supabase server");
  }

  /**
   * Fetch all tools registered on the MCP server.
   * These are the same 18 tools we built: db_query, auth_list_users, etc.
   */
  async listTools(): Promise<MCPTool[]> {
    await this.connect();
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /**
   * Call a specific tool on the MCP server by name with the given arguments.
   * Returns the text content of the tool's response.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();

    const result = await this.client.callTool({ name, arguments: args });

    // Extract text from the response content array
    const textParts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text as string);

    return textParts.join("\n") || JSON.stringify(result.content);
  }

  async disconnect(): Promise<void> {
    if (this.transport && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

// Singleton — one connection shared across all requests
export const mcpClient = new MCPClient();
