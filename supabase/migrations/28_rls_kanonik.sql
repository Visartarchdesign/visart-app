-- VISART 28 — RLS kanonik holatga keltirish (idempotent, qayta ishga tushirsa bo'ladi)
-- Maqsad: kompaniyalar o'rtasida izolyatsiya + mijoz faqat O'Z obyektini O'QIYDI
-- (chatga yozadi/o'qilgan deb belgilaydi), prorab o'z kompaniyasida hammasini qiladi.
-- Ishga tushirishdan oldin: Supabase → SQL Editor. Keyin mijoz va prorab bilan login sinang.
begin;

-- 1) Shu jadvallardagi BARCHA eski siyosatlarni tozalash (OR bo'lib teshik ochmasligi uchun)
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
    where schemaname='public' and tablename in
    ('obyektlar','xarajatlar','tolovlar','zakazlar','xizmat_tolovlar','chat_xabarlar','prorablar','mijozlar','kompaniyalar')
  loop execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename); end loop;
end $$;

alter table kompaniyalar enable row level security;

-- 2) Prorab: o'z kompaniyasida hammasi (faol kompaniya)
do $$ declare t text; begin
  foreach t in array array['obyektlar','xarajatlar','tolovlar','zakazlar','xizmat_tolovlar','chat_xabarlar','mijozlar'] loop
    execute format($f$create policy prorab_tenant on %I for all
      using (is_prorab() and kompaniya_id = current_kompaniya_id() and company_is_active())
      with check (is_prorab() and kompaniya_id = current_kompaniya_id() and company_is_active())$f$, t);
  end loop;
end $$;

-- 3) Mijoz: faqat o'z obyekti — O'QISH
create policy mijoz_read on obyektlar for select
  using (id = my_obyekt_id() and company_is_active());
do $$ declare t text; begin
  foreach t in array array['xarajatlar','tolovlar','zakazlar','xizmat_tolovlar'] loop
    execute format($f$create policy mijoz_read on %I for select
      using (obyekt_id = my_obyekt_id() and kompaniya_id = current_kompaniya_id() and company_is_active())$f$, t);
  end loop;
end $$;

-- 4) Chat: mijoz o'z obyektida o'qiydi, yozadi, "o'qilgan" deb belgilaydi
create policy mijoz_chat_read on chat_xabarlar for select
  using (obyekt_id = my_obyekt_id() and kompaniya_id = current_kompaniya_id() and company_is_active());
create policy mijoz_chat_insert on chat_xabarlar for insert
  with check (obyekt_id = my_obyekt_id() and kompaniya_id = current_kompaniya_id() and company_is_active());
create policy mijoz_chat_upd on chat_xabarlar for update
  using (obyekt_id = my_obyekt_id() and kompaniya_id = current_kompaniya_id() and company_is_active())
  with check (obyekt_id = my_obyekt_id() and kompaniya_id = current_kompaniya_id());

-- Mijoz chatda faqat `oqilgan` ni o'zgartira oladi (matn/yuboruvchi/obyektni emas)
create or replace function chat_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if is_prorab() or auth.role() = 'service_role' then return new; end if;
  if (to_jsonb(new) - 'oqilgan') is distinct from (to_jsonb(old) - 'oqilgan') then
    raise exception 'Faqat o''qilgan belgisini o''zgartirish mumkin';
  end if;
  return new;
end $$;
drop trigger if exists trg_chat_guard on chat_xabarlar;
create trigger trg_chat_guard before update on chat_xabarlar for each row execute function chat_guard();

-- 5) Prorablar: o'z qatori + o'z kompaniyasi prorablari; o'zgartirish faqat o'z qatori
create policy prorab_self_read on prorablar for select
  using (user_id = auth.uid() or (is_prorab() and kompaniya_id = current_kompaniya_id()));
create policy prorab_self_upd on prorablar for update
  using (user_id = auth.uid()) with check (user_id = auth.uid() and kompaniya_id = current_kompaniya_id());

-- 6) Mijozlar: mijoz o'zini o'qiydi/yangilaydi (kompaniya/obyekt/user o'zgarmaydi)
create policy mijoz_self_read on mijozlar for select using (user_id = auth.uid());
create policy mijoz_self_upd on mijozlar for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function mijoz_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if is_prorab() or auth.role() = 'service_role' then return new; end if;
  if new.user_id is distinct from old.user_id or new.obyekt_id is distinct from old.obyekt_id
     or new.kompaniya_id is distinct from old.kompaniya_id then
    raise exception 'Bu maydonlarni o''zgartirib bo''lmaydi';
  end if;
  return new;
end $$;
drop trigger if exists trg_mijoz_guard on mijozlar;
create trigger trg_mijoz_guard before update on mijozlar for each row execute function mijoz_guard();

-- 7) Kompaniyalar: hamma o'z kompaniyasini ko'radi, o'zgartirish FAQAT prorab
create policy komp_read on kompaniyalar for select using (id = current_kompaniya_id());
create policy komp_upd on kompaniyalar for update
  using (id = current_kompaniya_id() and is_prorab())
  with check (id = current_kompaniya_id() and is_prorab());

commit;

-- TEKSHIRUV:
-- select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1,2;
