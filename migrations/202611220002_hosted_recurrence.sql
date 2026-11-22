BEGIN;
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.streamline_mcp_call(text,jsonb)'::regprocedure) IS DISTINCT FROM '9d205b5a0793ff7f3409c6d6d05a958a' THEN RAISE EXCEPTION 'Unexpected existing MCP function; review before applying'; END IF;
END; $guard$;
-- Private source notes also hide their derived tasks and legacy occurrences.
CREATE FUNCTION streamline_mcp_private.task_visible(a public.tasks, owner uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $f$
 SELECT a.user_id=owner AND NOT coalesce(a.is_deleted,false) AND a.trashed_date IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM public.tasks parent
   WHERE (parent.id=a.recurrence_parent_id OR
     (a.series_id IS NOT NULL AND parent.series_id=a.series_id AND parent.is_recurring_template))
   AND parent.user_id<>owner
 )
 AND NOT EXISTS (
   SELECT 1 FROM public.tasks source_task
   WHERE (source_task.id=a.id OR source_task.id=a.recurrence_parent_id OR
     (a.series_id IS NOT NULL AND source_task.series_id=a.series_id AND source_task.is_recurring_template))
   AND source_task.source IS NOT NULL AND source_task.source<>'00000000-0000-0000-0000-000000000000'::uuid
   AND NOT EXISTS (SELECT 1 FROM public.notes n WHERE n.id=source_task.source AND n.user_id=owner
     AND NOT coalesce(n.is_private,false) AND NOT coalesce(n.is_deleted,false) AND n.trashed_date IS NULL)
 );
$f$;

