-- Snapshot of Streamline native schema for isolated compatibility tests. No production data.
-- Streamline Supabase Schema
-- Run this in the Supabase SQL editor to create all tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TASKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'New Task',
    note TEXT,
    status BOOLEAN DEFAULT FALSE,
    due_date TIMESTAMPTZ,
    reminder_date TIMESTAMPTZ,
    reminder_time_of_day TEXT,
    completed_date TIMESTAMPTZ,
    completion_outcome TEXT,
    trashed_date TIMESTAMPTZ,
    manual_sort_index REAL DEFAULT 0,
    is_recurring_template BOOLEAN DEFAULT FALSE,
    is_marked_for_completion BOOLEAN DEFAULT FALSE,
    is_skipped BOOLEAN DEFAULT FALSE,
    is_urgent_alarm BOOLEAN DEFAULT FALSE,
    notification_status TEXT,
    recurrence_rule_data TEXT, -- JSON string for recurrence rules
    recurrence_summary TEXT,
    recurrence_status TEXT,
    recurrence_parent_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    series_id UUID,
    reschedule_count INTEGER DEFAULT 0,
    source UUID,
    account_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE,
    last_mutation_id UUID,
    last_modified_device_id TEXT
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_series_id ON tasks(series_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_last_mutation ON tasks(user_id, last_mutation_id) WHERE last_mutation_id IS NOT NULL;

-- ============================================
-- NOTES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT,
    first_line_clean TEXT,
    second_line_clean TEXT,
    word_count INTEGER DEFAULT 0,
    character_count INTEGER DEFAULT 0,
    is_flagged BOOLEAN DEFAULT FALSE,
    in_archive BOOLEAN DEFAULT FALSE,
    is_private BOOLEAN DEFAULT FALSE,
    trashed_date TIMESTAMPTZ,
    pinned_date TIMESTAMPTZ,
    creation_latitude DOUBLE PRECISION DEFAULT 0,
    creation_longitude DOUBLE PRECISION DEFAULT 0,
    creation_location_description TEXT,
    pdf_asset_name TEXT,
    transcript TEXT,
    time_to_read TEXT,
    related_task_tag_id UUID,
    active_duration DOUBLE PRECISION DEFAULT 0,
    open_tasks INTEGER DEFAULT 0,
    completed_tasks INTEGER DEFAULT 0,
    backlinks UUID[] DEFAULT '{}',
    outgoing_note_links UUID[] DEFAULT '{}',
    account_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_edited_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_is_flagged ON notes(is_flagged);
CREATE INDEX IF NOT EXISTS idx_notes_in_archive ON notes(in_archive);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_last_edited_at ON notes(last_edited_at);
CREATE INDEX IF NOT EXISTS idx_notes_first_line ON notes(first_line_clean);

ALTER TABLE notes
ADD COLUMN IF NOT EXISTS related_task_tag_id UUID;

ALTER TABLE notes
ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;

UPDATE notes
SET last_edited_at = COALESCE(last_edited_at, updated_at)
WHERE last_edited_at IS NULL;

ALTER TABLE notes
ALTER COLUMN last_edited_at SET DEFAULT NOW();

-- ============================================
-- TAGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_favorite_for_task_lists BOOLEAN DEFAULT FALSE,
    is_favorite_for_note_lists BOOLEAN DEFAULT FALSE,
    is_hidden_for_task_lists BOOLEAN DEFAULT FALSE,
    is_hidden_for_note_lists BOOLEAN DEFAULT FALSE,
    account_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE,
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_updated_at ON tags(updated_at);

-- ============================================
-- WORKSPACES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'New Workspace',
    color_name TEXT,
    sort_index INTEGER DEFAULT 0,
    context_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at);

-- ============================================
-- AUDIO RECORDINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS audio_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
    duration DOUBLE PRECISION DEFAULT 0,
    local_file_name TEXT,
    cloud_storage_path TEXT,
    transcript TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_audio_recordings_note_id ON audio_recordings(note_id);
CREATE INDEX IF NOT EXISTS idx_audio_recordings_updated_at ON audio_recordings(updated_at);

-- ============================================
-- JUNCTION TABLES (Many-to-Many Relationships)
-- ============================================

