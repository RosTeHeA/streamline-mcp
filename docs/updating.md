# Updating Streamline MCP

Streamline MCP is distributed from [RosTeHeA/streamline-mcp on GitHub](https://github.com/RosTeHeA/streamline-mcp). The unrelated npm registry package named `streamline-mcp` is **not this server**. Use the GitHub specifier or this repository's release download.

## GitHub / npx installations

Use this configuration in each MCP client that launches its own server:

```json
{
  "mcpServers": {
    "streamline": {
      "command": "npx",
      "args": ["-y", "github:RosTeHeA/streamline-mcp#v1.1.1"]
    }
  }
}
```

Then fully restart the MCP client or disconnect and reconnect its Streamline server. Keep your existing credentials configuration. The first launch downloads the source and builds the server automatically, so it can take longer than later launches. Node.js 18 or later and Git are required.

Pinning a release tag makes the installed version explicit and avoids relying on a previously cached unversioned Git checkout. For later releases, change the tag and reconnect. If your client's npm configuration disables lifecycle scripts, use the prebuilt release download below instead.

## Existing local checkout

In your Streamline MCP repository, save any local work, then run:

```sh
git switch main
git pull --ff-only origin main
npm ci
```

`npm ci` now runs the build automatically. Keep a client configured with `node /absolute/path/to/streamline-mcp/dist/index.js` pointing at that same checkout. Restart/reconnect every client that already has a running copy; updating files does not replace an existing Node process.

## Prebuilt release download

The [v1.1.1 release](https://github.com/RosTeHeA/streamline-mcp/releases/tag/v1.1.1) includes `streamline-mcp-1.1.1.tgz` with the compiled server. Clients can launch it without a TypeScript build:

```json
{
  "mcpServers": {
    "streamline": {
      "command": "npx",
      "args": ["-y", "https://github.com/RosTeHeA/streamline-mcp/releases/download/v1.1.1/streamline-mcp-1.1.1.tgz"]
    }
  }
}
```

## Confirm the update

After reconnecting, the MCP initialization response and startup log should report `1.1.1`. Existing user configuration and credentials stay in their current location; neither the Git install nor the release archive includes them.

## Streamline app recovery

The server fix enables future edits to carry the correct content timestamp. To recover notes that older app builds already skipped, also build and run Streamline from `main` containing commit `2722c656074a284892a06c4abe29b97ae9c9384c` or later. The app rechecks older note revisions once, adopts accepted remote content, refreshes open notes through the existing editor notification, and protects newer local edits. For an Xcode installation, pull Streamline and run the updated app from Xcode.

No new database migration is needed for the note-refresh fix. The separately included `append_task_note` tool still requires the [atomic append migration](append-task-note-deployment.md) if you use that tool.

## Message to share with other users or agents

> Streamline MCP v1.1.1 fixes note edits staying empty or stale in the app. Update your MCP configuration to `github:RosTeHeA/streamline-mcp#v1.1.1`, or pull your local checkout and run `npm ci`, then restart/reconnect the MCP server. Also run an updated Streamline app to recover previously skipped edits. Your existing credentials do not change.
