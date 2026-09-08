create table if not exists public.workbench_documents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.workbench_documents enable row level security;

create policy "Users can read their own workbench" on public.workbench_documents for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their own workbench" on public.workbench_documents for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their own workbench" on public.workbench_documents for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their own workbench" on public.workbench_documents for delete to authenticated using ((select auth.uid()) = user_id);

create index if not exists workbench_documents_updated_at_idx on public.workbench_documents (updated_at desc);
