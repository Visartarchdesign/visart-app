// ═══════════════════════════════════════════════════════════════
// VISART — manage-auth Edge Function (production versiya)
// Deploy: supabase functions deploy manage-auth
// Barcha xavfsizlik tekshiruvlari SHU YERDA — clientga ishonilmaydi.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const AUTH_EMAIL_DOMAIN = "visart.internal";
const toAuthEmail = (login: string) => `${login}@${AUTH_EMAIL_DOMAIN}`;
const normTel = (s: string) => (s || "").replace(/[^0-9]/g, "");
const normLogin = (s: string) => (s || "").trim().toLowerCase();
const LOGIN_RE = /^[a-z0-9.]{3,32}$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => j({ ok: false, error: msg }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // faqat serverda
  );

  let action = "", payload: Record<string, unknown> = {};
  try {
    const body = await req.json();
    action = body.action;
    payload = body.payload || {};
  } catch {
    return err("Noto'g'ri so'rov");
  }

  // ── So'rov yuborgan foydalanuvchini aniqlash (JWT'dan, clientdan emas) ──
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: { user: caller } } = await admin.auth.getUser(jwt);

  const isCallerProrab = async () => {
    if (!caller) return false;
    const { data } = await admin.from("prorablar").select("login").eq("user_id", caller.id).maybeSingle();
    return !!data;
  };

  // ── Rate limit: login bo'yicha 1 soatda maks 5 urinish ──
  const rateLimited = async (login: string) => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("reset_attempts")
      .select("*", { count: "exact", head: true })
      .eq("login", login).gte("created_at", hourAgo);
    if ((count ?? 0) >= 5) return true;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
    await admin.from("reset_attempts").insert({ login, ip });
    return false;
  };

  // ── Server-side telefon verifikatsiyasi ──
  const verifyPhone = async (login: string, tel: string) => {
    const { data: pr } = await admin.from("prorablar").select("tel").eq("login", login).maybeSingle();
    return !!pr?.tel && normTel(pr.tel) === normTel(tel) && normTel(tel).length >= 9;
  };

  try {
    switch (action) {
      // ══ 1. Parol tiklash: 1-bosqich tekshiruvi (login+tel serverda solishtiriladi) ══
      case "verify_reset": {
        const login = normLogin(payload.login as string);
        const tel = payload.tel as string;
        if (!login || !tel) return err("Login va telefon kerak");
        if (await rateLimited(login)) return err("Juda ko'p urinish — 1 soatdan keyin qayta urining", 429);
        if (!(await verifyPhone(login, tel))) return err("Login yoki telefon raqami mos kelmadi");
        return j({ ok: true });
      }

      // ══ 2. Parolni tiklash / o'zgartirish ══
      case "reset_password": {
        const targetLogin = normLogin(payload.targetLogin as string);
        const newPassword = payload.newPassword as string;
        if (!targetLogin || !newPassword || newPassword.length < 6) return err("Parol kamida 6 belgi");

        if (payload.viaPhoneVerification) {
          // Telefon orqali: verifikatsiya QAYTA serverda (clientdagi flagga ishonilmaydi)
          if (await rateLimited(targetLogin)) return err("Juda ko'p urinish", 429);
          if (!(await verifyPhone(targetLogin, payload.tel as string)))
            return err("Telefon raqami tasdiqlanmadi");
        } else {
          // Prorab boshqa foydalanuvchi (mijoz) parolini tiklaydi
          if (!(await isCallerProrab())) return err("Ruxsat yo'q", 403);
        }

        // login -> auth user
        const { data: mj } = await admin.from("mijozlar").select("user_id").eq("login", targetLogin).maybeSingle();
        const { data: pr } = await admin.from("prorablar").select("user_id").eq("login", targetLogin).maybeSingle();
        const uid = mj?.user_id || pr?.user_id;
        if (!uid) return err("Foydalanuvchi topilmadi");

        const { error } = await admin.auth.admin.updateUserById(uid, { password: newPassword });
        if (error) return err(error.message);
        return j({ ok: true });
      }

      // ══ 3. Ro'yxatdan o'tish (prorab) — kompaniya kodi FAQAT serverda tekshiriladi ══
      case "register_prorab": {
        const { kod, ism, tel, login: rawLogin, parol } = payload as Record<string, string>;
        const login = normLogin(rawLogin);
        if (!LOGIN_RE.test(login)) return err("Login: 3–32 ta lotin harf/raqam/nuqta");
        if (!parol || parol.length < 6) return err("Parol kamida 6 belgi");
        if (normTel(tel).length < 9) return err("Telefon raqami noto'g'ri");

        const { data: kk } = await admin.from("sozlamalar").select("value").eq("key", "kompaniya_kod").maybeSingle();
        const expected = kk?.value || "VISART-2024";
        if ((kod || "").trim().toUpperCase() !== expected.toUpperCase())
          return err("Kompaniya kodi noto'g'ri");

        // login bandligini ikkala jadvalda tekshirish
        const [{ data: p1 }, { data: m1 }] = await Promise.all([
          admin.from("prorablar").select("login").eq("login", login).maybeSingle(),
          admin.from("mijozlar").select("login").eq("login", login).maybeSingle(),
        ]);
        if (p1 || m1) return err("Bu login band");

        const { data: created, error: ce } = await admin.auth.admin.createUser({
          email: toAuthEmail(login), password: parol, email_confirm: true,
        });
        if (ce || !created.user) return err(ce?.message || "Auth xatosi");

        const parts = (ism || "").trim().split(/\s+/);
        const avatar = ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "PR";
        const { error: ie } = await admin.from("prorablar")
          .insert({ login, ism, tel, avatar, user_id: created.user.id });
        if (ie) { await admin.auth.admin.deleteUser(created.user.id); return err(ie.message); }
        return j({ ok: true });
      }

      // ══ 4. Mijoz yaratish — faqat prorab ══
      case "create_mijoz": {
        if (!(await isCallerProrab())) return err("Ruxsat yo'q", 403);
        const { login: rawLogin, parol, ism, tel, obyektId, avatar } = payload as Record<string, string>;
        const login = normLogin(rawLogin);
        if (!LOGIN_RE.test(login)) return err("Login formati noto'g'ri");
        if (!parol || parol.length < 6) return err("Parol kamida 6 belgi");

        const [{ data: p1 }, { data: m1 }] = await Promise.all([
          admin.from("prorablar").select("login").eq("login", login).maybeSingle(),
          admin.from("mijozlar").select("login").eq("login", login).maybeSingle(),
        ]);
        if (p1 || m1) return err("Bu login band");

        const { data: created, error: ce } = await admin.auth.admin.createUser({
          email: toAuthEmail(login), password: parol, email_confirm: true,
        });
        if (ce || !created.user) return err(ce?.message || "Auth xatosi");

        const { error: ie } = await admin.from("mijozlar")
          .insert({ login, ism, tel, avatar: avatar || "MJ", obyekt_id: obyektId, user_id: created.user.id });
        if (ie) { await admin.auth.admin.deleteUser(created.user.id); return err(ie.message); }
        return j({ ok: true });
      }

      // ══ 5. Login o'zgartirish — faqat o'zi uchun ══
      case "update_login": {
        if (!caller) return err("Avtorizatsiya kerak", 401);
        const newLogin = normLogin(payload.newLogin as string);
        if (!LOGIN_RE.test(newLogin)) return err("Login formati noto'g'ri");

        const [{ data: p1 }, { data: m1 }] = await Promise.all([
          admin.from("prorablar").select("login").eq("login", newLogin).maybeSingle(),
          admin.from("mijozlar").select("login").eq("login", newLogin).maybeSingle(),
        ]);
        if (p1 || m1) return err("Bu login band");

        const { error: ae } = await admin.auth.admin.updateUserById(caller.id, { email: toAuthEmail(newLogin) });
        if (ae) return err(ae.message);
        // ikkala profil jadvalida ham urinib ko'ramiz (qaysi rolda bo'lsa o'sha yangilanadi)
        await admin.from("prorablar").update({ login: newLogin }).eq("user_id", caller.id);
        await admin.from("mijozlar").update({ login: newLogin }).eq("user_id", caller.id);
        // obyektlar kartasidagi mijoz_login ham sinxron bo'lsin
        const { data: mj } = await admin.from("mijozlar").select("obyekt_id").eq("user_id", caller.id).maybeSingle();
        if (mj?.obyekt_id) await admin.from("obyektlar").update({ mijoz_login: newLogin }).eq("id", mj.obyekt_id);
        return j({ ok: true });
      }

      // ══ 6. Mijoz profilini obyekt kartasiga sinxronlash ══
      case "mijoz_sync_obyekt": {
        if (!caller) return err("Avtorizatsiya kerak", 401);
        const { data: mj } = await admin.from("mijozlar")
          .select("ism, tel, login, obyekt_id").eq("user_id", caller.id).maybeSingle();
        if (!mj?.obyekt_id) return j({ ok: true });
        await admin.from("obyektlar")
          .update({ mijoz_ism: mj.ism, mijoz_tel: mj.tel, mijoz_login: mj.login })
          .eq("id", mj.obyekt_id);
        return j({ ok: true });
      }

      default:
        return err("Noma'lum amal");
    }
  } catch (e) {
    console.error(action, e);
    return err("Server xatosi", 500);
  }
});
