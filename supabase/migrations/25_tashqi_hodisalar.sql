-- ═══════════════════════════════════════════════════════════════
-- VISART — Telegram integratsiyasi uchun "tashqi hodisalar" jadvali
-- Faqat QO'SHADI. Mavjud ma'lumotlarga tegmaydi.
--
-- Vazifasi: har bir yuborilgan hodisa (xarajat_qoshildi, tolov_qilindi,
-- obyekt_muzlatildi va h.k.) uchun tashqi tizim qaytargan hodisa_id'ni
-- saqlab turadi — shu yozuv keyinroq TAHRIRLANSA, yangi Telegram xabar
-- emas, balki o'sha ESKI xabar tuzatiladi.
--
-- Xavfsizlik: bu jadval faqat Edge Function (service_role) orqali
-- yoziladi/o'qiladi — RLS yoqilgan, lekin hech qanday policy yo'q,
-- shuning uchun frontend (anon/authenticated) hech qachon to'g'ridan
-- to'g'ri kira olmaydi (service_role RLS'ni chetlab o'tadi).
--
-- Ishlatish: Supabase Dashboard → SQL Editor → New query →
-- shu faylni to'liq joylashtiring → Run
-- ═══════════════════════════════════════════════════════════════
begin;

create table if not exists tashqi_hodisalar (
  id uuid primary key default gen_random_uuid(),
  kompaniya_id uuid references kompaniyalar(id),
  entity_turi text not null,      -- 'xarajat' | 'tolov' | 'obyekt' | 'zakaz'
  entity_id text not null,
  hodisa_turi text not null,      -- masalan: 'xarajat_qoshildi'
  hodisa_id bigint,               -- tashqi tizim qaytargan ID (tuzatish uchun kerak)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_turi, entity_id, hodisa_turi)
);

alter table tashqi_hodisalar enable row level security;
-- Qasddan HECH QANDAY policy qo'shilmaydi — faqat service_role (Edge Function) yoza/o'qiy oladi.

commit;

-- TEKSHIRISH:
-- select * from tashqi_hodisalar order by created_at desc limit 10;
