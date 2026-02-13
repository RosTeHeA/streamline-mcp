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
// Recurrence Types and Engine (ported from Swift)
// ============================================================================

type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
type RecurrenceAnchor = "scheduledDueDate" | "completionDate";
type MonthlyMode = "dayOfMonth" | "ordinalWeekday";
type RecurrenceStatus = "active" | "paused" | "ended";

interface RecurrenceEndCondition {
  type: "never" | "afterOccurrences" | "onDate";
  count?: number;
  date?: string;
}

interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  weekdays?: number[]; // 1 = Sunday, 7 = Saturday
  monthlyMode?: MonthlyMode;
  dayOfMonth?: number;
  ordinalWeek?: number;
  ordinalWeekday?: number;
  monthOfYear?: number;
  anchor: RecurrenceAnchor;
  endCondition: RecurrenceEndCondition;
  occurrencesGenerated: number;
}

/**
 * Recurrence Engine - calculates next occurrence dates
 * Ported from TaskRecurrenceEngine.swift
 */
class RecurrenceEngine {
  /**
   * Compute the next occurrence date for a recurrence rule
   */
  nextOccurrenceDate(
    rule: RecurrenceRule,
    anchorDate: Date,
    referenceDate: Date = new Date()
  ): Date | null {
    // Check if series has ended
    if (this.hasEnded(rule, referenceDate)) {
      return null;
    }

    let candidateDate: Date;

    switch (rule.frequency) {
      case "daily":
        candidateDate = this.nextDailyOccurrence(anchorDate, rule.interval);
        break;
      case "weekly":
        candidateDate = this.nextWeeklyOccurrence(anchorDate, rule.interval, rule.weekdays || []);
        break;
      case "monthly":
        candidateDate = this.nextMonthlyOccurrence(
          anchorDate,
          rule.interval,
          rule.monthlyMode || "dayOfMonth",
          rule.dayOfMonth,
          rule.ordinalWeek,
          rule.ordinalWeekday
        );
        break;
      case "yearly":
        candidateDate = this.nextYearlyOccurrence(
          anchorDate,
          rule.interval,
          rule.monthOfYear,
          rule.dayOfMonth
        );
        break;
      default:
        candidateDate = this.nextDailyOccurrence(anchorDate, rule.interval);
    }

    // For scheduled-anchor rules, if candidate is in the past, find next valid date
    if (rule.anchor === "scheduledDueDate" && candidateDate < referenceDate) {
      candidateDate = this.findNextValidDate(rule, referenceDate);
    }

    // Check against end date
    if (rule.endCondition.type === "onDate" && rule.endCondition.date) {
      const endDate = new Date(rule.endCondition.date);
      if (candidateDate > endDate) {
        return null;
      }
    }

    return candidateDate;
  }

  private hasEnded(rule: RecurrenceRule, referenceDate: Date): boolean {
    switch (rule.endCondition.type) {
      case "never":
        return false;
      case "afterOccurrences":
        return rule.occurrencesGenerated >= (rule.endCondition.count || 0);
      case "onDate":
        if (rule.endCondition.date) {
          return referenceDate > new Date(rule.endCondition.date);
        }
        return false;
      default:
        return false;
    }
  }

