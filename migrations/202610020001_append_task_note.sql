-- REVIEW/APPLY EXPLICITLY. This migration is not run by the MCP server.
-- Requires public.tasks(id uuid, user_id uuid, note text, updated_at timestamptz,
-- is_deleted boolean, trashed_date timestamptz, last_mutation_id uuid,
-- last_modified_device_id text), and Supabase's service_role with BYPASSRLS.
BEGIN;

-- Fail early if the deployed schema predates the tracked native sync metadata.
DO $$ BEGIN
  PERFORM id, user_id, note, updated_at, is_deleted, trashed_date,
    last_mutation_id, last_modified_device_id FROM public.tasks WHERE false;
END $$;

-- schema.sql's update_tasks_updated_at trigger assigns NOW(), even when an
-- explicit revision was supplied. Run after that trigger, ONLY inside this RPC.
CREATE FUNCTION public.streamline_append_note_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'service_role' AND
     current_setting('streamline.append_note_operation', true) =
       NEW.id::text || ':' || NEW.last_mutation_id::text AND
     NEW.last_modified_device_id = 'streamline-mcp' THEN
    NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '2 milliseconds');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.streamline_append_note_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.streamline_append_note_revision() TO service_role;
CREATE TRIGGER zz_streamline_append_note_revision
  BEFORE UPDATE ON public.tasks FOR EACH ROW
  EXECUTE FUNCTION public.streamline_append_note_revision();

CREATE TABLE public.task_note_append_requests (
  user_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 65536),
  appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, task_id, request_id)
);
ALTER TABLE public.task_note_append_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_note_append_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.task_note_append_requests TO service_role;

CREATE FUNCTION public.append_task_note(
  p_user_id uuid, p_task_id uuid, p_request_id uuid, p_content text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$
DECLARE
  prior public.task_note_append_requests%ROWTYPE;
  appended_time timestamptz;
  previous_revision timestamptz;
  actual_revision timestamptz;
  previous_operation text;
BEGIN
  -- This server already uses a trusted service-role credential. Do not expose
  -- caller-selected p_user_id to anon/authenticated clients.
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_task_id IS NULL OR p_request_id IS NULL OR
     p_content IS NULL OR octet_length(p_content) NOT BETWEEN 1 AND 65536 OR
     p_content !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'Invalid append parameters' USING ERRCODE = '22023';
  END IF;

  -- Serialize append calls and ordinary UPDATEs on this row. Ownership and
  -- deletion are checked after any concurrent updater releases the row lock.
  SELECT updated_at INTO previous_revision FROM public.tasks
    WHERE id = p_task_id AND user_id = p_user_id AND is_deleted IS NOT TRUE AND trashed_date IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found or unavailable' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO prior FROM public.task_note_append_requests
    WHERE user_id = p_user_id AND task_id = p_task_id AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.content IS DISTINCT FROM p_content THEN
      RAISE EXCEPTION 'request_id already used with different content' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('success', true, 'uuid', p_task_id,
      'request_id', p_request_id, 'appended', false, 'appended_at', prior.appended_at);
  END IF;

  appended_time := clock_timestamp();
  previous_operation := current_setting('streamline.append_note_operation', true);
  PERFORM set_config('streamline.append_note_operation', p_task_id::text || ':' || p_request_id::text, true);
  UPDATE public.tasks SET
    note = coalesce(note, '') || CASE WHEN coalesce(note, '') = '' THEN '' ELSE E'\n\n' END || p_content,
    -- The native guarded upsert uses a 1ms revision tolerance. Advance by at
    -- least 2ms so even a rapid append invalidates the prior native baseline.
    updated_at = greatest(appended_time, updated_at + interval '2 milliseconds'),
    last_mutation_id = p_request_id,
    last_modified_device_id = 'streamline-mcp'
    WHERE id = p_task_id AND user_id = p_user_id
    RETURNING updated_at INTO actual_revision;
  PERFORM set_config('streamline.append_note_operation', coalesce(previous_operation, ''), true);
  -- Unknown later BEFORE triggers must not silently weaken this revision.
  IF actual_revision IS NULL OR (previous_revision IS NOT NULL AND
     actual_revision < previous_revision + interval '2 milliseconds') THEN
    RAISE EXCEPTION 'Append revision trigger was overridden' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.task_note_append_requests(user_id, task_id, request_id, content, appended_at)
    VALUES (p_user_id, p_task_id, p_request_id, p_content, appended_time);
  RETURN jsonb_build_object('success', true, 'uuid', p_task_id,
    'request_id', p_request_id, 'appended', true, 'appended_at', appended_time);
END;
$$;
REVOKE ALL ON FUNCTION public.append_task_note(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_task_note(uuid, uuid, uuid, text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
