-- MANUAL ONLY, separate approval. First pause ALL writers and drain in-flight
-- RPCs. This guard alone does not drain executing function invocations.
-- Refuse downgrade while compact staged requests still need this implementation.
begin;
set local lock_timeout='5s';
do $guard$ begin
  if exists(select 1 from public.workbench_row_staging where not(operation?'collection')) then
    raise exception 'Compact staged requests remain; retain compatible stage function and preserve all drafts' using errcode='55000';
  end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.stage_workbench_rows(p_request_id uuid, p_offset integer, p_changes jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare owner_id uuid := auth.uid(); batch public.workbench_row_batches; entry record; existing jsonb; item jsonb; added_bytes bigint := 0;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null or p_offset is null or p_offset < 0 or p_changes is null or pg_catalog.jsonb_typeof(p_changes)<>'array' then
    raise exception 'Invalid stage chunk' using errcode='22023';
  end if;
  if pg_catalog.jsonb_array_length(p_changes) not between 1 and 200 or pg_catalog.octet_length(p_changes::text)>524288 then
    raise exception 'Stage chunk exceeds limits' using errcode='22023';
  end if;
  select * into batch from public.workbench_row_batches where user_id=owner_id and request_id=p_request_id for update;
  if not found then raise exception 'Unknown batch' using errcode='22023'; end if;
  if batch.result_revision is not null then return; end if;
  if p_offset::bigint + pg_catalog.jsonb_array_length(p_changes) > batch.operation_count then raise exception 'Stage outside batch' using errcode='22023'; end if;
  for entry in select value,ordinality from pg_catalog.jsonb_array_elements(p_changes) with ordinality loop
    item := entry.value;
    if pg_catalog.jsonb_typeof(item)<>'object' or pg_catalog.jsonb_typeof(item->'collection') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item->'scope') is distinct from 'string' or pg_catalog.jsonb_typeof(item->'record_key') is distinct from 'string' then
      raise exception 'Invalid row identity' using errcode='22023';
    end if;
    if item ? 'row' then
      if item ? 'position' then raise exception 'Ambiguous row operation' using errcode='22023'; end if;
      if item->'row' <> 'null'::jsonb and (pg_catalog.jsonb_typeof(item->'row')<>'object' or not ((item->'row') ? 'body')
        or (item->'row'->>'collection') is distinct from (item->>'collection') or (item->'row'->>'scope') is distinct from (item->>'scope')
        or (item->'row'->>'record_key') is distinct from (item->>'record_key')
        or coalesce(item->'row'->>'position','') !~ '^(0|[1-9][0-9]{0,8})$') then
        raise exception 'Invalid row payload' using errcode='22023';
      end if;
    else
      -- Compact move cannot carry a body, deletion or any other hidden mutation.
      if pg_catalog.jsonb_typeof(item->'position') is distinct from 'number'
        or coalesce(item->>'position','') !~ '^(0|[1-9][0-9]{0,8})$'
        or (item - 'collection' - 'scope' - 'record_key' - 'position') <> '{}'::jsonb then
        raise exception 'Invalid position operation' using errcode='22023';
      end if;
    end if;
    select operation into existing from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id and operation_index=p_offset+entry.ordinality-1;
    if found then
      if existing is distinct from item then raise exception 'Stage retry changed payload' using errcode='22023'; end if;
    else
      insert into public.workbench_row_staging values(owner_id,p_request_id,p_offset+entry.ordinality-1,item->>'collection',item->>'scope',item->>'record_key',item);
      added_bytes := added_bytes + pg_catalog.octet_length(item::text);
    end if;
  end loop;
  if batch.staged_bytes + added_bytes > 8388608 then raise exception 'Atomic batch exceeds 8 MiB; local changes retained' using errcode='54000'; end if;
  update public.workbench_row_batches set staged_bytes=staged_bytes+added_bytes where user_id=owner_id and request_id=p_request_id and added_bytes>0;
end $function$;
revoke all on function public.stage_workbench_rows(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.stage_workbench_rows(uuid,integer,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
