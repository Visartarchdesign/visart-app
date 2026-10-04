-- ═══════════════════════════════════════════════════════════════
-- VISART — To'lovlar uchun valyuta (USD) qo'llab-quvvatlash
-- Faqat QO'SHADI. Mavjud ustunlar/qatorlar o'zgarmaydi.
-- Ishlatish: Supabase Dashboard → SQL Editor → New query →
-- shu faylni to'liq joylashtiring → Run
-- ═══════════════════════════════════════════════════════════════
begin;

alter table tolovlar add column if not exists valyuta text not null default 'som';
alter table tolovlar add column if not exists summa_valyuta numeric;
alter table tolovlar add column if not exists kurs numeric;

commit;

-- TEKSHIRISH:
-- select id, summa, valyuta, summa_valyuta, kurs from tolovlar limit 5;
