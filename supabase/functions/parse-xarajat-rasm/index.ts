// ═══════════════════════════════════════════════════════════════
// VISART — parse-xarajat-rasm Edge Function
// Vazifa: qo'lda yozilgan/chop etilgan xarajatlar ro'yxati rasmini
// Google Gemini (bepul tarifi bor) vision modeliga yuborib, undan
// JSON ko'rinishida qatorlarga ajratilgan xarajatlar ro'yxatini
// qaytaradi.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function
//         (nomi aniq: parse-xarajat-rasm) → shu faylni joylashtiring
//
// MUHIM: GEMINI_API_KEY maxfiy kalitini albatta
//        Edge Functions → Secrets bo'limida sozlang — bu yerda
//        hech qachon ochiq yozilmaydi.
// Bepul kalit olish: https://aistudio.google.com/app/apikey
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => j({ ok: false, error: msg }, status);

const GEMINI_MODEL = "gemini-3.8-flash";

const PROMPT = `Sen O'zbekistondagi qurilish/ta'mirlash xarajatlari ro'yxatini rasmdan o'qiydigan yordamchisan.
Rasmda qo'lda yozilgan (ko'pincha o'zbek tilida, lotin YOKI kirill alifbosida, qisqartmalar bilan) yoki chop etilgan
xarajatlar ro'yxati bor. Mahsulot nomi, miqdori, narxi, jami summasi aralash tartibda bo'lishi mumkin;
ba'zi qatorlarda faqat jami summa yozilgan.

Har bir xarajat qatorini quyidagi tuzilmada chiqar:
{"mahsulot":"nomi","birlik":"dona|kg|metr|litr|m²|m³|to'plam","narx":raqam_yoki_null,"miqdor":raqam_yoki_null,"jami":raqam}

Qoidalar:
- Mahsulot nomini rasmdagi yozuvga yaqin, lotin alifbosida yoz (kirill bo'lsa lotinga o'gir). Hech narsa o'ylab topma.
- Raqamlar: probel, nuqta, vergul — mingliklar ajratuvchisi ("1 500 000", "1.500.000", "1,500,000" → 1500000).
  "ming", "k", "т", "mln/млн" kabi qisqartmalarni to'liq songa aylantir ("150 ming" → 150000, "2 mln" → 2000000, "75k" → 75000).
  So'm/sum/UZS belgilarini tashla. Vergulli o'nlik kasrlar (masalan "2,5 kg") miqdorda saqlansin: 2.5.
- Narx va miqdor ikkalasi aniq yozilgan bo'lsa — ikkalasini to'ldir. Jami sifatida rasmda YOZILGAN jami summani ol;
  agar jami yozilmagan bo'lsa narx*miqdor.
- Faqat jami summa yozilgan bo'lsa — narx va miqdor null, faqat jami.
- Ustun sarlavhalari, sana, "Jami:/Itogo" umumiy yig'indi qatori, ustiga chizilgan (o'chirilgan) qatorlar — xarajat qatori EMAS, tushirib qoldir.
- Birlikni ro'yxatdagi eng yaqiniga moslab tanla (mos kelmasa "dona").
- Rasmda butunlay o'qib bo'lmaydigan joyni tushirib qoldir, lekin o'qiy olgan hamma qatorni chiqar. Qatorlar tartibini rasmdagidek saqla.
- Hech qanday xarajat topa olmasang — bo'sh massiv [] qaytar.

Javob FAQAT JSON massiv bo'lsin (izoh, markdown yo'q).`;

// Gemini'ga JSON sxemasini majburlaymiz — "o'qib bo'lmadi" xatolarini keskin kamaytiradi
const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      mahsulot: { type: "STRING" },
      birlik: { type: "STRING" },
      narx: { type: "NUMBER", nullable: true },
      miqdor: { type: "NUMBER", nullable: true },
      jami: { type: "NUMBER" },
    },
    required: ["mahsulot", "birlik", "jami"],
  },
};

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
  const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  const mediaType = ALLOWED_MEDIA.includes(payload.mediaType as string) ? (payload.mediaType as string) : "image/jpeg";
  if (!imageBase64) return err("Rasm yuborilmadi");

  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
  if (!GEMINI_API_KEY) return err("Server sozlanmagan: GEMINI_API_KEY sozlanmagan (Edge Functions → Secrets)", 500);

  // data: URI bo'lsa, faqat base64 qismini ajratamiz
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  const callGemini = async (structured: boolean) => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      // Thinking-modellar o'ylash tokenlarini ham shu limitdan sarflaydi — uzun ro'yxat JSON'i
      // o'rtasida uzilib qolmasligi uchun katta zaxira beramiz.
      maxOutputTokens: 16384,
    };
    if (structured) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = RESPONSE_SCHEMA;
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mediaType, data: base64Data } }] }],
        generationConfig,
      }),
    });
    return { res, data: await res.json() };
  };

  try {
    let { res, data } = await callGemini(true);
    // Model sxemani qabul qilmasa (400) — sxemasiz qayta urinamiz
    if (!res.ok && res.status === 400) {
      console.warn("structured output rad etildi, sxemasiz qayta urinish", data?.error?.message);
      ({ res, data } = await callGemini(false));
    }
    if (!res.ok) {
      console.error("gemini error", data);
      return err("AI xizmatidan xato: " + (data?.error?.message || res.status));
    }
    const cand = data?.candidates?.[0];
    if (cand?.finishReason && cand.finishReason !== "STOP") console.warn("gemini finishReason", cand.finishReason);
    // "thought" qismlarini tashlab, faqat javob matnini birlashtiramiz
    const textOut: string = (cand?.content?.parts || [])
      .filter((p: { thought?: boolean; text?: string }) => !p.thought && typeof p.text === "string")
      .map((p: { text: string }) => p.text).join("");
    let items: unknown;
    try {
      const clean = textOut.replace(/```json|```/g, "").trim();
      const match = clean.match(/\[[\s\S]*\]/);
      items = JSON.parse(match ? match[0] : clean);
    } catch (e) {
      console.error("parse error", e, cand?.finishReason, textOut);
      return err("AI javobini o'qib bo'lmadi — rasmni aniqroq oling va qayta urining");
    }
    if (!Array.isArray(items)) return err("Noto'g'ri format qaytdi");
    return j({ ok: true, items });
  } catch (e) {
    console.error(e);
    return err("Server xatosi", 500);
  }
});
