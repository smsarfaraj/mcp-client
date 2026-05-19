# How I Built an MCP Server and MCP Client from Scratch

**Author: Sarfaraz Shaikh**  
[sarfaraz.pro](https://sarfaraz.pro) · [LinkedIn](https://linkedin.com/in/sarfaraz-shaikh)

> This document is a complete technical deep-dive into how both projects were built — every file, every decision, every concept explained from first principles. Written as a learning reference so anyone can understand and reproduce it.

---

## Table of Contents

1. [What is MCP?](#1-what-is-mcp)
2. [The Big Picture — Architecture](#2-the-big-picture--architecture)
3. [The Protocol — How MCP Actually Works](#3-the-protocol--how-mcp-actually-works)
4. [Project 1: mcp-supabase (The MCP Server)](#4-project-1-mcp-supabase-the-mcp-server)
   - [Project Structure](#41-project-structure)
   - [package.json — Why These Dependencies](#42-packagejson--why-these-dependencies)
   - [tsconfig.json — Why NodeNext Matters](#43-tsconfigjson--why-nodenext-matters)
   - [src/supabase.ts — The Database Connection](#44-srcsupabasets--the-database-connection)
   - [src/tools/database.ts — All 5 Database Tools](#45-srctoolsdatabasets--all-5-database-tools)
   - [src/tools/auth.ts — All 6 Auth Tools](#46-srctoolsauthts--all-6-auth-tools)
   - [src/tools/storage.ts — All 7 Storage Tools](#47-srctoolsstoragets--all-7-storage-tools)
   - [src/index.ts — The Server Entry Point](#48-srcindexts--the-server-entry-point)
5. [Project 2: mcp-client (The MCP Client)](#5-project-2-mcp-client-the-mcp-client)
   - [Project Structure](#51-project-structure)
   - [src/mcpClient.ts — The MCP Client Core](#52-srcmcpclientts--the-mcp-client-core)
   - [src/server.ts — The Express Backend](#53-srcserts--the-express-backend)
   - [public/index.html — The Web UI](#54-publicindexhtml--the-web-ui)
6. [The Agentic Loop — How Claude Uses Tools](#6-the-agentic-loop--how-claude-uses-tools)
7. [How Server and Client Connect](#7-how-server-and-client-connect)
8. [How Claude Desktop Connects (Bonus)](#8-how-claude-desktop-connects-bonus)
9. [Key Design Decisions and Why](#9-key-design-decisions-and-why)
10. [Common Errors and What They Mean](#10-common-errors-and-what-they-mean)
11. [How to Extend This](#11-how-to-extend-this)
12. [Glossary](#12-glossary)

---

## 1. What is MCP?

**MCP stands for Model Context Protocol.** It is an open standard created by Anthropic that defines how AI models like Claude can connect to and interact with external tools, databases, APIs, and services.

Before MCP existed, every AI product that wanted to connect to an external system had to invent its own way of doing it. There was no standard. MCP solves this by defining a universal protocol — like how HTTP is a universal protocol for the web.

### The problem MCP solves

Imagine you want Claude to query your database. Without MCP, you would have to:
- Hardcode the database query logic inside Claude's prompt
- Write custom code to parse Claude's response and figure out what it wants
- Build your own tool invocation system from scratch

With MCP, there is a defined contract:
- The **server** announces: "Here are the tools I have and what they do"
- The **client** says: "Call this tool with these arguments"
- The **server** executes it and returns a result
- The **client** feeds the result back to the AI

This is clean, reusable, and universal.

### MCP in one sentence

MCP is a JSON-RPC protocol that runs over `stdio` (or HTTP) and lets an AI model discover and call tools on an external server.

---

## 2. The Big Picture — Architecture

Here is the complete picture of what was built and how the pieces connect:

```
┌─────────────────────────────────────────────────────────────┐
│                        YOUR BROWSER                         │
│                  http://localhost:3000                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (fetch API)
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    mcp-client (Port 3000)                    │
│                                                             │
│   Express.js Web Server                                     │
│                                                             │
│   GET  /api/tools   → list all MCP tools                    │
│   POST /api/tool    → call a tool directly (no AI)          │
│   POST /api/chat    → send message to Claude + use tools    │
│                                                             │
│   ┌─────────────────────────────────────┐                  │
│   │           mcpClient.ts              │                  │
│   │  MCP SDK Client                     │                  │
│   │  Spawns the server as child process │                  │
│   │  Communicates via stdio             │                  │
│   └──────────────────┬──────────────────┘                  │
└──────────────────────┼──────────────────────────────────────┘
                       │ stdio (JSON-RPC messages)
                       │ stdin → server reads requests
                       │ stdout → server writes responses
                       │ stderr → server writes logs
┌──────────────────────▼──────────────────────────────────────┐
│                  mcp-supabase (Child Process)                │
│                                                             │
│   MCP Server                                                │
│   Registers 18 tools: db_*, auth_*, storage_*              │
│                                                             │
│   tools/database.ts  → 5 tools (query, insert, update...)  │
│   tools/auth.ts      → 6 tools (list users, create...)     │
│   tools/storage.ts   → 7 tools (list files, upload...)     │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS REST API
                       │ (supabase-js library)
┌──────────────────────▼──────────────────────────────────────┐
│                        SUPABASE                             │
│                  (Your cloud database)                      │
│                                                             │
│   PostgreSQL Database                                       │
│   Supabase Auth (user management)                           │
│   Supabase Storage (file buckets)                           │
└─────────────────────────────────────────────────────────────┘

                           ↕ HTTPS (Anthropic API)

┌─────────────────────────────────────────────────────────────┐
│                    ANTHROPIC CLAUDE API                     │
│              (Only used in /api/chat route)                 │
└─────────────────────────────────────────────────────────────┘
```

There are three distinct layers:
1. **The browser** — what the user sees and interacts with
2. **The mcp-client** — a Node.js Express server that bridges the browser, Claude, and the MCP server
3. **The mcp-supabase** — a Node.js MCP server that knows how to talk to Supabase

The MCP server does NOT run as a web server. It runs as a **child process** spawned by the client, and they communicate through pipes (`stdin`/`stdout`). This is the stdio transport model.

---

## 3. The Protocol — How MCP Actually Works

Before looking at any code, you need to understand the protocol layer. MCP is built on top of **JSON-RPC 2.0** — a simple standard for remote procedure calls using JSON.

### What is JSON-RPC?

A JSON-RPC message is just a JSON object with a specific shape. Here is what a tool call looks like flowing from the client to the server:

**Client → Server (request):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "db_query",
    "arguments": {
      "table": "subscribers_sarfaraz_pro",
      "columns": "*",
      "limit": 10
    }
  }
}
```

**Server → Client (response):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"rows\": [...], \"count\": 10}"
      }
    ]
  }
}
```

The `id` field links every request to its response. The `method` tells the server what operation to perform. The `params` contain the arguments.

### The MCP Handshake

When the client first connects to the server, they perform a handshake:

```
Client → Server: { "method": "initialize", "params": { "protocolVersion": "...", "clientInfo": {...} } }
Server → Client: { "result": { "serverInfo": {...}, "capabilities": {...} } }
Client → Server: { "method": "notifications/initialized" }
```

After the handshake, the client can:
- Call `tools/list` to discover available tools
- Call `tools/call` to invoke a specific tool
- Call `resources/list`, `prompts/list` for other MCP features

### Why stdio?

Messages are sent line by line over `stdin`/`stdout`. The client writes a JSON line to the server's `stdin`. The server reads it, processes it, and writes a JSON line to its `stdout`. The client reads that.

This is simple and works without any networking, ports, or authentication. The MCP SDK handles all of this — you never write the raw JSON yourself.

---

## 4. Project 1: mcp-supabase (The MCP Server)

### 4.1 Project Structure

```
mcp-supabase/
├── src/
│   ├── index.ts          ← Entry point: creates the server and starts it
│   ├── supabase.ts       ← Creates the Supabase client using env vars
│   └── tools/
│       ├── database.ts   ← Registers 5 database tools
│       ├── auth.ts       ← Registers 6 auth tools
│       └── storage.ts    ← Registers 7 storage tools
├── dist/                 ← TypeScript compiles here (git-ignored)
├── .env.example          ← Template for credentials
├── .gitignore
├── package.json
└── tsconfig.json
```

The structure is deliberately simple. Each file has one job. The tools are split into three files by Supabase service (database, auth, storage) so they are easy to find and modify independently.

---

### 4.2 package.json — Why These Dependencies

```json
{
  "name": "mcp-supabase",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@supabase/supabase-js": "^2.45.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

**`"type": "module"`** — This tells Node.js to treat every `.js` file as an ES module (uses `import`/`export` syntax) instead of CommonJS (uses `require`). This is required because the MCP SDK is built as an ES module. Without this, you would get errors about `import` not being recognised.

**`@modelcontextprotocol/sdk`** — The official Anthropic MCP SDK. Provides the `McpServer` class, `StdioServerTransport`, and all the protocol handling. Without this you would have to write all the JSON-RPC message parsing yourself.

**`@supabase/supabase-js`** — The official Supabase JavaScript client. It provides a clean API for querying the database (`supabase.from('table').select()`), managing auth users, and working with storage.

**`zod`** — A TypeScript-first schema validation library. Used to define the shape of each tool's input arguments. The MCP SDK uses Zod schemas to generate the `inputSchema` JSON that tells Claude what arguments each tool accepts.

**`@types/node`** — TypeScript type definitions for Node.js built-in APIs like `process.env`, `process.stderr`, etc. Without this, TypeScript would complain when you access Node.js globals.

---

### 4.3 tsconfig.json — Why NodeNext Matters

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

**`"module": "NodeNext"` and `"moduleResolution": "NodeNext"`** — These two settings are the most important. They tell TypeScript to resolve modules the same way Node.js does with ES modules. This means:
- Import paths must include the `.js` extension even for TypeScript files (e.g., `import { supabase } from "./supabase.js"` — note the `.js`, not `.ts`)
- Package imports follow the `"exports"` field in `package.json`

This was a critical bug we hit. Using `"module": "CommonJS"` caused `__dirname is not defined` errors at runtime because CommonJS globals don't exist in ES module scope.

**`"strict": true`** — Enables all TypeScript strict checks. This catches bugs at compile time. For example, it forced us to properly type the `contains` filter (which required casting through `unknown`).

**`"target": "ES2022"`** — The version of JavaScript TypeScript compiles down to. ES2022 supports `async/await`, `Promise`, and all modern features natively without needing polyfills.

---

### 4.4 src/supabase.ts — The Database Connection

```typescript
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
```

**Why `process.env` and not a `.env` file?**

The credentials are injected as environment variables by whoever runs the server — Claude Desktop does this via the `env` block in `claude_desktop_config.json`, and the mcp-client does this when spawning the server as a child process. The server itself never needs to read a file. This is the correct pattern for MCP servers.

We originally used `dotenv` and `path.resolve(__dirname, "../.env")`, but this crashed with `ReferenceError: __dirname is not defined in ES module scope` because `__dirname` only exists in CommonJS modules. In ES modules, the equivalent is `import.meta.url`, but since we didn't actually need dotenv at all, we removed it.

**Why `service_role` key?**

Supabase has two keys:
- `anon` key — for public-facing apps, subject to Row Level Security (RLS) policies
- `service_role` key — for admin/server-side use, bypasses RLS entirely

Since this server is a trusted backend tool that should have full access to all data, the `service_role` key is correct. You would never use this key in a browser or mobile app.

**Why `autoRefreshToken: false` and `persistSession: false`?**

These options are for Supabase's auth session management, which is designed for client-side apps that log users in. This server is not a user-facing app — it is an admin tool. Disabling session persistence prevents unnecessary network calls and keeps the client stateless.

**The singleton pattern**

The `supabase` client is exported as a singleton — one instance shared across all tool files. Creating multiple clients would waste memory and connections. All three tool files (`database.ts`, `auth.ts`, `storage.ts`) import this one shared instance.

---

### 4.5 src/tools/database.ts — All 5 Database Tools

This file registers five tools for working with Supabase database tables. Let's go through each one.

#### How a tool is registered

Every tool follows this pattern:

```typescript
server.tool(
  "tool_name",          // 1. The name Claude uses to call this tool
  "Description...",    // 2. What Claude reads to decide when to use this tool
  { /* zod schema */ },// 3. The input arguments schema
  async (args) => {    // 4. The handler function
    // Do the work
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);
```

The **description** is critically important. Claude reads it to decide which tool to call. A vague description leads to wrong tool choices. A clear description leads to correct ones.

The **Zod schema** serves two purposes: it validates incoming arguments at runtime, and it generates the `inputSchema` JSON that gets sent to Claude so it knows what arguments to provide.

The **handler** must always return `{ content: [{ type: "text", text: "..." }] }`. This is the MCP response format. The text can be anything — we always serialize it as JSON for consistency.

#### `db_list_tables`

```typescript
server.tool("db_list_tables", "List all tables...", {}, async () => {
  const response = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const spec = await response.json();
  const tables = Object.entries(spec.definitions ?? {}).map(([name, def]) => ({
    table: name,
    columns: Object.entries(def.properties ?? {}).map(([col, meta]) => ({
      column: col,
      type: meta.format ?? meta.type ?? "unknown",
    })),
  }));
  // ...
});
```

This tool hits the Supabase REST API's root endpoint (`/rest/v1/`). Supabase exposes an **OpenAPI specification** at this URL — a JSON document that describes every table in the public schema as a "definition" object, with each column listed as a "property".

We cannot use `supabase.from('information_schema.tables')` because PostgREST (the layer Supabase uses) does not expose `information_schema` through its REST API. The OpenAPI spec is the correct way to discover tables.

#### `db_query`

```typescript
server.tool(
  "db_query",
  "Query rows from a Supabase table...",
  {
    table: z.string(),
    columns: z.string().optional().default("*"),
    filters: z.array(z.object({
      column: z.string(),
      operator: z.enum(["eq", "neq", "gt", ...]),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })).optional().default([]),
    order_by: z.string().optional(),
    ascending: z.boolean().optional().default(true),
    limit: z.number().optional().default(100),
    offset: z.number().optional().default(0),
  },
  async ({ table, columns, filters, order_by, ascending, limit, offset }) => {
    let query = supabase.from(table).select(columns ?? "*");
    for (const f of filters ?? []) {
      switch (f.operator) {
        case "eq": query = query.eq(f.column, f.value); break;
        // ... other operators
      }
    }
    // ... ordering and pagination
    const { data, error } = await query;
  }
);
```

The `filters` array allows Claude to build complex WHERE clauses. Claude might call this tool as:
```json
{
  "table": "subscribers_sarfaraz_pro",
  "filters": [{"column": "email", "operator": "ilike", "value": "%gmail%"}],
  "limit": 10
}
```

The `switch` statement maps MCP operator names to Supabase query builder methods. Each operator like `eq`, `neq`, `ilike` corresponds to a Supabase method of the same name.

**The `contains` bug** — `f.value` was typed as `string | number | boolean | null` but Supabase's `.contains()` method only accepts `string | readonly unknown[] | Record<string, unknown>`. TypeScript wouldn't allow a direct cast between non-overlapping types, so we used `as unknown as ...` to go through the `unknown` escape hatch. This is the correct TypeScript pattern when you know more than the type system does.

#### `db_insert`, `db_update`, `db_delete`

These follow the same pattern — build a Supabase query, execute it, return the result. Key points:

- `db_insert` supports `upsert: true` which is INSERT + UPDATE on conflict. Useful for syncing data.
- `db_update` and `db_delete` take a single `filter_column` + `filter_value` pair (e.g., `id = 5`). This is intentionally simple — for complex filters, Claude would call `db_query` first to find the rows, then use the IDs.
- All three call `.select()` at the end to return the affected rows so Claude can confirm what changed.

#### `db_rpc`

```typescript
server.tool("db_rpc", "Call a Postgres function...", {
  function_name: z.string(),
  params: z.record(z.unknown()).optional().default({}),
}, async ({ function_name, params }) => {
  const { data, error } = await supabase.rpc(function_name, params ?? {});
});
```

Supabase allows you to write custom PostgreSQL functions and call them via RPC (Remote Procedure Call). This tool is an escape hatch for anything the other tools can't do — complex queries, aggregations, business logic stored in the database, etc. You would define a function in Supabase's SQL editor, then Claude can call it by name.

---

### 4.6 src/tools/auth.ts — All 6 Auth Tools

All auth tools use `supabase.auth.admin.*` — the admin API that requires the `service_role` key. This is different from `supabase.auth.*` which is for end-users signing in.

#### `auth_list_users`

```typescript
const { data, error } = await supabase.auth.admin.listUsers({
  page: page ?? 1,
  perPage: per_page ?? 50,
});
```

Returns a paginated list of users. The response is mapped to a cleaner shape — only the useful fields are returned (id, email, role, created_at, etc.) rather than the full Supabase user object which has many internal fields.

#### `auth_create_user`

```typescript
const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: email_confirmed ?? true,
  user_metadata: user_metadata ?? {},
});
```

`email_confirm: true` skips the email confirmation step — useful for creating test users or admin-created accounts. In a production app you would set this to `false` and let Supabase send the confirmation email.

#### `auth_update_user`

```typescript
if (ban !== undefined) updates.ban_duration = ban ? "876600h" : "none";
```

Supabase bans users by setting a `ban_duration`. The value `"876600h"` is 100 years — effectively permanent. Setting it to `"none"` unbans them. This is the Supabase API convention.

#### `auth_generate_magic_link`

```typescript
const { data, error } = await supabase.auth.admin.generateLink({
  type: "magiclink",
  email,
});
```

A magic link is a one-time sign-in URL that bypasses password authentication. The link is returned in `data.properties.action_link`. This is useful for sending to users who forgot their password or for testing authentication flows.

---

### 4.7 src/tools/storage.ts — All 7 Storage Tools

#### `storage_list_files`

```typescript
const { data, error } = await supabase.storage.from(bucket).list(folder ?? "", {
  limit: limit ?? 100,
  offset: offset ?? 0,
  sortBy: { column: "name", order: "asc" },
});
```

Lists files in a specific bucket and optional folder path. Supabase storage uses a hierarchical folder structure — `folder` is a path prefix like `"images/avatars"`.

#### `storage_upload_from_url`

```typescript
const response = await fetch(source_url);
const arrayBuffer = await response.arrayBuffer();
const { data, error } = await supabase.storage.from(bucket)
  .upload(destination_path, arrayBuffer, {
    contentType: mimeType,
    upsert: true,
  });
```

This is the most interesting storage tool. It fetches a file from any public URL, reads it into memory as an `ArrayBuffer`, then uploads it to Supabase Storage. This means Claude can say: *"Download the image at this URL and store it in the avatars bucket"* — without any manual file handling.

`upsert: true` means if a file already exists at that path, overwrite it. Without this, the upload would fail if the file exists.

#### `storage_create_signed_url`

```typescript
const { data, error } = await supabase.storage
  .from(bucket)
  .createSignedUrl(path, expires_in ?? 3600);
```

For private buckets (where files are not publicly accessible), you need a signed URL — a time-limited URL with a cryptographic signature that proves it was issued by someone with the service role key. After `expires_in` seconds, the URL stops working.

---

### 4.8 src/index.ts — The Server Entry Point

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDatabaseTools } from "./tools/database.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerStorageTools } from "./tools/storage.js";

async function main() {
  const server = new McpServer({
    name: "mcp-supabase",
    version: "1.0.0",
    description: "MCP server providing Claude with full access to Supabase...",
  });

  registerDatabaseTools(server);
  registerAuthTools(server);
  registerStorageTools(server);

  const transport = new StdioServerTransport();

  transport.onmessage = (msg) => {
    const m = msg as { method?: string; params?: { name?: string } };
    if (m.method === "tools/call") {
      process.stderr.write(`[mcp-supabase] 🔧 Tool called: ${m.params?.name}\n`);
    }
  };

  await server.connect(transport);
  process.stderr.write("[mcp-supabase] ✅ Server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
```

**Why `process.stderr` instead of `console.log`?**

This is the single most important rule for MCP servers: **never write to stdout**. The MCP protocol uses `stdout` for JSON-RPC messages. If you accidentally write a log message to `stdout`, the client will receive it as part of the JSON stream, fail to parse it, and crash. `stderr` is a separate pipe that is never mixed with `stdout` — safe for logs.

**Why wrap everything in `main()`?**

Node.js ES modules don't allow `await` at the top level in older versions. Wrapping in an `async function main()` and immediately calling it is the safe pattern that works everywhere. The `.catch()` at the end ensures unhandled errors are logged and the process exits with a non-zero code — so the MCP client knows the server crashed.

**The `registerXxxTools(server)` pattern**

Each tool file exports a single `register` function that takes the `server` as an argument and calls `server.tool(...)` multiple times. This keeps `index.ts` clean and makes it easy to add or remove entire tool groups. If you wanted to add a new category (e.g., Supabase Edge Functions), you would create `tools/functions.ts` with a `registerFunctionTools(server)` export and add one line to `index.ts`.

---

## 5. Project 2: mcp-client (The MCP Client)

### 5.1 Project Structure

```
mcp-client/
├── src/
│   ├── server.ts         ← Express server — HTTP routes + agentic loop
│   └── mcpClient.ts      ← MCP SDK Client — connects to MCP server via stdio
├── public/
│   └── index.html        ← The complete web UI (HTML + CSS + JS in one file)
├── dist/                 ← Compiled output (git-ignored)
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

### 5.2 src/mcpClient.ts — The MCP Client Core

This is the heart of the client — the code that actually speaks MCP.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
```

The `Client` class from the MCP SDK handles all the JSON-RPC protocol mechanics — serializing/deserializing messages, matching request IDs to responses, and managing the connection state. We just use its high-level API.

#### Connecting to the Server

```typescript
async connect(): Promise<void> {
  if (this.connected) return;

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
}
```

`StdioClientTransport` does the heavy lifting here. When you call `this.client.connect(transport)`:
1. It spawns a new child process: `node /path/to/mcp-supabase/dist/index.js`
2. It connects the child's `stdin` and `stdout` to pipes
3. It sends the MCP `initialize` handshake
4. It waits for the server to respond with its capabilities

The `env` spread (`...process.env`) passes through all environment variables from the parent process, then we explicitly add the Supabase credentials. This is how credentials reach the server — not through a file, but through the process environment.

The `if (this.connected) return` guard prevents connecting twice. Since `connect()` is called at the start of every method (`listTools`, `callTool`), this lazy connection pattern ensures the server is only spawned once regardless of how many times the methods are called.

#### Listing Tools

```typescript
async listTools(): Promise<MCPTool[]> {
  await this.connect();
  const result = await this.client.listTools();
  return result.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}
```

`this.client.listTools()` sends `{ "method": "tools/list" }` to the server and returns the parsed response. The server replies with all 18 tools, each with its name, description, and Zod-generated JSON schema. We map the result to a simpler shape for use in `server.ts`.

#### Calling a Tool

```typescript
async callTool(name: string, args: Record<string, unknown>): Promise<string> {
  await this.connect();
  const result = await this.client.callTool({ name, arguments: args });
  const textParts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string);
  return textParts.join("\n") || JSON.stringify(result.content);
}
```

`this.client.callTool()` sends a `tools/call` request and waits for the response. MCP responses can contain multiple content blocks (text, images, etc.) — we filter for text blocks and join them. In practice, all our tools return a single text block with a JSON string.

#### The Singleton

```typescript
export const mcpClient = new MCPClient();
```

This creates one `MCPClient` instance that is shared across the entire Express server. The MCP server child process is spawned once and stays alive for the lifetime of the Express server. Every API request reuses the same connection — no reconnecting on every request.

---

### 5.3 src/server.ts — The Express Backend

This file has three jobs: serve the static HTML, provide the direct tool call route, and provide the Claude AI route with the agentic loop.

#### Loading .env Without dotenv

```typescript
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
```

We don't use the `dotenv` package here — instead we read the `.env` file manually. This avoids the `__dirname` problem entirely, since we compute `__dirname` using the ES module pattern:

```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

`import.meta.url` gives the full URL of the current module file (e.g., `file:///Users/.../dist/server.js`). `fileURLToPath` converts it to a regular path. This is the correct ES module replacement for CommonJS `__dirname`.

#### GET /api/tools

```typescript
app.get("/api/tools", async (_req, res) => {
  const tools = await mcpClient.listTools();
  res.json({ tools });
});
```

The browser calls this on page load to populate the MCP Inspector sidebar. It simply asks the MCP client for all tools and returns them as JSON.

#### POST /api/tool — Direct Call (No Claude)

```typescript
app.post("/api/tool", async (req, res) => {
  const { tool, args } = req.body;
  const result = await mcpClient.callTool(tool, args ?? {});
  res.json({ result: JSON.parse(result) });
});
```

This is the simplest route. The browser sends `{ tool: "db_query", args: { table: "..." } }`. We call the MCP server directly and return the raw result. No AI involved. This is the MCP Inspector mode.

#### POST /api/chat — The Agentic Loop

This is the most complex part of the entire project. Let's walk through it step by step.

```typescript
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  const mcpTools = await mcpClient.listTools();
  const anthropicTools = mcpTools.map(toAnthropicTool);
  const messages = [...history, { role: "user", content: message }];
  const toolCallLog = [];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "You are a helpful data assistant...",
      messages,
      tools: anthropicTools,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Claude is done — send the final text response
      res.json({ reply: textContent, toolCalls: toolCallLog });
      return;
    }

    if (response.stop_reason === "tool_use") {
      // Claude wants to call tools — execute them and feed results back
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await mcpClient.callTool(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
      // Loop continues — Claude will respond again with tool results in context
    }
  }
});
```

**Step by step:**

1. We fetch all 18 MCP tools and convert them to Anthropic's tool format
2. We build the message history (previous turns + new user message)
3. We call Claude's API, passing the tools so Claude knows what's available
4. Claude responds — either with a final answer (`end_turn`) or with tool calls (`tool_use`)
5. If Claude wants to call tools, we loop through each tool call block, execute it via the MCP client, and collect the results
6. We add the tool results to the message history as `tool_result` blocks
7. We call Claude again with the updated history — Claude now sees what the tools returned
8. We repeat until Claude says `end_turn`

This is the **agentic loop**. The key insight is that Claude never directly calls your tools — it tells you what it wants to call, you execute it, and you tell Claude what happened. Claude is the decision maker; your code is the executor.

#### Converting MCP tools to Anthropic format

```typescript
function toAnthropicTool(tool: MCPTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}
```

The MCP tool format and the Anthropic API tool format are almost identical. Both use `name`, `description`, and a JSON Schema for the input. The Anthropic SDK calls it `input_schema` instead of `inputSchema` — a minor naming difference. We reuse the same JSON Schema that the MCP server generated from our Zod definitions.

---

### 5.4 public/index.html — The Web UI

The entire frontend is a single HTML file with embedded CSS and JavaScript. No React, no Vue, no build step for the frontend. This keeps it simple and makes it easy to understand.

#### Tab switching

```javascript
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});
```

When a tab is clicked, remove `active` from all tabs and panels, then add it to the clicked tab and its corresponding panel. The CSS uses `display: none` on non-active panels and `display: flex` on the active one.

#### Auto-resizing textarea

```javascript
chatInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
```

Sets the height to `auto` first (collapse to minimum), then sets it to `scrollHeight` (the actual content height). Capped at 120px so it doesn't grow indefinitely. This gives a natural expanding text input.

#### Conversation history

```javascript
const conversationHistory = [];
// After each exchange:
conversationHistory.push({ role: 'user', content: text });
conversationHistory.push({ role: 'assistant', content: data.reply });
```

Conversation history is kept in a JavaScript array in memory. Each message pair is pushed after each exchange. On the next message, the entire history is sent to the `/api/chat` endpoint so Claude has context from previous turns. This enables multi-turn conversations.

#### MCP Inspector — auto-generating default args

```javascript
const props = tool.inputSchema?.properties || {};
const defaults = {};
for (const [key, schema] of Object.entries(props)) {
  if (schema.default !== undefined) defaults[key] = schema.default;
  else if (schema.type === 'string') defaults[key] = '';
  else if (schema.type === 'number') defaults[key] = 0;
  else if (schema.type === 'array') defaults[key] = [];
}
```

When you click a tool in the sidebar, this code reads the tool's JSON Schema (which was generated from our Zod definitions), and creates a default args object. If the Zod schema has a `.default()` value, we use it. Otherwise we generate sensible defaults based on the type. This pre-fills the JSON editor so you don't have to write arguments from scratch.

---

## 6. The Agentic Loop — How Claude Uses Tools

This is worth explaining in more detail because it is the core concept of AI-powered tool use.

When you send Claude a message with tools available, Claude doesn't call the tools itself — it returns a structured response telling you what tool it wants to call and with what arguments. You execute the tool. You tell Claude the result. Claude decides what to do next.

Here is a concrete example. You ask: *"How many subscribers joined this month?"*

**Turn 1 — You send the message:**
```
User: "How many subscribers joined this month?"
Tools: [db_list_tables, db_query, db_insert, ...]
```

**Turn 1 — Claude responds with a tool call:**
```json
{
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "db_query",
      "input": {
        "table": "subscribers_sarfaraz_pro",
        "filters": [{"column": "created_at", "operator": "gte", "value": "2026-05-01"}],
        "columns": "id,email,created_at"
      }
    }
  ]
}
```

**You execute the tool and get back:**
```json
{"rows": [{"id": "...", "email": "...", "created_at": "2026-05-03T..."}], "count": 7}
```

**Turn 2 — You send Claude the tool result:**
```
User (tool_result): [{"type": "tool_result", "tool_use_id": "toolu_01", "content": "{...}"}]
```

**Turn 2 — Claude responds with a final answer:**
```
stop_reason: "end_turn"
"You have 7 new subscribers who joined this month, the most recent signing up on May 15th."
```

Claude can chain multiple tools in a single conversation turn if needed. It might call `db_list_tables` first to see what tables exist, then `db_query` to get the actual data, then give you the answer. Each tool call and result is another cycle of the loop.

---

## 7. How Server and Client Connect

Let's trace exactly what happens from the moment you run `npm start` in mcp-client to the moment you get a result.

**Step 1 — Express server starts**

`node dist/server.js` runs. Express binds to port 3000. The `mcpClient` singleton is created but `connected = false`. No child process yet.

**Step 2 — Browser loads the page**

`GET /` → Express serves `public/index.html`. The browser renders the UI and calls `GET /api/tools`.

**Step 3 — First API call triggers connection**

`GET /api/tools` calls `mcpClient.listTools()`. Inside `listTools()`, `this.connect()` is called. `connected` is `false`, so it proceeds:
- `StdioClientTransport` spawns: `node /path/to/mcp-supabase/dist/index.js`
- The MCP handshake runs over stdin/stdout
- `connected = true`

Now `listTools()` sends `tools/list` and returns all 18 tools.

**Step 4 — User asks a question**

Browser sends `POST /api/chat` with `{ message: "How many subscribers?" }`. The Express route starts the agentic loop. It calls `mcpClient.listTools()` again — this time `connected = true` so no new process is spawned. Then it calls Claude's API.

**Step 5 — Claude calls a tool**

Claude returns `tool_use` blocks. The server calls `mcpClient.callTool("db_query", {...})`. This sends the JSON-RPC message to the MCP server child process over stdin. The MCP server executes the Supabase query and writes the response to stdout. The MCP client reads it and returns the parsed result.

**Step 6 — Result returned to browser**

After the agentic loop finishes, `res.json({ reply: "...", toolCalls: [...] })` sends the response. The browser renders Claude's answer and shows the collapsible tool call log.

---

## 8. How Claude Desktop Connects (Bonus)

Claude Desktop is itself an MCP client — it does exactly what our `mcpClient.ts` does, but it's built into the app. When you add an entry to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "supabase": {
      "command": "node",
      "args": ["/path/to/mcp-supabase/dist/index.js"],
      "env": {
        "SUPABASE_URL": "...",
        "SUPABASE_SERVICE_ROLE_KEY": "..."
      }
    }
  }
}
```

Claude Desktop reads this config on startup, spawns the server as a child process (same as `StdioClientTransport`), performs the handshake, and fetches the tool list. When you chat in Claude Desktop and it needs to call a tool, it goes through the exact same JSON-RPC flow over stdin/stdout.

The difference is that in Claude Desktop, the agentic loop is handled by the app itself. In our mcp-client, we implemented the agentic loop manually in `server.ts`. This is why building your own client is such a good learning exercise — you see what Claude Desktop does internally.

---

## 9. Key Design Decisions and Why

**Why TypeScript instead of Python?**

The MCP SDK has an official TypeScript implementation with the best support and most examples. Python has an MCP SDK too, but TypeScript matches the language of the Supabase JS client, reducing the number of languages in the project.

**Why ESM (`"type": "module"`) instead of CommonJS?**

The MCP SDK is published as an ES module. Mixing CommonJS and ES modules in Node.js is possible but fragile. Using ESM throughout eliminates compatibility issues.

**Why stdio transport instead of HTTP?**

Stdio is simpler for local tools — no port management, no auth, no networking. The MCP server starts when the client needs it and stops when the client stops. HTTP transport is better for remote servers that multiple clients connect to simultaneously.

**Why Express.js instead of a fancier framework?**

Express is minimal, widely understood, and has zero magic. For a learning project with three routes, it is the right choice. The goal was to make the agentic loop logic visible, not hide it behind framework abstractions.

**Why plain HTML instead of React?**

A React app would need a build step, a development server, and knowledge of React to read the code. Plain HTML with vanilla JavaScript is readable by anyone and requires no additional tooling. The UI is simple enough that React would add complexity without benefit.

**Why a singleton MCP client?**

Spawning a new MCP server child process for every HTTP request would be expensive — each spawn requires a full MCP handshake. A singleton keeps one long-lived connection open. The MCP SDK handles concurrent requests by using unique `id` values in JSON-RPC messages to match responses to requests.

---

## 10. Common Errors and What They Mean

**`ReferenceError: __dirname is not defined in ES module scope`**

You used `__dirname` in an ES module. Replace with:
```typescript
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```
Or, better: stop using `__dirname` — pass paths as environment variables instead.

**`Could not find the table 'public.information_schema.tables' in the schema cache`**

You tried to query `information_schema.tables` via `supabase.from()`. PostgREST doesn't expose `information_schema`. Use the OpenAPI spec at `/rest/v1/` instead (what `db_list_tables` does).

**`npm error enoent Could not read package.json`**

You ran `npm install` from the wrong directory. Always `cd` into the project folder first.

**`Server transport closed unexpectedly`** (in MCP logs)

The server process crashed before completing the handshake. Check the logs for the actual error — it's usually a missing environment variable or a TypeScript compilation error.

**`TS2352: Conversion of type X to type Y may be a mistake`**

TypeScript's type checker found a potentially unsafe cast. If you're certain about the runtime type, cast through `unknown` first: `value as unknown as TargetType`.

---

## 11. How to Extend This

**Add a new tool to the MCP server:**

1. Open `src/tools/database.ts` (or auth/storage)
2. Add a new `server.tool(...)` block
3. Run `npm run build` in `mcp-supabase`
4. Restart Claude Desktop or `mcp-client`

**Add a new tool category (e.g., Supabase Edge Functions):**

1. Create `src/tools/functions.ts`
2. Export `registerFunctionTools(server: McpServer)`
3. Import and call it in `src/index.ts`

**Connect to a different database (PostgreSQL, MySQL):**

Replace `src/supabase.ts` with a different database client. The tool files would need to change too, but the structure (`server.tool()`, Zod schemas, return format) stays identical.

**Add authentication to the web UI:**

Add an Express middleware before the API routes:
```typescript
app.use("/api", (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
```

**Stream Claude's responses:**

Replace `anthropic.messages.create()` with `anthropic.messages.stream()` and send chunks to the browser using Server-Sent Events (SSE). This would make Claude's response appear word by word instead of all at once.

---

## 12. Glossary

**MCP (Model Context Protocol)** — An open standard by Anthropic for connecting AI models to external tools and data sources via a JSON-RPC protocol.

**MCP Server** — A process that exposes tools. It listens for tool call requests, executes them, and returns results. Runs passively and waits to be called.

**MCP Client** — A process that connects to an MCP server, discovers its tools, and calls them. Claude Desktop is an MCP client. Our Express server is also an MCP client.

**JSON-RPC** — A remote procedure call protocol that uses JSON for message encoding. Every request has a `method`, `params`, and `id`. Every response has a `result` or `error` and the matching `id`.

**stdio transport** — Communication method where messages are sent over `stdin` (standard input) and `stdout` (standard output) pipes between processes. Used for local MCP servers.

**Tool** — A named function that an MCP server exposes. Has a name, description, input schema, and handler. Claude reads the description to decide when to use it.

**Agentic loop** — The cycle of sending a message to Claude, receiving tool call requests, executing the tools, feeding results back to Claude, and repeating until Claude gives a final answer.

**`service_role` key** — A Supabase API key that bypasses Row Level Security and has full admin access to the database. Must never be exposed publicly.

**Zod** — A TypeScript schema validation library. Used to define the shape of tool inputs. The MCP SDK uses Zod schemas to generate JSON Schema descriptions of tool parameters.

**ESM (ES Modules)** — The modern JavaScript module system using `import`/`export`. The alternative is CommonJS using `require`/`module.exports`. Node.js supports both but they have important differences.

**`__dirname`** — A CommonJS global variable containing the directory of the current file. Does not exist in ES modules. Replaced by `path.dirname(fileURLToPath(import.meta.url))`.

**Child process** — A process spawned by another process. The MCP client spawns the MCP server as a child process using Node.js's `child_process` module (handled internally by `StdioClientTransport`).

**Singleton** — A design pattern where only one instance of a class is created and shared. Our `mcpClient` is a singleton — one MCP connection for the entire Express server lifetime.

---

*Built by Sarfaraz Shaikh as part of his AI Expert learning journey.*  
*[sarfaraz.pro](https://sarfaraz.pro) · [LinkedIn](https://linkedin.com/in/sarfaraz-shaikh) · [GitHub](https://github.com/sarfaraz-shaikh)*
