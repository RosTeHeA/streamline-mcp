#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  projectURL: string;
  apiKey: string;
  userID: string;
}

function loadConfig(): Config {
  const configPaths = [
    process.env.SUPABASE_CONFIG_PATH,
    join(process.cwd(), "config.json"),
    join(homedir(), ".config", "streamline-mcp", "config.json"),
    join(homedir(), ".config", "streamline-mcp", "supabase.json"),
  ].filter(Boolean) as string[];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);

      // Allow environment variable overrides
      return {
        projectURL: process.env.SUPABASE_URL || config.projectURL,
        apiKey: process.env.SUPABASE_API_KEY || config.apiKey,
        userID: process.env.SUPABASE_USER_ID || config.userID,
      };
    }
  }

  // Check for all env vars
  if (process.env.SUPABASE_URL && process.env.SUPABASE_API_KEY && process.env.SUPABASE_USER_ID) {
    return {
      projectURL: process.env.SUPABASE_URL,
      apiKey: process.env.SUPABASE_API_KEY,
      userID: process.env.SUPABASE_USER_ID,
    };
  }

  throw new Error(
    "Config not found. Create ~/.config/streamline-mcp/config.json or set SUPABASE_URL, SUPABASE_API_KEY, SUPABASE_USER_ID"
  );
}

// ============================================================================
// Supabase Client
// ============================================================================

class SupabaseClient {
  private baseURL: string;
  private headers: Record<string, string>;
  private userID: string;

  constructor(config: Config) {
    this.baseURL = `${config.projectURL}/rest/v1`;
    this.userID = config.userID;
    this.headers = {
      apikey: config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
  }

  async select<T>(
    table: string,
    options: {
      filters?: string[];
      order?: string;
      limit?: number;
    } = {}
  ): Promise<T[]> {
    const params = new URLSearchParams();
    params.set("select", "*");

    for (const filter of options.filters || []) {
      const [col, rest] = filter.split("=");
      params.append(col, rest);
    }

    if (options.order) params.set("order", options.order);
    if (options.limit) params.set("limit", options.limit.toString());

    const response = await fetch(`${this.baseURL}/${table}?${params}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async insert<T>(table: string, data: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseURL}/${table}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.status} ${await response.text()}`);
    }

    const results = await response.json();
    return results[0];
  }

