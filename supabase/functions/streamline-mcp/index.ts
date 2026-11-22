import { createHandler } from "./handler.ts";
const projectURL = Deno.env.get("SUPABASE_URL")!;
Deno.serve(createHandler({
  projectURL,
  publishableKey: Deno.env.get("MCP_PUBLISHABLE_KEY") ?? "",
  ownerID: Deno.env.get("MCP_OWNER_ID") ?? "",
  clientID: Deno.env.get("MCP_CLIENT_ID") ?? "",
  resourceURL: `${projectURL}/functions/v1/streamline-mcp`,
  writesEnabled: Deno.env.get("MCP_WRITES_ENABLED") === "true",
}));
