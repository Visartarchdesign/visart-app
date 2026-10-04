// Supabase Edge Function — notify-visart-event (v2)
// Kontrakt "Visart Moliya ilovasi" (visartdesign.uz) tomoni bilan kelishilgan:
// bitta chaqiruv ichida moliya (ichki, to'liq) VA obyekt (mijoz, qisqa) matnlari
// ikkalasi ham yuboriladi, tuzatish ham shu funksiya orqali amalga oshadi.
//
// MUHIM (xavfsizlik — bu versiya "Moliya ilovasi" bergan namunaga nisbatan
// QO'SHIMCHA ravishda ikkita tekshiruv bilan mustahkamlangan):
//   1) Faqat haqiqiy PRORAB (tizimga kirgan, prorablar jadvalida bor foydalanuvchi)
//      bu funksiyani chaqira oladi — mijoz yoki autentifikatsiyasiz so'rov rad etiladi.
//      (Original namunada bu tekshiruv yo'q edi — har qanday login qilgan foydalanuvchi,
//      hatto mijoz akkounti ham, soxta hodisa — masalan soxta "to'lov qilindi" yoki
//      soxta "obyekt muzlatildi" — yuborib, Telegram guruhlariga yolg'on xabar
//      tushirishi mumkin edi.)
//   2) Agar so'rovda obyekt_id berilgan bo'lsa, u aynan CHAQIRUVCHI PRORABNING
//      O'Z KOMPANIYASIGA tegishli obyekt ekanligi tekshiriladi — aks holda
//      boshqa kompaniya nomidan/obyekti bo'yicha xabar yuborib bo'lmaydi
//      (ko'p-tenant izolyatsiyasini saqlab qolish uchun).
//
// Deploy: Supabase Dashboard → Edge Functions → notify-visart-event → Code → shu faylni joylashtiring → Deploy
// Secret: Edge Functions → Secrets → VISART_EVENTS_SECRET = <Moliya ilovasi bergan qiymat>
//
// Chaqirish (frontenddan, saqlash muvaffaqiyatli bo'lgandan keyin):
//   await supabase.functions.invoke('notify-visart-event', { body: {...} })
//
// Body (yangi hodisa):
// {
//   entity_turi: "xarajat" | "tolov" | "zakaz" | "obyekt" | ...,
//   entity_id: "<shu yozuvning o'z jadvalidagi id'si>",
//   hodisa_turi: "xarajat_qoshildi" | "tolov_qilindi" | "obyekt_muzlatildi" | ...,
//   obyekt_id: "<obyektlar.id>" | null,
//   matn_moliya: "<ichki, to'liq matn — MAJBURIY>",
//   matn_mijoz: "<mijozga ko'rsatiladigan qisqa matn>" | null,
//   summa: <raqam — kunlik yig'indi digest uchun> | null,
//   urgent: boolean,
// }
//
// Body (tuzatish):
// {
//   entity_turi, entity_id, hodisa_turi,
//   tuzatish: true,
//   matn_moliya: "<yangilangan to'liq matn>",
//   matn_mijoz: "<yangilangan qisqa matn>" | null,
//   summa: <yangilangan raqam> | null,
// }

import { createClient } from "jsr:@supabase/supabase-js@2";

