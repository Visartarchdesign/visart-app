-- ═══════════════════════════════════════════════════════════════
-- VISART — "tashqi_hodisalar" jadvali (v2 — "Moliya ilovasi" bilan
-- kelishilgan yakuniy sxema: moliya/obyekt guruhlari alohida ustunda)
--
-- Agar avval 25_tashqi_hodisalar.sql ishga tushirilgan bo'lsa ham,
-- bu xavfsiz: jadval faqat Telegram-tuzatish uchun hodisa_id
-- bookkeeping'i, hech qanday biznes ma'lumot emas — eski jadvalni
-- almashtiramiz.
--
-- Ishlatish: Supabase Dashboard → SQL Editor → New query →
-- shu faylni to'liq joylashtiring → Run
-- ═══════════════════════════════════════════════════════════════
begin;

drop table if exists tashqi_hodisalar;

create table tashqi_hodisalar (
  id bigint generated always as identity primary key,
  entity_turi text not null,
  entity_id text not null,
  hodisa_turi text not null,
  guruh text not null check (guruh in ('moliya','obyekt')),
  hodisa_id bigint not null,
  yaratilgan_vaqt timestamptz not null default now(),
  unique (entity_turi, entity_id, hodisa_turi, guruh)
);

alter table tashqi_hodisalar enable row level security;
-- Qasddan HECH QANDAY policy qo'shilmaydi — faqat service_role (Edge Function) yoza/o'qiy oladi.

commit;

-- TEKSHIRISH:
-- select * from tashqi_hodisalar order by yaratilgan_vaqt desc limit 10;
