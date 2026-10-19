-- Transport/storage repair only. No settlement values, rules or history are changed.
begin;

-- Authenticated writes were restricted to 8 seconds, including decoding ~16 MB
-- snapshots. Keep anonymous requests and lock timeouts unchanged.
alter role authenticated set statement_timeout = '60s';
-- Faster lossless compression for future saves; existing rows remain untouched.
alter table public.workbench_documents alter column data set compression lz4;

-- Small edits send only changed top-level sections instead of resending ledgers.
-- This function runs with the caller's existing permissions and RLS policies.
create or replace function public.save_workbench_patch(
  p_updates jsonb,
  p_remove text[] default array[]::text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  saved_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_updates is null or pg_catalog.jsonb_typeof(p_updates) <> 'object' then
    raise exception 'Updates must be a JSON object' using errcode = '22023';
  end if;
  update public.workbench_documents
    set data = (data - coalesce(p_remove, array[]::text[])) || p_updates,
        updated_at = pg_catalog.clock_timestamp()
    where user_id = auth.uid()
    returning updated_at into saved_at;
  if not found then
    raise exception 'Workbench document not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('updated_at', saved_at);
end;
$function$;

revoke all on function public.save_workbench_patch(jsonb, text[]) from public;
revoke all on function public.save_workbench_patch(jsonb, text[]) from anon;
grant execute on function public.save_workbench_patch(jsonb, text[]) to authenticated;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
commit;