-- Task-Tag relationships
CREATE TABLE IF NOT EXISTS task_tags (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_task_tags_task_id ON task_tags(task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags(tag_id);

-- Note-Tag relationships
CREATE TABLE IF NOT EXISTS note_tags (
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);

-- Workspace-Tag relationships
CREATE TABLE IF NOT EXISTS workspace_tags (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, tag_id)
);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_tags ENABLE ROW LEVEL SECURITY;

-- Policies for tasks
CREATE POLICY "Users can view own tasks" ON tasks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks" ON tasks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks" ON tasks
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks" ON tasks
    FOR DELETE USING (auth.uid() = user_id);

-- Policies for notes
CREATE POLICY "Users can view own notes" ON notes
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notes" ON notes
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes" ON notes
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notes" ON notes
    FOR DELETE USING (auth.uid() = user_id);

-- Policies for tags
CREATE POLICY "Users can view own tags" ON tags
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tags" ON tags
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tags" ON tags
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tags" ON tags
    FOR DELETE USING (auth.uid() = user_id);

-- Policies for workspaces
CREATE POLICY "Users can view own workspaces" ON workspaces
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own workspaces" ON workspaces
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own workspaces" ON workspaces
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own workspaces" ON workspaces
    FOR DELETE USING (auth.uid() = user_id);

-- Policies for audio_recordings
CREATE POLICY "Users can view own recordings" ON audio_recordings
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own recordings" ON audio_recordings
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own recordings" ON audio_recordings
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own recordings" ON audio_recordings
    FOR DELETE USING (auth.uid() = user_id);

-- Policies for junction tables (via related entities)
CREATE POLICY "Users can manage task_tags via tasks" ON task_tags
    FOR ALL USING (
        EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_tags.task_id AND tasks.user_id = auth.uid())
    );

CREATE POLICY "Users can manage note_tags via notes" ON note_tags
    FOR ALL USING (
        EXISTS (SELECT 1 FROM notes WHERE notes.id = note_tags.note_id AND notes.user_id = auth.uid())
    );

CREATE POLICY "Users can manage workspace_tags via workspaces" ON workspace_tags
    FOR ALL USING (
        EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = workspace_tags.workspace_id AND workspaces.user_id = auth.uid())
    );

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to update a note only if the caller still has the current sync revision
CREATE OR REPLACE FUNCTION update_note_if_current(
    p_note_id UUID,
    p_expected_updated_at TEXT,
    p_content TEXT,
    p_first_line_clean TEXT,
    p_second_line_clean TEXT,
    p_word_count INTEGER,
    p_character_count INTEGER,
    p_is_flagged BOOLEAN,
    p_in_archive BOOLEAN,
    p_is_private BOOLEAN,
    p_trashed_date TIMESTAMPTZ,
    p_pinned_date TIMESTAMPTZ,
    p_creation_latitude DOUBLE PRECISION,
    p_creation_longitude DOUBLE PRECISION,
    p_creation_location_description TEXT,
    p_pdf_asset_name TEXT,
    p_transcript TEXT,
    p_time_to_read TEXT,
    p_related_task_tag_id UUID,
    p_active_duration DOUBLE PRECISION,
    p_open_tasks INTEGER,
    p_completed_tasks INTEGER,
    p_backlinks UUID[],
    p_outgoing_note_links UUID[],
    p_last_edited_at TIMESTAMPTZ,
    p_is_deleted BOOLEAN
)
RETURNS TABLE(status TEXT, note JSONB) AS $$
DECLARE
    v_expected_updated_at TIMESTAMPTZ := NULLIF(p_expected_updated_at, '')::TIMESTAMPTZ;
    current_note notes%ROWTYPE;
    updated_note notes%ROWTYPE;
BEGIN
    SELECT *
    INTO current_note
    FROM notes
    WHERE id = p_note_id
      AND user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'missing'::TEXT, NULL::JSONB;
        RETURN;
    END IF;

    -- Client timestamps carry millisecond precision while updated_at carries
    -- microseconds (NOW()), so equality must allow 1ms of slack — exact
    -- comparison would mark every update stale (see upsert_task_if_current).
    IF v_expected_updated_at IS NULL
       OR abs(extract(epoch from (current_note.updated_at - v_expected_updated_at))) > 0.001 THEN
        RETURN QUERY SELECT 'stale'::TEXT, to_jsonb(current_note);
        RETURN;
    END IF;

    UPDATE notes
    SET content = p_content,
        first_line_clean = p_first_line_clean,
        second_line_clean = p_second_line_clean,
        word_count = p_word_count,
        character_count = p_character_count,
        is_flagged = p_is_flagged,
        in_archive = p_in_archive,
        is_private = p_is_private,
        trashed_date = p_trashed_date,
        pinned_date = p_pinned_date,
        creation_latitude = p_creation_latitude,
        creation_longitude = p_creation_longitude,
        creation_location_description = p_creation_location_description,
        pdf_asset_name = p_pdf_asset_name,
        transcript = p_transcript,
        time_to_read = p_time_to_read,
        related_task_tag_id = p_related_task_tag_id,
        active_duration = p_active_duration,
        open_tasks = p_open_tasks,
        completed_tasks = p_completed_tasks,
        backlinks = p_backlinks,
        outgoing_note_links = p_outgoing_note_links,
        last_edited_at = p_last_edited_at,
        updated_at = NOW(),
        is_deleted = p_is_deleted
    WHERE id = p_note_id
      AND user_id = auth.uid()
    RETURNING *
    INTO updated_note;

    RETURN QUERY SELECT 'updated'::TEXT, to_jsonb(updated_note);
