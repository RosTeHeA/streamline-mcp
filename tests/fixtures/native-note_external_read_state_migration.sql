-- Snapshot of Streamline native schema for isolated compatibility tests. No production data.
-- Apply before releasing the unread-note client. Existing notes start read;
-- only subsequent external inserts/body changes get an unread revision.
-- Native clients identify their requests with x-streamline-client: app.
-- MCP, REST and SQL writers need no changes and must omit that header.
-- Older native builds without the header will also count as external writers.
-- Read receipts use a separate RPC so opening a note never uploads its body.

BEGIN;

ALTER TABLE public.notes
    ADD COLUMN IF NOT EXISTS external_update_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS external_read_revision BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.track_note_external_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    headers JSONB := COALESCE(NULLIF(current_setting('request.headers', true), ''), '{}')::JSONB;
    is_native BOOLEAN := COALESCE(headers->>'x-streamline-client', '') = 'app';
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.external_update_revision := CASE WHEN is_native THEN 0 ELSE 1 END;
        NEW.external_read_revision := 0;
    ELSE
        -- Derived previews, tags, pins, flags and sync bookkeeping don't make
        -- an unchanged note body unread. Attachment replacements do.
        NEW.external_update_revision := OLD.external_update_revision;
        IF NOT is_native AND (
            NEW.content IS DISTINCT FROM OLD.content
            OR NEW.pdf_asset_name IS DISTINCT FROM OLD.pdf_asset_name
            OR NEW.transcript IS DISTINCT FROM OLD.transcript
        ) THEN
            NEW.external_update_revision := OLD.external_update_revision + 1;
        END IF;
        NEW.external_read_revision := LEAST(NEW.external_update_revision,
            GREATEST(OLD.external_read_revision, COALESCE(NEW.external_read_revision, 0)));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_note_external_changes ON public.notes;
CREATE TRIGGER track_note_external_changes
    BEFORE INSERT OR UPDATE ON public.notes
    FOR EACH ROW EXECUTE FUNCTION public.track_note_external_changes();

CREATE OR REPLACE FUNCTION public.mark_note_external_changes_read(p_note_id UUID, p_revision BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    -- Row locking is implicit in UPDATE. A receipt for revision N can never
    -- clear N+1, even if a newer external edit arrives before this request.
    -- The existing updated_at trigger makes receipts visible to incremental sync.
    UPDATE public.notes
    SET external_read_revision = LEAST(external_update_revision, p_revision)
    WHERE id = p_note_id
      AND user_id = auth.uid()
      AND p_revision > 0
      AND external_read_revision < LEAST(external_update_revision, p_revision);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_note_external_changes_read(UUID, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_note_external_changes_read(UUID, BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
