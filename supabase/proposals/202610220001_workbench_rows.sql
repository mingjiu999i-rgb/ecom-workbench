-- PROPOSAL: isolated tests only. Production installation/cutover needs approval.
-- Additive schema, no copy/drop/update of any existing business document.
begin;
create table public.workbench_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'shadow' check (mode in ('shadow','rows','frozen')),
  revision bigint not null default 0 check (revision >= 0)
);
create table public.workbench_rows (
  user_id uuid not null references public.workbench_heads(user_id) on delete cascade,
  collection text not null, scope text not null, record_key text not null,
  position integer not null check (position >= 0), body jsonb not null,
  store_id text, client_id text, business_date text,
  primary key(user_id,collection,scope,record_key)
);
create index workbench_rows_store_date on public.workbench_rows(user_id,store_id,business_date,collection);
create index workbench_rows_client_date on public.workbench_rows(user_id,client_id,business_date,collection);
create table public.workbench_row_batches (
  user_id uuid not null references public.workbench_heads(user_id) on delete cascade,
  request_id uuid not null, expected_revision bigint not null,
  fingerprint text not null, operation_count integer not null check(operation_count between 1 and 100000),
  staged_bytes bigint not null default 0 check(staged_bytes between 0 and 8388608),
  result_revision bigint, created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
create table public.workbench_row_staging (
  user_id uuid not null, request_id uuid not null, operation_index integer not null,
  collection text not null, scope text not null, record_key text not null, operation jsonb not null,
  primary key(user_id,request_id,operation_index),
  unique(user_id,request_id,collection,scope,record_key),
  foreign key(user_id,request_id) references public.workbench_row_batches(user_id,request_id) on delete cascade
);
alter table public.workbench_heads enable row level security;
alter table public.workbench_rows enable row level security;
alter table public.workbench_row_batches enable row level security;
alter table public.workbench_row_staging enable row level security;
create policy own_heads on public.workbench_heads for select to authenticated using ((select auth.uid())=user_id);
create policy own_rows on public.workbench_rows for select to authenticated using ((select auth.uid())=user_id);
create policy own_batches on public.workbench_row_batches for select to authenticated using ((select auth.uid())=user_id);
create policy own_staging on public.workbench_row_staging for select to authenticated using ((select auth.uid())=user_id);
revoke all on public.workbench_heads,public.workbench_rows,public.workbench_row_batches,public.workbench_row_staging from public,anon,authenticated;
grant select on public.workbench_heads,public.workbench_rows,public.workbench_row_batches to authenticated;
-- Staging is internal. authenticated cannot bypass CAS via direct table writes.

create function public.read_workbench_rows_head()
returns jsonb language sql stable security invoker set search_path='' as $$
  select pg_catalog.jsonb_build_object('user_id',user_id,'mode',mode,'revision',revision::text)
    from public.workbench_heads where user_id=auth.uid()
$$;
create function public.read_workbench_rows_page(p_after text[] default null,p_limit integer default 500)
returns setof public.workbench_rows language sql stable security invoker set search_path='' as $$
  select r.* from public.workbench_rows r where r.user_id=auth.uid()
    and (p_after is null or (r.collection,r.scope,r.record_key)>(p_after[1],p_after[2],p_after[3]))
    order by r.collection,r.scope,r.record_key limit least(greatest(p_limit,1),500)
$$;

-- Lightweight startup view: master data, saved overview records and other
-- small root collections only. Heavy order index and ledger history remain
-- absent, including their array headers, so the client cannot mistake them
-- for verified empty arrays.
create function public.read_workbench_rows_startup_page(
  p_after text[] default null,p_limit integer default 500,p_max_bytes integer default 262144
)
returns setof public.workbench_rows language sql stable security invoker set search_path='' as $$
  with candidates as (
    select r.*,
      pg_catalog.row_number() over(order by r.collection,r.scope,r.record_key) as rn,
      pg_catalog.sum(pg_catalog.octet_length(r.body::text)+pg_catalog.octet_length(r.collection)+
        pg_catalog.octet_length(r.scope)+pg_catalog.octet_length(r.record_key)+64)
        over(order by r.collection,r.scope,r.record_key) as running_bytes
    from public.workbench_rows r
    where r.user_id=auth.uid()
      and (p_after is null or (r.collection,r.scope,r.record_key)>(p_after[1],p_after[2],p_after[3]))
      and r.collection=any(array[
        '$array','$value','a:clients','a:stores','a:products','a:productLinks',
        'a:productCosts','a:skus','a:operations','a:skuHistory','a:todos',
        'a:profitRecords','a:collectionRecords','a:skuPlanningDrafts','a:linkSalesPromotions'
      ])
      and (r.collection<>'$array' or r.record_key=any(array[
        'clients','stores','products','productLinks','productCosts','skus','operations',
        'skuHistory','todos','profitRecords','collectionRecords','skuPlanningDrafts','linkSalesPromotions'
      ]))
    order by r.collection,r.scope,r.record_key
    limit least(greatest(p_limit,1),500)
  )
  select user_id,collection,scope,record_key,position,body,store_id,client_id,business_date
  from candidates
  where rn=1 or running_bytes<=least(greatest(p_max_bytes,32768),524288)
  order by collection,scope,record_key
$$;

create function public.read_workbench_row_collections()
returns setof text language sql stable security invoker set search_path='' as $$
  select distinct r.collection from public.workbench_rows r
  where r.user_id=auth.uid() order by r.collection
$$;

create function public.read_workbench_rows_collection_page(
  p_collection text,p_after text[] default null,p_limit integer default 500,p_max_bytes integer default 262144
)
returns setof public.workbench_rows language sql stable security invoker set search_path='' as $$
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
$$;

create function public.begin_workbench_rows(p_request_id uuid,p_expected_revision bigint,p_fingerprint text,p_operation_count integer)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare owner_id uuid := auth.uid(); batch public.workbench_row_batches; head public.workbench_heads;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null or p_expected_revision is null or p_operation_count is null or p_operation_count not between 1 and 100000 or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid batch descriptor' using errcode='22023';
  end if;
  -- Lock order is always head, then batch. Never lock/read the old JSONB.
  select * into head from public.workbench_heads where user_id=owner_id for update;
  if not found or head.mode <> 'rows' then raise exception 'Row storage is not active' using errcode='40001'; end if;
  select * into batch from public.workbench_row_batches where user_id=owner_id and request_id=p_request_id;
  if found then
    if batch.expected_revision <> p_expected_revision or batch.fingerprint <> p_fingerprint or batch.operation_count <> p_operation_count then
      raise exception 'Request identity reused for different changes' using errcode='22023';
    end if;
    return pg_catalog.jsonb_build_object('revision',batch.result_revision::text);
  end if;
  if head.revision <> p_expected_revision then raise exception 'Cloud data changed; local changes retained' using errcode='40001'; end if;
  insert into public.workbench_row_batches(user_id,request_id,expected_revision,fingerprint,operation_count)
    values(owner_id,p_request_id,p_expected_revision,p_fingerprint,p_operation_count);
  return pg_catalog.jsonb_build_object('revision',null);
end $$;

create function public.stage_workbench_rows(p_request_id uuid,p_offset integer,p_changes jsonb)
returns void language plpgsql security definer set search_path=''
as $$
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
  if p_offset + pg_catalog.jsonb_array_length(p_changes) > batch.operation_count then raise exception 'Stage outside batch' using errcode='22023'; end if;
  for entry in select value,ordinality from pg_catalog.jsonb_array_elements(p_changes) with ordinality loop
    item := entry.value;
    if pg_catalog.jsonb_typeof(item)<>'object' or pg_catalog.jsonb_typeof(item->'collection') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item->'scope') is distinct from 'string' or pg_catalog.jsonb_typeof(item->'record_key') is distinct from 'string'
      or not (item ? 'row') then raise exception 'Invalid row identity' using errcode='22023'; end if;
    if item->'row' <> 'null'::jsonb and (pg_catalog.jsonb_typeof(item->'row')<>'object' or not ((item->'row') ? 'body')
      or (item->'row'->>'collection') is distinct from (item->>'collection') or (item->'row'->>'scope') is distinct from (item->>'scope')
      or (item->'row'->>'record_key') is distinct from (item->>'record_key')
      or coalesce(item->'row'->>'position','') !~ '^(0|[1-9][0-9]{0,8})$') then
      raise exception 'Invalid row payload' using errcode='22023';
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
end $$;

