-- VISART 29 — Auth audit-log + "bitta akkaunt = bitta rol" himoyasi
-- Mijoz ko'rishi va ishlashiga TA'SIR QILMAYDI: faqat user_id/login o'zgarganda ishlaydi,
-- audit yozuvi xato bersa ham asosiy amal bekor bo'lmaydi.
-- Idempotent: qayta ishga tushirsa bo'ladi.
begin;

-- 1) Audit jadvali (faqat superadmin o'qiydi, yozish faqat trigger/Edge Function orqali)
create table if not exists auth_audit (
  id bigint generated always as identity primary key,
  vaqt timestamptz not null default now(),
  manba text not null,                 -- 'trigger' | 'edge'
  jadval text,
  amal text not null,
  kim uuid,
  qator_user_id uuid,
  eski jsonb,
  yangi jsonb
);
alter table auth_audit enable row level security;
drop policy if exists sa_read on auth_audit;
create policy sa_read on auth_audit for select
  using (exists (select 1 from superadmins where user_id = auth.uid()));
create index if not exists idx_auth_audit_vaqt on auth_audit (vaqt desc);

-- 2) mijozlar / prorablar / superadmins o'zgarishlarini yozish
create or replace function fn_auth_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into auth_audit(manba, jadval, amal, kim, qator_user_id, eski, yangi)
    values (
      'trigger', tg_table_name, tg_op, auth.uid(),
      coalesce((to_jsonb(new)->>'user_id'), (to_jsonb(old)->>'user_id'))::uuid,
      case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
      case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
    );
  exception when others then
    raise warning 'auth_audit yozilmadi: %', sqlerrm;
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_auth_audit on mijozlar;
create trigger trg_auth_audit after insert or update or delete on mijozlar
  for each row execute function fn_auth_audit();
drop trigger if exists trg_auth_audit on prorablar;
create trigger trg_auth_audit after insert or update or delete on prorablar
  for each row execute function fn_auth_audit();
drop trigger if exists trg_auth_audit on superadmins;
create trigger trg_auth_audit after insert or update or delete on superadmins
  for each row execute function fn_auth_audit();

-- 3) Bitta akkaunt faqat BITTA rolda bo'la oladi
create or replace function fn_user_rol_yagona() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name <> 'mijozlar' and exists (select 1 from mijozlar where user_id = new.user_id) then
    raise exception 'Bu foydalanuvchi allaqachon mijoz';
  end if;
  if tg_table_name <> 'prorablar' and exists (select 1 from prorablar where user_id = new.user_id) then
    raise exception 'Bu foydalanuvchi allaqachon prorab';
  end if;
  if tg_table_name <> 'superadmins' and exists (select 1 from superadmins where user_id = new.user_id) then
    raise exception 'Bu foydalanuvchi allaqachon superadmin';
  end if;
  return new;
end $$;

drop trigger if exists trg_rol_yagona on mijozlar;
create trigger trg_rol_yagona before insert or update of user_id on mijozlar
  for each row execute function fn_user_rol_yagona();
drop trigger if exists trg_rol_yagona on prorablar;
create trigger trg_rol_yagona before insert or update of user_id on prorablar
  for each row execute function fn_user_rol_yagona();
drop trigger if exists trg_rol_yagona on superadmins;
create trigger trg_rol_yagona before insert or update of user_id on superadmins
  for each row execute function fn_user_rol_yagona();

commit;

-- TEKSHIRUV (hamma qator bitta rolda bo'lishi kerak, natija 0 qator):
-- select user_id from (select user_id from mijozlar union all select user_id from prorablar
--   union all select user_id from superadmins) t group by user_id having count(*) > 1;
