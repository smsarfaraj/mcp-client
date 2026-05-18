# mcp-client

> **A web-based MCP Client with two modes — Chat with Claude AI and a direct MCP Inspector.**  
> Built by [Sarfaraz Shaikh](https://sarfaraz.pro)

---

## What is this?

This is a **Model Context Protocol (MCP) Client** — the counterpart to an MCP server. It connects to the [mcp-supabase](https://github.com/your-username/mcp-supabase) server and provides a clean browser-based interface to interact with your Supabase database in two distinct ways.

### What is an MCP Client?

In the MCP architecture, the **client** is responsible for:
1. Spawning the MCP server as a child process
2. Establishing a connection over stdio
3. Discovering available tools from the server
4. Deciding how to invoke those tools (either via AI or directly)

```
Browser (You)
    ↓  HTTP
Express Server (this client — port 3000)
    ↓  stdio / JSON-RPC
mcp-supabase server (child process)
    ↓  HTTPS
Supabase
```

---

## Two Modes

### Mode 1 — Claude AI Tab
You type in plain English. The client sends your message to the **Anthropic Claude API** along with the full list of MCP tools. Claude decides which tools to call, the client executes them on the MCP server, feeds the results back to Claude, and Claude returns a final answer.

This is the **agentic loop** — Claude can chain multiple tool calls to answer a single question.

```
You: "Compare feedback from my two projects"
  → Claude calls db_list_tables
  → Claude calls db_query on feedback_sarfaraz_pro
  → Claude calls db_query on feedback_in_hand_salary
  → Claude synthesizes and replies
```

### Mode 2 — MCP Inspector Tab
You pick a tool directly from the sidebar, edit the JSON arguments, and hit Run. No Claude involved — this is raw MCP protocol talking directly to the server. This is equivalent to what tools like the official MCP Inspector do.

This mode is perfect for:
- Testing individual tools without AI overhead
- Debugging your MCP server
- Understanding exactly what each tool does

---

## Features

- Clean dark-mode chat UI
- Real-time tool call visibility (expandable under each Claude response)
- Full agentic loop with conversation history
- MCP Inspector with auto-generated JSON args from tool schema
- Tools grouped by category: Database, Auth, Storage
- No framework dependencies — plain HTML/JS frontend

---

## Tech Stack

- **Runtime:** Node.js (v18+)
- **Language:** TypeScript
- **Web Framework:** Express.js
- **MCP SDK:** `@modelcontextprotocol/sdk` (Client)
- **AI:** `@anthropic-ai/sdk` (Claude API)
- **Frontend:** Vanilla HTML + CSS + JS (no React/Vue)
- **Transport:** stdio to MCP server, HTTP to browser

---

## Prerequisites

- Node.js v18 or higher
- [mcp-supabase](https://github.com/your-username/mcp-supabase) server built and available
- Anthropic API key ([get one here](https://console.anthropic.com))
- Supabase project credentials

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/your-username/mcp-client.git
cd mcp-client

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
```

Open `.env` and fill in all values:

```env
# Anthropic API key — from https://console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...

# Absolute path to the compiled mcp-supabase server
MCP_SERVER_PATH=/absolute/path/to/mcp-supabase/dist/index.js

# Supabase credentials (passed to the MCP server process)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Port for this web server
PORT=3000
```

```bash
# 4. Build
npm run build

# 5. Start
npm start
```

Open your browser at `http://localhost:3000`

---

## Usage

### Claude AI Tab

Type any natural language question about your data:

```
"What tables do I have?"
"How many subscribers do I have on sarfaraz.pro?"
"Show me all the feedback and summarise it"
"Who are my most recent Supabase Auth users?"
```

Claude will automatically call the right tools, chain them if needed, and reply with a clear answer. Each response shows a collapsible **"🔧 X tool calls made"** section so you can see exactly what happened under the hood.

### MCP Inspector Tab

1. Pick a tool from the left sidebar (grouped by Database / Auth / Storage)
2. The JSON args editor auto-fills with default values from the tool's schema
3. Edit the args as needed
4. Click **▶ Run Tool**
5. The raw result appears in the output panel

---

## API Routes

The Express server exposes three endpoints:

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/tools` | List all tools available on the MCP server |
| `POST` | `/api/tool` | Call a specific tool directly (MCP Inspector) |
| `POST` | `/api/chat` | Send a message to Claude with MCP tools (agentic loop) |

### POST /api/chat
```json
{
  "message": "How many subscribers do I have?",
  "history": []
}
```
Response:
```json
{
  "reply": "You have 42 subscribers on sarfaraz.pro...",
  "toolCalls": [
    { "tool": "db_query", "args": { "table": "subscribers_sarfaraz_pro" }, "result": "..." }
  ]
}
```

### POST /api/tool
```json
{
  "tool": "db_query",
  "args": { "table": "subscribers_sarfaraz_pro", "columns": "*", "limit": 10 }
}
```
Response:
```json
{
  "result": { "rows": [...], "count": 10 }
}
```

---

## How the Agentic Loop Works

```
1. User sends message
2. Client fetches tool list from MCP server
3. Client sends message + tools to Claude API
4. Claude responds with tool_use blocks
5. Client executes each tool via MCP server
6. Results sent back to Claude as tool_result blocks
7. Claude generates final text response
8. Steps 4–7 repeat until Claude returns end_turn
```

This is the same pattern used internally by Claude Desktop — we just built it ourselves to understand it fully.

---

## Project Structure

```
mcp-client/
├── src/
│   ├── server.ts         # Express server + API routes + agentic loop
│   └── mcpClient.ts      # MCP SDK Client — connects to MCP server via stdio
├── public/
│   └── index.html        # Web UI (Claude AI tab + MCP Inspector tab)
├── dist/                 # Compiled output (git-ignored)
├── .env.example          # Environment variable template
├── package.json
└── tsconfig.json
```

---

## Understanding the Architecture

| Component | Role | Analogy |
|-----------|------|---------|
| `mcpClient.ts` | Spawns MCP server, sends tool calls | The driver |
| `server.ts /api/tool` | Passes tool calls through directly | A direct phone call |
| `server.ts /api/chat` | Asks Claude which tools to call, then calls them | A manager who delegates |
| `public/index.html` | The UI you interact with | The front desk |

---

## Security Notes

- The `.env` file is git-ignored — never commit your API keys
- The MCP server child process inherits only the env vars you explicitly pass
- For production use, add authentication to the Express routes

---

## Related Project

**[mcp-supabase](https://github.com/your-username/mcp-supabase)** — The MCP server this client connects to. Exposes 18 tools across Supabase database, auth, and storage.

---

## Author

**Sarfaraz Shaikh**  
[sarfaraz.pro](https://sarfaraz.pro) · [LinkedIn](https://linkedin.com/in/sarfaraz-shaikh)

---

## License

MIT
