-- Run ONE section at a time from an operator SQL session during a quiet period.
-- Read-only, bounded, no document expansion, no ANALYZE/EXPLAIN ANALYZE or resets.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
select now() as observed_at, pg_postmaster_start_time() as postgres_started_at, version();
select name,setting,unit from pg_settings where name in ('max_connections','shared_buffers','work_mem','statement_timeout','idle_in_transaction_session_timeout');
select state,wait_event_type,wait_event,count(*) as connections from pg_stat_activity where datname=current_database() group by 1,2,3;
select pid,usename,state,wait_event_type,wait_event,now()-xact_start as transaction_age,now()-query_start as query_age,
  pg_blocking_pids(pid) as blockers,left(query,240) as query_shape
  from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  order by xact_start nulls last limit 20;
-- Query text may contain business literals: redact before sharing results.
select relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del,last_autovacuum
  from pg_stat_user_tables where relname in ('workbench_documents','workbench_rows','workbench_heads','workbench_row_batches','workbench_row_staging');
select c.relname,pg_total_relation_size(c.oid) as total_bytes,pg_relation_size(c.oid) as heap_bytes,
  pg_total_relation_size(c.reltoastrelid) as toast_total_bytes
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('workbench_documents','workbench_rows');
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where tablename like 'workbench_%';
select routine_name,grantee,privilege_type from information_schema.routine_privileges
  where routine_schema='public' and (routine_name like '%workbench%' or routine_name like '%rows%');
select table_name,grantee,privilege_type from information_schema.table_privileges where table_schema='public' and table_name like 'workbench_%';
select extname,extnamespace::regnamespace from pg_extension where extname='pg_stat_statements';
-- If extension exists, execute the next query SEPARATELY with its actual schema.
-- SELECT queryid,calls,total_exec_time,mean_exec_time,rows,left(query,300)
-- FROM extensions.pg_stat_statements
-- WHERE query ILIKE '%workbench%' ORDER BY total_exec_time DESC LIMIT 20;
-- No pg_stat_statements_reset(). Statistics are cumulative, not per-save physical writes.
select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('save_workbench_delta','save_workbench_patch','_workbench_apply_delta');
commit;
-- Optional operator-approved single-account size sample (TOAST metadata only):
-- BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
-- SELECT updated_at,pg_column_size(data) AS stored_datum_bytes FROM public.workbench_documents WHERE user_id='<ACCOUNT_UUID>'::uuid;
-- COMMIT;
-- Do not run length(data::text), jsonb_each(data), or a full export just to poll health.
-- CPU, RSS/swap, pool queue and restart logs require Supabase Dashboard metrics/logs;
-- record the same UTC window and convert to Asia/Shanghai for incident correlation.
