-- 30: kompaniyalar.kod ni mijozdan yashirish (faqat prorab RPC orqali oladi)
-- Eslatma: mijoz_guard ning joriy varianti 28 faylda yangilangan (auth.uid() is null ruxsat).
begin;

create or replace function public.kompaniya_kodi() returns text
language sql stable security definer set search_path=public as $$
  select k.kod from kompaniyalar k
  where k.id = current_kompaniya_id() and is_prorab()
$$;
revoke all on function public.kompaniya_kodi() from public, anon;
grant execute on function public.kompaniya_kodi() to authenticated;

-- 'kod' ustunidan boshqa hamma ustunga SELECT ruxsati (UPDATE ruxsati o'zgarmaydi)
revoke select on public.kompaniyalar from anon, authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ') into cols
  from information_schema.columns
  where table_schema='public' and table_name='kompaniyalar' and column_name <> 'kod';
  execute format('grant select (%s) on public.kompaniyalar to authenticated', cols);
end $$;

commit;

-- TEKSHIRUV (prorab sifatida ilovada Profil -> kompaniya kodi ko'rinishi kerak);
-- Qaytarish kerak bo'lsa: grant select on public.kompaniyalar to authenticated;
