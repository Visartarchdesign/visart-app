// ═══════════════════════════════════════════════════════════════
// VISART — notify-visart-event Edge Function
// Vazifa: muhim hodisalar (xarajat qo'shildi, to'lov qilindi,
// obyekt muzlatildi va h.k.) yuz berganda https://visartdesign.uz
// tarafidagi Telegram integratsiyasiga xabar yuboradi.
//
// MUHIM: maxfiy kalit (X-Visart-Secret) faqat shu yerda, server
// tomonida ishlatiladi — frontendga HECH QACHON yuborilmaydi.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function
//         (nomi aniq: notify-visart-event) → shu faylni joylashtiring
// Secret: Edge Functions → Secrets → VISART_EVENTS_SECRET
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => j({ ok: false, error: msg }, status);

const EVENTS_URL = "https://visartdesign.uz/api/visart-events";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Faqat prorab (xarajat/to'lov yoza oladigan rol) chaqira oladi
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: { user: caller } } = await admin.auth.getUser(jwt);
  if (!caller) return err("Avtorizatsiya kerak", 401);
  const { data: pr } = await admin.from("prorablar").select("login, kompaniya_id").eq("user_id", caller.id).maybeSingle();
  if (!pr) return err("Ruxsat yo'q", 403);

  const SECRET = Deno.env.get("VISART_EVENTS_SECRET");
  if (!SECRET) return err("Server sozlanmagan: VISART_EVENTS_SECRET sozlanmagan (Edge Functions → Secrets)", 500);

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return err("Noto'g'ri so'rov");
  }

  const entityTuri = payload.entity_turi as string;
  const entityId = payload.entity_id as string;
  const hodisaTuri = payload.hodisa_turi as string;
  const matn = payload.matn as string;
  if (!entityTuri || !entityId || !hodisaTuri || !matn) {
    return err("entity_turi, entity_id, hodisa_turi va matn majburiy");
  }

  try {
    if (payload.tuzatish) {
      // ── TUZATISH: avval yuborilgan hodisaning matnini yangilaymiz ──
      const { data: row } = await admin
        .from("tashqi_hodisalar")
        .select("hodisa_id")
        .eq("entity_turi", entityTuri).eq("entity_id", entityId).eq("hodisa_turi", hodisaTuri)
        .maybeSingle();
      if (!row || row.hodisa_id == null) {
        // Hali hech qachon yuborilmagan — tuzatadigan narsa yo'q, bu xato emas
        return j({ ok: true, tahrir: "hodisa_topilmadi" });
      }
      const res = await fetch(EVENTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Visart-Secret": SECRET },
        body: JSON.stringify({ tuzatish_hodisa_id: row.hodisa_id, matn }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        console.error("tuzatish error", data);
        return err("Tuzatish yuborishda xato: " + (data?.error || res.status));
      }
      await admin.from("tashqi_hodisalar")
        .update({ updated_at: new Date().toISOString() })
        .eq("entity_turi", entityTuri).eq("entity_id", entityId).eq("hodisa_turi", hodisaTuri);
      return j({ ok: true, tahrir: data.tahrir || "yangilandi" });
    }

    // ── YANGI HODISA ──
    const group = (payload.group as string) || "moliya";
    const urgent = !!payload.urgent;
    const obyektId = payload.obyekt_id as string | undefined;
    const body: Record<string, unknown> = { type: hodisaTuri, matn, group, urgent };
    if (obyektId) body.obyekt_id = obyektId;

    const res = await fetch(EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Visart-Secret": SECRET },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      console.error("notify error", data);
      return err("Xabar yuborishda xato: " + (data?.error || res.status));
    }
    // hodisa_id kelsa (navbatga yozilgan bo'lsa) — keyingi TUZATISH uchun saqlab qo'yamiz
    if (data.hodisa_id != null) {
      await admin.from("tashqi_hodisalar").upsert({
        entity_turi: entityTuri, entity_id: entityId, hodisa_turi: hodisaTuri,
        hodisa_id: data.hodisa_id, kompaniya_id: pr.kompaniya_id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "entity_turi,entity_id,hodisa_turi" });
    }
    return j({ ok: true, hodisa_id: data.hodisa_id ?? null });
  } catch (e) {
    console.error(e);
    return err("Server xatosi", 500);
  }
});
