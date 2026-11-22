-- Hosted personal connector. No user data is rewritten by this migration.
-- Configure the single owner/client only after tests; initially disabled.
BEGIN;
CREATE SCHEMA IF NOT EXISTS streamline_mcp_private;
REVOKE ALL ON SCHEMA streamline_mcp_private FROM PUBLIC, anon, authenticated;

CREATE TABLE streamline_mcp_private.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_id uuid NOT NULL,
  client_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  writes_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE streamline_mcp_private.requests (
  owner_id uuid NOT NULL, request_id uuid NOT NULL,
  tool text NOT NULL, args jsonb NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id, request_id)
);
CREATE TABLE streamline_mcp_private.rate_limits (
  owner_id uuid PRIMARY KEY, window_start timestamptz NOT NULL, calls integer NOT NULL
);
CREATE TABLE streamline_mcp_private.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tool text NOT NULL, succeeded boolean NOT NULL
);
CREATE TABLE streamline_mcp_private.guarded_functions (
  signature text PRIMARY KEY, original_definition text NOT NULL, guarded_definition text NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA streamline_mcp_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA streamline_mcp_private FROM PUBLIC, anon, authenticated;

-- Restrict OAuth at the REST entry point as well, including future tables/RPCs.
-- Refuse to overwrite an existing application hook.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole,
    unnest(s.setconfig) c WHERE r.rolname='authenticator' AND c LIKE 'pgrst.db_pre_request=%') THEN
    RAISE EXCEPTION 'Existing PostgREST pre-request hook requires explicit integration';
  END IF;
END $$;
CREATE FUNCTION public.streamline_mcp_pre_request() RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (auth.jwt()->>'client_id') IS NOT NULL AND
     current_setting('request.path',true) IS DISTINCT FROM '/rpc/streamline_mcp_call' THEN
    RAISE EXCEPTION 'OAuth connector must use its scoped API' USING ERRCODE='42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.streamline_mcp_pre_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streamline_mcp_pre_request() TO anon,authenticated,service_role;
ALTER ROLE authenticator SET pgrst.db_pre_request='public.streamline_mcp_pre_request';

-- The OAuth token can only reach the bounded RPC below, never table REST,
-- GraphQL, storage metadata or realtime rows. Existing native JWTs have no
-- client_id and retain their existing policies, including ownership checks.
DO $block$
DECLARE t record; f record; original text; guarded text;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','storage','realtime') AND c.relkind IN ('r','p') AND c.relrowsecurity
      -- Managed storage/realtime tables without permissive policies already
      -- deny user access and may be owned exclusively by Supabase system roles.
      AND (n.nspname='public' OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive))
  LOOP
    EXECUTE format('CREATE POLICY streamline_block_oauth_direct ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((auth.jwt()->>''client_id'') IS NULL) WITH CHECK ((auth.jwt()->>''client_id'') IS NULL)',t.nspname,t.relname);
  END LOOP;
  -- Existing SECURITY DEFINER RPCs would bypass those policies. Guard every
  -- nontrigger public definer function; abort on an unfamiliar language/body.
  FOR f IN SELECT p.oid, p.oid::regprocedure::text signature, l.lanname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prosecdef AND p.prorettype <> 'trigger'::regtype
  LOOP
    original := pg_get_functiondef(f.oid);
    IF f.lanname <> 'plpgsql' OR original !~* E'\nBEGIN[[:space:]]' THEN
      RAISE EXCEPTION 'Review SECURITY DEFINER function before enabling OAuth: %',f.signature;
    END IF;
    guarded := regexp_replace(original, E'\nBEGIN([[:space:]])', E'\nBEGIN\n    IF (auth.jwt()->>''client_id'') IS NOT NULL THEN RAISE EXCEPTION ''OAuth connector cannot invoke native RPC'' USING ERRCODE = ''42501''; END IF;\n', 'i');
    INSERT INTO streamline_mcp_private.guarded_functions VALUES(f.signature,original,guarded);
    EXECUTE guarded;
  END LOOP;
END;
$block$;

-- Make every task revision monotonic, including native transactions started
-- before an MCP append. Runs after existing timestamp/append triggers.
CREATE FUNCTION streamline_mcp_private.monotonic_task_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '2 milliseconds', NEW.updated_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER zzzz_streamline_monotonic_revision BEFORE UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION streamline_mcp_private.monotonic_task_revision();

