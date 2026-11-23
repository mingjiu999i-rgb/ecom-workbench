-- PROPOSAL ONLY: requires separate production approval.
-- No business DML, schema/limit/timeout changes, or frontend wire-format changes.
begin;
set local lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.stage_workbench_rows(p_request_id uuid, p_offset integer, p_changes jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare owner_id uuid := auth.uid(); batch public.workbench_row_batches; entry record; existing public.workbench_row_staging; item jsonb; compact_item jsonb; compact_existing jsonb; added_bytes bigint := 0; payload jsonb; flags integer;
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
    -- Internal row tuple: [position, body, store_id, client_id, business_date,
    -- optional-key presence mask plus exact-value reference flags, unknown fields].
    -- External RPC remains unchanged. Null/absent and unknown fields survive.
    compact_item := item-'collection'-'scope'-'record_key';
    if pg_catalog.jsonb_typeof(item->'row')='object' then
      payload := (item->'row')-'collection'-'scope'-'record_key';
      flags := (case when payload ? 'store_id' then 1 else 0 end)+(case when payload ? 'client_id' then 2 else 0 end)+(case when payload ? 'business_date' then 4 else 0 end);
      -- Reuse only values proven exactly equal; never infer store/client/date.
      if pg_catalog.jsonb_typeof(payload->'store_id')='string' then
        if payload->'store_id'=payload->'body'->'storeId' then flags := flags | 8;
        elsif item->>'scope'=pg_catalog.jsonb_build_array(payload->'store_id')::text then flags := flags | 16; end if;
      end if;
      if pg_catalog.jsonb_typeof(payload->'client_id')='string' and payload->'client_id'=payload->'body'->'clientId' then flags := flags | 32; end if;
      if pg_catalog.jsonb_typeof(payload->'business_date')='string' and payload->'business_date'=payload->'body'->'date' then flags := flags | 64; end if;
      compact_item := pg_catalog.jsonb_set(compact_item,'{row}',pg_catalog.jsonb_build_array(
        payload->'position',payload->'body',case when (flags & 24)<>0 then null else payload->'store_id' end,
        case when (flags & 32)<>0 then null else payload->'client_id' end,
        case when (flags & 64)<>0 then null else payload->'business_date' end,flags,
        payload-'position'-'body'-'store_id'-'client_id'-'business_date'));
    end if;
    select * into existing from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id and operation_index=p_offset+entry.ordinality-1;
    if found then
      compact_existing := existing.operation-'collection'-'scope'-'record_key';
      if pg_catalog.jsonb_typeof(existing.operation->'row')='object' then
        payload := (existing.operation->'row')-'collection'-'scope'-'record_key';
      flags := (case when payload ? 'store_id' then 1 else 0 end)+(case when payload ? 'client_id' then 2 else 0 end)+(case when payload ? 'business_date' then 4 else 0 end);
      -- Reuse only values proven exactly equal; never infer store/client/date.
      if pg_catalog.jsonb_typeof(payload->'store_id')='string' then
        if payload->'store_id'=payload->'body'->'storeId' then flags := flags | 8;
        elsif existing.scope=pg_catalog.jsonb_build_array(payload->'store_id')::text then flags := flags | 16; end if;
      end if;
      if pg_catalog.jsonb_typeof(payload->'client_id')='string' and payload->'client_id'=payload->'body'->'clientId' then flags := flags | 32; end if;
      if pg_catalog.jsonb_typeof(payload->'business_date')='string' and payload->'business_date'=payload->'body'->'date' then flags := flags | 64; end if;
      compact_existing := pg_catalog.jsonb_set(compact_existing,'{row}',pg_catalog.jsonb_build_array(
        payload->'position',payload->'body',case when (flags & 24)<>0 then null else payload->'store_id' end,
        case when (flags & 32)<>0 then null else payload->'client_id' end,
        case when (flags & 64)<>0 then null else payload->'business_date' end,flags,
        payload-'position'-'body'-'store_id'-'client_id'-'business_date'));
      end if;
      -- Payload comparison must still include identity: removing duplicate
      -- JSON keys must never allow an index to be retried for another row.
      if existing.collection is distinct from item->>'collection'
        or existing.scope is distinct from item->>'scope'
        or existing.record_key is distinct from item->>'record_key'
        or compact_existing is distinct from compact_item then
        raise exception 'Stage retry changed payload' using errcode='22023';
      end if;
      if existing.operation is distinct from compact_item then
        update public.workbench_row_staging set operation=compact_item
          where user_id=owner_id and request_id=p_request_id and operation_index=p_offset+entry.ordinality-1;
        added_bytes := added_bytes + pg_catalog.octet_length(compact_item::text)-pg_catalog.octet_length(existing.operation::text);
      end if;
    else
      insert into public.workbench_row_staging values(owner_id,p_request_id,p_offset+entry.ordinality-1,item->>'collection',item->>'scope',item->>'record_key',compact_item);
      added_bytes := added_bytes + pg_catalog.octet_length(compact_item::text);
    end if;
  end loop;
  if batch.staged_bytes + added_bytes < 0 then raise exception 'Inconsistent staging byte counter' using errcode='22023'; end if;
  if batch.staged_bytes + added_bytes > 8388608 then raise exception 'Atomic batch exceeds 8 MiB; local changes retained' using errcode='54000'; end if;
  update public.workbench_row_batches set staged_bytes=staged_bytes+added_bytes where user_id=owner_id and request_id=p_request_id and added_bytes<>0;
end $function$
;
CREATE OR REPLACE FUNCTION public.commit_workbench_rows(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare owner_id uuid := auth.uid(); batch public.workbench_row_batches; head public.workbench_heads; total integer;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into head from public.workbench_heads where user_id=owner_id for update;
  if not found or head.mode <> 'rows' then raise exception 'Row storage is not active' using errcode='40001'; end if;
  select * into batch from public.workbench_row_batches where user_id=owner_id and request_id=p_request_id for update;
  if not found then raise exception 'Unknown batch' using errcode='22023'; end if;
  if batch.result_revision is not null then return pg_catalog.jsonb_build_object('revision',batch.result_revision::text); end if;
  if head.revision <> batch.expected_revision then raise exception 'Cloud data changed; local changes retained' using errcode='40001'; end if;
  select count(*) into total from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id;
  if total <> batch.operation_count then raise exception 'Incomplete staged batch' using errcode='22023'; end if;
  -- Check moves before any mutation, under the same account revision lock.
  if exists (
    select 1 from public.workbench_row_staging s
    where s.user_id=owner_id and s.request_id=p_request_id and not (s.operation ? 'row')
      and not exists (select 1 from public.workbench_rows r where r.user_id=owner_id
        and r.collection=s.collection and r.scope=s.scope and r.record_key=s.record_key)
  ) then raise exception 'Position target missing; local changes retained' using errcode='40001'; end if;
  delete from public.workbench_rows r using public.workbench_row_staging s
    where s.user_id=owner_id and s.request_id=p_request_id and s.operation->'row'='null'::jsonb
      and r.user_id=owner_id and r.collection=s.collection and r.scope=s.scope and r.record_key=s.record_key;
  insert into public.workbench_rows as r(user_id,collection,scope,record_key,position,body,store_id,client_id,business_date)
    select owner_id,s.collection,s.scope,s.record_key,((case when pg_catalog.jsonb_typeof(s.operation->'row')='array' then s.operation->'row'->>0 else s.operation->'row'->>'position' end))::integer,
      (case when pg_catalog.jsonb_typeof(s.operation->'row')='array' then s.operation->'row'->1 else s.operation->'row'->'body' end),(case when pg_catalog.jsonb_typeof(s.operation->'row')='array' then case when ((s.operation->'row'->>5)::integer & 8)<>0 then s.operation->'row'->1->>'storeId' when ((s.operation->'row'->>5)::integer & 16)<>0 then s.scope::jsonb->>0 else s.operation->'row'->>2 end else s.operation->'row'->>'store_id' end),(case when pg_catalog.jsonb_typeof(s.operation->'row')='array' then case when ((s.operation->'row'->>5)::integer & 32)<>0 then s.operation->'row'->1->>'clientId' else s.operation->'row'->>3 end else s.operation->'row'->>'client_id' end),(case when pg_catalog.jsonb_typeof(s.operation->'row')='array' then case when ((s.operation->'row'->>5)::integer & 64)<>0 then s.operation->'row'->1->>'date' else s.operation->'row'->>4 end else s.operation->'row'->>'business_date' end)
      from public.workbench_row_staging s where s.user_id=owner_id and s.request_id=p_request_id and s.operation->'row'<>'null'::jsonb
    on conflict(user_id,collection,scope,record_key) do update set position=excluded.position,body=excluded.body,
      store_id=excluded.store_id,client_id=excluded.client_id,business_date=excluded.business_date
    where (r.position,r.body,r.store_id,r.client_id,r.business_date) is distinct from
      (excluded.position,excluded.body,excluded.store_id,excluded.client_id,excluded.business_date);
  update public.workbench_rows r set position=(s.operation->>'position')::integer
    from public.workbench_row_staging s where s.user_id=owner_id and s.request_id=p_request_id
      and not (s.operation ? 'row') and r.user_id=owner_id
      and r.collection=s.collection and r.scope=s.scope and r.record_key=s.record_key
      and r.position is distinct from (s.operation->>'position')::integer;
  update public.workbench_heads set revision=revision+1 where user_id=owner_id returning * into head;
  update public.workbench_row_batches set result_revision=head.revision where user_id=owner_id and request_id=p_request_id;
  delete from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id;
  return pg_catalog.jsonb_build_object('revision',head.revision::text);
end $function$
;
revoke all on function public.stage_workbench_rows(uuid,integer,jsonb),public.commit_workbench_rows(uuid) from public,anon,authenticated;
grant execute on function public.stage_workbench_rows(uuid,integer,jsonb),public.commit_workbench_rows(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
