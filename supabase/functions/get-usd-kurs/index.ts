// ═══════════════════════════════════════════════════════════════
// VISART — get-usd-kurs Edge Function
// Vazifa: O'zbekiston Markaziy banki (CBU) rasmiy USD kursini
// qaytaradi — prorab uchun TAVSIYA sifatida (u real sotish kursiga
// qo'lda to'g'rilab qo'yishi mumkin). Hech qanday maxfiy kalit kerak
// emas — CBU API ochiq va bepul.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function
//         (nomi aniq: get-usd-kurs) → shu faylni joylashtiring
// ═══════════════════════════════════════════════════════════════
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // CBU ba'zan bugungi kunni kech e'lon qiladi — shuning uchun
  // bugundan boshlab orqaga qarab, topilguncha (7 kungacha) qidiramiz.
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = fmtDate(d);
    try {
      const res = await fetch(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/${dateStr}/`);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.Rate) {
        return j({ ok: true, rate: Number(data[0].Rate), date: data[0].Date, manba: "CBU (rasmiy)" });
      }
    } catch {
      // keyingi kunga o'tamiz
    }
  }
  return j({ ok: false, error: "Kursni olib bo'lmadi — qo'lda kiriting" }, 200);
});