create function public.commit_workbench_rows(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare owner_id uuid := auth.uid(); batch public.workbench_row_batches; head public.workbench_heads; total integer;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into head from public.workbench_heads where user_id=owner_id for update;
  if not found or head.mode <> 'rows' then raise exception 'Row storage is not active' using errcode='40001'; end if;
  select * into batch from public.workbench_row_batches where user_id=owner_id and request_id=p_request_id for update;
  if not found then raise exception 'Unknown batch' using errcode='22023'; end if;
  -- Receipts survive later saves: a lost response is acknowledged without reapplying.
  if batch.result_revision is not null then return pg_catalog.jsonb_build_object('revision',batch.result_revision::text); end if;
  if head.revision <> batch.expected_revision then raise exception 'Cloud data changed; local changes retained' using errcode='40001'; end if;
  select count(*) into total from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id;
  if total <> batch.operation_count then raise exception 'Incomplete staged batch' using errcode='22023'; end if;
  delete from public.workbench_rows r using public.workbench_row_staging s
    where s.user_id=owner_id and s.request_id=p_request_id and s.operation->'row'='null'::jsonb
      and r.user_id=owner_id and r.collection=s.collection and r.scope=s.scope and r.record_key=s.record_key;
  insert into public.workbench_rows as r(user_id,collection,scope,record_key,position,body,store_id,client_id,business_date)
    select owner_id,s.collection,s.scope,s.record_key,(s.operation->'row'->>'position')::integer,
      s.operation->'row'->'body',s.operation->'row'->>'store_id',s.operation->'row'->>'client_id',s.operation->'row'->>'business_date'
      from public.workbench_row_staging s where s.user_id=owner_id and s.request_id=p_request_id and s.operation->'row'<>'null'::jsonb
    on conflict(user_id,collection,scope,record_key) do update set position=excluded.position,body=excluded.body,
      store_id=excluded.store_id,client_id=excluded.client_id,business_date=excluded.business_date
    where (r.position,r.body,r.store_id,r.client_id,r.business_date) is distinct from
      (excluded.position,excluded.body,excluded.store_id,excluded.client_id,excluded.business_date);
  update public.workbench_heads set revision=revision+1 where user_id=owner_id returning * into head;
  update public.workbench_row_batches set result_revision=head.revision where user_id=owner_id and request_id=p_request_id;
  delete from public.workbench_row_staging where user_id=owner_id and request_id=p_request_id;
  return pg_catalog.jsonb_build_object('revision',head.revision::text);
end $$;

-- This gate is dormant while an account has no head or is shadow. Switching to
-- rows/frozen blocks every legacy writer, including old RPCs and offline apps.
create function public.guard_legacy_workbench_write() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; storage_mode text;
begin
  owner_id := case when tg_op='DELETE' then old.user_id else new.user_id end;
  select mode into storage_mode from public.workbench_heads where user_id=owner_id for share;
  if storage_mode in ('rows','frozen') then raise exception 'Storage changed; export local backup and refresh client' using errcode='40001'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_legacy_workbench_write before insert or update or delete on public.workbench_documents
  for each row execute function public.guard_legacy_workbench_write();

revoke all on function public.begin_workbench_rows(uuid,bigint,text,integer),public.stage_workbench_rows(uuid,integer,jsonb),public.commit_workbench_rows(uuid),public.guard_legacy_workbench_write(),public.read_workbench_rows_page(text[],integer),public.read_workbench_rows_head(),public.read_workbench_rows_startup_page(text[],integer,integer),public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.begin_workbench_rows(uuid,bigint,text,integer),public.stage_workbench_rows(uuid,integer,jsonb),public.commit_workbench_rows(uuid),public.read_workbench_rows_page(text[],integer),public.read_workbench_rows_head(),public.read_workbench_rows_startup_page(text[],integer,integer),public.read_workbench_row_collections(),public.read_workbench_rows_collection_page(text,text[],integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
