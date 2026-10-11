import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });
server.tool("echo", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
