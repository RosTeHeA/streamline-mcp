# Streamline MCP

MCP server that gives AI assistants access to your Streamline tasks, notes, tags, and workspaces.

## Setup

### 1. Configure credentials

Create `~/.config/streamline-mcp/config.json`:

```json
{
  "projectURL": "https://YOUR_PROJECT_ID.supabase.co",
  "apiKey": "YOUR_SERVICE_ROLE_KEY",
  "userID": "YOUR_USER_UUID"
}
```

**Where to get these:**
- `apiKey`: Supabase Dashboard → Settings → API → `service_role` key
- `userID`: Supabase Dashboard → Authentication → Users → Your user ID

### 2. Add to Claude Code

Edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "streamline": {
      "command": "npx",
      "args": ["github:YOUR_USERNAME/streamline-mcp"]
    }
  }
}
```

Or run locally:

```json
{
  "mcpServers": {
    "streamline": {
      "command": "node",
      "args": ["/path/to/streamline-mcp/dist/index.js"]
    }
  }
}
```

### 3. Restart Claude Code

The tools will now be available.

---

## Tools

### Tasks
| Tool | Description |
|------|-------------|
| `search_tasks` | Search by name, tags, due date, status, or workspace |
| `read_task` | Get full details by UUID (includes recurrence info) |
| `create_task` | Create a new one-time task |
| `create_recurring_task` | Create a recurring task with a schedule |
| `update_task` | Update name, notes, due date, urgency |
| `complete_task` | Mark completed (auto-creates next occurrence for recurring) |
| `skip_recurring_task` | Skip an occurrence without completing |
| `pause_recurring_series` | Pause a recurring series |
| `resume_recurring_series` | Resume a paused series |
| `end_recurring_series` | Permanently end a series |
| `delete_task` | Move to trash or delete permanently |

### Notes
| Tool | Description |
|------|-------------|
| `search_notes` | Search by title, content, tags, or workspace |
| `read_note` | Get full content by UUID |
| `create_note` | Create with markdown content |
| `update_note` | Replace content or append |
| `delete_note` | Move to trash or delete permanently |

### Tags
| Tool | Description |
|------|-------------|
| `list_tags` | List all tags |
| `create_tag` | Create a new tag |
| `tag_item` | Add tag to a task or note |
| `untag_item` | Remove tag from a task or note |

### Workspaces
| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces with filtering rules |
| `read_workspace` | Get workspace details (by UUID or name) |

---

## Examples

### Basic Tasks

```
# Create a task with tags and due date
create_task(name: "Review PR", due_date: "tomorrow", tags: ["work"], is_urgent: true)

# Search tasks due today
search_tasks(due_before: "today", include_completed: false)

# Complete a task
complete_task(uuid: "550e8400-e29b-41d4-a716-446655440000")
```

### Recurring Tasks

```
# Create a daily recurring task
create_recurring_task(
  name: "Morning standup",
  due_date: "tomorrow",
  frequency: "daily",
  tags: ["work"]
)

# Create a weekly task on specific days
create_recurring_task(
  name: "Gym workout",
  due_date: "2025-02-15",
  frequency: "weekly",
  interval: 1,
  weekdays: [2, 4, 6],  # Mon, Wed, Fri (1=Sun, 7=Sat)
  tags: ["health"]
)

# Create a monthly task
create_recurring_task(
  name: "Pay rent",
  due_date: "2025-03-01",
  frequency: "monthly",
  day_of_month: 1,
  tags: ["bills"]
)

# Complete a recurring task (auto-creates next occurrence)
complete_task(uuid: "recurring-occurrence-uuid")

# Skip without completing
skip_recurring_task(uuid: "recurring-occurrence-uuid")

# Pause the series (no new occurrences until resumed)
pause_recurring_series(uuid: "any-task-in-series")

# Resume a paused series
resume_recurring_series(uuid: "any-task-in-series")

# End the series permanently
end_recurring_series(uuid: "any-task-in-series")
```

### Workspace Filtering

```
# Search tasks in a specific workspace
search_tasks(workspace: "Work", due_before: "today")

# Search notes in a workspace
search_notes(workspace: "Projects", query: "meeting notes", limit: 10)

# List workspaces with their filtering rules
list_workspaces(include_rules: true)

# Get workspace details by name
read_workspace(name: "Work")
```

### Notes

```
# Append to a note
update_note(uuid: "...", append: "\n\n## Follow-up\nNew content here")
```

---

## Recurring Tasks - How It Works

Recurring tasks in Streamline use a template/occurrence model:

1. **Template**: A hidden "master" task that stores the recurrence rule
2. **Occurrences**: The visible tasks you interact with

When you complete or skip a recurring task occurrence:
- The occurrence is marked complete/skipped
- The next occurrence is automatically created based on the rule

### Recurrence Options

| Option | Description |
|--------|-------------|
| `frequency` | `daily`, `weekly`, `monthly`, or `yearly` |
| `interval` | How many periods between occurrences (default: 1) |
| `weekdays` | For weekly: which days (1=Sun through 7=Sat) |
| `day_of_month` | For monthly: which day (1-31) |
| `anchor` | `scheduledDueDate` (fixed schedule) or `completionDate` (relative to when you finish) |

### Anchor Types

- **scheduledDueDate** (default): Next task is scheduled relative to when it was *supposed* to be done. Good for fixed schedules like "every Monday".

- **completionDate**: Next task is scheduled relative to when you *actually* completed it. Good for tasks like "2 weeks after I change the oil".

---

## Environment Variables

You can use environment variables instead of a config file:

```bash
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_API_KEY=your_service_role_key
SUPABASE_USER_ID=your_user_uuid
```

---

## Development

```bash
npm install
npm run build
npm start
```

## Changelog

### v1.1.0
- Added full recurring task support:
  - `create_recurring_task` - Create tasks with recurrence rules
  - `skip_recurring_task` - Skip occurrences
  - `pause_recurring_series` / `resume_recurring_series` - Control series
  - `end_recurring_series` - End series permanently
  - `complete_task` now auto-creates next occurrence for recurring tasks
- Added `include_recurring_templates` option to `search_tasks`
- `read_task` now shows recurrence details

### v1.0.0
- Initial release with tasks, notes, tags, and workspaces
