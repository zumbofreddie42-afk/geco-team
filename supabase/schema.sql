-- Geco Team: database schema, access rules (RLS) and server-side functions.
-- Run it ONCE in Supabase: Dashboard → SQL Editor → New query → paste everything → Run.
-- Running it again is safe only on an empty project (it creates tables, it does not migrate them).
--
-- Roles: 'admin' sees and changes everything; 'member' sees own tasks, own memos and the projects an admin opened
-- to them (or that contain one of their tasks), and changes only their own progress, memo state and comments.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  job text not null default '' check (char_length(job) <= 60),
  color text not null default '#12428a',
  created_at timestamptz not null default now()
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  approval boolean not null default true
);
insert into public.settings (id) values (1);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  cat text not null check (cat in ('priv', 'pub', 'gara')),
  code text unique,
  name text not null check (char_length(name) between 1 and 100),
  status text not null default 'corso' check (status in ('preventivo', 'corso', 'sospeso', 'chiuso')),
  due date,
  reminded_for date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (project_id, user_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 140),
  notes text not null default '' check (char_length(notes) <= 1000),
  due date,
  priority text not null default 'media' check (priority in ('alta', 'media', 'bassa')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person on a task: each person has their own percentage.
create table public.task_assignees (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  progress int not null default 0 check (progress between 0 and 100),
  pending int check (pending between 0 and 100),
  reminded_for date,
  late_noted_for date,
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  author uuid references public.profiles (id) on delete set null,
  text text not null check (char_length(text) between 1 and 800),
  created_at timestamptz not null default now()
);

create table public.memos (
  id uuid primary key default gen_random_uuid(),
  author uuid references public.profiles (id) on delete set null,
  text text not null check (char_length(text) between 1 and 1500),
  for_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memo_recipients (
  memo_id uuid not null references public.memos (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read boolean not null default false,
  done boolean not null default false,
  primary key (memo_id, user_id)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 300),
  link text not null default '',
  read boolean not null default false,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles (id) on delete set null,
  actor_name text not null default '',
  text text not null check (char_length(text) between 1 and 300),
  created_at timestamptz not null default now()
);

-- ---------- helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.can_see_project(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from project_members where project_id = p and user_id = auth.uid());
$$;

create or replace function public.can_see_task(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks where id = t and public.can_see_project(project_id));
$$;

-- Automatic project code per type: PRIV-001, PUB-001, GARA-001 …
create or replace function public.set_project_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare prefix text; n int;
begin
  if new.code is not null then return new; end if;
  prefix := case new.cat when 'priv' then 'PRIV' when 'pub' then 'PUB' else 'GARA' end;
  perform pg_advisory_xact_lock(hashtext('project_code_' || new.cat));
  select coalesce(max(split_part(code, '-', 2)::int), 0) + 1 into n from projects where cat = new.cat;
  new.code := prefix || '-' || lpad(n::text, 3, '0');
  return new;
end $$;
create trigger projects_code before insert on public.projects for each row execute function public.set_project_code();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();
create trigger memos_touch before update on public.memos for each row execute function public.touch_updated_at();
create trigger assignees_touch before update on public.task_assignees for each row execute function public.touch_updated_at();

-- Whoever gets a task can see its project.
create or replace function public.assignee_joins_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into project_members (project_id, user_id)
  select project_id, new.user_id from tasks where id = new.task_id
  on conflict do nothing;
  return new;
end $$;
create trigger task_assignees_member after insert on public.task_assignees for each row execute function public.assignee_joins_project();

-- ---------- functions the app calls (RPC) ----------
-- A team member updates their own percentage: applied at once, or kept as a proposal when approval is on.
create or replace function public.set_my_progress(p_task uuid, p_value int) returns text
language plpgsql security definer set search_path = public as $$
declare cur task_assignees; need_ok boolean;
begin
  if p_value < 0 or p_value > 100 then raise exception 'valore non valido'; end if;
  select * into cur from task_assignees where task_id = p_task and user_id = auth.uid();
  if not found then raise exception 'attività non assegnata a te'; end if;
  select approval into need_ok from settings where id = 1;
  if public.is_admin() or not need_ok then
    update task_assignees set progress = p_value, pending = null where task_id = p_task and user_id = auth.uid();
    return 'applied';
  end if;
  update task_assignees set pending = case when p_value = cur.progress then null else p_value end
  where task_id = p_task and user_id = auth.uid();
  return case when p_value = cur.progress then 'unchanged' else 'pending' end;
end $$;

-- An admin approves or rejects a proposed percentage.
create or replace function public.decide_progress(p_task uuid, p_user uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'solo gli amministratori'; end if;
  update task_assignees
     set progress = case when p_approve and pending is not null then pending else progress end, pending = null
   where task_id = p_task and user_id = p_user;
end $$;

-- A recipient marks a memo as read or done.
create or replace function public.mark_memo(p_memo uuid, p_read boolean, p_done boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update memo_recipients set read = p_read, done = p_done where memo_id = p_memo and user_id = auth.uid();
  if not found then raise exception 'memo non tuo'; end if;
end $$;

-- Any signed-in person can notify others (text only); the server then sends phone push / email.
create or replace function public.notify(p_users uuid[], p_text text, p_link text) returns setof uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  return query
    with ins as (
      insert into notifications (user_id, text, link)
      select u, left(p_text, 300), left(coalesce(p_link, ''), 200)
        from unnest(p_users) as u
       where u <> auth.uid() and exists (select 1 from profiles where id = u)
      returning notifications.id
    )
    select ins.id from ins;
end $$;

-- Switching approval off applies the pending proposals.
create or replace function public.set_approval(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'solo gli amministratori'; end if;
  update settings set approval = p_on where id = 1;
  if not p_on then update task_assignees set progress = pending, pending = null where pending is not null; end if;
end $$;

-- ---------- access rules (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.comments enable row level security;
alter table public.memos enable row level security;
alter table public.memo_recipients enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.activity_log enable row level security;

-- Everybody in the team sees names; only admins edit people (accounts are created by the server).
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_admin_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy settings_read on public.settings for select to authenticated using (true);

create policy projects_read on public.projects for select to authenticated using (public.can_see_project(id));
create policy projects_admin on public.projects for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy members_read on public.project_members for select to authenticated using (public.can_see_project(project_id));
create policy members_admin on public.project_members for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy tasks_read on public.tasks for select to authenticated using (public.can_see_project(project_id));
create policy tasks_admin on public.tasks for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy assignees_read on public.task_assignees for select to authenticated using (public.can_see_task(task_id));
create policy assignees_admin on public.task_assignees for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy comments_read on public.comments for select to authenticated using (public.can_see_task(task_id));
create policy comments_write on public.comments for insert to authenticated with check (author = auth.uid() and public.can_see_task(task_id));
create policy comments_delete on public.comments for delete to authenticated using (author = auth.uid() or public.is_admin());

create policy memos_read on public.memos for select to authenticated
  using (public.is_admin() or exists (select 1 from public.memo_recipients r where r.memo_id = memos.id and r.user_id = auth.uid()));
create policy memos_admin on public.memos for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy recipients_read on public.memo_recipients for select to authenticated using (public.is_admin() or user_id = auth.uid());
create policy recipients_admin on public.memo_recipients for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_mark on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

create policy push_own on public.push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy log_read on public.activity_log for select to authenticated using (public.is_admin());
create policy log_write on public.activity_log for insert to authenticated with check (actor = auth.uid());

-- ---------- live updates ----------
alter publication supabase_realtime add table public.projects, public.project_members, public.tasks, public.task_assignees,
  public.comments, public.memos, public.memo_recipients, public.notifications, public.settings, public.profiles;
