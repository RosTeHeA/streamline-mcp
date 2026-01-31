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
// Workspace Rules Types
// ============================================================================

interface RuleGroup {
  id: string;
  matchType: "Any of" | "All of";
  tagNames: string[];
}

interface WorkspaceRules {
  includeGroups: RuleGroup[];
  excludeTags: string[];
  groupCombinator: "AND" | "OR";
  autoTagNames: string[];
}

/**
 * Parse rules_data JSON from Supabase into WorkspaceRules
 */
function parseWorkspaceRules(rulesData: unknown): WorkspaceRules | null {
  if (!rulesData) return null;

  try {
    const rules = rulesData as WorkspaceRules;

    // Validate structure
    if (!Array.isArray(rules.includeGroups)) return null;
    if (!Array.isArray(rules.excludeTags)) return null;
    if (!["AND", "OR"].includes(rules.groupCombinator)) return null;

    return rules;
  } catch {
    return null;
  }
}

/**
 * Generate human-readable summary of workspace rules
 */
function getRulesSummary(rules: WorkspaceRules): string {
  const parts: string[] = [];

  const nonEmptyGroups = rules.includeGroups.filter((g) => g.tagNames.length > 0);

  if (nonEmptyGroups.length === 1) {
    const group = nonEmptyGroups[0];
    if (group.tagNames.length === 1) {
      parts.push(`Include: ${group.tagNames[0]}`);
    } else {
      parts.push(`Include ${group.matchType.toLowerCase()}: ${group.tagNames.join(", ")}`);
    }
  } else if (nonEmptyGroups.length > 1) {
    parts.push(`${nonEmptyGroups.length} rule groups (${rules.groupCombinator})`);
  }

  if (rules.excludeTags.length > 0) {
    parts.push(`Exclude: ${rules.excludeTags.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : "No rules (all items)";
}

// ============================================================================
// Tool Definitions
// ============================================================================

const tools: Tool[] = [
  {
    name: "search_tasks",
    description: "Search tasks by name, tags, due date, status, or workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in task names and notes" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tag names" },
        workspace: { type: "string", description: "Filter by workspace name (case-insensitive)" },
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
    description: "Search notes by title, content, tags, or workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tag names" },
        workspace: { type: "string", description: "Filter by workspace name (case-insensitive)" },
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
    description: "List all workspaces with their filtering rules.",
    inputSchema: {
      type: "object",
      properties: {
        include_rules: { type: "boolean", description: "Include rule summaries (default: true)" },
      },
    },
  },
  {
    name: "read_workspace",
    description: "Get workspace details including filtering rules.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Workspace UUID" },
        name: { type: "string", description: "Workspace name (alternative to UUID, case-insensitive)" },
      },
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
          return await this.listWorkspaces(args);
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

    // When filtering by tags or workspace, fetch more initially since we filter in memory
    const hasTagFilter = !!(args.tags as string[])?.length;
    const hasWorkspaceFilter = !!(args.workspace as string);
    const initialLimit = (hasTagFilter || hasWorkspaceFilter) ? 1000 : ((args.limit as number) || 100);
    
    let tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters,
      order: "due_date.asc.nullslast",
      limit: initialLimit,
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

    // Filter by workspace
    const workspaceName = args.workspace as string;
    if (workspaceName) {
      const workspaceFilter = await this.getWorkspaceFilteredIDs(workspaceName, "task");
      if (workspaceFilter === null) {
        return JSON.stringify({ error: `Workspace '${workspaceName}' not found.` });
      }
      if (workspaceFilter !== "all") {
        tasks = tasks.filter((t) => workspaceFilter.has(t.id as string));
      }
    }

    // Filter by tags (applied after workspace filter)
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

    // Apply final limit
    const limit = (args.limit as number) || 20;
    tasks = tasks.slice(0, limit);

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
      await this.client.delete("tasks", [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`]);
    } else {
      const now = new Date().toISOString();
      await this.client.update("tasks", [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`], {
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
      limit: (args.limit as number) || 100, // Fetch more initially for workspace filtering
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

    // Filter by workspace
    const workspaceName = args.workspace as string;
    if (workspaceName) {
      const workspaceFilter = await this.getWorkspaceFilteredIDs(workspaceName, "note");
      if (workspaceFilter === null) {
        return JSON.stringify({ error: `Workspace '${workspaceName}' not found.` });
      }
      if (workspaceFilter !== "all") {
        notes = notes.filter((n) => workspaceFilter.has(n.id as string));
      }
    }

    // Filter by tags (applied after workspace filter)
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

    // Apply final limit
    const limit = (args.limit as number) || 20;
    notes = notes.slice(0, limit);

    if (notes.length === 0) {
      return "No notes found matching your criteria.";
    }

    const results = notes.map((n) => ({
      uuid: n.id,
      title: n.first_line_clean || "Untitled",
      preview: n.second_line_clean ? (n.second_line_clean as string).slice(0, 150) : undefined,
      last_edited: n.updated_at ? formatDate(n.updated_at as string) : undefined,
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
        last_edited: n.updated_at ? formatDate(n.updated_at as string) : undefined,
        created: n.created_at ? formatDate(n.created_at as string) : undefined,
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
      created_at: now,
      updated_at: now,
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

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

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
        updated_at: now,
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

      // Check if tag is already assigned
      const existingNoteTag = await this.client.select<Record<string, unknown>>("note_tags", {
        filters: [`note_id=eq.${uuid}`, `tag_id=eq.${tagID}`],
        limit: 1,
      });
      if (existingNoteTag.length > 0) {
        return JSON.stringify({ success: true, message: `Tag '${tagName}' already assigned to note` });
      }

      await this.client.insert("note_tags", { note_id: uuid, tag_id: tagID });
    } else {
      const tasks = await this.client.select<Record<string, unknown>>("tasks", {
        filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
        limit: 1,
      });
      if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

      // Check if tag is already assigned
      const existingTaskTag = await this.client.select<Record<string, unknown>>("task_tags", {
        filters: [`task_id=eq.${uuid}`, `tag_id=eq.${tagID}`],
        limit: 1,
      });
      if (existingTaskTag.length > 0) {
        return JSON.stringify({ success: true, message: `Tag '${tagName}' already assigned to task` });
      }

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

  private async listWorkspaces(args: Record<string, unknown> = {}): Promise<string> {
    const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
      filters: [`user_id=eq.${this.client.getUserID()}`, "is_deleted=eq.false"],
      order: "sort_index.asc",
      limit: 100,
    });

    const includeRules = args.include_rules !== false; // Default to true

    const results = workspaces.map((w) => {
      const result: Record<string, unknown> = {
        uuid: w.id,
        name: w.name,
        color: w.color_name,
      };

      if (includeRules) {
        const rules = parseWorkspaceRules(w.rules_data);
        result.rules_summary = rules ? getRulesSummary(rules) : "No rules (all items)";
      }

      return result;
    });

    return JSON.stringify({ count: results.length, workspaces: results }, null, 2);
  }

  private async readWorkspace(args: Record<string, unknown>): Promise<string> {
    let workspace: Record<string, unknown> | null = null;

    // Support lookup by UUID or name
    if (args.uuid) {
      const uuid = args.uuid as string;
      const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
        filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
        limit: 1,
      });
      workspace = workspaces[0] || null;
    } else if (args.name) {
      const name = args.name as string;
      const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
        filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
        limit: 1,
      });
      workspace = workspaces[0] || null;
    } else {
      return JSON.stringify({ error: "UUID or name required" });
    }

    if (!workspace) {
      return args.uuid
        ? `Workspace not found with UUID: ${args.uuid}`
        : `Workspace not found with name: ${args.name}`;
    }

    const rules = parseWorkspaceRules(workspace.rules_data);

    return JSON.stringify(
      {
        uuid: workspace.id,
        name: workspace.name,
        color: workspace.color_name,
        rules: rules
          ? {
              include_groups: rules.includeGroups.map((g) => ({
                match_type: g.matchType,
                tags: g.tagNames,
              })),
              exclude_tags: rules.excludeTags,
              group_combinator: rules.groupCombinator,
              auto_tags: rules.autoTagNames,
              summary: getRulesSummary(rules),
            }
          : null,
        created: workspace.created_at ? formatDate(workspace.created_at as string) : undefined,
        updated: workspace.updated_at ? formatDate(workspace.updated_at as string) : undefined,
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
      // Try exact match first, then case-insensitive
      let tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`user_id=eq.${this.client.getUserID()}`, `name=eq.${name}`],
        limit: 1,
      });
      if (tags.length === 0) {
        tags = await this.client.select<Record<string, unknown>>("tags", {
          filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
          limit: 1,
        });
      }
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
    // Use intersection (AND logic) - task must have ALL specified tags
    let resultSet: Set<string> | null = null;
    
    for (const tagID of tagIDs) {
      const junctions = await this.client.select<Record<string, unknown>>("task_tags", {
        filters: [`tag_id=eq.${tagID}`],
        limit: 1000,
      });
      
      const taskIDsForTag = new Set<string>();
      for (const j of junctions) {
        taskIDsForTag.add(j.task_id as string);
      }
      
      if (resultSet === null) {
        // First tag - initialize with all its tasks
        resultSet = taskIDsForTag;
      } else {
        // Subsequent tags - intersect (keep only tasks that have this tag too)
        const intersection = new Set<string>();
        for (const id of resultSet) {
          if (taskIDsForTag.has(id)) {
            intersection.add(id);
          }
        }
        resultSet = intersection;
      }
    }
    
    return resultSet ?? new Set<string>();
  }

  private async getNoteIDsWithTags(tagIDs: string[]): Promise<Set<string>> {
    // Use intersection (AND logic) - note must have ALL specified tags
    let resultSet: Set<string> | null = null;
    
    for (const tagID of tagIDs) {
      const junctions = await this.client.select<Record<string, unknown>>("note_tags", {
        filters: [`tag_id=eq.${tagID}`],
        limit: 1000,
      });
      
      const noteIDsForTag = new Set<string>();
      for (const j of junctions) {
        noteIDsForTag.add(j.note_id as string);
      }
      
      if (resultSet === null) {
        resultSet = noteIDsForTag;
      } else {
        const intersection = new Set<string>();
        for (const id of resultSet) {
          if (noteIDsForTag.has(id)) {
            intersection.add(id);
          }
        }
        resultSet = intersection;
      }
    }
    
    return resultSet ?? new Set<string>();
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

  // --------------------------------------------------------------------------
  // Workspace Filtering Helpers
  // --------------------------------------------------------------------------

  /**
   * Get IDs of items (tasks or notes) that match a workspace's rules.
   * Returns:
   * - null if workspace not found
   * - "all" if workspace has no filtering rules (all items match)
   * - Set<string> of matching item IDs
   */
  private async getWorkspaceFilteredIDs(
    workspaceName: string,
    itemType: "task" | "note"
  ): Promise<Set<string> | "all" | null> {
    // Find workspace by name
    const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
      filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${workspaceName}`],
      limit: 1,
    });

    if (workspaces.length === 0) {
      return null; // Workspace not found
    }

    const workspace = workspaces[0];
    const rules = parseWorkspaceRules(workspace.rules_data);

    // No rules or empty rules = all items match
    if (!rules) {
      return "all";
    }

    const nonEmptyGroups = rules.includeGroups.filter((g) => g.tagNames.length > 0);
    if (nonEmptyGroups.length === 0 && rules.excludeTags.length === 0) {
      return "all";
    }

    // Build tag name -> ID cache
    const allTagNames = [
      ...new Set([
        ...nonEmptyGroups.flatMap((g) => g.tagNames),
        ...rules.excludeTags,
      ]),
    ];

    const tagCache = new Map<string, string>();
    for (const name of allTagNames) {
      const tags = await this.client.select<Record<string, unknown>>("tags", {
        filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${name}`],
        limit: 1,
      });
      if (tags.length > 0) {
        tagCache.set(name.toLowerCase(), tags[0].id as string);
      }
    }

    const junctionTable = itemType === "task" ? "task_tags" : "note_tags";
    const idField = itemType === "task" ? "task_id" : "note_id";

    // Process include groups
    let matchingIDs: Set<string> | null = null;

    if (nonEmptyGroups.length > 0) {
      const groupResults: Set<string>[] = [];

      for (const group of nonEmptyGroups) {
        const tagIDs = group.tagNames
          .map((name) => tagCache.get(name.toLowerCase()))
          .filter(Boolean) as string[];

        if (tagIDs.length === 0) {
          // Group references tags that don't exist - no matches for this group
          groupResults.push(new Set());
          continue;
        }

        const groupItemIDs = await this.getItemsMatchingTags(
          junctionTable,
          idField,
          tagIDs,
          group.matchType
        );
        groupResults.push(groupItemIDs);
      }

      // Combine groups based on combinator
      if (groupResults.length > 0) {
        if (rules.groupCombinator === "OR") {
          matchingIDs = this.unionSets(groupResults);
        } else {
          matchingIDs = this.intersectSets(groupResults);
        }
      }
    }

    // If no include rules, start with all items that have any tags
    // (we'll filter by excludes only)
    if (matchingIDs === null && rules.excludeTags.length > 0) {
      // Get all items
      const allItems = await this.client.select<Record<string, unknown>>(
        itemType === "task" ? "tasks" : "notes",
        {
          filters: [`user_id=eq.${this.client.getUserID()}`, "is_deleted=eq.false"],
          limit: 10000,
        }
      );
      matchingIDs = new Set(allItems.map((item) => item.id as string));
    }

    // Apply exclusions
    if (rules.excludeTags.length > 0 && matchingIDs !== null) {
      const excludeTagIDs = rules.excludeTags
        .map((name) => tagCache.get(name.toLowerCase()))
        .filter(Boolean) as string[];

      if (excludeTagIDs.length > 0) {
        const excludedItems = await this.getItemsWithAnyTag(junctionTable, idField, excludeTagIDs);

        // Remove excluded items
        for (const id of excludedItems) {
          matchingIDs.delete(id);
        }
      }
    }

    return matchingIDs || new Set();
  }

  /**
   * Get items that match tags based on matchType (ANY of / ALL of)
   */
  private async getItemsMatchingTags(
    table: string,
    idField: string,
    tagIDs: string[],
    matchType: "Any of" | "All of"
  ): Promise<Set<string>> {
    const itemIDs = new Set<string>();

    if (matchType === "Any of") {
      // OR logic: item has any of the tags
      for (const tagID of tagIDs) {
        const junctions = await this.client.select<Record<string, unknown>>(table, {
          filters: [`tag_id=eq.${tagID}`],
          limit: 10000,
        });
        for (const j of junctions) {
          itemIDs.add(j[idField] as string);
        }
      }
    } else {
      // AND logic: item has all tags
      if (tagIDs.length === 0) return itemIDs;

      // Get items for first tag
      const firstTagJunctions = await this.client.select<Record<string, unknown>>(table, {
        filters: [`tag_id=eq.${tagIDs[0]}`],
        limit: 10000,
      });

      const candidates = new Set(firstTagJunctions.map((j) => j[idField] as string));

      // Check remaining tags - item must have all
      for (let i = 1; i < tagIDs.length; i++) {
        const junctions = await this.client.select<Record<string, unknown>>(table, {
          filters: [`tag_id=eq.${tagIDs[i]}`],
          limit: 10000,
        });
        const hasTag = new Set(junctions.map((j) => j[idField] as string));

        // Keep only items that have this tag too
        for (const id of candidates) {
          if (!hasTag.has(id)) {
            candidates.delete(id);
          }
        }
      }

      return candidates;
    }

    return itemIDs;
  }

  /**
   * Get items that have any of the specified tags
   */
  private async getItemsWithAnyTag(
    table: string,
    idField: string,
    tagIDs: string[]
  ): Promise<Set<string>> {
    const itemIDs = new Set<string>();
    for (const tagID of tagIDs) {
      const junctions = await this.client.select<Record<string, unknown>>(table, {
        filters: [`tag_id=eq.${tagID}`],
        limit: 10000,
      });
      for (const j of junctions) {
        itemIDs.add(j[idField] as string);
      }
    }
    return itemIDs;
  }

  /**
   * Union multiple sets
   */
  private unionSets(sets: Set<string>[]): Set<string> {
    const result = new Set<string>();
    for (const set of sets) {
      for (const item of set) {
        result.add(item);
      }
    }
    return result;
  }

  /**
   * Intersect multiple sets
   */
  private intersectSets(sets: Set<string>[]): Set<string> {
    if (sets.length === 0) return new Set();
    if (sets.length === 1) return sets[0];

    const result = new Set(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      for (const item of result) {
        if (!sets[i].has(item)) {
          result.delete(item);
        }
      }
    }
    return result;
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
