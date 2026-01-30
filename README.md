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
| `read_task` | Get full details by UUID |
| `create_task` | Create a new task |
| `update_task` | Update name, notes, due date, urgency |
| `complete_task` | Mark completed or uncompleted |
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

```
# Create a task with tags and due date
create_task(name: "Review PR", due_date: "tomorrow", tags: ["work"], is_urgent: true)

# Search tasks due today
search_tasks(due_before: "today", include_completed: false)

# Search tasks in a specific workspace
search_tasks(workspace: "Work", due_before: "today")

# Search notes in a workspace
search_notes(workspace: "Projects", query: "meeting notes", limit: 10)

# List workspaces with their filtering rules
list_workspaces(include_rules: true)

# Get workspace details by name
read_workspace(name: "Work")

# Complete a task
complete_task(uuid: "550e8400-e29b-41d4-a716-446655440000")

# Append to a note
update_note(uuid: "...", append: "\n\n## Follow-up\nNew content here")
```

### Workspace Filtering

Workspaces in Streamline are defined by tag-based filtering rules. When you filter by workspace, the MCP applies those rules to return only matching items.

Example workspace rules:
- **"Work"**: Show items with "Work" or "Project" tags, exclude "Personal"
- **"Trove"**: Show items with all of "Trove" AND "Active" tags

The `list_workspaces` tool shows a summary of each workspace's rules, and `read_workspace` provides the full rule structure.

---

## Environment Variables

You can use environment variables instead of a config file:

```bash
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_API_KEY=your_service_role_key
SUPABASE_USER_ID=your_user_uuid
```

Or in Claude Code config:

```json
{
  "mcpServers": {
    "streamline": {
      "command": "npx",
      "args": ["github:YOUR_USERNAME/streamline-mcp"],
      "env": {
        "SUPABASE_API_KEY": "...",
        "SUPABASE_USER_ID": "..."
      }
    }
  }
}
```

---

## Development

```bash
npm install
npm run build
npm start
```
