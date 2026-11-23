-- MANUAL, separate approval: restore the two previous read-only RPCs.
begin;
set local lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.read_workbench_row_collections()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select distinct r.collection from public.workbench_rows r
  where r.user_id=auth.uid() order by r.collection
$function$;
CREATE OR REPLACE FUNCTION public.read_workbench_rows_collection_page(p_collection text, p_after text[] DEFAULT NULL::text[], p_limit integer DEFAULT 500, p_max_bytes integer DEFAULT 262144)
 RETURNS SETOF workbench_rows
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with candidates as (
    select r.*,
      pg_catalog.row_number() over(order by r.scope,r.record_key) as rn,
      pg_catalog.sum(pg_catalog.octet_length(r.body::text)+pg_catalog.octet_length(r.collection)+
        pg_catalog.octet_length(r.scope)+pg_catalog.octet_length(r.record_key)+64)
        over(order by r.scope,r.record_key) as running_bytes
    from public.workbench_rows r
    where r.user_id=auth.uid() and r.collection=p_collection
      and (p_after is null or (r.scope,r.record_key)>(p_after[2],p_after[3]))
    order by r.scope,r.record_key
    limit least(greatest(p_limit,1),500)
  )
  select user_id,collection,scope,record_key,position,body,store_id,client_id,business_date
  from candidates
  where rn=1 or running_bytes<=least(greatest(p_max_bytes,32768),524288)
  order by scope,record_key
$function$;
revoke all on function public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
