import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_APPEND_BYTES = 65536;

export const appendTaskNoteTool: Tool = {
  name: "append_task_note",
  description: "Atomically append a contribution to task notes without replacing existing text. Requires the database migration. Generate a request_id UUID once per contribution and reuse it with identical content for ALL retries, including after a timeout. A reused key with different content fails. Separate contributions need different keys. Later intentional rewrites can still replace notes.",
  inputSchema: {
    type: "object",
    properties: {
      uuid: { type: "string", format: "uuid", description: "Task UUID" },
      content: { type: "string", minLength: 1, maxLength: MAX_APPEND_BYTES, description: "Nonblank contribution, up to 65536 UTF-8 bytes. Preserved exactly; two newlines separate it from nonempty existing notes." },
      request_id: { type: "string", format: "uuid", description: "Stable UUID for this contribution; reuse on retries, never generate a new one to retry an uncertain result" },
    },
    required: ["uuid", "content", "request_id"],
    additionalProperties: false,
  },
};

interface AppendClient {
  getUserID(): string;
  rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T>;
}

interface AppendResult {
  success: true;
  uuid: string;
  request_id: string;
  appended: boolean;
  appended_at: string;
}

export async function appendTaskNote(client: AppendClient, args: Record<string, unknown>): Promise<AppendResult> {
  if (Object.keys(args).some(key => !["uuid", "content", "request_id"].includes(key))) {
    throw new Error("Only uuid, content, and request_id are accepted");
  }
  for (const key of ["uuid", "request_id"] as const) {
    if (typeof args[key] !== "string" || !UUID.test(args[key])) throw new Error(`${key} must be a UUID`);
  }
  const content = args.content;
  if (typeof content !== "string" || !content.trim() || content.includes("\0") || /[\uD800-\uDFFF]/u.test(content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) {
    throw new Error("content must be nonblank text without NUL or unpaired surrogates");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_APPEND_BYTES) throw new Error("content exceeds 65536 UTF-8 bytes");
  const userID = client.getUserID();
  if (!UUID.test(userID)) throw new Error("Configured user ID must be a UUID");
  // One database transaction; never fall back to a read/merge/PATCH sequence.
  const result = await client.rpc<AppendResult>("append_task_note", {
    p_user_id: userID,
    p_task_id: args.uuid,
    p_request_id: args.request_id,
    p_content: content,
  });
  if (!result || result.success !== true || typeof result.appended !== "boolean" ||
      typeof result.uuid !== "string" || typeof result.request_id !== "string" ||
      result.uuid.toLowerCase() !== (args.uuid as string).toLowerCase() ||
      result.request_id.toLowerCase() !== (args.request_id as string).toLowerCase() ||
      typeof result.appended_at !== "string") {
    throw new Error("Unexpected append response; outcome uncertain. Retry only with the same request_id and content.");
  }
  return result;
}