const VISART_EVENTS_URL = "https://visartdesign.uz/api/visart-events";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function sbAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function sendToVisart(payload: Record<string, unknown>) {
  const res = await fetch(VISART_EVENTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Visart-Secret": Deno.env.get("VISART_EVENTS_SECRET") ?? "",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function topilganHodisalar(sb: ReturnType<typeof sbAdmin>, entity_turi: string, entity_id: string, hodisa_turi: string) {
  const { data, error } = await sb
    .from("tashqi_hodisalar")
    .select("guruh, hodisa_id")
    .eq("entity_turi", entity_turi)
    .eq("entity_id", entity_id)
    .eq("hodisa_turi", hodisa_turi);
  if (error) throw error;
  return data ?? [];
}

async function saqlaHodisaId(sb: ReturnType<typeof sbAdmin>, row: {
  entity_turi: string; entity_id: string; hodisa_turi: string; guruh: string; hodisa_id: number;
}) {
  const { error } = await sb.from("tashqi_hodisalar").upsert(row, {
    onConflict: "entity_turi,entity_id,hodisa_turi,guruh",
  });
  if (error) throw error;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const sb = sbAdmin();

  // ── FAQAT PRORAB chaqira oladi ──
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: { user: caller } } = await sb.auth.getUser(jwt);
  if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: pr } = await sb.from("prorablar").select("login, kompaniya_id").eq("user_id", caller.id).maybeSingle();
  if (!pr) return json({ ok: false, error: "forbidden" }, 403);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const { entity_turi, entity_id, hodisa_turi } = body;
  if (!entity_turi || !entity_id || !hodisa_turi) {
    return json({ ok: false, error: "entity_turi/entity_id/hodisa_turi majburiy" }, 400);
  }

  // ── Ko'p-tenant xavfsizlik: obyekt_id chaqiruvchining o'z kompaniyasiga tegishli bo'lishi shart ──
  if (body.obyekt_id) {
    const { data: ob } = await sb.from("obyektlar").select("id, kompaniya_id").eq("id", body.obyekt_id).maybeSingle();
    if (!ob || ob.kompaniya_id !== pr.kompaniya_id) {
      return json({ ok: false, error: "obyekt_topilmadi_yoki_ruxsat_yoq" }, 403);
    }
  }

  try {
    // ─── TUZATISH ───
    if (body.tuzatish) {
      let topilgan;
      try {
        topilgan = await topilganHodisalar(sb, entity_turi, entity_id, hodisa_turi);
      } catch (e) {
        return json({ ok: false, error: "tashqi_hodisalar_xato", detail: String(e) }, 500);
      }
      if (!topilgan.length) {
        return json({ ok: false, error: "avvalgi_hodisa_topilmadi" }, 404);
      }
      const natijalar: Record<string, unknown> = {};
      for (const row of topilgan) {
        const matn = row.guruh === "moliya" ? body.matn_moliya : body.matn_mijoz;
        if (!matn) continue;
        const r = await sendToVisart({ tuzatish_hodisa_id: row.hodisa_id, matn, summa: body.summa ?? undefined });
        natijalar[row.guruh] = r.data;
      }
      return json({ ok: true, tuzatildi: natijalar });
    }

    // ─── YANGI HODISA ───
    if (!body.matn_moliya) return json({ ok: false, error: "matn_moliya majburiy" }, 400);

    const natijalar: Record<string, unknown> = {};

    const moliyaJavob = await sendToVisart({
      type: hodisa_turi,
      matn: body.matn_moliya,
      group: "moliya",
      obyekt_id: body.obyekt_id ?? undefined,
      summa: body.summa ?? undefined,
      urgent: !!body.urgent,
    });
    natijalar.moliya = moliyaJavob.data;
    if (moliyaJavob.ok && moliyaJavob.data?.hodisa_id) {
      await saqlaHodisaId(sb, {
        entity_turi, entity_id, hodisa_turi, guruh: "moliya",
        hodisa_id: moliyaJavob.data.hodisa_id,
      });
    }

    if (body.matn_mijoz && body.obyekt_id) {
      const obyektJavob = await sendToVisart({
        type: hodisa_turi,
        matn: body.matn_mijoz,
        group: "obyekt",
        obyekt_id: body.obyekt_id,
        summa: body.summa ?? undefined,
        urgent: !!body.urgent,
      });
      natijalar.obyekt = obyektJavob.data;
      if (obyektJavob.ok && obyektJavob.data?.hodisa_id) {
        await saqlaHodisaId(sb, {
          entity_turi, entity_id, hodisa_turi, guruh: "obyekt",
          hodisa_id: obyektJavob.data.hodisa_id,
        });
      }
    }

    return json({ ok: true, natijalar });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "server_xatosi", detail: String(e) }, 500);
  }
});