  private nextDailyOccurrence(date: Date, interval: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + interval);
    return result;
  }

  private nextWeeklyOccurrence(date: Date, interval: number, weekdays: number[]): Date {
    // If no weekdays specified, just add weeks
    if (weekdays.length === 0) {
      const result = new Date(date);
      result.setDate(result.getDate() + interval * 7);
      return result;
    }

    const currentWeekday = date.getDay() + 1; // JS is 0-based, we use 1-based
    const sortedWeekdays = [...weekdays].sort((a, b) => a - b);

    // Try to find a weekday later in the current week (for interval = 1)
    if (interval === 1) {
      for (const weekday of sortedWeekdays) {
        if (weekday > currentWeekday) {
          const daysToAdd = weekday - currentWeekday;
          const result = new Date(date);
          result.setDate(result.getDate() + daysToAdd);
          return result;
        }
      }
    }

    // Jump to the next week (or N weeks) and find the first matching weekday
    const result = new Date(date);
    result.setDate(result.getDate() + interval * 7);

    const targetWeekday = sortedWeekdays[0];
    const nextWeekCurrentDay = result.getDay() + 1;
    const daysDifference = targetWeekday - nextWeekCurrentDay;

    result.setDate(result.getDate() + daysDifference);
    return result;
  }

  private nextMonthlyOccurrence(
    date: Date,
    interval: number,
    mode: MonthlyMode,
    dayOfMonth?: number,
    ordinalWeek?: number,
    ordinalWeekday?: number
  ): Date {
    if (mode === "dayOfMonth") {
      return this.nextMonthlyByDay(date, interval, dayOfMonth || 1);
    } else {
      return this.nextMonthlyByOrdinalWeekday(
        date,
        interval,
        ordinalWeek || 1,
        ordinalWeekday || 2 // Default to Monday
      );
    }
  }

  private nextMonthlyByDay(date: Date, interval: number, day: number): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() + interval);

    // Clamp day to valid range for the month
    const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, daysInMonth));

    return result;
  }

  private nextMonthlyByOrdinalWeekday(
    date: Date,
    interval: number,
    ordinal: number,
    weekday: number
  ): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() + interval);
    result.setDate(1);

    if (ordinal === -1) {
      // Last occurrence of weekday in month
      const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0);
      let current = lastDay;
      while (current.getDay() + 1 !== weekday) {
        current.setDate(current.getDate() - 1);
      }
      return current;
    }

    // Find the nth occurrence
    let count = 0;
    while (count < ordinal) {
      if (result.getDay() + 1 === weekday) {
        count++;
        if (count === ordinal) break;
      }
      result.setDate(result.getDate() + 1);
    }

    return result;
  }

  private nextYearlyOccurrence(
    date: Date,
    interval: number,
    month?: number,
    day?: number
  ): Date {
    const result = new Date(date);
    result.setFullYear(result.getFullYear() + interval);

    if (month !== undefined) {
      result.setMonth(month - 1); // JS months are 0-based
    }

    if (day !== undefined) {
      const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
      result.setDate(Math.min(day, daysInMonth));
    }

    return result;
  }

  private findNextValidDate(rule: RecurrenceRule, startDate: Date): Date {
    let currentDate = new Date(startDate);
    let iterations = 0;
    const maxIterations = 1000;

    while (iterations < maxIterations) {
      const nextDate = this.computeRawNextDate(rule, currentDate);
      if (nextDate && nextDate >= startDate) {
        return nextDate;
      }
      if (nextDate) {
        currentDate = nextDate;
      } else {
        break;
      }
      iterations++;
    }

    return startDate;
  }

  private computeRawNextDate(rule: RecurrenceRule, date: Date): Date | null {
    switch (rule.frequency) {
      case "daily":
        return this.nextDailyOccurrence(date, rule.interval);
      case "weekly":
        return this.nextWeeklyOccurrence(date, rule.interval, rule.weekdays || []);
      case "monthly":
        return this.nextMonthlyOccurrence(
          date,
          rule.interval,
          rule.monthlyMode || "dayOfMonth",
          rule.dayOfMonth,
          rule.ordinalWeek,
          rule.ordinalWeekday
        );
      case "yearly":
        return this.nextYearlyOccurrence(date, rule.interval, rule.monthOfYear, rule.dayOfMonth);
      default:
        return null;
    }
  }

  /**
   * Generate human-readable summary for a recurrence rule
   */
  getHumanReadableSummary(rule: RecurrenceRule): string {
    const parts: string[] = [];

    switch (rule.frequency) {
      case "daily":
        parts.push(rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`);
        break;
      case "weekly":
        if (rule.weekdays && rule.weekdays.length > 0) {
          const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          const days = rule.weekdays.map((d) => dayNames[d - 1]).join(", ");
          if (rule.interval === 1) {
            parts.push(`Every ${days}`);
          } else {
            parts.push(`Every ${rule.interval} weeks on ${days}`);
          }
        } else {
          parts.push(rule.interval === 1 ? "Every week" : `Every ${rule.interval} weeks`);
        }
        break;
      case "monthly":
        const monthText = rule.interval === 1 ? "Every month" : `Every ${rule.interval} months`;
        if (rule.dayOfMonth) {
          parts.push(`${monthText} on the ${this.ordinalString(rule.dayOfMonth)}`);
        } else {
          parts.push(monthText);
        }
        break;
      case "yearly":
        parts.push(rule.interval === 1 ? "Every year" : `Every ${rule.interval} years`);
        break;
    }

    if (rule.anchor === "completionDate") {
      parts.push("after completion");
    }

    return parts.join(" ");
  }

  private ordinalString(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
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
        include_tags: { type: "boolean", description: "Include tags for each task in results (default: false)" },
        include_recurring_templates: { type: "boolean", description: "Include recurring task templates (default: false, normally hidden)" },
        due_before: { type: "string", description: "Filter tasks due on or before (today, tomorrow, YYYY-MM-DD)" },
        due_after: { type: "string", description: "Filter tasks due on or after" },
        limit: { type: "integer", description: "Maximum results (default: 20)" },
      },
    },
  },
  {
    name: "read_task",
    description: "Get full details of a task by UUID, including recurrence information.",
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
    description: "Create a new task. For recurring tasks, use create_recurring_task instead.",
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
    name: "create_recurring_task",
    description: "Create a new recurring task with a recurrence rule.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name (required)" },
        notes: { type: "string", description: "Additional notes" },
        due_date: { type: "string", description: "First occurrence due date (required)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to assign" },
        is_urgent: { type: "boolean", description: "Mark as urgent" },
        frequency: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "yearly"],
          description: "Recurrence frequency (required)",
        },
        interval: { type: "integer", description: "Interval between occurrences (default: 1)" },
        weekdays: {
          type: "array",
          items: { type: "integer" },
          description: "For weekly: days of week (1=Sun, 2=Mon, ..., 7=Sat)",
        },
        day_of_month: { type: "integer", description: "For monthly: day of month (1-31)" },
        anchor: {
          type: "string",
          enum: ["scheduledDueDate", "completionDate"],
          description: "Schedule from due date or completion date (default: scheduledDueDate)",
        },
      },
      required: ["name", "due_date", "frequency"],
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
    description: "Mark a task as completed. For recurring tasks, automatically creates the next occurrence.",
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
    name: "skip_recurring_task",
    description: "Skip a recurring task occurrence without completing it. Creates the next occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (required)" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "pause_recurring_series",
    description: "Pause a recurring task series. No new occurrences will be created until resumed.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (can be template or any occurrence in the series)" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "resume_recurring_series",
    description: "Resume a paused recurring task series.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (can be template or any occurrence in the series)" },
      },
      required: ["uuid"],
    },
  },
  {
    name: "end_recurring_series",
    description: "Permanently end a recurring task series. No more occurrences will be created.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Task UUID (can be template or any occurrence in the series)" },
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
  private recurrenceEngine: RecurrenceEngine;

  constructor(client: SupabaseClient) {
    this.client = client;
    this.recurrenceEngine = new RecurrenceEngine();
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
        case "create_recurring_task":
          return await this.createRecurringTask(args);
        case "update_task":
          return await this.updateTask(args);
        case "complete_task":
          return await this.completeTask(args);
        case "skip_recurring_task":
          return await this.skipRecurringTask(args);
        case "pause_recurring_series":
          return await this.pauseRecurringSeries(args);
        case "resume_recurring_series":
          return await this.resumeRecurringSeries(args);
        case "end_recurring_series":
          return await this.endRecurringSeries(args);
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

    // By default, hide recurring templates (they're not actionable tasks)
    if (!args.include_recurring_templates) {
      filters.push("is_recurring_template=eq.false");
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
    const initialLimit = hasTagFilter || hasWorkspaceFilter ? 1000 : (args.limit as number) || 100;

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
        const name = ((t.name as string) || "").toLowerCase();
        const note = ((t.note as string) || "").toLowerCase();
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

    const includeTags = args.include_tags === true;

    const results = await Promise.all(
      tasks.map(async (t) => {
        const result: Record<string, unknown> = {
          uuid: t.id,
          name: t.name,
          completed: t.status,
          due_date: t.due_date ? formatDate(t.due_date as string) : undefined,
          notes: t.note ? (t.note as string).slice(0, 100) : undefined,
          is_urgent: t.is_urgent_alarm || undefined,
        };

        // Add recurrence info if present
        if (t.series_id) {
          result.is_recurring = true;
          result.recurrence_summary = t.recurrence_summary || undefined;
        }

        if (includeTags) {
          const tagNames = await this.getTagNamesForTask(t.id as string);
          if (tagNames.length > 0) {
            result.tags = tagNames;
          }
        }

        return result;
      })
    );

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

    const result: Record<string, unknown> = {
      uuid: t.id,
      name: t.name,
      notes: t.note,
      completed: t.status,
      due_date: t.due_date ? formatDate(t.due_date as string) : undefined,
      created: formatDate(t.created_at as string),
      completed_date: t.completed_date ? formatDate(t.completed_date as string) : undefined,
      is_urgent: t.is_urgent_alarm,
      tags: tagNames.length ? tagNames : undefined,
    };

    // Add recurrence information
    if (t.series_id) {
      result.is_recurring = true;
      result.series_id = t.series_id;
      result.is_recurring_template = t.is_recurring_template;
      result.recurrence_summary = t.recurrence_summary;
      result.recurrence_status = t.recurrence_status;

      // If this is an occurrence, get info about the series
      if (!t.is_recurring_template) {
        const templates = await this.client.select<Record<string, unknown>>("tasks", {
          filters: [
            `series_id=eq.${t.series_id}`,
            "is_recurring_template=eq.true",
            `user_id=eq.${this.client.getUserID()}`,
          ],
          limit: 1,
        });
        if (templates.length > 0) {
          result.series_status = templates[0].recurrence_status;
        }
      }
    }

    return JSON.stringify(result, null, 2);
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
      source: "00000000-0000-0000-0000-000000000000",
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

  private async createRecurringTask(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const frequency = args.frequency as RecurrenceFrequency;
    const dueDateInput = args.due_date as string;

    if (!name) return JSON.stringify({ error: "Task name is required" });
    if (!frequency) return JSON.stringify({ error: "Frequency is required" });
    if (!dueDateInput) return JSON.stringify({ error: "Due date is required for recurring tasks" });

    const dueDate = parseDate(dueDateInput);
    if (!dueDate) return JSON.stringify({ error: "Invalid due date" });

    const seriesID = crypto.randomUUID();
    const templateUUID = crypto.randomUUID();
    const occurrenceUUID = crypto.randomUUID();
    const now = new Date().toISOString();

    // Build the recurrence rule
    const rule: RecurrenceRule = {
      frequency,
      interval: (args.interval as number) || 1,
      anchor: (args.anchor as RecurrenceAnchor) || "scheduledDueDate",
      endCondition: { type: "never" },
      occurrencesGenerated: 1,
    };

    if (args.weekdays) {
      rule.weekdays = args.weekdays as number[];
    }
    if (args.day_of_month) {
      rule.dayOfMonth = args.day_of_month as number;
      rule.monthlyMode = "dayOfMonth";
    }

    const recurrenceSummary = this.recurrenceEngine.getHumanReadableSummary(rule);

    // Create the template (hidden master task)
    await this.client.insert("tasks", {
      id: templateUUID,
      user_id: this.client.getUserID(),
      name,
      note: args.notes || null,
      status: false,
      due_date: dueDate.toISOString(),
      is_urgent_alarm: args.is_urgent || false,
      is_recurring_template: true,
      series_id: seriesID,
      recurrence_rule_data: JSON.stringify(rule),
      recurrence_summary: recurrenceSummary,
      recurrence_status: "active",
      created_at: now,
      updated_at: now,
      is_deleted: false,
      source: "00000000-0000-0000-0000-000000000000",
    });

    // Create the first occurrence
    await this.client.insert("tasks", {
      id: occurrenceUUID,
      user_id: this.client.getUserID(),
      name,
      note: args.notes || null,
      status: false,
      due_date: dueDate.toISOString(),
      is_urgent_alarm: args.is_urgent || false,
      is_recurring_template: false,
      series_id: seriesID,
      recurrence_parent_id: templateUUID,
      recurrence_summary: recurrenceSummary,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      source: "00000000-0000-0000-0000-000000000000",
    });

    // Handle tags for both template and occurrence
    const tagNames = args.tags as string[];
    if (tagNames?.length) {
      const tagIDs = await this.getOrCreateTagIDs(tagNames);
      for (const tagID of tagIDs) {
        await this.client.insert("task_tags", { task_id: templateUUID, tag_id: tagID });
        await this.client.insert("task_tags", { task_id: occurrenceUUID, tag_id: tagID });
      }
    }

    return JSON.stringify({
      success: true,
      uuid: occurrenceUUID,
      template_uuid: templateUUID,
      series_id: seriesID,
      recurrence_summary: recurrenceSummary,
      message: `Created recurring task: ${name} (${recurrenceSummary})`,
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
    const now = new Date();
    const nowISO = now.toISOString();

    // Get the task
    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

    const task = tasks[0];

    // Mark the task as complete
    await this.client.update("tasks", [`id=eq.${uuid}`], {
      status: completed,
      completed_date: completed ? nowISO : null,
      updated_at: nowISO,
    });

    const action = completed ? "completed" : "uncompleted";
    let message = `Task '${task.name}' marked as ${action}`;

    // Handle recurring task completion
    if (completed && task.series_id && !task.is_recurring_template) {
      const nextOccurrence = await this.createNextOccurrence(task, now);
      if (nextOccurrence) {
        message += `. Next occurrence created for ${formatDate(nextOccurrence.dueDate)}`;
      }
    }

    return JSON.stringify({
      success: true,
      message,
    });
  }

  private async skipRecurringTask(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const now = new Date();
    const nowISO = now.toISOString();

    // Get the task
    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) return `Task not found with UUID: ${uuid}`;

    const task = tasks[0];

    if (!task.series_id || task.is_recurring_template) {
      return JSON.stringify({ error: "This task is not a recurring occurrence" });
    }

    // Mark as skipped
    await this.client.update("tasks", [`id=eq.${uuid}`], {
      is_skipped: true,
      updated_at: nowISO,
    });

    // Create next occurrence (using scheduled due date as anchor for skips)
    const nextOccurrence = await this.createNextOccurrence(task, now, true);

    let message = `Skipped task '${task.name}'`;
    if (nextOccurrence) {
      message += `. Next occurrence created for ${formatDate(nextOccurrence.dueDate)}`;
    }

    return JSON.stringify({ success: true, message });
  }

  private async pauseRecurringSeries(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const template = await this.findSeriesTemplate(uuid);
    if (!template) {
      return JSON.stringify({ error: "Task is not part of a recurring series" });
    }

    await this.client.update("tasks", [`id=eq.${template.id}`], {
      recurrence_status: "paused",
      updated_at: new Date().toISOString(),
    });

    return JSON.stringify({
      success: true,
      message: `Paused recurring series '${template.name}'`,
    });
  }

  private async resumeRecurringSeries(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const template = await this.findSeriesTemplate(uuid);
    if (!template) {
      return JSON.stringify({ error: "Task is not part of a recurring series" });
    }

    const now = new Date();
    await this.client.update("tasks", [`id=eq.${template.id}`], {
      recurrence_status: "active",
      updated_at: now.toISOString(),
    });

    // Check if we need to create an occurrence
    const hasOpen = await this.hasOpenOccurrence(template.series_id as string);
    let message = `Resumed recurring series '${template.name}'`;

    if (!hasOpen && template.recurrence_rule_data) {
      const rule = JSON.parse(template.recurrence_rule_data as string) as RecurrenceRule;
      const nextDueDate = this.recurrenceEngine.nextOccurrenceDate(rule, now, now);
      if (nextDueDate) {
        await this.createOccurrenceTask(template, nextDueDate);
        message += `. Created occurrence for ${formatDate(nextDueDate)}`;
      }
    }

    return JSON.stringify({ success: true, message });
  }

  private async endRecurringSeries(args: Record<string, unknown>): Promise<string> {
    const uuid = args.uuid as string;
    if (!uuid) return JSON.stringify({ error: "UUID required" });

    const template = await this.findSeriesTemplate(uuid);
    if (!template) {
      return JSON.stringify({ error: "Task is not part of a recurring series" });
    }

    await this.client.update("tasks", [`id=eq.${template.id}`], {
      recurrence_status: "ended",
      updated_at: new Date().toISOString(),
    });

    return JSON.stringify({
      success: true,
      message: `Ended recurring series '${template.name}'. No more occurrences will be created.`,
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

    const task = tasks[0];

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

      // If this is a recurring occurrence, create the next one
      if (task.series_id && !task.is_recurring_template && task.due_date) {
        await this.createNextOccurrenceAfterDelete(task);
      }
    }

    const action = args.permanent ? "permanently deleted" : "moved to trash";
    return JSON.stringify({
      success: true,
      message: `Task '${tasks[0].name}' ${action}`,
    });
  }

  // --------------------------------------------------------------------------
  // Recurrence Helpers
  // --------------------------------------------------------------------------

  private async findSeriesTemplate(uuid: string): Promise<Record<string, unknown> | null> {
    // First get the task
    const tasks = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [`id=eq.${uuid}`, `user_id=eq.${this.client.getUserID()}`],
      limit: 1,
    });

    if (tasks.length === 0) return null;

    const task = tasks[0];
    if (!task.series_id) return null;

    // If it's already the template, return it
    if (task.is_recurring_template) return task;

    // Find the template
    const templates = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [
        `series_id=eq.${task.series_id}`,
        "is_recurring_template=eq.true",
        `user_id=eq.${this.client.getUserID()}`,
      ],
      limit: 1,
    });

    return templates.length > 0 ? templates[0] : null;
  }

  private async hasOpenOccurrence(seriesID: string): Promise<boolean> {
    const occurrences = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [
        `series_id=eq.${seriesID}`,
        "is_recurring_template=eq.false",
        "status=eq.false",
        "is_skipped=eq.false",
        "is_deleted=eq.false",
        `user_id=eq.${this.client.getUserID()}`,
      ],
      limit: 1,
    });

    return occurrences.length > 0;
  }

  private async createNextOccurrence(
    task: Record<string, unknown>,
    completionDate: Date,
    isSkip: boolean = false
  ): Promise<{ uuid: string; dueDate: Date } | null> {
    const seriesID = task.series_id as string;
    if (!seriesID) return null;

    // Find the template
    const templates = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [
        `series_id=eq.${seriesID}`,
        "is_recurring_template=eq.true",
        `user_id=eq.${this.client.getUserID()}`,
      ],
      limit: 1,
    });

    if (templates.length === 0) return null;

    const template = templates[0];

    // Check if series is active
    if (template.recurrence_status !== "active") return null;

    // Parse the recurrence rule
    if (!template.recurrence_rule_data) return null;

    let rule: RecurrenceRule;
    try {
      rule = JSON.parse(template.recurrence_rule_data as string) as RecurrenceRule;
    } catch {
      return null;
    }

    // Determine anchor date
    let anchorDate: Date;
    if (isSkip || rule.anchor === "scheduledDueDate") {
      anchorDate = task.due_date ? new Date(task.due_date as string) : completionDate;
    } else {
      anchorDate = completionDate;
    }

    // Calculate next occurrence date
    const nextDueDate = this.recurrenceEngine.nextOccurrenceDate(rule, anchorDate);
    if (!nextDueDate) {
      // End the series
      await this.client.update("tasks", [`id=eq.${template.id}`], {
        recurrence_status: "ended",
        updated_at: new Date().toISOString(),
      });
      return null;
    }

    // Check if there's already an open occurrence
    if (await this.hasOpenOccurrence(seriesID)) {
      return null;
    }

    // Update occurrences count on template
    rule.occurrencesGenerated = (rule.occurrencesGenerated || 0) + 1;
    await this.client.update("tasks", [`id=eq.${template.id}`], {
      recurrence_rule_data: JSON.stringify(rule),
      updated_at: new Date().toISOString(),
    });

    // Create the occurrence
    return await this.createOccurrenceTask(template, nextDueDate);
  }

  private async createNextOccurrenceAfterDelete(task: Record<string, unknown>): Promise<void> {
    const seriesID = task.series_id as string;
    if (!seriesID) return;

    // Find the template
    const templates = await this.client.select<Record<string, unknown>>("tasks", {
      filters: [
        `series_id=eq.${seriesID}`,
        "is_recurring_template=eq.true",
        `user_id=eq.${this.client.getUserID()}`,
      ],
      limit: 1,
    });

    if (templates.length === 0) return;

    const template = templates[0];
    if (template.recurrence_status !== "active") return;

    // Check if there's already an open occurrence
    if (await this.hasOpenOccurrence(seriesID)) return;

    // Parse rule and calculate next date from the deleted task's due date
    if (!template.recurrence_rule_data) return;

    let rule: RecurrenceRule;
    try {
      rule = JSON.parse(template.recurrence_rule_data as string) as RecurrenceRule;
    } catch {
      return;
    }

    const deletedDueDate = task.due_date ? new Date(task.due_date as string) : new Date();
    const nextDueDate = this.recurrenceEngine.nextOccurrenceDate(rule, deletedDueDate);

    if (nextDueDate) {
      await this.createOccurrenceTask(template, nextDueDate);
    }
  }

  private async createOccurrenceTask(
    template: Record<string, unknown>,
    dueDate: Date
  ): Promise<{ uuid: string; dueDate: Date }> {
    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.client.insert("tasks", {
      id: uuid,
      user_id: this.client.getUserID(),
      name: template.name,
      note: template.note || null,
      status: false,
      due_date: dueDate.toISOString(),
      is_urgent_alarm: template.is_urgent_alarm || false,
      is_recurring_template: false,
      series_id: template.series_id,
      recurrence_parent_id: template.id,
      recurrence_summary: template.recurrence_summary,
      is_skipped: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      source: "00000000-0000-0000-0000-000000000000",
    });

    // Copy tags from template
    const templateTags = await this.client.select<Record<string, unknown>>("task_tags", {
      filters: [`task_id=eq.${template.id}`],
      limit: 100,
    });

    for (const tag of templateTags) {
      await this.client.insert("task_tags", { task_id: uuid, tag_id: tag.tag_id });
    }

    return { uuid, dueDate };
  }

  // --------------------------------------------------------------------------
  // Note Tools
  // --------------------------------------------------------------------------

  private async searchNotes(args: Record<string, unknown>): Promise<string> {
    const filters = [`user_id=eq.${this.client.getUserID()}`, "is_deleted=eq.false"];

    if (!args.include_archived) {
      filters.push("in_archive=eq.false");
    }

    let notes = await this.client.select<Record<string, unknown>>("notes", {
      filters,
      order: "updated_at.desc",
      limit: (args.limit as number) || 100,
    });

    // Filter by query text
    const query = args.query as string;
    if (query) {
      const lower = query.toLowerCase();
      notes = notes.filter((n) => {
        const title = ((n.first_line_clean as string) || "").toLowerCase();
        const content = ((n.content as string) || "").toLowerCase();
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
    let content = (n.content as string) || "";
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
      await this.client.update("notes", [`id=eq.${uuid}`], { updated_at: new Date().toISOString() });
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
      await this.client.update("tasks", [`id=eq.${uuid}`], { updated_at: new Date().toISOString() });
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
      await this.client.update("notes", [`id=eq.${uuid}`], { updated_at: new Date().toISOString() });
    } else {
      await this.client.delete("task_tags", [`task_id=eq.${uuid}`, `tag_id=eq.${tagID}`]);
      await this.client.update("tasks", [`id=eq.${uuid}`], { updated_at: new Date().toISOString() });
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

    const includeRules = args.include_rules !== false;

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
        resultSet = taskIDsForTag;
      } else {
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

  private async getWorkspaceFilteredIDs(
    workspaceName: string,
    itemType: "task" | "note"
  ): Promise<Set<string> | "all" | null> {
    const workspaces = await this.client.select<Record<string, unknown>>("workspaces", {
      filters: [`user_id=eq.${this.client.getUserID()}`, `name=ilike.${workspaceName}`],
      limit: 1,
    });

    if (workspaces.length === 0) {
      return null;
    }

    const workspace = workspaces[0];
    const rules = parseWorkspaceRules(workspace.rules_data);

    if (!rules) {
      return "all";
    }

    const nonEmptyGroups = rules.includeGroups.filter((g) => g.tagNames.length > 0);
    if (nonEmptyGroups.length === 0 && rules.excludeTags.length === 0) {
      return "all";
    }

    const allTagNames = [
      ...new Set([...nonEmptyGroups.flatMap((g) => g.tagNames), ...rules.excludeTags]),
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

    let matchingIDs: Set<string> | null = null;

    if (nonEmptyGroups.length > 0) {
      const groupResults: Set<string>[] = [];

      for (const group of nonEmptyGroups) {
        const tagIDs = group.tagNames
          .map((name) => tagCache.get(name.toLowerCase()))
          .filter(Boolean) as string[];

        if (tagIDs.length === 0) {
          groupResults.push(new Set());
          continue;
        }

        const groupItemIDs = await this.getItemsMatchingTags(junctionTable, idField, tagIDs, group.matchType);
        groupResults.push(groupItemIDs);
      }

      if (groupResults.length > 0) {
        if (rules.groupCombinator === "OR") {
          matchingIDs = this.unionSets(groupResults);
        } else {
          matchingIDs = this.intersectSets(groupResults);
        }
      }
    }

    if (matchingIDs === null && rules.excludeTags.length > 0) {
      const allItems = await this.client.select<Record<string, unknown>>(
        itemType === "task" ? "tasks" : "notes",
        {
          filters: [`user_id=eq.${this.client.getUserID()}`, "is_deleted=eq.false"],
          limit: 10000,
        }
      );
      matchingIDs = new Set(allItems.map((item) => item.id as string));
    }

    if (rules.excludeTags.length > 0 && matchingIDs !== null) {
      const excludeTagIDs = rules.excludeTags
        .map((name) => tagCache.get(name.toLowerCase()))
        .filter(Boolean) as string[];

      if (excludeTagIDs.length > 0) {
        const excludedItems = await this.getItemsWithAnyTag(junctionTable, idField, excludeTagIDs);

        for (const id of excludedItems) {
          matchingIDs.delete(id);
        }
      }
    }

    return matchingIDs || new Set();
  }

  private async getItemsMatchingTags(
    table: string,
    idField: string,
    tagIDs: string[],
    matchType: "Any of" | "All of"
  ): Promise<Set<string>> {
    const itemIDs = new Set<string>();

    if (matchType === "Any of") {
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
      if (tagIDs.length === 0) return itemIDs;

      const firstTagJunctions = await this.client.select<Record<string, unknown>>(table, {
        filters: [`tag_id=eq.${tagIDs[0]}`],
        limit: 10000,
      });

      const candidates = new Set(firstTagJunctions.map((j) => j[idField] as string));

      for (let i = 1; i < tagIDs.length; i++) {
        const junctions = await this.client.select<Record<string, unknown>>(table, {
          filters: [`tag_id=eq.${tagIDs[i]}`],
          limit: 10000,
        });
        const hasTag = new Set(junctions.map((j) => j[idField] as string));

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

  private async getItemsWithAnyTag(table: string, idField: string, tagIDs: string[]): Promise<Set<string>> {
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

  private unionSets(sets: Set<string>[]): Set<string> {
    const result = new Set<string>();
    for (const set of sets) {
      for (const item of set) {
        result.add(item);
      }
    }
    return result;
  }

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

  const server = new Server({ name: "streamline-mcp", version: "1.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await executor.execute(request.params.name, (request.params.arguments || {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: result }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Streamline MCP server running (v1.1.0 with recurrence support)");
}

main().catch(console.error);
