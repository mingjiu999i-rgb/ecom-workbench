-- Transport-only update. The existing JSON document and all business values retain
-- their original shape. No ledger, settlement, normalization or export rules change.
begin;
alter table public.workbench_documents add column if not exists last_sync_request jsonb;

create or replace function public._workbench_apply_delta(p_current jsonb, p_delta jsonb, p_depth integer default 0)
returns jsonb language plpgsql immutable security invoker set search_path = ''
as $function$
declare
  result jsonb; tail jsonb; entry record; length_text text; new_length integer; old_length integer; existing_changes integer;
begin
  if p_depth is null or p_depth < 0 or p_depth > 64 or pg_catalog.jsonb_typeof(p_delta) is distinct from 'object' then
    raise exception 'Invalid transport delta' using errcode='22023';
  end if;
  case p_delta->>'t'
  when 'r' then
    if not (p_delta ? 'v') then raise exception 'Missing replacement value' using errcode='22023'; end if;
    return p_delta->'v';
  when 'o' then
    if pg_catalog.jsonb_typeof(p_current) is distinct from 'object' or pg_catalog.jsonb_typeof(p_delta->'v') is distinct from 'object' or pg_catalog.jsonb_typeof(p_delta->'d') is distinct from 'array' then
      raise exception 'Invalid object delta' using errcode='22023';
    end if;
    result := p_current;
    if pg_catalog.jsonb_array_length(p_delta->'d')>0 then
      result := p_current - array(select pg_catalog.jsonb_array_elements_text(p_delta->'d'));
    end if;
    for entry in select key,value from pg_catalog.jsonb_each(p_delta->'v') loop
      result := pg_catalog.jsonb_set(result,array[entry.key],public._workbench_apply_delta(p_current->entry.key,entry.value,p_depth+1),true);
    end loop;
    return result;
  when 'a' then
    length_text := p_delta->>'l';
    if pg_catalog.jsonb_typeof(p_current) is distinct from 'array' or pg_catalog.jsonb_typeof(p_delta->'v') is distinct from 'object' or length_text is null or length_text !~ '^(0|[1-9][0-9]{0,8})$' then
      raise exception 'Invalid array delta' using errcode='22023';
    end if;
    new_length := length_text::integer;
    old_length := pg_catalog.jsonb_array_length(p_current);
    if exists(select 1 from pg_catalog.jsonb_object_keys(p_delta->'v') k where k !~ '^(0|[1-9][0-9]{0,8})$') then
      raise exception 'Invalid array index' using errcode='22023';
    end if;
    if exists(select 1 from pg_catalog.jsonb_object_keys(p_delta->'v') k where k::integer >= new_length) then
      raise exception 'Array index outside result' using errcode='22023';
    end if;
    if new_length > old_length and exists(select 1 from pg_catalog.generate_series(old_length,new_length-1) i where not ((p_delta->'v') ? i::text)) then
      raise exception 'Missing appended value' using errcode='22023';
    end if;
    if new_length=0 then return '[]'::jsonb; end if;
    result:=p_current;
    if new_length<old_length then
      result:=pg_catalog.jsonb_path_query_array(p_current,('$[0 to '||(new_length-1)::text||']')::pg_catalog.jsonpath);
    end if;
    select count(*) into existing_changes from pg_catalog.jsonb_object_keys(p_delta->'v') k where k::integer<least(old_length,new_length);
    if existing_changes<=8 then
      -- Sparse edits use the native JSONB setter without expanding/sorting a
      -- complete historical ledger. Appended values are collected separately.
      for entry in select key,value from pg_catalog.jsonb_each(p_delta->'v') where key::integer<least(old_length,new_length) loop
        result:=pg_catalog.jsonb_set(result,array[entry.key],public._workbench_apply_delta(p_current->(entry.key::integer),entry.value,p_depth+1),false);
      end loop;
    else
      select pg_catalog.jsonb_agg(case when (p_delta->'v') ? (items.position-1)::text
        then public._workbench_apply_delta(items.value,(p_delta->'v')->(items.position-1)::text,p_depth+1)
        else items.value end order by items.position)
        into result from pg_catalog.jsonb_array_elements(result) with ordinality items(value,position);
    end if;
    if new_length>old_length then
      select pg_catalog.jsonb_agg(public._workbench_apply_delta(null,(p_delta->'v')->i::text,p_depth+1) order by i)
        into tail from pg_catalog.generate_series(old_length,new_length-1) i;
      result:=result||tail;
    end if;
    return result;
  else raise exception 'Unknown transport delta' using errcode='22023';
  end case;
end;
$function$;

create or replace function public.save_workbench_delta(p_delta jsonb, p_expected_updated_at timestamptz, p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = ''
as $function$
declare current_data jsonb; current_updated_at timestamptz; last_request jsonb; saved_at timestamptz; result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_expected_updated_at is null or p_request_id is null or p_delta is null then raise exception 'Missing save revision' using errcode='22023'; end if;
  select data,updated_at,last_sync_request into current_data,current_updated_at,last_request
    from public.workbench_documents where user_id=auth.uid() for update;
  if not found then raise exception 'Workbench document not found' using errcode='P0002'; end if;
  -- A lost response may be retried without writing again. A later legacy save
  -- changes updated_at, so it cannot accidentally acknowledge this old request.
  if last_request->>'id'=p_request_id::text and (last_request->>'updated_at')::timestamptz=current_updated_at then
    return pg_catalog.jsonb_build_object('updated_at',current_updated_at);
  end if;
  if current_updated_at is distinct from p_expected_updated_at then
    raise exception 'Cloud data changed since loading; local changes retained' using errcode='40001';
  end if;
  result := public._workbench_apply_delta(current_data,p_delta);
  if pg_catalog.jsonb_typeof(result) <> 'object' then raise exception 'Workbench must remain an object' using errcode='22023'; end if;
  saved_at := pg_catalog.clock_timestamp();
  update public.workbench_documents set data=result,updated_at=saved_at,
    last_sync_request=pg_catalog.jsonb_build_object('id',p_request_id,'updated_at',saved_at)
    where user_id=auth.uid();
  return pg_catalog.jsonb_build_object('updated_at',saved_at);
end;
$function$;
revoke all on function public._workbench_apply_delta(jsonb,jsonb,integer) from public,anon;
revoke all on function public.save_workbench_delta(jsonb,timestamptz,uuid) from public,anon;
grant execute on function public._workbench_apply_delta(jsonb,jsonb,integer) to authenticated;
grant execute on function public.save_workbench_delta(jsonb,timestamptz,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
