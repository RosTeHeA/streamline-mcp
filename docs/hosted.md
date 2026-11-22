# Hosted personal Streamline connector

> Rollout withdrawn on 2026-11-22: hosted access and OAuth are disabled, and
> GitHub Pages has been unpublished. GitHub advises against using Pages for
> sensitive transactions such as passwords. The consent UI must move to an
> appropriate, isolated HTTPS origin before reconnection. The setup command is
> intentionally blocked until that migration is implemented and verified.
> The instructions below describe the prior deployment, not a ready-to-use service.
> Native app and local stdio access remain available.


The hosted transport is a Supabase Edge Function, independent of a Mac or running
Streamline app. Local stdio installations remain available. The hosted version has
a deliberately smaller tool set and never loads the local privileged config.

## Connect Claude / Duet

In Claude's custom connectors, add:

`https://jrgsnuobnulpadoivgyj.supabase.co/functions/v1/streamline-mcp`

Choose OAuth sign-in and **Use your own OAuth client**. Use the public client ID
from `docs/consent-config.json`; leave client secret empty. This is a public OAuth
client using authorization code + PKCE, with only
`https://claude.ai/api/mcp/auth_callback` registered. Dynamic registration is off.
Sign in on the consent page using the existing Streamline account. Password and
email-link authentication go directly to Supabase; this page never stores tokens
in browser storage, includes third-party scripts, or sends analytics.

The initial deployment is read-only. Verify search/read in Claude and Duet, then
enable writes with the explicit admin command below. Claude may require a
reconnection to refresh its tool list. The connector reads the last data synced to
Supabase; unsynced offline edits remain on the device until normal sync runs.

## Permission boundaries

- Every MCP request verifies the JWT signature, issuer, expiration, audience,
  authenticated role, exact owner UUID, and dedicated OAuth client ID. Supabase
  uses the shared `authenticated` audience; the client ID check binds access to
  this registered connector. JWT metadata alone is never trusted without
  signature verification.
- The Edge Function uses only a publishable key plus the user's OAuth token for
  database calls. It does not use `service_role`, a database password, a management
  token, or the local MCP secret key.
- PostgREST's pre-request hook restricts OAuth calls to `streamline_mcp_call`.
  Restrictive RLS policies separately prevent OAuth table/storage/realtime reads
  and writes. Existing native JWTs have no OAuth `client_id` and retain access.
- Existing public SECURITY DEFINER nontrigger functions have an OAuth guard.
  Their original definitions are stored privately for review/recovery. The
  narrowly scoped MCP RPC derives ownership from the verified identity, checks
  owner/client settings on every call, and exposes only explicitly coded queries.
- Private notes, deleted/trashed records, attachments, note history, chat data,
  reflection data, locations, arbitrary SQL, deletion and recurring-task writes
  are not exposed. Workspace names are available; workspace rules are not an
  authorization boundary. Tasks/notes can be filtered by tag IDs.
- Revocation and write controls are enforced in the database, including for an
  OAuth holder bypassing the Edge Function. Unauthenticated discovery reveals
  public OAuth configuration only.
- Public signup and OAuth dynamic registration are disabled for this personal
  deployment. Existing account sign-in and the native callback are retained.
- Setup requires Supabase Auth v2.198.0 or later, which blocks OAuth client tokens
  from changing account credentials or enrolling MFA. The deployed Auth version
  was verified before completing this rollout.

## Data integrity

Note replacement requires the exact revision returned by `read_note`; task edits
require the exact `updated_at` from `read_task`. Conflicts do not retry blindly.
Appends lock the row and append to its current text. Every write requires a stable
request ID, and the private ledger makes identical retries a no-op while rejecting
changed payloads. It retains exact arguments and a metadata-only result for the
life of the operation; do not prune it while old requests may be retried.

Content edits update `last_edited_at`, previews and counts. Metadata-only edits
preserve the content timestamp. The RPC strips the native-client header so its
changes remain externally unread in the app. Normal native triggers handle note
revisions and timer closure. Task timestamps are made globally monotonic (at least
2 ms beyond the old value), preventing an older transaction from reopening the
native guarded-update tolerance window. Large, truncated note/task bodies cannot
be replaced through the connector; append and metadata operations remain usable.

Rate limiting is shared across instances (120 authorized RPC calls/minute, with
an authorization check plus data call for each tool). Request bodies are limited
to 96 KiB, inputs/results are bounded, and errors never include database details.
Edge logs and the bounded database audit contain tool names, success and timing
only. The idempotency ledger is separate and contains private write payloads.

## Deploy and operate

Run commands from this repository. `SUPABASE_ACCESS_TOKEN` is read from the
environment; the existing private `~/.config/streamline-mcp/config.json` provides
the project/owner and admin credential for setup only. Never copy secrets into
source, command arguments, logs or chat. Setup checkpoints and prior auth settings
are stored in `~/.config/streamline-mcp/hosted-deployment.json` with mode 0600.

```sh
npm test
npm run test:install
deno test --allow-net --allow-env --allow-read --config supabase/functions/streamline-mcp/deno.json supabase/functions/streamline-mcp/handler_test.ts
python3 scripts/hosted-admin.py apply-schema
python3 scripts/hosted-admin.py configure-auth
npx supabase functions deploy streamline-mcp --remote=jrgsnuobnulpadoivgyj --use-api --no-verify-jwt --yes
python3 scripts/hosted-admin.py status
```

`--no-verify-jwt` is intentional: the legacy gateway cannot authenticate the OAuth
discovery request. The function performs its own strict JWT verification before
processing any MCP message. Publish `docs/` with GitHub Pages on this repository's
main branch; `consent-config.json` contains only public configuration.

After a successful owner-authorized connection test:

```sh
python3 scripts/hosted-admin.py enable-writes --connection-verified
```

Immediate kill switch (blocks even existing unexpired tokens):

```sh
python3 scripts/hosted-admin.py disable
```

This changes only hosted access; native app and local stdio clients remain usable.
Removing the Claude connector also stops its future use. To revoke its refresh
grant, revoke the OAuth authorization in Supabase. To roll back the deployment,
disable the connector first and restore the prior function deployment. Do not
drop the write ledger or undo data edits. A schema rollback requires reviewing
the privately saved original function definitions against any newer native
migrations before restoring them. Do not overwrite native updates blindly.

## Maintaining the native schema

When adding tables or SECURITY DEFINER functions, retain the OAuth boundary.
Reapplying a native `CREATE OR REPLACE FUNCTION` can remove an inserted OAuth guard;
recheck these after app migrations. The REST pre-request guard still limits OAuth
to the MCP RPC, but it is defense in depth, not a substitute for RLS and function
authorization. New direct-read features must cover private notes and associated
data consistently. Do not grant the OAuth client native app privileges to fix an
integration error.

The fixtures under `tests/fixtures/` are schema snapshots from Streamline, not
production data. The tests use an isolated PostgreSQL instance, synthetic users,
mock HTTP services and locally signed test JWTs. Never point tests at production.

References: [Supabase hosted MCP](https://supabase.com/docs/guides/ai-tools/byo-mcp),
[OAuth database permissions](https://supabase.com/docs/guides/auth/oauth-server/token-security),
[Claude connector authentication](https://claude.com/docs/connectors/building/authentication).
