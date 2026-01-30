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
| `search_tasks` | Search by name, tags, due date, or status |
| `read_task` | Get full details by UUID |
| `create_task` | Create a new task |
| `update_task` | Update name, notes, due date, urgency |
| `complete_task` | Mark completed or uncompleted |
| `delete_task` | Move to trash or delete permanently |

### Notes
| Tool | Description |
|------|-------------|
| `search_notes` | Search by title, content, or tags |
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
| `list_workspaces` | List all workspaces |
| `read_workspace` | Get workspace details |

---

## Examples

```
create_task(name: "Review PR", due_date: "tomorrow", tags: ["work"], is_urgent: true)

search_tasks(due_before: "today", include_completed: false)

search_notes(query: "meeting notes", limit: 10)

complete_task(uuid: "550e8400-e29b-41d4-a716-446655440000")

update_note(uuid: "...", append: "\n\n## Follow-up\nNew content here")
```

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