CREATE FUNCTION streamline_mcp_private.note_summary(p_content text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'first', left(regexp_replace(split_part(trim(p_content), E'\n',1),'^[#>* _`-]+','','g'),300),
    'second', left(regexp_replace(substring(trim(p_content) from E'\n(.*)'), '[[:space:]]+', ' ', 'g'),300),
    'words', CASE WHEN trim(p_content)='' THEN 0 ELSE cardinality(regexp_split_to_array(trim(p_content),'[[:space:]]+')) END
  );
$$;

CREATE FUNCTION public.streamline_mcp_call(p_tool text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET statement_timeout = '15s' SET lock_timeout = '5s' AS $fn$
<<mcp>>
DECLARE
  cfg streamline_mcp_private.settings%ROWTYPE;
  u uuid := auth.uid(); client text := auth.jwt()->>'client_id';
  n public.notes%ROWTYPE; t public.tasks%ROWTYPE;
  previous streamline_mcp_private.requests%ROWTYPE;
  result jsonb; request_id uuid; item_id uuid; allowed text[];
  tag_ids uuid[]; is_write boolean; lim integer; off integer;
  counts integer; tick timestamptz := clock_timestamp(); body text; summary jsonb;
BEGIN
  SELECT * INTO cfg FROM streamline_mcp_private.settings WHERE singleton;
  IF NOT FOUND OR NOT cfg.enabled OR u IS DISTINCT FROM cfg.owner_id OR client IS DISTINCT FROM cfg.client_id
     OR auth.jwt()->>'role' IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Connector access denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO streamline_mcp_private.rate_limits VALUES(u,tick,1)
    ON CONFLICT(owner_id) DO UPDATE SET
      calls=CASE WHEN tick-rate_limits.window_start >= interval '1 minute' THEN 1 ELSE rate_limits.calls+1 END,
      window_start=CASE WHEN tick-rate_limits.window_start >= interval '1 minute' THEN tick ELSE rate_limits.window_start END
    RETURNING calls INTO counts;
  IF counts > 120 THEN RETURN jsonb_build_object('error','Rate limit reached; retry in one minute'); END IF;
  IF p_tool='__authorize' THEN RETURN jsonb_build_object('authorized',true,'writes_enabled',cfg.writes_enabled); END IF;
  -- Validate again in SQL because an OAuth holder can call this RPC directly.
  IF jsonb_typeof(p_args) IS DISTINCT FROM 'object' OR octet_length(p_args::text)>98304 THEN
    RETURN jsonb_build_object('error','Invalid arguments');
  END IF;
  is_write := p_tool = ANY(ARRAY['create_task','update_task','complete_task','append_task_note','create_note','update_note','append_note']);
  allowed := CASE p_tool
    WHEN 'search_tasks' THEN ARRAY['query','limit','offset','include_completed','due_before','due_after','tag_ids']
    WHEN 'search_notes' THEN ARRAY['query','limit','offset','include_archived','tag_ids']
    WHEN 'read_task' THEN ARRAY['uuid'] WHEN 'read_note' THEN ARRAY['uuid'] WHEN 'read_workspace' THEN ARRAY['uuid']
    WHEN 'list_tags' THEN ARRAY['limit','offset'] WHEN 'list_workspaces' THEN ARRAY['limit','offset']
    WHEN 'create_task' THEN ARRAY['uuid','request_id','name','notes','due_date','tag_ids']
    WHEN 'update_task' THEN ARRAY['uuid','request_id','expected_updated_at','name','notes','due_date','tag_ids']
    WHEN 'complete_task' THEN ARRAY['uuid','request_id','expected_updated_at']
    WHEN 'append_task_note' THEN ARRAY['uuid','request_id','content']
    WHEN 'create_note' THEN ARRAY['uuid','request_id','content','tag_ids']
    WHEN 'update_note' THEN ARRAY['uuid','request_id','expected_revision','content','is_flagged','is_archived','tag_ids']
    WHEN 'append_note' THEN ARRAY['uuid','request_id','content'] ELSE NULL END;
  IF allowed IS NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_args) k WHERE NOT k=ANY(allowed)) THEN
    RETURN jsonb_build_object('error','Unknown tool or argument');
  END IF;
  IF is_write AND NOT cfg.writes_enabled THEN RETURN jsonb_build_object('error','Writes are disabled'); END IF;
  -- Exception block is a subtransaction: any mutation/ledger error rolls back
  -- the entire operation while the rate counter remains effective.
  BEGIN
    lim := coalesce((p_args->>'limit')::integer,20); off := coalesce((p_args->>'offset')::integer,0);
    IF lim NOT BETWEEN 1 AND 50 OR off NOT BETWEEN 0 AND 10000 OR length(coalesce(p_args->>'query',''))>200 THEN RAISE EXCEPTION 'Invalid bounds'; END IF;
    item_id := (p_args->>'uuid')::uuid;
    IF p_args ? 'tag_ids' THEN
      IF jsonb_typeof(p_args->'tag_ids') <> 'array' OR jsonb_array_length(p_args->'tag_ids')>30 THEN RAISE EXCEPTION 'Invalid tags'; END IF;
      tag_ids := ARRAY(SELECT jsonb_array_elements_text(p_args->'tag_ids')::uuid);
      IF EXISTS(SELECT 1 FROM unnest(tag_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.tags WHERE id=x AND user_id=u AND NOT coalesce(is_deleted,false))) THEN RAISE EXCEPTION 'Unavailable tag'; END IF;
    END IF;
    IF p_args ? 'content' AND (jsonb_typeof(p_args->'content') <> 'string' OR octet_length(p_args->>'content')>65536) THEN RAISE EXCEPTION 'Invalid content'; END IF;
    IF p_args ? 'notes' AND (jsonb_typeof(p_args->'notes') <> 'string' OR octet_length(p_args->>'notes')>65536) THEN RAISE EXCEPTION 'Invalid notes'; END IF;
    IF p_args ? 'name' AND (jsonb_typeof(p_args->'name') <> 'string' OR length(trim(p_args->>'name')) NOT BETWEEN 1 AND 1000) THEN RAISE EXCEPTION 'Invalid name'; END IF;
    IF is_write THEN
      PERFORM set_config('request.headers',(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb - 'x-streamline-client')::text,true);
      request_id := (p_args->>'request_id')::uuid;
      IF request_id IS NULL OR item_id IS NULL THEN RAISE EXCEPTION 'IDs required'; END IF;
      -- Serialize retries on the same operation before locking the data row.
      PERFORM pg_advisory_xact_lock(hashtextextended(u::text || request_id::text,0));
      SELECT * INTO previous FROM streamline_mcp_private.requests r WHERE r.owner_id=u AND r.request_id=mcp.request_id;
      IF FOUND THEN
        IF previous.tool<>p_tool OR previous.args<>p_args THEN RAISE EXCEPTION 'Idempotency key reused'; END IF;
        RETURN previous.result;
      END IF;
    END IF;
    CASE
    WHEN p_tool IN ('search_tasks','read_task') THEN
      SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO result FROM (
        SELECT a.id AS uuid,left(a.name,1000) AS name,left(a.note,CASE WHEN p_tool='read_task' THEN 60000 ELSE 1000 END) AS notes,
          length(a.note)>CASE WHEN p_tool='read_task' THEN 60000 ELSE 1000 END AS notes_truncated,a.status AS completed,a.due_date,a.updated_at,
          a.is_recurring_template,a.series_id,a.recurrence_summary,
          ARRAY(SELECT tt.tag_id FROM public.task_tags tt JOIN public.tags g ON g.id=tt.tag_id WHERE tt.task_id=a.id AND g.user_id=u AND NOT coalesce(g.is_deleted,false)) AS tag_ids
        FROM public.tasks a WHERE a.user_id=u AND NOT coalesce(a.is_deleted,false) AND a.trashed_date IS NULL
          AND (p_tool<>'read_task' OR a.id=item_id)
          AND (p_tool='read_task' OR (NOT coalesce(a.is_recurring_template,false) AND (coalesce((p_args->>'include_completed')::boolean,false) OR NOT coalesce(a.status,false))))
          AND (NOT p_args ? 'query' OR position(lower(p_args->>'query') in lower(coalesce(a.name,'') || ' ' || coalesce(a.note,'')))>0)
          AND (p_args->>'due_before' IS NULL OR a.due_date <= (p_args->>'due_before')::timestamptz)
          AND (p_args->>'due_after' IS NULL OR a.due_date >= (p_args->>'due_after')::timestamptz)
          AND (tag_ids IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(tag_ids) tag WHERE NOT EXISTS(SELECT 1 FROM public.task_tags j WHERE j.task_id=a.id AND j.tag_id=tag)))
        ORDER BY a.updated_at DESC,a.id LIMIT CASE WHEN p_tool='read_task' THEN 1 ELSE lim END OFFSET off
      ) x;
    WHEN p_tool IN ('search_notes','read_note') THEN
      SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO result FROM (
        SELECT a.id AS uuid,left(a.first_line_clean,1000) AS title,
          CASE WHEN p_tool='read_note' THEN left(a.content,60000) ELSE left(a.second_line_clean,500) END AS content,
          a.revision,a.updated_at,a.last_edited_at,a.is_flagged,a.in_archive AS is_archived,
          (p_tool='read_note' AND length(a.content)>60000) AS truncated,
          ARRAY(SELECT nt.tag_id FROM public.note_tags nt JOIN public.tags g ON g.id=nt.tag_id WHERE nt.note_id=a.id AND g.user_id=u AND NOT coalesce(g.is_deleted,false)) AS tag_ids
        FROM public.notes a WHERE a.user_id=u AND NOT coalesce(a.is_private,false) AND NOT coalesce(a.is_deleted,false) AND a.trashed_date IS NULL
          AND (p_tool<>'read_note' OR a.id=item_id)
          AND (p_tool='read_note' OR coalesce((p_args->>'include_archived')::boolean,false) OR NOT coalesce(a.in_archive,false))
          AND (NOT p_args ? 'query' OR position(lower(p_args->>'query') in lower(coalesce(a.content,'')))>0)
          AND (tag_ids IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(tag_ids) tag WHERE NOT EXISTS(SELECT 1 FROM public.note_tags j WHERE j.note_id=a.id AND j.tag_id=tag)))
        ORDER BY a.updated_at DESC,a.id LIMIT CASE WHEN p_tool='read_note' THEN 1 ELSE lim END OFFSET off
      ) x;
    WHEN p_tool='list_tags' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO result FROM (SELECT id AS uuid,left(name,1000) AS name FROM public.tags WHERE user_id=u AND NOT coalesce(is_deleted,false) ORDER BY name,id LIMIT lim OFFSET off) x;
    WHEN p_tool IN ('list_workspaces','read_workspace') THEN
      SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO result FROM (SELECT id AS uuid,name,color_name,sort_index FROM public.workspaces WHERE user_id=u AND NOT coalesce(is_deleted,false) AND (p_tool<>'read_workspace' OR id=item_id) ORDER BY sort_index,id LIMIT CASE WHEN p_tool='read_workspace' THEN 1 ELSE lim END OFFSET off) x;
    WHEN p_tool IN ('create_task','update_task','complete_task','append_task_note') THEN
      IF p_tool='create_task' THEN
        IF NOT p_args ? 'name' THEN RAISE EXCEPTION 'Name required'; END IF;
        INSERT INTO public.tasks(id,user_id,name,note,due_date,status,is_deleted,is_recurring_template,created_at,updated_at,last_mutation_id,last_modified_device_id)
        VALUES(item_id,u,p_args->>'name',coalesce(p_args->>'notes',''),(p_args->>'due_date')::timestamptz,false,false,false,tick,tick,request_id,'streamline-hosted-mcp');
      ELSE
        SELECT * INTO t FROM public.tasks WHERE id=item_id AND user_id=u AND NOT coalesce(is_deleted,false) AND trashed_date IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable task'; END IF;
        IF coalesce(t.is_recurring_template,false) OR t.series_id IS NOT NULL OR t.recurrence_parent_id IS NOT NULL THEN RAISE EXCEPTION 'Recurring task writes unavailable'; END IF;
        IF p_tool='append_task_note' THEN
          IF NOT p_args ? 'content' OR length(trim(p_args->>'content'))=0 THEN RAISE EXCEPTION 'Content required'; END IF;
          UPDATE public.tasks SET note=coalesce(note,'') || CASE WHEN coalesce(note,'')='' THEN '' ELSE E'\n\n' END || (p_args->>'content'),last_mutation_id=request_id,last_modified_device_id='streamline-hosted-mcp' WHERE id=item_id;
        ELSE
          IF p_args->>'expected_updated_at' IS NULL OR t.updated_at IS DISTINCT FROM (p_args->>'expected_updated_at')::timestamptz THEN RETURN jsonb_build_object('error','Conflict: read the task again before editing'); END IF;
          IF p_args ? 'notes' AND length(t.note)>60000 THEN RAISE EXCEPTION 'Large task-note replacements require native editor'; END IF;
          UPDATE public.tasks SET name=coalesce(p_args->>'name',name),note=CASE WHEN p_args ? 'notes' THEN p_args->>'notes' ELSE note END,
            due_date=CASE WHEN p_args ? 'due_date' THEN (p_args->>'due_date')::timestamptz ELSE due_date END,
            status=CASE WHEN p_tool='complete_task' THEN true ELSE status END,
            completed_date=CASE WHEN p_tool='complete_task' THEN tick ELSE completed_date END,
            last_mutation_id=request_id,last_modified_device_id='streamline-hosted-mcp' WHERE id=item_id;
        END IF;
      END IF;
      IF tag_ids IS NOT NULL THEN
        DELETE FROM public.task_tags WHERE task_id=item_id;
        INSERT INTO public.task_tags(task_id,tag_id) SELECT item_id,id FROM (SELECT DISTINCT unnest(tag_ids) id) x;
      END IF;
      SELECT jsonb_build_object('success',true,'uuid',id,'updated_at',updated_at,'request_id',request_id) INTO result FROM public.tasks WHERE id=item_id;
    WHEN p_tool IN ('create_note','update_note','append_note') THEN
      IF p_tool='create_note' THEN
        IF NOT p_args ? 'content' THEN RAISE EXCEPTION 'Content required'; END IF;
        body := p_args->>'content'; summary := streamline_mcp_private.note_summary(body);
        INSERT INTO public.notes(id,user_id,content,first_line_clean,second_line_clean,word_count,character_count,is_private,is_deleted,in_archive,is_flagged,last_edited_at,created_at,updated_at)
          VALUES(item_id,u,body,summary->>'first',coalesce(summary->>'second',''),(summary->>'words')::integer,length(body),false,false,false,false,tick,tick,tick);
      ELSE
        SELECT * INTO n FROM public.notes WHERE id=item_id AND user_id=u AND NOT coalesce(is_private,false) AND NOT coalesce(is_deleted,false) AND trashed_date IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable note'; END IF;
        IF p_tool='append_note' THEN
          IF NOT p_args ? 'content' OR length(trim(p_args->>'content'))=0 THEN RAISE EXCEPTION 'Content required'; END IF;
          body := coalesce(n.content,'') || CASE WHEN coalesce(n.content,'')='' THEN '' ELSE E'\n\n' END || (p_args->>'content');
        ELSE
          IF p_args->>'expected_revision' IS NULL OR n.revision IS DISTINCT FROM (p_args->>'expected_revision')::bigint THEN RETURN jsonb_build_object('error','Conflict: read the note again before editing'); END IF;
          IF p_args ? 'content' AND length(n.content)>60000 THEN RAISE EXCEPTION 'Large note replacements require native editor'; END IF;
          body := CASE WHEN p_args ? 'content' THEN p_args->>'content' ELSE n.content END;
        END IF;
        summary := streamline_mcp_private.note_summary(coalesce(body,''));
        UPDATE public.notes SET content=body,first_line_clean=summary->>'first',second_line_clean=coalesce(summary->>'second',''),word_count=(summary->>'words')::integer,character_count=length(body),
          last_edited_at=CASE WHEN body IS DISTINCT FROM n.content THEN clock_timestamp() ELSE n.last_edited_at END,
          is_flagged=CASE WHEN p_args ? 'is_flagged' THEN (p_args->>'is_flagged')::boolean ELSE n.is_flagged END,
          in_archive=CASE WHEN p_args ? 'is_archived' THEN (p_args->>'is_archived')::boolean ELSE n.in_archive END WHERE id=item_id;
      END IF;
      IF tag_ids IS NOT NULL THEN
        DELETE FROM public.note_tags WHERE note_id=item_id;
        INSERT INTO public.note_tags(note_id,tag_id) SELECT item_id,id FROM (SELECT DISTINCT unnest(tag_ids) id) x;
      END IF;
      SELECT jsonb_build_object('success',true,'uuid',id,'revision',revision,'request_id',request_id) INTO result FROM public.notes WHERE id=item_id;
    ELSE RAISE EXCEPTION 'Unknown operation';
    END CASE;
    IF is_write THEN INSERT INTO streamline_mcp_private.requests(owner_id,request_id,tool,args,result) VALUES(u,request_id,p_tool,p_args,result); END IF;
    INSERT INTO streamline_mcp_private.audit(tool,succeeded) VALUES(p_tool,true);
    DELETE FROM streamline_mcp_private.audit WHERE id < (SELECT max(id)-2000 FROM streamline_mcp_private.audit);
    RETURN result;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO streamline_mcp_private.audit(tool,succeeded) VALUES(p_tool,false);
    DELETE FROM streamline_mcp_private.audit WHERE id < (SELECT max(id)-2000 FROM streamline_mcp_private.audit);
    RETURN jsonb_build_object('error','Operation rejected. Check arguments, access and revision. Retry uncertain writes only with the same request_id.');
  END;
END;
$fn$;
REVOKE ALL ON FUNCTION public.streamline_mcp_call(text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.streamline_mcp_call(text,jsonb) TO authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA streamline_mcp_private FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
COMMIT;
