-- PROPOSAL: replace only two read RPCs after separate production approval.
-- Same signatures, rows, ordering, RLS, page limits and byte budget.
begin;
set local lock_timeout='5s';

create or replace function public.read_workbench_row_collections()
returns setof text language sql stable security invoker set search_path='' as $$
  -- Seek the next distinct collection using the existing leading PK columns.
  -- Do not rescan every business row merely to enumerate its collections.
  with recursive collection_walk as (
    (select r.collection from public.workbench_rows r
      where r.user_id=(select auth.uid()) order by r.collection limit 1)
    union all
    select next_collection.collection from collection_walk previous
    cross join lateral (
      select r.collection from public.workbench_rows r
      where r.user_id=(select auth.uid()) and r.collection>previous.collection
      order by r.collection limit 1
    ) next_collection
  ) select collection from collection_walk order by collection
$$;

create or replace function public.read_workbench_rows_collection_page(
  p_collection text,p_after text[] default null,p_limit integer default 500,p_max_bytes integer default 262144
)
returns setof public.workbench_rows language plpgsql stable security invoker set search_path='' as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null or p_collection is null then return; end if;
  -- Separate first/subsequent pages so generic cached plans can use the
  -- cursor as an index range, instead of filtering every preceding row.
  if p_after is null then
    return query
    with page as materialized (
      select r.* from public.workbench_rows r
      where r.user_id=owner_id and r.collection=p_collection
      order by r.scope,r.record_key limit least(greatest(p_limit,1),500)
    ), sized as (
      select r.*,pg_catalog.row_number() over(order by r.scope,r.record_key) as rn,
        pg_catalog.sum(pg_catalog.octet_length(r.body::text)+pg_catalog.octet_length(r.collection)+
          pg_catalog.octet_length(r.scope)+pg_catalog.octet_length(r.record_key)+64)
          over(order by r.scope,r.record_key) as running_bytes
      from page r
    )
    select r.user_id,r.collection,r.scope,r.record_key,r.position,r.body,r.store_id,r.client_id,r.business_date
      from sized r where r.rn=1 or r.running_bytes<=least(greatest(p_max_bytes,32768),524288)
      order by r.scope,r.record_key;
  else
    return query
    with page as materialized (
      select r.* from public.workbench_rows r
      where r.user_id=owner_id and r.collection=p_collection
        and (r.scope,r.record_key)>(p_after[2],p_after[3])
      order by r.scope,r.record_key limit least(greatest(p_limit,1),500)
    ), sized as (
      select r.*,pg_catalog.row_number() over(order by r.scope,r.record_key) as rn,
        pg_catalog.sum(pg_catalog.octet_length(r.body::text)+pg_catalog.octet_length(r.collection)+
          pg_catalog.octet_length(r.scope)+pg_catalog.octet_length(r.record_key)+64)
          over(order by r.scope,r.record_key) as running_bytes
      from page r
    )
    select r.user_id,r.collection,r.scope,r.record_key,r.position,r.body,r.store_id,r.client_id,r.business_date
      from sized r where r.rn=1 or r.running_bytes<=least(greatest(p_max_bytes,32768),524288)
      order by r.scope,r.record_key;
  end if;
end $$;

revoke all on function public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
