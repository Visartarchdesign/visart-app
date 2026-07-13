-- ═══════════════════════════════════════════════════════════════
-- VISART — 001_security.sql
-- P0: RLS, indexlar, integrity constraint'lar, storage siyosati
-- Supabase SQL Editor'da bir marta ishga tushiring.
-- ═══════════════════════════════════════════════════════════════

-- ── Yordamchi funksiyalar (RLS ichida qayta ishlatiladi) ──
create or replace function public.is_prorab() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from prorablar where user_id = auth.uid());
$$;

create or replace function public.my_obyekt_id() returns text
language sql stable security definer set search_path = public as $$
  select obyekt_id from mijozlar where user_id = auth.uid();
$$;

-- ── RLS yoqish ──
alter table obyektlar        enable row level security;
alter table xarajatlar       enable row level security;
alter table tolovlar         enable row level security;
alter table zakazlar         enable row level security;
alter table xizmat_tolovlar  enable row level security;
alter table chat_xabarlar    enable row level security;
alter table prorablar        enable row level security;
alter table mijozlar         enable row level security;
alter table sozlamalar       enable row level security;

-- ── OBYEKTLAR: prorab — hammasi; mijoz — faqat o'ziniki (read-only) ──
create policy obyektlar_prorab_all on obyektlar for all
  using (is_prorab()) with check (is_prorab());
create policy obyektlar_mijoz_read on obyektlar for select
  using (id = my_obyekt_id());

-- ── XARAJATLAR / TOLOVLAR / ZAKAZLAR / XIZMAT_TOLOVLAR: bir xil model ──
create policy xarajatlar_prorab_all on xarajatlar for all
  using (is_prorab()) with check (is_prorab());
create policy xarajatlar_mijoz_read on xarajatlar for select
  using (obyekt_id = my_obyekt_id());

create policy tolovlar_prorab_all on tolovlar for all
  using (is_prorab()) with check (is_prorab());
create policy tolovlar_mijoz_read on tolovlar for select
  using (obyekt_id = my_obyekt_id());

create policy zakazlar_prorab_all on zakazlar for all
  using (is_prorab()) with check (is_prorab());
create policy zakazlar_mijoz_read on zakazlar for select
  using (obyekt_id = my_obyekt_id());

create policy xizmat_prorab_all on xizmat_tolovlar for all
  using (is_prorab()) with check (is_prorab());
create policy xizmat_mijoz_read on xizmat_tolovlar for select
  using (obyekt_id = my_obyekt_id());

-- ── CHAT: prorab — hamma obyekt; mijoz — faqat o'z obyekti; yozish — o'z nomidan ──
create policy chat_prorab_all on chat_xabarlar for select using (is_prorab());
create policy chat_mijoz_read on chat_xabarlar for select
  using (obyekt_id = my_obyekt_id());
create policy chat_insert on chat_xabarlar for insert
  with check (is_prorab() or obyekt_id = my_obyekt_id());
create policy chat_mark_read on chat_xabarlar for update
  using (is_prorab() or obyekt_id = my_obyekt_id())
  with check (is_prorab() or obyekt_id = my_obyekt_id());

-- ── PRORABLAR: har kim faqat o'z qatorini ko'radi/yangilaydi.
--    MUHIM: tel raqamlar endi anon/mijozga OCHIQ EMAS (parol tiklash hujumi yopiladi) ──
create policy prorablar_self on prorablar for select using (user_id = auth.uid());
create policy prorablar_self_upd on prorablar for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── MIJOZLAR: mijoz — o'zini; prorab — hammasini (boshqaruv uchun) ──
create policy mijozlar_self on mijozlar for select using (user_id = auth.uid());
create policy mijozlar_self_upd on mijozlar for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mijozlar_prorab_read on mijozlar for select using (is_prorab());

-- ── SOZLAMALAR (kompaniya kodi): FAQAT prorab o'qiydi/yozadi.
--    Ro'yxatdan o'tishda kod tekshiruvi Edge Function'da (service_role) bo'ladi ──
create policy sozlamalar_prorab on sozlamalar for all
  using (is_prorab()) with check (is_prorab());

-- ═══ INDEXLAR ═══
create index if not exists idx_xarajatlar_obyekt on xarajatlar (obyekt_id);
create index if not exists idx_tolovlar_obyekt   on tolovlar (obyekt_id);
create index if not exists idx_zakazlar_obyekt   on zakazlar (obyekt_id);
create index if not exists idx_xizmat_obyekt     on xizmat_tolovlar (obyekt_id);
create index if not exists idx_chat_obyekt_vaqt  on chat_xabarlar (obyekt_id, vaqt desc);
create index if not exists idx_prorablar_user    on prorablar (user_id);
create index if not exists idx_mijozlar_user     on mijozlar (user_id);

-- ═══ INTEGRITY CONSTRAINT'LAR (server-side validation) ═══
alter table xarajatlar add constraint chk_xar_narx    check (narx >= 0);
alter table xarajatlar add constraint chk_xar_miqdor  check (miqdor > 0);
alter table xarajatlar add constraint chk_xar_jami    check (jami >= 0);
alter table tolovlar   add constraint chk_tol_summa   check (summa > 0);
alter table zakazlar   add constraint chk_zak_umumiy  check (umumiy > 0);
alter table zakazlar   add constraint chk_zak_avans   check (avans >= 0 and avans <= umumiy);
alter table xizmat_tolovlar add constraint chk_xiz_summa check (summa > 0);

-- FK'lar (obyekt o'chsa bog'liq yozuvlar ham o'chadi — orphan qolmaydi)
alter table xarajatlar      add constraint fk_xar_ob foreign key (obyekt_id) references obyektlar(id) on delete cascade;
alter table tolovlar        add constraint fk_tol_ob foreign key (obyekt_id) references obyektlar(id) on delete cascade;
alter table zakazlar        add constraint fk_zak_ob foreign key (obyekt_id) references obyektlar(id) on delete cascade;
alter table xizmat_tolovlar add constraint fk_xiz_ob foreign key (obyekt_id) references obyektlar(id) on delete cascade;
alter table chat_xabarlar   add constraint fk_chat_ob foreign key (obyekt_id) references obyektlar(id) on delete cascade;

-- ═══ STORAGE: chek-rasmlari ═══
-- Yuklash — faqat authenticated; o'chirish — faqat prorab; o'qish — public URL orqali
-- (mavjud saqlangan URL'larni buzmaslik uchun read public qoladi; keyingi bosqichda
--  private bucket + signed URL'ga o'tish tavsiya etiladi)
create policy chek_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'chek-rasmlari');
create policy chek_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chek-rasmlari' and public.is_prorab());

-- ═══ PAROL TIKLASH RATE-LIMIT jadvali (Edge Function ishlatadi) ═══
create table if not exists reset_attempts (
  id bigint generated always as identity primary key,
  login text not null,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists idx_reset_attempts on reset_attempts (login, created_at);
alter table reset_attempts enable row level security; -- hech qanday policy yo'q = faqat service_role
