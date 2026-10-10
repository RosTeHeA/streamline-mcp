# Installing and updating from Git

Use [RosTeHeA/streamline-mcp](https://github.com/RosTeHeA/streamline-mcp), with one local checkout per machine shared by that machine's MCP clients. Follow the [README setup](../README.md#setup) on a new machine. The npm registry package named `streamline-mcp` is unrelated.

## Update an existing installation

From its checkout on `main`:

```sh
npm run update
```

This runs `git pull --ff-only origin main` followed by `npm ci`. Installation builds the server automatically through `prepare`. If an older checkout does not have the update command yet, run those two commands directly once.

Save any local development work first. If Git reports divergent branches or overlapping edits, resolve them without resetting or discarding local work. The update command stops if the pull fails.

Restart/reconnect each client running the Streamline MCP server after updating. Existing Node processes keep the code they loaded at startup. The configured `node /absolute/path/to/streamline-mcp/dist/index.js` command does not change between updates.

## Switching an existing npx client

Replace the client's `npx` command and GitHub argument with `node` and the absolute path to your existing checkout's `dist/index.js`. Keep all existing credentials configuration. This removes the extra cached installation and lets every client on the machine use the same update.

Do not run `npx streamline-mcp` or install that bare package name: it refers to another project. No registry publication or prebuilt archive is needed for this workflow.

## Verify

From the checkout:

```sh
git status --short --branch
git log -1 --oneline
node -p 'require("./package.json").version'
```

The startup log and MCP initialization response report the package version. Git's commit identifies the exact installed revision, including changes on `main` made after a version tag.

## Streamline app recovery

Build and run Streamline from `main` containing commit `2722c656074a284892a06c4abe29b97ae9c9384c` or later. The app rechecks older note revisions once, adopts accepted remote content, refreshes open notes through the existing editor notification, and protects newer local edits. For an Xcode installation, pull Streamline and run the updated app from Xcode.

No new database migration is needed for the note-refresh fix. The separately included `append_task_note` tool still requires the [atomic append migration](append-task-note-deployment.md) if you use that tool.
