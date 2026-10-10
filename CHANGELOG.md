# Changelog

## 1.1.1 — 2026-10-10

- Fix MCP note edits that were visible to agents but stayed empty or stale in Streamline. Creating, replacing, appending, or clearing content now supplies the content-edit timestamp used by the app; metadata-only updates preserve it.
- Keep note previews and character counts current when appending content.
- Build automatically when installed from Git and include compiled files in release downloads.
- Report the package version during MCP initialization and startup.
- Document pinned GitHub installs, local-checkout updates, restart requirements, and recovery of previously skipped edits.

This release also includes the previously committed recurring-task tools and atomic task-note append tool. The optional `append_task_note` tool requires its separate database migration; the note-refresh fix requires no new migration. See [deployment instructions](docs/append-task-note-deployment.md).