CREATE FUNCTION streamline_mcp_private.recurrence_rule(rule jsonb, generated integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $f$
DECLARE frequency text; interval_n integer; e jsonb; native_end jsonb; k text; v integer;
BEGIN
 IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR octet_length(rule::text)>4000 OR generated NOT BETWEEN 0 AND 2147483646
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(rule) x WHERE NOT x=ANY(ARRAY['frequency','interval','weekdays','monthlyMode','dayOfMonth','ordinalWeek','ordinalWeekday','monthOfYear','anchor','endCondition']))
 THEN RAISE EXCEPTION 'Invalid recurrence rule'; END IF;
 frequency:=rule->>'frequency';
 IF frequency IS NULL OR frequency NOT IN ('daily','weekly','monthly','yearly') THEN RAISE EXCEPTION 'Invalid frequency'; END IF;
 IF rule ? 'anchor' AND (rule->>'anchor' IS NULL OR rule->>'anchor' NOT IN ('scheduledDueDate','completionDate')) THEN RAISE EXCEPTION 'Invalid anchor'; END IF;
 FOR k IN SELECT unnest(ARRAY['interval','dayOfMonth','ordinalWeek','ordinalWeekday','monthOfYear']) LOOP
  IF rule ? k AND (jsonb_typeof(rule->k)<>'number' OR (rule->>k)!~'^-?[0-9]+$') THEN RAISE EXCEPTION 'Integer required'; END IF;
 END LOOP;
 interval_n:=coalesce((rule->>'interval')::integer,1);
 IF interval_n NOT BETWEEN 1 AND 999 THEN RAISE EXCEPTION 'Invalid interval'; END IF;
 IF rule ? 'weekdays' THEN
  IF frequency<>'weekly' OR jsonb_typeof(rule->'weekdays')<>'array' OR jsonb_array_length(rule->'weekdays') NOT BETWEEN 1 AND 7 THEN RAISE EXCEPTION 'Invalid weekdays'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rule->'weekdays') x WHERE jsonb_typeof(x)<>'number' OR x::text!~'^[1-7]$') THEN RAISE EXCEPTION 'Invalid weekday'; END IF;
  IF (SELECT count(DISTINCT x) FROM jsonb_array_elements(rule->'weekdays') x)<>jsonb_array_length(rule->'weekdays') THEN RAISE EXCEPTION 'Duplicate weekday'; END IF;
 END IF;
 IF rule ? 'monthlyMode' AND (frequency<>'monthly' OR rule->>'monthlyMode' IS NULL OR rule->>'monthlyMode' NOT IN ('dayOfMonth','ordinalWeekday')) THEN RAISE EXCEPTION 'Invalid monthly mode'; END IF;
 IF frequency='monthly' THEN
  IF rule->>'monthlyMode' IS NULL THEN RAISE EXCEPTION 'Monthly mode required'; END IF;
  IF rule->>'monthlyMode'='ordinalWeekday' AND (rule->>'ordinalWeek' IS NULL OR (rule->>'ordinalWeek')::integer NOT IN (-1,1,2,3,4,5) OR rule->>'ordinalWeekday' IS NULL OR (rule->>'ordinalWeekday')::integer NOT BETWEEN 1 AND 7) THEN RAISE EXCEPTION 'Ordinal required'; END IF;
 END IF;
 IF frequency='yearly' AND (rule->>'monthOfYear' IS NULL OR (rule->>'monthOfYear')::integer NOT BETWEEN 1 AND 12) THEN RAISE EXCEPTION 'Month required'; END IF;
 IF frequency='yearly' OR (frequency='monthly' AND rule->>'monthlyMode'='dayOfMonth') THEN
  IF rule->>'dayOfMonth' IS NULL OR (rule->>'dayOfMonth')::integer NOT BETWEEN 1 AND 31 THEN RAISE EXCEPTION 'Day required'; END IF;
 END IF;
 IF (rule ? 'dayOfMonth' AND NOT (frequency='yearly' OR (frequency='monthly' AND rule->>'monthlyMode'='dayOfMonth')))
 OR (rule ? 'monthOfYear' AND frequency<>'yearly')
 OR ((rule ? 'ordinalWeek' OR rule ? 'ordinalWeekday') AND NOT (frequency='monthly' AND rule->>'monthlyMode'='ordinalWeekday')) THEN RAISE EXCEPTION 'Inapplicable rule field'; END IF;
 e:=coalesce(rule->'endCondition','{"type":"never"}'::jsonb);
 IF jsonb_typeof(e)<>'object' OR e->>'type' IS NULL OR e->>'type' NOT IN ('never','afterOccurrences','onDate')
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) x WHERE NOT x=ANY(CASE e->>'type' WHEN 'never' THEN ARRAY['type'] WHEN 'afterOccurrences' THEN ARRAY['type','count'] ELSE ARRAY['type','date'] END)) THEN RAISE EXCEPTION 'Invalid end condition'; END IF;
 native_end:=e;
 IF e->>'type'='afterOccurrences' THEN
  IF jsonb_typeof(e->'count') IS DISTINCT FROM 'number' OR e->>'count'!~'^[0-9]+$' OR (e->>'count')::integer NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid count'; END IF;
 ELSIF e->>'type'='onDate' THEN
  IF jsonb_typeof(e->'date') IS DISTINCT FROM 'string' OR e->>'date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$' OR NOT isfinite((e->>'date')::timestamptz) THEN RAISE EXCEPTION 'Invalid end date'; END IF;
  -- Swift JSONEncoder's default Date is seconds since 2001-01-01 UTC.
  native_end:=jsonb_build_object('type','onDate','date',extract(epoch FROM (e->>'date')::timestamptz)-978307200);
 END IF;
 RETURN rule || jsonb_build_object('interval',interval_n,'anchor',coalesce(rule->>'anchor','scheduledDueDate'),'endCondition',native_end,'occurrencesGenerated',generated);
END;
$f$;

