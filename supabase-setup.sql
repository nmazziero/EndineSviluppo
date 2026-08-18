-- Esegui questo script una sola volta in Supabase:
-- Project > SQL Editor > New query > incolla tutto > Run

create table if not exists dashboard_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Abilita Row Level Security ma permette lettura/scrittura pubblica
-- (va bene per un link privato condiviso solo con Maurizio; se in futuro
-- serve autenticazione vera, si può restringere questa policy).
alter table dashboard_kv enable row level security;

create policy "Consenti lettura pubblica"
  on dashboard_kv for select
  using (true);

create policy "Consenti scrittura pubblica"
  on dashboard_kv for insert
  with check (true);

create policy "Consenti aggiornamento pubblico"
  on dashboard_kv for update
  using (true);