END;
$$ language 'plpgsql';

GRANT EXECUTE ON FUNCTION update_note_if_current(
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    INTEGER,
    INTEGER,
    BOOLEAN,
    BOOLEAN,
    BOOLEAN,
    TIMESTAMPTZ,
    TIMESTAMPTZ,
    DOUBLE PRECISION,
    DOUBLE PRECISION,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    UUID,
    DOUBLE PRECISION,
    INTEGER,
    INTEGER,
    UUID[],
    UUID[],
    TIMESTAMPTZ,
    BOOLEAN
) TO authenticated;

-- Triggers for updated_at
CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notes_updated_at
    BEFORE UPDATE ON notes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tags_updated_at
    BEFORE UPDATE ON tags
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workspaces_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_audio_recordings_updated_at
    BEFORE UPDATE ON audio_recordings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- REALTIME SUBSCRIPTIONS
-- ============================================

-- Enable realtime for sync
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE notes;
ALTER PUBLICATION supabase_realtime ADD TABLE tags;
ALTER PUBLICATION supabase_realtime ADD TABLE workspaces;
ALTER PUBLICATION supabase_realtime ADD TABLE audio_recordings;

-- ============================================
-- NOTE VERSIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS note_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    content TEXT,
    word_count INTEGER DEFAULT 0,
    character_count INTEGER DEFAULT 0,
    first_line_clean TEXT,
    content_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_note_versions_user_id ON note_versions(user_id);
CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
CREATE INDEX IF NOT EXISTS idx_note_versions_created_at ON note_versions(created_at);

ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own versions" ON note_versions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own versions" ON note_versions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own versions" ON note_versions
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own versions" ON note_versions
    FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_note_versions_updated_at
    BEFORE UPDATE ON note_versions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER PUBLICATION supabase_realtime ADD TABLE note_versions;

-- ============================================
-- STORAGE BUCKETS (run separately in Supabase dashboard)
-- ============================================
-- Create these buckets in Supabase Storage:
-- 1. audio-recordings (private)
-- 2. pdfs (private)
-- 3. assets (private)

-- Exact note revisions and atomic note/tag writes (v22 clients).
-- Deploy before clients using note revision sync. Legacy RPC remains available.
BEGIN;
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.advance_note_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.revision := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.revision + 1 END;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zz_notes_revision ON public.notes;
CREATE TRIGGER zz_notes_revision BEFORE INSERT OR UPDATE ON public.notes
FOR EACH ROW EXECUTE FUNCTION public.advance_note_revision();

-- Tag changes made by older clients also invalidate the accepted note revision.
CREATE OR REPLACE FUNCTION public.touch_note_tag_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.notes SET updated_at = clock_timestamp() WHERE id = OLD.note_id;
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.note_id IS DISTINCT FROM OLD.note_id) THEN
    UPDATE public.notes SET updated_at = clock_timestamp() WHERE id = NEW.note_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS note_tags_revision ON public.note_tags;
CREATE TRIGGER note_tags_revision AFTER INSERT OR UPDATE OR DELETE ON public.note_tags
FOR EACH ROW EXECUTE FUNCTION public.touch_note_tag_revision();