CREATE FUNCTION streamline_mcp_private.client_recurrence(raw text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $f$
DECLARE r jsonb;
BEGIN
 IF raw IS NULL OR octet_length(raw)>4000 THEN RETURN NULL; END IF;
 r:=raw::jsonb-'occurrencesGenerated';
 IF r->'endCondition'->>'type'='onDate' THEN
  r:=jsonb_set(r,'{endCondition,date}',to_jsonb(to_char(to_timestamp((r->'endCondition'->>'date')::double precision+978307200) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 END IF;
 RETURN r;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$f$;

CREATE FUNCTION streamline_mcp_private.occurrence_id(series uuid, due timestamptz)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $f$
DECLARE bytes bytea;
BEGIN
 bytes:=substring(sha256(convert_to('8ca7cb2c-e539-47fa-93fa-1f11eed07e96'||chr(31)||series::text||chr(31)||extract(epoch FROM due)::bigint::text,'UTF8')) FROM 1 FOR 16);
 bytes:=set_byte(bytes,6,(get_byte(bytes,6)&15)|80);
 bytes:=set_byte(bytes,8,(get_byte(bytes,8)&63)|128);
 RETURN encode(bytes,'hex')::uuid;
END;
$f$;

CREATE FUNCTION streamline_mcp_private.recurrence_summary(r jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $f$
 SELECT 'Every '||CASE WHEN r->>'interval'='1' THEN '' ELSE (r->>'interval')||' ' END||CASE r->>'frequency' WHEN 'daily' THEN 'day' WHEN 'weekly' THEN 'week' WHEN 'monthly' THEN 'month' ELSE 'year' END||CASE WHEN r->>'interval'='1' THEN '' ELSE 's' END
 ||CASE WHEN r ? 'weekdays' THEN ' on '||(SELECT string_agg((ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[x::integer],', ' ORDER BY x::integer) FROM jsonb_array_elements_text(r->'weekdays') x) ELSE '' END
 ||CASE WHEN r ? 'dayOfMonth' THEN ' on day '||(r->>'dayOfMonth') ELSE '' END
 ||CASE WHEN r ? 'monthOfYear' THEN ' of month '||(r->>'monthOfYear') ELSE '' END
 ||CASE WHEN r ? 'ordinalWeek' THEN ' on '||CASE WHEN r->>'ordinalWeek'='-1' THEN 'last' ELSE r->>'ordinalWeek' END||' '||(ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[(r->>'ordinalWeekday')::integer] ELSE '' END
 ||CASE WHEN r->>'anchor'='completionDate' THEN ' after completion' ELSE '' END
 ||CASE r->'endCondition'->>'type' WHEN 'afterOccurrences' THEN ' ('||(r->'endCondition'->>'count')||' times)' WHEN 'onDate' THEN ' until '||to_char(to_timestamp((r->'endCondition'->>'date')::double precision+978307200) AT TIME ZONE 'UTC','YYYY-MM-DD') ELSE '' END;
$f$;
CREATE OR REPLACE FUNCTION public.streamline_mcp_call(p_tool text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET statement_timeout = '15s' SET lock_timeout = '5s' AS $fn$
<<mcp>>
DECLARE
  native_rule jsonb; series uuid; occurrence uuid; first_due timestamptz; rule_summary text;
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
  is_write := p_tool = ANY(ARRAY['set_task_recurrence','create_task','update_task','complete_task','append_task_note','create_note','update_note','append_note']);
  allowed := CASE p_tool
    WHEN 'search_tasks' THEN ARRAY['query','limit','offset','include_completed','include_templates','series_id','due_before','due_after','tag_ids']
    WHEN 'search_notes' THEN ARRAY['query','limit','offset','include_archived','tag_ids']
    WHEN 'read_task' THEN ARRAY['uuid'] WHEN 'read_note' THEN ARRAY['uuid'] WHEN 'read_workspace' THEN ARRAY['uuid']
    WHEN 'list_tags' THEN ARRAY['limit','offset'] WHEN 'list_workspaces' THEN ARRAY['limit','offset']
    WHEN 'set_task_recurrence' THEN ARRAY['uuid','request_id','expected_updated_at','rule','first_due_date','recurrence_status']
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
          a.is_recurring_template,a.series_id,a.recurrence_parent_id,a.recurrence_summary,a.recurrence_status,
          streamline_mcp_private.client_recurrence(a.recurrence_rule_data) AS recurrence_rule,
          ARRAY(SELECT tt.tag_id FROM public.task_tags tt JOIN public.tags g ON g.id=tt.tag_id WHERE tt.task_id=a.id AND g.user_id=u AND NOT coalesce(g.is_deleted,false)) AS tag_ids
        FROM public.tasks a WHERE streamline_mcp_private.task_visible(a,u)
          AND (p_tool<>'read_task' OR a.id=item_id)
          AND (p_tool='read_task' OR ((coalesce((p_args->>'include_templates')::boolean,false) OR NOT coalesce(a.is_recurring_template,false)) AND (coalesce((p_args->>'include_completed')::boolean,false) OR NOT coalesce(a.status,false))))
          AND (NOT p_args ? 'query' OR position(lower(p_args->>'query') in lower(coalesce(a.name,'') || ' ' || coalesce(a.note,'')))>0)
          AND (p_args->>'series_id' IS NULL OR a.series_id=(p_args->>'series_id')::uuid)
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
    WHEN p_tool='set_task_recurrence' THEN
      SELECT * INTO t FROM public.tasks a WHERE a.id=item_id AND streamline_mcp_private.task_visible(a,u) FOR UPDATE;
      IF NOT FOUND OR t.recurrence_parent_id IS NOT NULL OR (t.series_id IS NOT NULL AND NOT coalesce(t.is_recurring_template,false)) THEN RAISE EXCEPTION 'Use the series template, not an occurrence'; END IF;
      IF p_args->>'expected_updated_at' IS NULL OR t.updated_at IS DISTINCT FROM (p_args->>'expected_updated_at')::timestamptz THEN RETURN jsonb_build_object('error','Conflict: read the task again before editing'); END IF;
      IF coalesce(t.status,false) OR coalesce(t.is_skipped,false) THEN RAISE EXCEPTION 'Completed tasks cannot become templates'; END IF;
      IF NOT p_args ? 'rule' AND NOT p_args ? 'recurrence_status' THEN RAISE EXCEPTION 'A rule or status is required'; END IF;
      IF p_args ? 'recurrence_status' AND (p_args->>'recurrence_status' IS NULL OR p_args->>'recurrence_status' NOT IN ('active','paused','ended')) THEN RAISE EXCEPTION 'Invalid series status'; END IF;
      IF coalesce(t.is_recurring_template,false) THEN
        IF t.series_id IS NULL OR p_args ? 'first_due_date' THEN RAISE EXCEPTION 'Existing series keep their current occurrence'; END IF;
        native_rule:=t.recurrence_rule_data::jsonb;
        IF p_args ? 'rule' THEN
          native_rule:=streamline_mcp_private.recurrence_rule(p_args->'rule',coalesce((native_rule->>'occurrencesGenerated')::integer,0));
        END IF;
        series:=t.series_id;
      ELSE
        IF NOT p_args ? 'rule' OR p_args->>'first_due_date' IS NULL OR p_args->>'first_due_date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Rule and first due day required'; END IF;
        first_due:=((p_args->>'first_due_date')::date+time '12:00') AT TIME ZONE 'UTC';
        IF NOT isfinite(first_due) THEN RAISE EXCEPTION 'Invalid first due day'; END IF;
        IF (t.reminder_date IS NOT NULL OR t.reminder_time_of_day IS NOT NULL) AND (t.due_date IS NULL OR (t.due_date AT TIME ZONE 'UTC')::date<>(first_due AT TIME ZONE 'UTC')::date) THEN RAISE EXCEPTION 'Preserve reminder day when converting'; END IF;
        native_rule:=streamline_mcp_private.recurrence_rule(p_args->'rule',0);
        series:=gen_random_uuid();
      END IF;
      IF native_rule IS NULL OR native_rule->>'frequency' IS NULL THEN RAISE EXCEPTION 'Invalid stored rule'; END IF;
      -- Revalidate stored rules for status-only changes, preserving the counter.
      native_rule:=streamline_mcp_private.recurrence_rule(streamline_mcp_private.client_recurrence(native_rule::text),coalesce((native_rule->>'occurrencesGenerated')::integer,0));
      rule_summary:=streamline_mcp_private.recurrence_summary(native_rule);
      UPDATE public.tasks SET is_recurring_template=true,series_id=series,recurrence_status=coalesce(p_args->>'recurrence_status',recurrence_status,'active'),
        recurrence_rule_data=native_rule::text,recurrence_summary=rule_summary,
        due_date=CASE WHEN first_due IS NOT NULL THEN first_due ELSE due_date END,
        last_mutation_id=request_id,last_modified_device_id='streamline-hosted-mcp' WHERE id=item_id;
      IF first_due IS NOT NULL THEN
        occurrence:=streamline_mcp_private.occurrence_id(series,first_due);
        INSERT INTO public.tasks(id,user_id,name,note,due_date,status,is_deleted,is_recurring_template,is_skipped,series_id,recurrence_parent_id,source,
          reminder_date,reminder_time_of_day,notification_status,created_at,updated_at,last_mutation_id,last_modified_device_id)
        VALUES(occurrence,u,t.name,t.note,first_due,false,false,false,false,series,item_id,t.source,
          t.reminder_date,t.reminder_time_of_day,t.notification_status,tick,tick,request_id,'streamline-hosted-mcp');
        INSERT INTO public.task_tags(task_id,tag_id)
          SELECT occurrence,j.tag_id FROM public.task_tags j JOIN public.tags g ON g.id=j.tag_id WHERE j.task_id=item_id AND g.user_id=u AND NOT coalesce(g.is_deleted,false);
      END IF;
      SELECT jsonb_build_object('success',true,'uuid',id,'updated_at',updated_at,'request_id',request_id,'series_id',series,
        'first_occurrence_uuid',occurrence,'recurrence_status',recurrence_status,'recurrence_rule',streamline_mcp_private.client_recurrence(recurrence_rule_data),
        'effect','Existing occurrences and history are preserved. New occurrences follow this rule when Streamline evaluates the series on sync/open.')
      INTO result FROM public.tasks WHERE id=item_id;
    WHEN p_tool IN ('create_task','update_task','complete_task','append_task_note') THEN
      IF p_tool='create_task' THEN
        IF NOT p_args ? 'name' THEN RAISE EXCEPTION 'Name required'; END IF;
        INSERT INTO public.tasks(id,user_id,name,note,due_date,status,is_deleted,is_recurring_template,created_at,updated_at,last_mutation_id,last_modified_device_id)
        VALUES(item_id,u,p_args->>'name',coalesce(p_args->>'notes',''),(p_args->>'due_date')::timestamptz,false,false,false,tick,tick,request_id,'streamline-hosted-mcp');
      ELSE
        SELECT * INTO t FROM public.tasks a WHERE a.id=item_id AND streamline_mcp_private.task_visible(a,u) FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable task'; END IF;
        IF p_tool='complete_task' AND (coalesce(t.is_recurring_template,false) OR t.series_id IS NOT NULL OR t.recurrence_parent_id IS NOT NULL) THEN RAISE EXCEPTION 'Complete recurring tasks in Streamline'; END IF;
        IF coalesce(t.is_recurring_template,false) AND p_args ? 'due_date' THEN RAISE EXCEPTION 'Edit the current occurrence due date instead'; END IF;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA streamline_mcp_private FROM PUBLIC,anon,authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
