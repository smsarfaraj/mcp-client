/**
 * server.ts — Express web server acting as the MCP Client backend
 *
 * Two modes exposed via separate routes:
 *
 * POST /api/chat        → WITH Claude
 *   - Sends user message to Claude API
 *   - Claude decides which MCP tools to call
 *   - We execute those tool calls via mcpClient
 *   - Claude sees the results and returns a final answer
 *
 * POST /api/tool        → WITHOUT Claude (direct MCP call)
 *   - You pick the tool name + args yourself
 *   - We call the MCP server directly, no AI involved
 *   - Raw result returned immediately
 *
 * GET  /api/tools       → List all available MCP tools (used by the UI)
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { mcpClient, MCPTool } from "./mcpClient.js";

// ── ESM __dirname polyfill ────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env manually (no dotenv dependency) ─────────────────────────────────
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length) {
      process.env[key.trim()] = rest.join("=").trim();
    }
  }
}

const app = express();
app.use(express.json());

// Serve the chat UI from /public
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Helper: convert MCP tool schema → Anthropic tool format ──────────────────
function toAnthropicTool(tool: MCPTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tools — list all MCP tools (used by the direct-call UI tab)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/tools", async (_req, res) => {
  try {
    const tools = await mcpClient.listTools();
    res.json({ tools });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tool — WITHOUT Claude, call an MCP tool directly
//
// Body: { tool: string, args: object }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/tool", async (req, res) => {
  const { tool, args } = req.body as { tool: string; args: Record<string, unknown> };

  if (!tool) {
    res.status(400).json({ error: "tool name is required" });
    return;
  }

  try {
    const result = await mcpClient.callTool(tool, args ?? {});
    res.json({ result: JSON.parse(result) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat — WITH Claude (agentic loop)
//
// Body: { message: string, history?: Array<{role, content}> }
//
// Flow:
//  1. Send user message + all MCP tools to Claude
//  2. If Claude responds with tool_use blocks → execute them via mcpClient
//  3. Feed results back to Claude
//  4. Repeat until Claude gives a final text response
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body as {
    message: string;
    history: Anthropic.MessageParam[];
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    // Fetch MCP tools and convert to Anthropic format
    const mcpTools = await mcpClient.listTools();
    const anthropicTools = mcpTools.map(toAnthropicTool);

    // Build message history
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: message },
    ];

    const toolCallLog: Array<{ tool: string; args: unknown; result: string }> = [];

    // Agentic loop — keep going until Claude stops calling tools
    while (true) {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system:
          "You are a helpful data assistant with access to a Supabase database. " +
          "Use the available tools to answer questions about the data. " +
          "Always show the data in a clear, readable format.",
        messages,
        tools: anthropicTools,
      });

      // Append Claude's response to the conversation
      messages.push({ role: "assistant", content: response.content });

      // If Claude is done (no more tool calls), return the final answer
      if (response.stop_reason === "end_turn") {
        const textContent = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        res.json({ reply: textContent, toolCalls: toolCallLog });
        return;
      }

      // Execute all tool_use blocks Claude requested
      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          console.log(`🔧 Claude calling tool: ${block.name}`, block.input);

          const result = await mcpClient.callTool(
            block.name,
            block.input as Record<string, unknown>
          );

          toolCallLog.push({ tool: block.name, args: block.input, result });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }

        // Feed tool results back to Claude
        messages.push({ role: "user", content: toolResults });
        // Loop back — Claude will continue
      }
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`\n🚀 MCP Client running at http://localhost:${PORT}`);
  console.log(`   Tab 1: Chat with Claude (uses MCP tools via AI)`);
  console.log(`   Tab 2: Direct tool calls (no Claude, raw MCP)\n`);
});