CREATE OR REPLACE FUNCTION public.update_note_if_current_v2(
  p_note JSONB, p_expected_revision BIGINT, p_create_if_missing BOOLEAN DEFAULT FALSE
) RETURNS TABLE(status TEXT, note JSONB)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  current_note public.notes%ROWTYPE;
  incoming public.notes%ROWTYPE;
  v_note_id UUID := (p_note->>'id')::UUID;
  wanted_tags UUID[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_note->'tag_ids', '[]'::jsonb))::UUID);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  incoming := jsonb_populate_record(NULL::public.notes, p_note);
  IF EXISTS (SELECT 1 FROM unnest(wanted_tags) AS t(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.tags WHERE tags.id = t.id AND user_id = auth.uid())) THEN
    RAISE EXCEPTION 'Tag does not belong to current user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO current_note FROM public.notes
    WHERE id = v_note_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND AND p_create_if_missing AND p_expected_revision = 0 THEN
    INSERT INTO public.notes (id, user_id, created_at, content, first_line_clean, second_line_clean, word_count, character_count, is_flagged, in_archive, is_private, trashed_date, pinned_date, creation_latitude, creation_longitude, creation_location_description, pdf_asset_name, transcript, time_to_read, related_task_tag_id, active_duration, open_tasks, completed_tasks, backlinks, outgoing_note_links, last_edited_at, is_deleted)
    VALUES (v_note_id, auth.uid(), COALESCE(incoming.created_at, clock_timestamp()), incoming.content, incoming.first_line_clean, incoming.second_line_clean, incoming.word_count, incoming.character_count, incoming.is_flagged, incoming.in_archive, incoming.is_private, incoming.trashed_date, incoming.pinned_date, incoming.creation_latitude, incoming.creation_longitude, incoming.creation_location_description, incoming.pdf_asset_name, incoming.transcript, incoming.time_to_read, incoming.related_task_tag_id, incoming.active_duration, incoming.open_tasks, incoming.completed_tasks, incoming.backlinks, incoming.outgoing_note_links, incoming.last_edited_at, incoming.is_deleted)
    ON CONFLICT (id) DO NOTHING RETURNING * INTO current_note;
    IF NOT FOUND THEN
      SELECT * INTO current_note FROM public.notes
        WHERE id = v_note_id AND user_id = auth.uid() FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Note unavailable' USING ERRCODE = '42501'; END IF;
      RETURN QUERY SELECT 'stale'::TEXT, to_jsonb(current_note) || jsonb_build_object('tag_ids',
        ARRAY(SELECT tag_id FROM public.note_tags WHERE note_id = current_note.id));
      RETURN;
    END IF;
  ELSE
    IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::TEXT, NULL::JSONB; RETURN; END IF;
    IF p_expected_revision IS NULL OR current_note.revision <> p_expected_revision THEN
      RETURN QUERY SELECT 'stale'::TEXT, to_jsonb(current_note) || jsonb_build_object('tag_ids',
        ARRAY(SELECT tag_id FROM public.note_tags WHERE note_id = current_note.id));
      RETURN;
    END IF;
    UPDATE public.notes SET content = incoming.content,
      first_line_clean = incoming.first_line_clean,
      second_line_clean = incoming.second_line_clean,
      word_count = incoming.word_count,
      character_count = incoming.character_count,
      is_flagged = incoming.is_flagged,
      in_archive = incoming.in_archive,
      is_private = incoming.is_private,
      trashed_date = incoming.trashed_date,
      pinned_date = incoming.pinned_date,
      creation_latitude = incoming.creation_latitude,
      creation_longitude = incoming.creation_longitude,
      creation_location_description = incoming.creation_location_description,
      pdf_asset_name = incoming.pdf_asset_name,
      transcript = incoming.transcript,
      time_to_read = incoming.time_to_read,
      related_task_tag_id = incoming.related_task_tag_id,
      active_duration = incoming.active_duration,
      open_tasks = incoming.open_tasks,
      completed_tasks = incoming.completed_tasks,
      backlinks = incoming.backlinks,
      outgoing_note_links = incoming.outgoing_note_links,
      last_edited_at = incoming.last_edited_at,
      is_deleted = incoming.is_deleted
      WHERE id = v_note_id AND user_id = auth.uid();
  END IF;
  DELETE FROM public.note_tags AS nt WHERE nt.note_id = v_note_id AND NOT (nt.tag_id = ANY(wanted_tags));
  INSERT INTO public.note_tags (note_id, tag_id)
    SELECT v_note_id, id FROM unnest(wanted_tags) AS t(id) ON CONFLICT DO NOTHING;
  SELECT * INTO current_note FROM public.notes WHERE id = v_note_id AND user_id = auth.uid();
  RETURN QUERY SELECT 'updated'::TEXT, to_jsonb(current_note) || jsonb_build_object('tag_ids', wanted_tags);
END;
$$;
-- Supabase can grant anon EXECUTE through default privileges independently of PUBLIC.
REVOKE ALL ON FUNCTION public.update_note_if_current_v2(JSONB, BIGINT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_note_if_current_v2(JSONB, BIGINT, BOOLEAN) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
