-- ═══════════════════════════════════════════════════════════════
-- VISART — register_attempts jadvali
-- Vazifa: "register_prorab" (ro'yxatdan o'tish, kompaniya kodi orqali)
-- amaliga nisbatan IP bo'yicha tezlikni cheklash (rate limit) uchun.
--
-- XAVFSIZLIK SABABI: register_prorab'da hech qanday rate-limit yo'q
-- edi — bu esa tashqi odam kompaniya kodini (4+ belgili, oddiy
-- matn) botlab, "brute-force" usulida topib, haqiqiy kompaniyaga
-- PRORAB sifatida ro'yxatdan o'tib, o'sha kompaniyaning BARCHA
-- moliyaviy ma'lumotlariga (xarajat, to'lov, mijozlar, chat)
-- to'liq kirish huquqini olishi mumkin edi — ko'p-tenant izolyatsiya
-- buzilishi. Shu jadval shu hujumni bloklash uchun.
--
-- Ishlatish: Supabase Dashboard → SQL Editor → New query →
-- shu faylni to'liq joylashtiring → Run
-- ═══════════════════════════════════════════════════════════════
begin;

create table if not exists register_attempts (
  id bigint generated always as identity primary key,
  ip text,
  created_at timestamptz not null default now()
);

alter table register_attempts enable row level security;
-- Qasddan HECH QANDAY policy qo'shilmaydi — faqat service_role (Edge Function) yoza/o'qiy oladi.

create index if not exists register_attempts_ip_time_idx on register_attempts (ip, created_at);

commit;
