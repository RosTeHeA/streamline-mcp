-- Snapshot of Streamline native schema for isolated compatibility tests. No production data.
-- Closes the task-sync hole where stale field values could overwrite a newer
-- revision on another device.
--
-- upsert_task_if_current guarded a write with:
--     IF v_expected_updated_at IS NOT NULL AND abs(...) > 0.001 THEN 'stale'
-- so when the client sent a NULL/empty p_expected_updated_at the guard was
-- SKIPPED entirely and the existing row was overwritten unconditionally, with
-- updated_at re-stamped to NOW() (the BEFORE UPDATE trigger also forces NOW()).
-- That fresh timestamp then beat every other device's serverUpdatedAt.
--
-- A client sends NULL expected only when it has no server baseline for a row it
-- nonetheless already has on the server: pre-v16-migrated tasks (lightweight
-- migration left serverUpdatedAt NULL), reinstalls, never-acked tasks, or
-- watch-only rows. Real symptom: tasks rescheduled/completed on Mac were reverted
-- ~minutes later by a backlog of NULL-expected pushes from another device.
--
-- Fix: treat NULL/empty expected as STALE in the UPDATE branch (same as
-- update_note_if_current). The INSERT branch (NOT FOUND) is unchanged so genuine
-- creates still work, and the last_mutation_id idempotency short-circuit stays
-- ABOVE the guard so lost-ack retries still no-op cleanly.
--
-- Run this once in the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.upsert_task_if_current(
    p_task_id UUID,
    p_expected_updated_at TEXT DEFAULT NULL,
    p_mutation_id UUID DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL,
    p_task JSONB DEFAULT '{}'::JSONB,
    p_tag_ids UUID[] DEFAULT '{}'::UUID[]
)
RETURNS TABLE(status TEXT, task JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $upsert_task_if_current$
DECLARE
    v_user_id UUID := auth.uid();
    v_expected_updated_at TIMESTAMPTZ := NULLIF(p_expected_updated_at, '')::TIMESTAMPTZ;
    v_existing public.tasks%ROWTYPE;
    v_updated public.tasks%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF p_mutation_id IS NULL THEN
        RAISE EXCEPTION 'Missing mutation id';
    END IF;

    IF p_device_id IS NULL OR p_device_id = '' THEN
        RAISE EXCEPTION 'Missing device id';
    END IF;

    SELECT *
    INTO v_existing
    FROM public.tasks
    WHERE id = p_task_id
      AND user_id = v_user_id
    FOR UPDATE;

    IF FOUND THEN
        -- LOAD-BEARING ORDER: the idempotency short-circuit MUST stay ABOVE the
        -- staleness guard below. A push that committed server-side but whose ack
        -- was dropped is retried with the same mutation id; matching it here makes
        -- that retry a clean no-op. If this moved below the (now stricter) guard,
        -- a lost-ack retry carrying a NULL/stale expected revision would loop on
        -- 'stale' forever.
        IF v_existing.last_mutation_id = p_mutation_id THEN
            status := 'updated';
            task := to_jsonb(v_existing);
            RETURN NEXT;
            RETURN;
        END IF;

        -- Treat a missing expected revision as STALE, never as "force overwrite".
        IF v_expected_updated_at IS NULL
           OR abs(extract(epoch from (v_existing.updated_at - v_expected_updated_at))) > 0.001 THEN
            status := 'stale';
            task := to_jsonb(v_existing);
            RETURN NEXT;
            RETURN;
        END IF;

        UPDATE public.tasks
        SET
            name = COALESCE(p_task->>'name', v_existing.name),
            note = CASE WHEN p_task ? 'note' THEN p_task->>'note' ELSE v_existing.note END,
            status = CASE WHEN p_task ? 'status' THEN (p_task->>'status')::BOOLEAN ELSE v_existing.status END,
            due_date = CASE WHEN p_task ? 'due_date' THEN NULLIF(p_task->>'due_date', '')::TIMESTAMPTZ ELSE v_existing.due_date END,
            reminder_date = CASE WHEN p_task ? 'reminder_date' THEN NULLIF(p_task->>'reminder_date', '')::TIMESTAMPTZ ELSE v_existing.reminder_date END,
            reminder_time_of_day = CASE WHEN p_task ? 'reminder_time_of_day' THEN p_task->>'reminder_time_of_day' ELSE v_existing.reminder_time_of_day END,
            completed_date = CASE WHEN p_task ? 'completed_date' THEN NULLIF(p_task->>'completed_date', '')::TIMESTAMPTZ ELSE v_existing.completed_date END,
            completion_outcome = CASE WHEN p_task ? 'completion_outcome' THEN p_task->>'completion_outcome' ELSE v_existing.completion_outcome END,
            trashed_date = CASE WHEN p_task ? 'trashed_date' THEN NULLIF(p_task->>'trashed_date', '')::TIMESTAMPTZ ELSE v_existing.trashed_date END,
            manual_sort_index = CASE WHEN p_task ? 'manual_sort_index' THEN (p_task->>'manual_sort_index')::REAL ELSE v_existing.manual_sort_index END,
            is_recurring_template = CASE WHEN p_task ? 'is_recurring_template' THEN (p_task->>'is_recurring_template')::BOOLEAN ELSE v_existing.is_recurring_template END,
            is_marked_for_completion = CASE WHEN p_task ? 'is_marked_for_completion' THEN (p_task->>'is_marked_for_completion')::BOOLEAN ELSE v_existing.is_marked_for_completion END,
            is_skipped = CASE WHEN p_task ? 'is_skipped' THEN (p_task->>'is_skipped')::BOOLEAN ELSE v_existing.is_skipped END,
            is_urgent_alarm = CASE WHEN p_task ? 'is_urgent_alarm' THEN (p_task->>'is_urgent_alarm')::BOOLEAN ELSE v_existing.is_urgent_alarm END,
            notification_status = CASE WHEN p_task ? 'notification_status' THEN p_task->>'notification_status' ELSE v_existing.notification_status END,
            recurrence_rule_data = CASE WHEN p_task ? 'recurrence_rule_data' THEN p_task->>'recurrence_rule_data' ELSE v_existing.recurrence_rule_data END,
            recurrence_summary = CASE WHEN p_task ? 'recurrence_summary' THEN p_task->>'recurrence_summary' ELSE v_existing.recurrence_summary END,
            recurrence_status = CASE WHEN p_task ? 'recurrence_status' THEN p_task->>'recurrence_status' ELSE v_existing.recurrence_status END,
            recurrence_parent_id = CASE WHEN p_task ? 'recurrence_parent_id' THEN NULLIF(p_task->>'recurrence_parent_id', '')::UUID ELSE v_existing.recurrence_parent_id END,
            series_id = CASE WHEN p_task ? 'series_id' THEN NULLIF(p_task->>'series_id', '')::UUID ELSE v_existing.series_id END,
            reschedule_count = CASE WHEN p_task ? 'reschedule_count' THEN (p_task->>'reschedule_count')::INTEGER ELSE v_existing.reschedule_count END,
            source = CASE WHEN p_task ? 'source' THEN NULLIF(p_task->>'source', '')::UUID ELSE v_existing.source END,
            is_deleted = CASE WHEN p_task ? 'is_deleted' THEN (p_task->>'is_deleted')::BOOLEAN ELSE v_existing.is_deleted END,
            updated_at = NOW(),
            last_mutation_id = p_mutation_id,
            last_modified_device_id = p_device_id
        WHERE id = p_task_id
          AND user_id = v_user_id
        RETURNING * INTO v_updated;
    ELSE
        INSERT INTO public.tasks (
            id,
            user_id,
            name,
            note,
            status,
            due_date,
            reminder_date,
            reminder_time_of_day,
            completed_date,
            completion_outcome,
            trashed_date,
            manual_sort_index,
            is_recurring_template,
            is_marked_for_completion,
            is_skipped,
            is_urgent_alarm,
            notification_status,
            recurrence_rule_data,
            recurrence_summary,
            recurrence_status,
            recurrence_parent_id,
            series_id,
            reschedule_count,
            source,
            created_at,
            updated_at,
            is_deleted,
            last_mutation_id,
            last_modified_device_id
        )
        VALUES (
            p_task_id,
            v_user_id,
            COALESCE(p_task->>'name', 'New Task'),
            p_task->>'note',
            COALESCE((p_task->>'status')::BOOLEAN, FALSE),
            NULLIF(p_task->>'due_date', '')::TIMESTAMPTZ,
            NULLIF(p_task->>'reminder_date', '')::TIMESTAMPTZ,
            p_task->>'reminder_time_of_day',
            NULLIF(p_task->>'completed_date', '')::TIMESTAMPTZ,
            p_task->>'completion_outcome',
            NULLIF(p_task->>'trashed_date', '')::TIMESTAMPTZ,
            COALESCE((p_task->>'manual_sort_index')::REAL, 0),
            COALESCE((p_task->>'is_recurring_template')::BOOLEAN, FALSE),
            COALESCE((p_task->>'is_marked_for_completion')::BOOLEAN, FALSE),
            COALESCE((p_task->>'is_skipped')::BOOLEAN, FALSE),
            COALESCE((p_task->>'is_urgent_alarm')::BOOLEAN, FALSE),
            p_task->>'notification_status',
            p_task->>'recurrence_rule_data',
            p_task->>'recurrence_summary',
            p_task->>'recurrence_status',
            NULLIF(p_task->>'recurrence_parent_id', '')::UUID,
            NULLIF(p_task->>'series_id', '')::UUID,
            COALESCE((p_task->>'reschedule_count')::INTEGER, 0),
            NULLIF(p_task->>'source', '')::UUID,
            COALESCE(NULLIF(p_task->>'created_at', '')::TIMESTAMPTZ, NOW()),
            NOW(),
            COALESCE((p_task->>'is_deleted')::BOOLEAN, FALSE),
            p_mutation_id,
            p_device_id
        )
        RETURNING * INTO v_updated;
    END IF;

    DELETE FROM public.task_tags AS tt
    WHERE tt.task_id = p_task_id
      AND NOT EXISTS (
          SELECT 1
          FROM unnest(COALESCE(p_tag_ids, '{}'::UUID[])) AS requested_tag_id(tag_id)
          JOIN public.tags AS tags
            ON tags.id = requested_tag_id.tag_id
           AND tags.user_id = v_user_id
           AND COALESCE(tags.is_deleted, FALSE) = FALSE
          WHERE tags.id = tt.tag_id
      );

    INSERT INTO public.task_tags(task_id, tag_id)
    SELECT p_task_id, tags.id
    FROM unnest(COALESCE(p_tag_ids, '{}'::UUID[])) AS requested_tag_id(tag_id)
    JOIN public.tags AS tags
      ON tags.id = requested_tag_id.tag_id
     AND tags.user_id = v_user_id
     AND COALESCE(tags.is_deleted, FALSE) = FALSE
    ON CONFLICT DO NOTHING;

    status := 'updated';
    task := to_jsonb(v_updated);
    RETURN NEXT;
END;
$upsert_task_if_current$;

GRANT EXECUTE ON FUNCTION public.upsert_task_if_current(UUID, TEXT, UUID, TEXT, JSONB, UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
