# Atomic task-note append: review and deployment

## Status and scope

Prepared migration only. Nothing here automatically applies SQL or edits credentials.
Deploy the database change before switching the MCP server. `append_task_note`
never falls back to a client-side read/merge/overwrite.

The schema was checked against RosTeHeA/Streamline commit
`fd1cc8700b6b0cc1fa4633e3172f122377cac146`:
- [schema.sql](https://github.com/RosTeHeA/Streamline/blob/fd1cc8700b6b0cc1fa4633e3172f122377cac146/DataAccess/Supabase/schema.sql)
- [task_guarded_upsert_rpc.sql](https://github.com/RosTeHeA/Streamline/blob/fd1cc8700b6b0cc1fa4633e3172f122377cac146/DataAccess/Supabase/task_guarded_upsert_rpc.sql)

This is source verification, not verification of the live database's applied schema.
Required task fields: `id uuid` primary key, `user_id uuid`, `note text`,
`updated_at timestamptz`, `is_deleted boolean`, `trashed_date timestamptz`,
`last_mutation_id uuid`, and `last_modified_device_id text`.

## Behavior

Supply a new UUID `request_id` once per contribution and retain it across all
retries, including connection failures and lost responses. Do not generate a new
key to retry. Exact same owner + task + key + content is a no-op on retry;
a changed payload for that key fails. A distinct contribution gets a distinct key.
A duplicate response acknowledges an earlier application; it does not assert that
later intentional rewrites have retained the text.

The RPC locks the owned, nontrashed task, checks the durable ledger, appends to the
current note, and inserts the ledger record in one transaction. Existing text is
preserved byte-for-byte. Two newlines separate nonempty text from the contribution;
null and empty notes start directly with the contribution. Content must be nonblank
and at most 65536 UTF-8 bytes; NUL and malformed Unicode are rejected by the MCP.
Other task fields are unchanged except sync revision/mutation/device metadata.

The ledger retains the exact contribution to detect key reuse with changed content.
It is not readable by anon/authenticated roles and is not added to realtime
publications. Entries persist for the life of the task and cascade on permanent task
deletion. Do not prune entries while retries may occur: doing so removes the
idempotency guarantee. A permanently deleted task UUID must not be recreated and
reused with old requests. Soft-deleted or transferred tasks are rejected even on retry.

## Exact database changes requiring approval

Apply `migrations/202610020001_append_task_note.sql` in the intended project's
Supabase SQL editor as the existing schema owner/admin, once, after reviewing the
actual deployed schema and triggers. Do not supply credentials in chat or commits.
The file is wrapped in BEGIN/COMMIT and deliberately fails on pre-existing object
names rather than silently adopting unknown definitions.

It creates:
1. `public.task_note_append_requests`, with owner/task/request primary key and
   task foreign key, RLS enabled without client policies
2. `public.append_task_note(uuid, uuid, uuid, text)`, SECURITY INVOKER with fixed
   `pg_catalog` search path and an explicit `current_user = 'service_role'` check
3. `public.streamline_append_note_revision()` plus the task-only BEFORE UPDATE
   trigger `zz_streamline_append_note_revision`

Permissions: revoke all ledger rights from PUBLIC, anon, authenticated, and
service_role, then grant only SELECT/INSERT on the new ledger to service_role.
Revoke PUBLIC/anon/authenticated execution on both new functions and grant execution
to service_role. Existing roles, credentials, task grants, task RLS policies, and
native RPCs are not changed. The deployment assumes Supabase's existing service_role
has BYPASSRLS and SELECT/UPDATE rights on tasks; do not create or expand those rights
as part of this migration. It sends `NOTIFY pgrst, 'reload schema'`.

The existing `update_tasks_updated_at` trigger overwrites timestamps with NOW().
The new `zz_...` trigger runs after it alphabetically, only when the trusted append
RPC sets a transaction-local marker matching the task and request. It sets the
revision to at least the old revision plus 2ms, using wall-clock time after the lock.
This exceeds the native guarded upsert's 1ms timestamp tolerance. The RPC restores
the marker and verifies the final revision; an unexpected later BEFORE trigger that
weakens the revision causes the entire append/ledger transaction to roll back.
Other updates retain their existing timestamp-trigger behavior.

## Rollout checklist

1. Obtain approval for the SQL objects, grants, trigger, and production deployment.
2. Read-only inspect the deployed task columns, existing triggers, and service_role
   privileges; confirm they match the prerequisites. No live state was inspected
   during this implementation.
3. Apply the migration in the approved project. A failed statement rolls back all
   migration changes. If the client disconnects, inspect object definitions before
   deciding whether any retry is needed; never blindly rerun.
4. Verify function/trigger definitions and permissions read-only. Confirm anon and
   authenticated cannot execute the append RPC or read its ledger.
5. Build the approved feature commit with `npm ci && npm run build`. Switch the
   installed server only after approval, preserving its existing private config
   and read-only helper. Restart the MCP session and verify `tools/list` includes
   `append_task_note`. No new credential is needed.
6. If desired, obtain explicit approval for a designated disposable live task smoke
   test; append the same request twice and verify one contribution. Never use a real
   user's task merely as a test fixture without approval.

## Rollback and limitations

Switching the MCP binary back does not undo contributions. Leave the ledger intact
so rollback/redeployment cannot enable duplicate retries. An approved database
rollback can revoke service_role EXECUTE on the append RPC and remove only the
new `zz_...` trigger and its helper; do not drop the ledger or rewrite task notes.
Do not expose this service-role RPC directly to untrusted clients. The MCP injects
the configured user ID; no caller-controlled owner field is accepted.

Atomic append preserves text committed before its row lock and other appends.
`update_task(notes)` remains an intentional full replacement. Later full-field
writes from legacy/native clients can still replace notes. The native guarded RPC
detects the prior baseline as stale immediately after the append. However, later
ordinary updates still run the existing NOW() timestamp trigger and can move the
revision backward (especially transactions started before the append), reopening
the stale-write window. An unguarded repository write path also exists; its live
use was not verified. Global monotonic task revisions/native merge changes are
outside this append feature. It does not make every client append-only or guarantee
permanent protection from stale native writes. Arbitrary AFTER triggers performing
further updates are also outside the RPC's RETURNING-based revision check; inspect
live triggers before deploying.

## Local verification

`npm test` builds TypeScript, tests runtime validation and transport behavior,
starts an isolated PostgreSQL 17 cluster with synthetic data/roles, and exercises
real concurrent sessions, SQL boundaries, rollback, RLS/grants, and native timestamp
trigger interaction. It also starts the MCP over stdio through a symlink and verifies
listing/calling the tool using a local mock HTTP server and synthetic config.
No live configuration or production database URL is read by these tests.
The PostgreSQL test package requires a supported platform and a non-root user;
it does not create OS users. Runtime dependencies are unchanged.