  async update<T>(
    table: string,
    filters: string[],
    data: Record<string, unknown>
  ): Promise<T[]> {
    const params = new URLSearchParams();
    for (const filter of filters) {
      const [col, rest] = filter.split("=");
      params.append(col, rest);
    }

    const response = await fetch(`${this.baseURL}/${table}?${params}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async delete(table: string, filters: string[]): Promise<void> {
    const params = new URLSearchParams();
    for (const filter of filters) {
      const [col, rest] = filter.split("=");
      params.append(col, rest);
    }

    const response = await fetch(`${this.baseURL}/${table}?${params}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.status} ${await response.text()}`);
    }
  }

  getUserID(): string {
    return this.userID;
  }
}

// ============================================================================
// Date Helpers
// ============================================================================

function parseDate(input: string | undefined): Date | null {
  if (!input) return null;

  const lower = input.toLowerCase().trim();
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  if (lower === "today") return today;
  if (lower === "tomorrow") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (lower === "yesterday") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // Try ISO format
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    parsed.setHours(12, 0, 0, 0);
    return parsed;
  }

  return null;
}

function formatDate(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ============================================================================
// Tool Definitions
// ============================================================================

const tools: Tool[] = [
  {
    name: "search_tasks",
    description: "Search tasks by name, tags, due date, or status.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in task names and notes" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tag names" },
        include_completed: { type: "boolean", description: "Include completed tasks (default: false)" },
        due_before: { type: "string", description: "Filter tasks due on or before (today, tomorrow, YYYY-MM-DD)" },
        due_after: { type: "string", description: "Filter tasks due on or after" },
        limit: { type: "integer", description: "Maximum results (default: 20)" },
      },
    },
  },
  {
    name: "read_task",
    description: "Get full details of a task by UUID.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "The task UUID" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name (required)" },
        notes: { type: "string", description: "Additional notes" },
        due_date: { type: "string", description: "Due date (today, tomorrow, YYYY-MM-DD)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to assign" },
        is_urgent: { type: "boolean", description: "Mark as urgent" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_task",
    description: "Update a task.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (required)" },
        name: { type: "string", description: "New name" },
        notes: { type: "string", description: "New notes" },
        due_date: { type: "string", description: "New due date" },
        is_urgent: { type: "boolean", description: "Urgency status" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed or uncompleted.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (required)" },
        completed: { type: "boolean", description: "Completion status (default: true)" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "delete_task",
    description: "Move task to trash or delete permanently.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (required)" },
        permanent: { type: "boolean", description: "Permanently delete (default: false)" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "search_notes",
    description: "Search notes by title, content, or tags.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tag names" },
        include_archived: { type: "boolean", description: "Include archived notes" },
        limit: { type: "integer", description: "Maximum results (default: 20)" },
      },
    },
  },
  {
    name: "read_note",
    description: "Get full content of a note by UUID.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Note UUID" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note with markdown content.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Note content in markdown" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to assign" },
      },
    },
  },
  {
    name: "update_note",
    description: "Update a note. Use 'append' to add to existing content.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Note UUID (required)" },
        content: { type: "string", description: "Replace entire content" },
        append: { type: "string", description: "Append to existing content" },
        is_flagged: { type: "boolean", description: "Flag status" },
        is_archived: { type: "boolean", description: "Archive status" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "delete_note",
    description: "Move note to trash or delete permanently.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Note UUID (required)" },
        permanent: { type: "boolean", description: "Permanently delete" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "list_tags",
    description: "List all tags with usage counts.",
    inputSchema: {
      type: "object",
      properties: {
        include_hidden: { type: "boolean", description: "Include hidden tags" },
      },
    },
  },
  {
    name: "create_tag",
    description: "Create a new tag.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tag name (required)" },
      },
      required: ["name"],
    },
  },
  {
    name: "tag_item",
    description: "Add a tag to a task or note.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Tag name (required)" },
        uuid: { type: "string", description: "Item UUID (required)" },
        type: { type: "string", description: "Item type: 'task' or 'note' (default: task)" },
      },
      required: ["tag", "uuid"],
    },
  },
  {
    name: "untag_item",
    description: "Remove a tag from a task or note.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Tag name (required)" },
        uuid: { type: "string", description: "Item UUID (required)" },
        type: { type: "string", description: "Item type: 'task' or 'note' (default: task)" },
      },
      required: ["tag", "uuid"],
    },
  },
  {
    name: "list_workspaces",
    description: "List all workspaces.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_workspace",
    description: "Get workspace details.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Workspace UUID" },
      },
      required: ["uuid"],
    },
  },
];

// ============================================================================
// Tool Executor
// ============================================================================

class ToolExecutor {
  private client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "search_tasks":
          return await this.searchTasks(args);
        case "read_task":
          return await this.readTask(args);
        case "create_task":
          return await this.createTask(args);
        case "update_task":
          return await this.updateTask(args);
        case "complete_task":
          return await this.completeTask(args);
        case "delete_task":
          return await this.deleteTask(args);
        case "search_notes":
          return await this.searchNotes(args);
        case "read_note":
          return await this.readNote(args);
        case "create_note":
          return await this.createNote(args);
        case "update_note":
          return await this.updateNote(args);
        case "delete_note":
          return await this.deleteNote(args);
        case "list_tags":
          return await this.listTags(args);
        case "create_tag":
          return await this.createTag(args);
        case "tag_item":
          return await this.tagItem(args);
        case "untag_item":
          return await this.untagItem(args);
        case "list_workspaces":
          return await this.listWorkspaces();
        case "read_workspace":
          return await this.readWorkspace(args);
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      return JSON.stringify({ error: String(error) });
    }
  }

  // --------------------------------------------------------------------------
  // Task Tools
  // --------------------------------------------------------------------------

  private async searchTasks(args: Record<string, unknown>): Promise<string> {
    const filters = [
      `user_id=eq.${this.client.getUserID()}`,
      "is_deleted=eq.false",
    ];

    if (!args.include_completed) {
      filters.push("status=eq.false");
    }

    const dueBefore = parseDate(args.due_before as string);
    if (dueBefore) {
      const nextDay = new Date(dueBefore);
      nextDay.setDate(nextDay.getDate() + 1);
      filters.push(`due_date=lt.${nextDay.toISOString()}`);
    }

    const dueAfter = parseDate(args.due_after as string);
    if (dueAfter) {
      filters.push(`due_date=gte.${dueAfter.toISOString()}`);
    }

    let tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters,
      order: "due_date.asc.nullslast",
      limit: (args.limit as number) || 20,
    });

    // Filter by query text
    const query = args.query as string;
    if (query) {
      const lower = query.toLowerCase();
      tasks = tasks.filter((t) => {
        const name = (t.name as string || "").toLowerCase();
        const note = (t.note as string || "").toLowerCase();
        return name.includes(lower) || note.includes(lower);
      });
    }

    // Filter by tags
    const tagNames = args.tags as string[];
    if (tagNames?.length) {
      const tagIDs = await this.getTagIDsByNames(tagNames);
      if (tagIDs.length) {
        const taskIDs = await this.getTaskIDsWithTags(tagIDs);
        tasks = tasks.filter((t) => taskIDs.has(t.id as string));
      } else {
        tasks = [];
      }
    }

    if (tasks.length === 0) {
      return "No tasks found matching your criteria.";
    }

    const results = tasks.map((t) => ({
      uuid: t.id,
      name: t.name,
      completed: t.status,
      due_date: t.due_date ? formatDate(t.due_date as string) : undefined,
      notes: t.note ? (t.note as string).slice(0, 100) : undefined,
      is_urgent: t.is_urgent_alarm || undefined,
    }));

    return JSON.stringify({ count: results.length, tasks: results }, null, 2);
  }

  private async readTask(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) {
      return `Task not found with UUID: ${uuid}`;
    }

    const t = tasks[0];
    const tagNames = await this.getTagNamesForTask(uuid);

    return JSON.stringify(
      {
        uuid: t.id,
        name: t.name,
        notes: t.note,
        completed: t.status,
        due_date: t.due_date ? formatDate(t.due_date as string) : undefined,
        created: formatDate(t.created_at as string),
        completed_date: t.completed_date ? formatDate(t.completed_date as string) : undefined,
        recurrence: t.recurrence_summary,
        is_urgent: t.is_urgent_alarm,
        tags: tagNames.length ? tagNames : undefined,
      },
      null,
      2
    );
  }

  private async createTask(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    if (!name) return JSON.stringify({ error: "Task name is required" });

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();
    const dueDate = parseDate(args.due_date as string);

    await this.client.insert("tasks", {
      id: uuid,
      user_id: this.client.getUserID(),
      name,
      note: args.notes || null,
      status: false,
      due_date: dueDate?.toISOString() || null,
      is_urgent_alarm: args.is_urgent || false,
      is_recurring_template: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      source: "00000000-0000-0000-0000-000000000000",  // Required for app visibility
    });

    // Handle tags
    const tagNames = args.tags as string[];
    if (tagNames?.length) {
      const tagIDs = await this.getOrCreateTagIDs(tagNames);
      for (const tagID of tagIDs) {
        await this.client.insert("task_tags", { task_id: uuid, tag_id: tagID });
      }
    }

    return JSON.stringify({
      success: true,
      uuid,
      message: `Created task: ${name}`,
    });
  }

  private async updateTask(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (args.name !== undefined) updates.name = args.name;
    if (args.notes !== undefined) updates.note = args.notes;
    if (args.is_urgent !== undefined) updates.is_urgent_alarm = args.is_urgent;

    const dueDate = parseDate(args.due_date as string);
    if (dueDate) updates.due_date = dueDate.toISOString();

    await this.client.update("tasks", [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`], updates);

    return JSON.stringify({ success: true, message: "Task updated successfully" });
  }

  private async completeTask(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const completed = args.completed !== false;
    const now = new Date().toISOString();

    // Get task name
    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

    await this.client.update("tasks", [`id=eq.${uuid}`], {
      status: completed,
      completed_date: completed ? now : null,
      updated_at: now,
    });

    const action = completed ? "completed" : "uncompleted";
    return JSON.stringify({
      success: true,
      message: `Task '${tasks[0].name}' marked as ${action}`,
    });
  }

  private async deleteTask(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

    if (args.permanent) {
      await this.client.delete("task_tags", [`task_id=eq.${uuid}`]);
      await this.client.delete("tasks", [`id=eq.${uuid}`]);
    } else {
      const now = new Date().toISOString();
      await this.client.update("tasks", [`id=eq.${uuid}`], {
        trashed_date: now,
        is_deleted: true,
        updated_at: now,
      });
    }

    const action = args.permanent ? "permanently deleted" : "moved to trash";
    return JSON.stringify({
      success: true,
      message: `Task '${tasks[0].name}' ${action}`,
    });
  }

  // --------------------------------------------------------------------------
  // Note Tools
  // --------------------------------------------------------------------------

  private async searchNotes(args: Record<string, unknown>): Promise<string> {
    const filters = [
      `user_id=eq.${this.client.getUserID()}`,
      "is_deleted=eq.false",
    ];

    if (!args.include_archived) {
      filters.push("in_archive=eq.false");
    }

    let notes = await this.client.select<Record<string, unknown>>("notes", {
      filters,
      order: "updated_at.desc",
      limit: (args.limit as number) || 20,
    });

    // Filter by query text
    const query = args.query as string;
    if (query) {
      const lower = query.toLowerCase();
      notes = notes.filter((n) => {
        const title = (n.first_line_clean as string || "").toLowerCase();
        const content = (n.content as string || "").toLowerCase();
        return title.includes(lower) || content.includes(lower);
      });
    }

    // Filter by tags
    const tagNames = args.tags as string[];
    if (tagNames?.length) {
      const tagIDs = await this.getTagIDsByNames(tagNames);
      if (tagIDs.length) {
        const noteIDs = await this.getNoteIDsWithTags(tagIDs);
        notes = notes.filter((n) => noteIDs.has(n.id as string));
      } else {
        notes = [];
      }
    }

    if (notes.length === 0) {
      return "No notes found matching your criteria.";
    }

    const results = notes.map((n) => ({
      uuid: n.id,
      title: n.first_line_clean || "Untitled",
      preview: n.second_line_clean ? (n.second_line_clean as string).slice(0, 150) : undefined,
      last_edited: n.last_edit_date ? formatDate(n.last_edit_date as string) : undefined,
      word_count: n.word_count,
      is_flagged: n.is_flagged,
    }));

    return JSON.stringify({ count: results.length, notes: results }, null, 2);
  }

  private async readNote(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const notes = await this.client.select<Record<string, unknown>>("notes", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (notes.length === 0) return `Note not found with UUID: ${uuid}`;

    const n = notes[0];
    if (n.trashed_date || n.is_deleted) return "This note has been deleted.";

    const tagNames = await this.getTagNamesForNote(uuid);
    let content = n.content as string || "";
    if (content.length > 50000) {
      content = content.slice(0, 50000) + "\n\n[Truncated]";
    }

    return JSON.stringify(
      {
        uuid: n.id,
        title: n.first_line_clean || "Untitled",
        content,
        last_edited: n.last_edit_date ? formatDate(n.last_edit_date as string) : undefined,
        created: n.creation_date ? formatDate(n.creation_date as string) : undefined,
        word_count: n.word_count,
        is_flagged: n.is_flagged,
        is_archived: n.in_archive,
        tags: tagNames.length ? tagNames : undefined,
      },
      null,
      2
    );
  }

  private async createNote(args: Record<string, unknown>): Promise<string> {
    const content = (args.content as string) || "";
    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();

    const lines = content.split("\n");
    const firstLine = lines[0]?.trim() || "Untitled";
    const secondLine = lines.slice(1).find((l) => l.trim())?.trim() || null;
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    await this.client.insert("notes", {
      id: uuid,
      user_id: this.client.getUserID(),
      content,
      first_line_clean: firstLine,
      second_line_clean: secondLine,
      creation_date: now,
      last_edit_date: now,
      is_flagged: false,
      in_archive: false,
      word_count: wordCount,
      is_deleted: false,
    });

    // Handle tags
    const tagNames = args.tags as string[];
    if (tagNames?.length) {
      const tagIDs = await this.getOrCreateTagIDs(tagNames);
      for (const tagID of tagIDs) {
        await this.client.insert("note_tags", { note_id: uuid, tag_id: tagID });
      }
    }

    return JSON.stringify({
      success: true,
      uuid,
      title: firstLine,
      message: `Created note: ${firstLine}`,
    });
  }

  private async updateNote(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const notes = await this.client.select<Record<string, unknown>>("notes", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (notes.length === 0) return `Note not found with UUID: ${uuid}`;

    const updates: Record<string, unknown> = { last_edit_date: new Date().toISOString() };

    if (args.content !== undefined) {
      const content = args.content as string;
      const lines = content.split("\n");
      updates.content = content;
      updates.first_line_clean = lines[0]?.trim() || "Untitled";
      updates.second_line_clean = lines.slice(1).find((l) => l.trim())?.trim() || null;
      updates.word_count = content.split(/\s+/).filter(Boolean).length;
    }

    if (args.append !== undefined) {
      const existing = (notes[0].content as string) || "";
      const newContent = existing + "\n\n" + (args.append as string);
      updates.content = newContent;
      updates.word_count = newContent.split(/\s+/).filter(Boolean).length;
    }

    if (args.is_flagged !== undefined) updates.is_flagged = args.is_flagged;
    if (args.is_archived !== undefined) updates.in_archive = args.is_archived;

    await this.client.update("notes", [`id=eq.${uuid}`], updates);

    return JSON.stringify({ success: true, message: "Note updated successfully" });
  }

  private async deleteNote(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const notes = await this.client.select<Record<string, unknown>>("notes", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (notes.length === 0) return `Note not found with UUID: ${uuid}`;

    const title = (notes[0].first_line_clean as string) || "Untitled";

    if (args.permanent) {
      await this.client.delete("note_tags", [`note_id=eq.${uuid}`]);
      await this.client.delete("notes", [`id=eq.${uuid}`]);
    } else {
      const now = new Date().toISOString();
      await this.client.update("notes", [`id=eq.${uuid}`], {
        trashed_date: now,
        is_deleted: true,
        last_edit_date: now,
      });
    }

    const action = args.permanent ? "permanently deleted" : "moved to trash";
    return JSON.stringify({ success: true, message: `Note '${title}' ${action}` });
  }

  // --------------------------------------------------------------------------
  // Tag Tools
  // --------------------------------------------------------------------------

  private async listTags(args: Record<string, unknown>): Promise<string> {
    const filters = [`user_id=eq.${this.client.getUserID()}`];

    if (!args.include_hidden) {
      filters.push("is_hidden_for_task_lists=eq.false");
      filters.push("is_hidden_for_note_lists=eq.false");
    }

    const tags = await this.client.select<Record<string, unknown>>("tags", {
      filters,
      order: "name.asc",
      limit: 200,
    });

    const results = tags.map((t) => ({
      name: t.name,
      is_favorite_for_tasks: t.is_favorite_for_task_lists,
      is_favorite_for_notes: t.is_favorite_for_note_lists,
    }));

    return JSON.stringify({ count: results.length, tags: results }, null, 2);
  }

  private async createTag(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    if (!name) return JSON.stringify({ error: "Tag name is required" });

    // Check if exists
    const existing = await this.client.select<Record<string, unknown>>("tags", {
      filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
      limit: 1,
    });

    if (existing.length > 0) {
      return JSON.stringify({ success: false, message: `Tag '${name}' already exists` });
    }

    await this.client.insert("tags", {
      id: crypto.randomUUID(),
      user_id: this.client.getUserID(),
      name,
      is_favorite_for_task_lists: false,
      is_favorite_for_note_lists: false,
      is_hidden_for_task_lists: false,
      is_hidden_for_note_lists: false,
    });

    return JSON.stringify({ success: true, message: `Created tag: ${name}` });
  }

  private async tagItem(args: Record<string, unknown>): Promise<string> {
    const tagName = args.tag as string;
    const uuid = args.uuid as string;
    const itemType = (args.type as string) || "task";

    if (!tagName || !uuid) {
      return JSON.stringify({ error: "Tag name and UUID required" });
    }

    const tagIDs = await this.getOrCreateTagIDs([tagName]);
    if (tagIDs.length === 0) {
      return JSON.stringify({ error: "Failed to create tag" });
    }

    const tagID = tagIDs[0];

    if (itemType === "note") {
      const notes = await this.client.select<Record<string, unknown>>("notes", {
        filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
        limit: 1,
      });
      if (notes.length === 0) return `Note not found with UUID: ${uuid}`;

      await this.client.insert("note_tags", { note_id: uuid, tag_id: tagID });
    } else {
      const tasks = await this.client.select<Record<string, unknown>>("tasks", {
        filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
        limit: 1,
      });
      if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

      await this.client.insert("task_tags", { task_id: uuid, tag_id: tagID });
    }

    return JSON.stringify({ success: true, message: `Added tag '${tagName}' to ${itemType}` });
  }

  private async untagItem(args: Record<string, unknown>): Promise<string> {
    const tagName = args.tag as string;
    const uuid = args.uuid as string;
    const itemType = (args.type as string) || "task";

    if (!tagName || !uuid) {
      return JSON.stringify({ error: "Tag name and UUID required" });
    }

    const tags = await this.client.select<Record<string, unknown>>("tags", {
      filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${tagName}`],
      limit: 1,
    });

    if (tags.length === 0) return `Tag '${tagName}' not found`;

    const tagID = tags[0].id as string;

    if (itemType === "note") {
      await this.client.delete("note_tags", [`note_id=eq.${uuid}`, `tag_id=eq.${tagID}`]);
    } else {
      await this.client.delete("task_tags", [`task_id=eq.${uuid}`, `tag_id=eq.${tagID}`]);
    }

    return JSON.stringify({ success: true, message: `Removed tag '${tagName}' from ${itemType}` });
  }

  // --------------------------------------------------------------------------
  // Workspace Tools
  // --------------------------------------------------------------------------

  private async listWorkspaces(): Promise<string> {
    const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
      filters: [`user_id=eq.${this.client.getUserID()}`],
      order: "sort_index.asc",
      limit: 100,
    });

    const results = workspaces.map((w) => ({
      uuid: w.id,
      name: w.name,
      color: w.color_name,
    }));

    return JSON.stringify({ count: results.length, workspaces: results }, null, 2);
  }

  private async readWorkspace(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (workspaces.length === 0) return `Workspace not found with UUID: ${uuid}`;

    const w = workspaces[0];
    return JSON.stringify(
      {
        uuid: w.id,
        name: w.name,
        color: w.color_name,
        created: w.created_date ? formatDate(w.created_date as string) : undefined,
        updated: w.updated_date ? formatDate(w.updated_date as string) : undefined,
      },
      null,
      2
    );
  }

  // --------------------------------------------------------------------------
  // Tag Helpers
  // --------------------------------------------------------------------------

  private async getTagIDsByNames(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
        limit: 1,
      });
      if (tags.length > 0) ids.push(tags[0].id as string);
    }
    return ids;
  }

  private async getOrCreateTagIDs(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
        limit: 1,
      });

      if (tags.length > 0) {
        ids.push(tags[0].id as string);
      } else {
        const newID = crypto.randomUUID();
        await this.client.insert("tags", {
          id: newID,
          user_id: this.client.getUserID(),
          name,
          is_favorite_for_task_lists: false,
          is_favorite_for_note_lists: false,
          is_hidden_for_task_lists: false,
          is_hidden_for_note_lists: false,
        });
        ids.push(newID);
      }
    }
    return ids;
  }

  private async getTaskIDsWithTags(tagIDs: string[]): Promise<Set<string>> {
    const taskIDs = new Set<string>();
    for (const tagID of tagIDs) {
      const junctions = await this.client.select<Record<string, unknown>>("task_tags", {
        filters: [`tag_id=eq.${tagID}`],
        limit: 1000,
      });
      for (const j of junctions) {
        taskIDs.add(j.task_id as string);
      }
    }
    return taskIDs;
  }

  private async getNoteIDsWithTags(tagIDs: string[]): Promise<Set<string>> {
    const noteIDs = new Set<string>();
    for (const tagID of tagIDs) {
      const junctions = await this.client.select<Record<string, unknown>>("note_tags", {
        filters: [`tag_id=eq.${tagID}`],
        limit: 1000,
      });
      for (const j of junctions) {
        noteIDs.add(j.note_id as string);
      }
    }
    return noteIDs;
  }

  private async getTagNamesForTask(taskID: string): Promise<string[]> {
    const junctions = await this.client.select<Record<string, unknown>>("task_tags", {
      filters: [`task_id=eq.${taskID}`],
      limit: 100,
    });

    const names: string[] = [];
    for (const j of junctions) {
      const tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`id=eq.${j.tag_id}`],
        limit: 1,
      });
      if (tags.length > 0) names.push(tags[0].name as string);
    }
    return names;
  }

  private async getTagNamesForNote(noteID: string): Promise<string[]> {
    const junctions = await this.client.select<Record<string, unknown>>("note_tags", {
      filters: [`note_id=eq.${noteID}`],
      limit: 100,
    });

    const names: string[] = [];
    for (const j of junctions) {
      const tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`id=eq.${j.tag_id}`],
        limit: 1,
      });
      if (tags.length > 0) names.push(tags[0].name as string);
    }
    return names;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const config = loadConfig();
  const client = new SupabaseClient(config);
  const executor = new ToolExecutor(client);

  const server = new Server(
    { name: "streamline-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await executor.execute(
      request.params.name,
      (request.params.arguments || {}) as Record<string, unknown>
    );
    return { content: [{ type: "text", text: result }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Streamline MCP server running");
}

main().catch(console.error);
