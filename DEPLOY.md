# VISART — Production Deploy (P0 tuzatishlar)

## Tartib (majburiy ketma-ketlik)

### 1. Database migration
Supabase Dashboard → SQL Editor → `supabase/migrations/001_security.sql` ni to'liq ishga tushiring.
- RLS barcha jadvallarga yoqiladi (bu qadamsiz anon key = butun bazaga kalit)
- FK constraint'lar mavjud orphan yozuvlarda xato bersa, avval tozalang:
  `delete from xarajatlar where obyekt_id not in (select id from obyektlar);` (har jadval uchun)

### 2. Edge Function
```bash
supabase functions deploy manage-auth
```
Yangi `verify_reset` action qo'shildi; `reset_password` endi telefon tekshiruvini serverda qiladi;
`register_prorab` kompaniya kodini serverda tekshiradi. Eski client'lar ham ishlashda davom etadi.

### 3. Frontend
`index.html` va `sw.js` ni deploy qiling. SW cache nomi `v2` — eski kesh avtomatik tozalanadi;
`index.html` endi network-first (xavfsizlik patchlari darhol tarqaladi).

### 4. Supabase Auth sozlamalari (Dashboard → Auth)
- Rate limits: default qoldiring yoki qattiqlashtiring
- Bot protection (Turnstile CAPTCHA) yoqish tavsiya etiladi

## Nima o'zgardi — xavfsizlik xulosasi
| Zaiflik | Holat |
|---|---|
| RLS yo'q — anon key bilan to'liq CRUD | ✅ RLS: prorab=all, mijoz=faqat o'z obyekti (read) |
| Stored XSS (mahsulot/izoh/nom → innerHTML) | ✅ Barcha user maydonlar `esc()` orqali |
| Parol tiklash client-side verify bypass | ✅ Server-side verify + 5/soat rate-limit; `prorablar.tel` endi ochiq emas |
| Kompaniya kodi anon'ga o'qiladi | ✅ RLS: faqat prorab; tekshiruv Edge Function'da |
| `javascript:` URL rasm maydonida | ✅ `safeUrl()` — faqat o'z Storage domenimiz |
| Realtime kanal leak (logout→login) | ✅ `unsubscribeRealtime()` + single-channel guard |
| refreshDB race (eski javob yangisini yozadi) | ✅ Sequence guard + 250ms debounce |
| UTC sana (Toshkent 00:00–05:00 xato) | ✅ Lokal `today()` |
| Xizmat haqi kalendar-oy xatosi | ✅ 30-kunlik davr asosida |
| Manfiy summa/avans>umumiy | ✅ Client + DB `check` constraint |
| CSV injection/ustun surilishi | ✅ Barcha matn ustunlar quoted |
| Unpinned supabase-js@2 | ✅ @2.49.4 pin |

## Keyingi bosqich (P1/P2 — funksionallikni buzmaydi, alohida sprint)
1. `chek-rasmlari` → private bucket + `createSignedUrl` (bazada URL o'rniga path saqlash kerak — data migration talab qiladi)
2. Modullashtirish (Vite): `api/`, `views/`, `state.js`
3. Realtime payload'dan nuqtaviy state yangilash (to'liq refetch o'rniga)
4. Sentry + haftalik `pg_dump` backup (GitHub Actions)
5. Accessibility: klaviatura navigatsiyasi, aria, `user-scalable=no` olib tashlash
