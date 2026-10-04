// ═══════════════════════════════════════════════════════════════
// VISART — parse-xarajat-rasm Edge Function
// Vazifa: qo'lda yozilgan/chop etilgan xarajatlar ro'yxati rasmini
// Claude (Anthropic) vision modeliga yuborib, undan JSON ko'rinishida
// qatorlarga ajratilgan xarajatlar ro'yxatini qaytaradi.
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function
//         (nomi aniq: parse-xarajat-rasm) → shu faylni joylashtiring
// MUHIM: ANTHROPIC_API_KEY maxfiy kalitini albatta
//        Edge Functions → Secrets bo'limida sozlang — bu yerda
//        hech qachon ochiq yozilmaydi.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => j({ ok: false, error: msg }, status);

const SYSTEM_PROMPT = `Sen qurilish/ta'mirlash xarajatlari ro'yxatini o'qiydigan yordamchisan.
Rasmda qo'lda yozilgan yoki chop etilgan xarajatlar ro'yxati bor (mahsulot nomi, miqdori,
narxi, jami summasi — tartib aralash bo'lishi mumkin, ba'zi qatorlarda faqat jami summa
yozilgan bo'lishi mumkin).

Har bir qatorni quyidagi JSON massiv ko'rinishida chiqar, BOSHQA HECH NARSA YOZMA —
izoh, tushuntirish, markdown belgilari (\`\`\`) ham kerak emas, FAQAT xom JSON massiv:
[{"mahsulot":"nomi","birlik":"dona|kg|metr|litr|m²|m³|to'plam","narx":raqam_yoki_null,"miqdor":raqam_yoki_null,"jami":raqam}]

Qoidalar:
- Agar narx va miqdor ikkalasi ham aniq yozilgan bo'lsa — ikkalasini ham to'ldir, jami = narx*miqdor.
- Agar faqat jami summa yozilgan, narx/miqdor ko'rinmasa — narx va miqdor'ni null qoldir, faqat jami'ni to'ldir.
- Raqamlarni probel/vergul/so'm belgisisiz, sof son sifatida yoz (masalan "1 500 000 so'm" → 1500000).
- Birlikni ro'yxatdagi so'zga eng yaqinini tanlab qo'y (mos kelmasa "dona" qo'y).
- Rasmda umuman o'qib bo'lmaydigan/xira joy bo'lsa, o'sha qatorni butunlay tushirib qoldir.
- Agar rasmda hech qanday xarajat qatori topa olmasang — bo'sh massiv [] qaytar.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Faqat prorab ishlata oladi (xarajat yoza oladigan rol)
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: { user: caller } } = await admin.auth.getUser(jwt);
  if (!caller) return err("Avtorizatsiya kerak", 401);
  const { data: pr } = await admin.from("prorablar").select("login").eq("user_id", caller.id).maybeSingle();
  if (!pr) return err("Ruxsat yo'q", 403);

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return err("Noto'g'ri so'rov");
  }

  const imageBase64 = payload.imageBase64 as string;
  const mediaType = (payload.mediaType as string) || "image/jpeg";
  if (!imageBase64) return err("Rasm yuborilmadi");

  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) return err("Server sozlanmagan: ANTHROPIC_API_KEY sozlanmagan (Edge Functions → Secrets)", 500);

  // data: URI bo'lsa, faqat base64 qismini ajratamiz
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: "Shu rasmdagi xarajatlar ro'yxatini yuqoridagi qoidalar bo'yicha JSON qilib chiqar." },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("anthropic error", data);
      return err("AI xizmatidan xato: " + (data?.error?.message || res.status));
    }
    const textOut: string = data?.content?.[0]?.text || "";
    let items: unknown;
    try {
      const match = textOut.match(/\[[\s\S]*\]/);
      items = JSON.parse(match ? match[0] : textOut);
    } catch (e) {
      console.error("parse error", e, textOut);
      return err("AI javobini o'qib bo'lmadi — rasmni aniqroq oling va qayta urining");
    }
    if (!Array.isArray(items)) return err("Noto'g'ri format qaytdi");
    return j({ ok: true, items });
  } catch (e) {
    console.error(e);
    return err("Server xatosi", 500);
  }
});
