# Streamline MCP

This is the personal Streamline note/task MCP server at `RosTeHeA/streamline-mcp`, not the unrelated npm registry package with the same name.

## Installation and updates

- Maintain one Git checkout per machine on `main`; share its absolute `dist/index.js` path across local MCP clients.
- On a new machine, clone this repository and run `npm ci`. The `prepare` script compiles TypeScript automatically.
- To update an installed checkout, run `npm run update`, then reconnect/restart its MCP clients. Do not reset or discard local edits to make a pull succeed.
- Do not introduce npm publishing, generated `dist` commits, release archives, or separate agent-specific copies unless the user explicitly requests a different distribution model.
- Existing version tags are checkpoints. Routine changes can be committed and pushed to `main` without cutting a release.

## Development

- Source is TypeScript in `src/`; built files in `dist/` are ignored by Git.
- `package.json` is the source of the version reported by MCP initialization and startup.
- Run `npm test` for behavior changes. It uses synthetic data and an isolated PostgreSQL instance.
- Run `npm run test:install` when changing setup, build, dependency, or update behavior. It clones and updates an isolated fixture, then initializes the actual MCP server.
- Note content mutations must update `last_edited_at`; `updated_at` alone will not update note text in older app builds. Metadata-only edits must not advance the content-edit timestamp.
- Preserve the existing atomic task-note append semantics and migration requirements.

## Configuration

- Credentials remain outside Git in the user's existing MCP configuration. Never print or commit credentials or real note/task contents for diagnostics.
- Tests must use synthetic configuration and must not access the live Supabase database.
- See `README.md` and `docs/updating.md` for portable setup instructions. Keep them aligned with the actual scripts.
