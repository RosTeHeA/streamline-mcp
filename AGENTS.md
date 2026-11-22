# Streamline MCP

This is the personal Streamline note/task MCP server at `RosTeHeA/streamline-mcp`, not the unrelated npm registry package with the same name.

## Installation and updates

- The personal deployment now uses the hosted connector. Local stdio is retired;
  do not restore local client registrations or privileged local credentials.
  Keep the canonical checkout for hosted development/deployment and the legacy
  transport source for reference/tests. See `docs/hosted.md`.
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

- Credentials remain outside Git. Hosted admin metadata lives in `hosted-admin.json`
  with only `projectURL` and `userID`; admin credentials are supplied through the
  environment for explicit operations. Never recreate legacy `config.json` or
  print/commit credentials or real note/task contents for diagnostics.
- Tests must use synthetic configuration and must not access the live Supabase database.
- See `README.md` and `docs/updating.md` for portable setup instructions. Keep them aligned with the actual scripts.

## Hosted connector

- Hosted code lives in `supabase/functions/streamline-mcp`; run its Deno tests as
  documented in `docs/hosted.md` in addition to `npm test` for behavior changes.
- Keep the hosted transport independent of local config and privileged keys.
- Preserve owner/client checks, direct-access restrictions, private-note exclusion,
  write gates, transactional retry deduplication and native sync metadata.
- `consent/consent-config.json` intentionally contains only public OAuth configuration.
- Deployment checkpoints and prior auth settings stay outside Git. Never run
  production setup scripts as part of tests or include real note/task contents.

- Sign-in is hosted on the dedicated Netlify origin using only `consent/`. Never
  publish it on GitHub Pages. Preserve HTTP security headers, production-origin
  checks, explicit consent, and PKCE for email sign-in. No auth tokens in storage.
