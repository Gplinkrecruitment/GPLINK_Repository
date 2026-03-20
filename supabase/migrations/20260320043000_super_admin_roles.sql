begin;

alter table public.user_roles
  drop constraint if exists user_roles_role_check;

alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('gp', 'staff', 'admin', 'super_admin'));

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = uid
      and r.role in ('admin', 'staff', 'super_admin')
  );
$$;

create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = uid
      and r.role = 'super_admin'
  );
$$;

commit;
