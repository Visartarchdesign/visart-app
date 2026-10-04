// ═══════════════════════════════════════════════════════════════
// VISART — manage-auth Edge Function (MULTI-TENANT + SUPERADMIN)
// Deploy: supabase functions deploy manage-auth
// Barcha xavfsizlik tekshiruvlari SHU YERDA — clientga ishonilmaydi.
//
// SUPERADMIN AMALLARI (faqat `superadmins` jadvalidagi user uchun):
//  - superadmin_list_companies   — barcha kompaniyalar + statistika
//  - superadmin_create_company   — yangi kompaniya yaratish
//  - superadmin_toggle_company   — faollashtirish/bloklash
//  - superadmin_list_users       — barcha prorab+mijozlar ro'yxati
//  - superadmin_reset_password   — istalgan foydalanuvchi paroli
//  - superadmin_update_login     — istalgan foydalanuvchi logini
//  - superadmin_delete_user      — istalgan foydalanuvchini o'chirish
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
// MUHIM: har doim HTTP 200 qaytaramiz (status kod NAZARDA TUTILADI, lekin ishlatilmaydi) —
// chunki supabase-js funksiyani chaqirganda non-2xx status kelsa, JAVOB TANASINI (bizning
// aniq xato matnimizni) o'qimay, faqat umumiy "Edge Function returned a non-2xx status code"
// deb ko'rsatadi. 200 qaytarib, xatoni { ok:false, error:"..." } orqali beramiz —
// frontend buni to'g'ri o'qib, foydalanuvchiga aniq xabar ko'rsatadi.
const err = (msg: string, _status = 400) => j({ ok: false, error: msg }, 200);

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

  // Chaqiruvchi prorabmi? Bo'lsa — uning kompaniya_id'sini ham qaytaradi.
  // Kompaniya bloklangan (faol=false) bo'lsa — null qaytaradi (ruxsat yo'q).
  const getCallerProrab = async (): Promise<{ login: string; kompaniya_id: string } | null> => {
    if (!caller) return null;
    const { data } = await admin.from("prorablar").select("login, kompaniya_id").eq("user_id", caller.id).maybeSingle();
    if (!data) return null;
    const { data: komp } = await admin.from("kompaniyalar").select("faol").eq("id", data.kompaniya_id).maybeSingle();
    if (!komp || komp.faol === false) return null;
    return data;
  };

  // Chaqiruvchi superadminmi?
  const isSuperadmin = async (): Promise<boolean> => {
    if (!caller) return false;
    const { data } = await admin.from("superadmins").select("user_id").eq("user_id", caller.id).maybeSingle();
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

  // ── IP bo'yicha ro'yxatdan o'tish urinishlarini cheklash (kompaniya kodini
  //    "brute-force" qilib topishning oldini olish uchun) ──
  const registerRateLimited = async () => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "noma'lum";
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("register_attempts")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip).gte("created_at", hourAgo);
    if ((count ?? 0) >= 10) return true;
    await admin.from("register_attempts").insert({ ip });
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
        if (!targetLogin || !newPassword || newPassword.length < 8) return err("Parol kamida 8 belgi bo'lishi kerak");

        if (payload.viaPhoneVerification) {
          // Telefon orqali: verifikatsiya QAYTA serverda (clientdagi flagga ishonilmaydi)
          if (await rateLimited(targetLogin)) return err("Juda ko'p urinish", 429);
          if (!(await verifyPhone(targetLogin, payload.tel as string)))
            return err("Telefon raqami tasdiqlanmadi");
        } else {
          // Prorab boshqa foydalanuvchi (mijoz) parolini tiklaydi.
          // XAVFSIZLIK: faqat O'Z KOMPANIYASIDAGI mijoz uchun ruxsat.
          const callerProrab = await getCallerProrab();
          if (!callerProrab) return err("Ruxsat yo'q", 403);
          const { data: targetMj } = await admin.from("mijozlar")
            .select("kompaniya_id").eq("login", targetLogin).maybeSingle();
          if (!targetMj || targetMj.kompaniya_id !== callerProrab.kompaniya_id)
            return err("Ruxsat yo'q", 403);
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

      // ══ 3. Ro'yxatdan o'tish (prorab) — kompaniya kodi kompaniyalar
      //       jadvalidan tekshiriladi, topilgan kompaniyaga bog'lanadi ══
      case "register_prorab": {
        if (await registerRateLimited()) return err("Juda ko'p urinish — 1 soatdan keyin qayta urining", 429);

        const { kod, ism, tel, login: rawLogin, parol } = payload as Record<string, string>;
        const login = normLogin(rawLogin);
        if (!LOGIN_RE.test(login)) return err("Login: 3–32 ta lotin harf/raqam/nuqta");
        if (!parol || parol.length < 8) return err("Parol kamida 8 belgi bo'lishi kerak");
        if (normTel(tel).length < 9) return err("Telefon raqami noto'g'ri");

        const kodInput = (kod || "").trim().toUpperCase();
        if (!kodInput) return err("Kompaniya kodini kiriting");

        const { data: komp } = await admin.from("kompaniyalar")
          .select("id, faol").eq("kod", kodInput).maybeSingle();
        if (!komp) return err("Kompaniya kodi noto'g'ri");
        if (!komp.faol) return err("Bu kompaniya faol emas — administratorga murojaat qiling");

        // login bandligini ikkala jadvalda tekshirish (barcha kompaniyalar bo'yicha —
        // login butun tizimda unikal bo'lishi shart, chunki u email sifatida ishlatiladi)
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
          .insert({ login, ism, tel, avatar, user_id: created.user.id, kompaniya_id: komp.id });
        if (ie) { await admin.auth.admin.deleteUser(created.user.id); return err(ie.message); }
        return j({ ok: true });
      }

      // ══ 4. Mijoz yaratish — faqat prorab, avtomatik uning kompaniyasiga bog'lanadi ══
      case "create_mijoz": {
        const callerProrab = await getCallerProrab();
        if (!callerProrab) return err("Ruxsat yo'q", 403);

        const { login: rawLogin, parol, ism, tel, obyektId, avatar } = payload as Record<string, string>;
        const login = normLogin(rawLogin);
        if (!LOGIN_RE.test(login)) return err("Login formati noto'g'ri");
        if (!parol || parol.length < 8) return err("Parol kamida 8 belgi bo'lishi kerak");

        // Obyekt haqiqatan ham shu prorabning kompaniyasiga tegishli ekanligini tekshirish
        const { data: obTarget } = await admin.from("obyektlar")
          .select("kompaniya_id").eq("id", obyektId).maybeSingle();
        if (!obTarget || obTarget.kompaniya_id !== callerProrab.kompaniya_id)
          return err("Obyekt topilmadi yoki ruxsat yo'q", 403);

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
          .insert({
            login, ism, tel, avatar: avatar || "MJ", obyekt_id: obyektId,
            user_id: created.user.id, kompaniya_id: callerProrab.kompaniya_id,
          });
        if (ie) { await admin.auth.admin.deleteUser(created.user.id); return err(ie.message); }
        return j({ ok: true });
      }

      // ══ 5. Mijoz akkauntini o'chirish — faqat o'z kompaniyasidagi mijozni ══
      case "delete_mijoz_account": {
        const callerProrab = await getCallerProrab();
        if (!callerProrab) return err("Ruxsat yo'q", 403);
        const targetLogin = normLogin(payload.targetLogin as string);
        const { data: targetMj } = await admin.from("mijozlar")
          .select("user_id, kompaniya_id").eq("login", targetLogin).maybeSingle();
        if (!targetMj || targetMj.kompaniya_id !== callerProrab.kompaniya_id)
          return err("Ruxsat yo'q", 403);
        const { error } = await admin.auth.admin.deleteUser(targetMj.user_id);
        if (error) return err(error.message);
        return j({ ok: true });
      }

      // ══ 6. Login o'zgartirish — faqat o'zi uchun ══
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
        await admin.from("prorablar").update({ login: newLogin }).eq("user_id", caller.id);
        await admin.from("mijozlar").update({ login: newLogin }).eq("user_id", caller.id);
        const { data: mj } = await admin.from("mijozlar").select("obyekt_id").eq("user_id", caller.id).maybeSingle();
        if (mj?.obyekt_id) await admin.from("obyektlar").update({ mijoz_login: newLogin }).eq("id", mj.obyekt_id);
        return j({ ok: true });
      }

      // ══ 7. Mijoz profilini obyekt kartasiga sinxronlash ══
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

      // ══════════════════ SUPERADMIN AMALLARI ══════════════════

      // ══ 8. Kompaniyalar ro'yxati + statistika ══
      case "superadmin_list_companies": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { data: companies, error: ce } = await admin.from("kompaniyalar")
          .select("id, nomi, kod, faol, created_at").order("created_at", { ascending: false });
        if (ce) return err(ce.message);

        const result = [];
        for (const k of companies || []) {
          const [{ count: prorabCount }, { count: mijozCount }, { count: obCount }] = await Promise.all([
            admin.from("prorablar").select("*", { count: "exact", head: true }).eq("kompaniya_id", k.id),
            admin.from("mijozlar").select("*", { count: "exact", head: true }).eq("kompaniya_id", k.id),
            admin.from("obyektlar").select("*", { count: "exact", head: true }).eq("kompaniya_id", k.id),
          ]);
          result.push({ ...k, prorab_soni: prorabCount ?? 0, mijoz_soni: mijozCount ?? 0, obyekt_soni: obCount ?? 0 });
        }
        return j({ ok: true, data: result });
      }

      // ══ 8.1 Kirish statistikasi (login analytics) — soddalashtirilgan ko'rinish ══
      case "superadmin_get_login_stats": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { data: attempts, error: ae } = await admin.from("login_attempts")
          .select("login, success, created_at, ip")
          .gte("created_at", monthAgo)
          .order("created_at", { ascending: false })
          .limit(2000);
        if (ae) return err(ae.message);

        const rows = attempts || [];
        const bugun = rows.filter((r) => r.created_at >= startOfToday);
        const hafta = rows.filter((r) => r.created_at >= weekAgo);

        // Har bir login qaysi kompaniya/rol/ismga tegishli ekanini aniqlaymiz
        const [{ data: prorablar }, { data: mijozlar }, { data: kompaniyalar }] = await Promise.all([
          admin.from("prorablar").select("login, ism, kompaniya_id"),
          admin.from("mijozlar").select("login, ism, kompaniya_id"),
          admin.from("kompaniyalar").select("id, nomi"),
        ]);
        const kompNomi = Object.fromEntries((kompaniyalar || []).map((k) => [k.id, k.nomi]));
        const userInfo = new Map();
        (prorablar || []).forEach((p) => userInfo.set(p.login, { ism: p.ism, rol: "prorab", kompaniyaNomi: kompNomi[p.kompaniya_id] || "-" }));
        (mijozlar || []).forEach((m) => userInfo.set(m.login, { ism: m.ism, rol: "mijoz", kompaniyaNomi: kompNomi[m.kompaniya_id] || "-" }));

        // Kompaniyalar bo'yicha so'nggi 7 kunlik kirishlar soni
        const kompaniyaHisob = {};
        hafta.forEach((r) => {
          const info = userInfo.get(r.login);
          const nomi = info?.kompaniyaNomi || "Noma'lum";
          kompaniyaHisob[nomi] = (kompaniyaHisob[nomi] || 0) + 1;
        });

        const songiFaollik = rows.slice(0, 50).map((r) => {
          const info = userInfo.get(r.login);
          return {
            login: r.login,
            ism: info?.ism || r.login,
            rol: info?.rol || "-",
            kompaniyaNomi: info?.kompaniyaNomi || "Noma'lum",
            vaqt: r.created_at,
            muvaffaqiyatli: r.success,
            ip: r.ip,
          };
        });

        return j({
          ok: true,
          data: {
            bugunJami: bugun.length,
            bugunMuvaffaqiyatli: bugun.filter((r) => r.success).length,
            bugunMuvaffaqiyatsiz: bugun.filter((r) => !r.success).length,
            haftaJami: hafta.length,
            oyJami: rows.length,
            faolFoydalanuvchilar: new Set(hafta.filter((r) => r.success).map((r) => r.login)).size,
            kompaniyalarBoyicha: Object.entries(kompaniyaHisob).sort((a, b) => b[1] - a[1]).map(([nomi, soni]) => ({ nomi, soni })),
            songiFaollik,
          },
        });
      }

      // ══ 9. Yangi kompaniya yaratish ══
      case "superadmin_create_company": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { nomi, kod } = payload as Record<string, string>;
        const kodNorm = (kod || "").trim().toUpperCase();
        if (!nomi || !nomi.trim()) return err("Kompaniya nomini kiriting");
        if (!kodNorm || kodNorm.length < 4) return err("Kod kamida 4 belgi bo'lishi kerak");

        const { data: exists } = await admin.from("kompaniyalar").select("id").eq("kod", kodNorm).maybeSingle();
        if (exists) return err("Bu kod band — boshqa kod tanlang");

        const { error: ie } = await admin.from("kompaniyalar").insert({ nomi: nomi.trim(), kod: kodNorm, faol: true });
        if (ie) return err(ie.message);
        return j({ ok: true });
      }

      // ══ 10. Kompaniyani faollashtirish / bloklash ══
      // ══ 10c. Kompaniyani BUTUNLAY o'chirish — barcha ma'lumotlari va foydalanuvchilari bilan ══
      case "superadmin_delete_company": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { kompaniyaId } = payload as Record<string, string>;
        if (!kompaniyaId) return err("Kompaniya ko'rsatilmagan");

        // 1) Shu kompaniyaga tegishli BARCHA auth foydalanuvchilarini yig'amiz
        const [{ data: prorabs }, { data: mijozlar }] = await Promise.all([
          admin.from("prorablar").select("user_id").eq("kompaniya_id", kompaniyaId),
          admin.from("mijozlar").select("user_id").eq("kompaniya_id", kompaniyaId),
        ]);
        const userIds = [
          ...(prorabs || []).map((p) => p.user_id),
          ...(mijozlar || []).map((m) => m.user_id),
        ].filter(Boolean);

        // 2) Auth akkauntlarini o'chiramiz (login/parol butunlay yo'qoladi)
        for (const uid of userIds) {
          await admin.auth.admin.deleteUser(uid as string).catch(() => {});
        }

        // 3) Ma'lumotlar jadvallarini tozalaymiz (bog'liq tartibda)
        await admin.from("chat_xabarlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("xizmat_tolovlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("tolovlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("xarajatlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("zakazlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("usta_tolovlari").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("ustalar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("kontragent_tolovlari").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("kontragentlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("obyektlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("mijozlar").delete().eq("kompaniya_id", kompaniyaId);
        await admin.from("prorablar").delete().eq("kompaniya_id", kompaniyaId);

        // 4) Kompaniyaning o'zini o'chiramiz
        const { error: de } = await admin.from("kompaniyalar").delete().eq("id", kompaniyaId);
        if (de) return err(de.message);

        return j({ ok: true, deletedUsers: userIds.length });
      }

      case "superadmin_toggle_company": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { kompaniyaId, faol } = payload as Record<string, unknown>;
        if (!kompaniyaId) return err("Kompaniya ko'rsatilmagan");
        const { error: ue } = await admin.from("kompaniyalar").update({ faol: !!faol }).eq("id", kompaniyaId as string);
        if (ue) return err(ue.message);
        return j({ ok: true });
      }

      // ══ 10b. Kompaniya nomi va/yoki ro'yxatdan o'tish kodini o'zgartirish ══
      case "superadmin_update_company": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { kompaniyaId, nomi, kod } = payload as Record<string, string>;
        if (!kompaniyaId) return err("Kompaniya ko'rsatilmagan");
        const kodNorm = (kod || "").trim().toUpperCase();
        if (!nomi || !nomi.trim()) return err("Kompaniya nomini kiriting");
        if (!kodNorm || kodNorm.length < 4) return err("Kod kamida 4 belgi bo'lishi kerak");

        const { data: exists } = await admin.from("kompaniyalar").select("id").eq("kod", kodNorm).neq("id", kompaniyaId).maybeSingle();
        if (exists) return err("Bu kod band — boshqa kod tanlang");

        const { error: ue } = await admin.from("kompaniyalar")
          .update({ nomi: nomi.trim(), kod: kodNorm }).eq("id", kompaniyaId);
        if (ue) return err(ue.message);
        return j({ ok: true });
      }

      // ══ 11. Barcha foydalanuvchilar ro'yxati (prorab + mijoz, kompaniya nomi bilan) ══
      case "superadmin_list_users": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const { data: companies } = await admin.from("kompaniyalar").select("id, nomi");
        const compMap = new Map((companies || []).map((c) => [c.id, c.nomi]));

        const [{ data: prorablar }, { data: mijozlar }] = await Promise.all([
          admin.from("prorablar").select("login, ism, tel, kompaniya_id, user_id"),
          admin.from("mijozlar").select("login, ism, tel, kompaniya_id, user_id"),
        ]);

        const result = [
          ...(prorablar || []).map((p) => ({ ...p, rol: "prorab", kompaniya_nomi: compMap.get(p.kompaniya_id) || "—" })),
          ...(mijozlar || []).map((m) => ({ ...m, rol: "mijoz", kompaniya_nomi: compMap.get(m.kompaniya_id) || "—" })),
        ];
        return j({ ok: true, data: result });
      }

      // ══ 12. Istalgan foydalanuvchi parolini tiklash ══
      case "superadmin_reset_password": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const targetLogin = normLogin(payload.targetLogin as string);
        const newPassword = payload.newPassword as string;
        if (!targetLogin || !newPassword || newPassword.length < 8) return err("Parol kamida 8 belgi bo'lishi kerak");

        const { data: mj } = await admin.from("mijozlar").select("user_id").eq("login", targetLogin).maybeSingle();
        const { data: pr } = await admin.from("prorablar").select("user_id").eq("login", targetLogin).maybeSingle();
        const uid = mj?.user_id || pr?.user_id;
        if (!uid) return err("Foydalanuvchi topilmadi");

        const { error } = await admin.auth.admin.updateUserById(uid, { password: newPassword });
        if (error) return err(error.message);
        return j({ ok: true });
      }

      // ══ 13. Istalgan foydalanuvchi loginini o'zgartirish ══
      case "superadmin_update_login": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const oldLogin = normLogin(payload.oldLogin as string);
        const newLogin = normLogin(payload.newLogin as string);
        if (!LOGIN_RE.test(newLogin)) return err("Yangi login formati noto'g'ri");

        const [{ data: p1 }, { data: m1 }] = await Promise.all([
          admin.from("prorablar").select("login").eq("login", newLogin).maybeSingle(),
          admin.from("mijozlar").select("login").eq("login", newLogin).maybeSingle(),
        ]);
        if (p1 || m1) return err("Bu login band");

        const { data: mj } = await admin.from("mijozlar").select("user_id, obyekt_id").eq("login", oldLogin).maybeSingle();
        const { data: pr } = await admin.from("prorablar").select("user_id").eq("login", oldLogin).maybeSingle();
        const uid = mj?.user_id || pr?.user_id;
        if (!uid) return err("Foydalanuvchi topilmadi");

        const { error: ae } = await admin.auth.admin.updateUserById(uid, { email: toAuthEmail(newLogin) });
        if (ae) return err(ae.message);
        await admin.from("prorablar").update({ login: newLogin }).eq("user_id", uid);
        await admin.from("mijozlar").update({ login: newLogin }).eq("user_id", uid);
        if (mj?.obyekt_id) await admin.from("obyektlar").update({ mijoz_login: newLogin }).eq("id", mj.obyekt_id);
        return j({ ok: true });
      }

      // ══ 14. Istalgan foydalanuvchini butunlay o'chirish ══
      case "superadmin_delete_user": {
        if (!(await isSuperadmin())) return err("Ruxsat yo'q", 403);
        const targetLogin = normLogin(payload.targetLogin as string);
        const { data: mj } = await admin.from("mijozlar").select("user_id").eq("login", targetLogin).maybeSingle();
        const { data: pr } = await admin.from("prorablar").select("user_id").eq("login", targetLogin).maybeSingle();
        const uid = mj?.user_id || pr?.user_id;
        if (!uid) return err("Foydalanuvchi topilmadi");
        const { error } = await admin.auth.admin.deleteUser(uid);
        if (error) return err(error.message);
        return j({ ok: true });
      }

      // ══ 15. Login urinishidan OLDIN tekshirish (auth talab qilinmaydi) ══
      case "check_login_allowed": {
        const login = normLogin(payload.login as string);
        if (!login) return err("Login kerak");
        const windowAgo = new Date(Date.now() - 15 * 60_000).toISOString();
        const { data: attempts } = await admin.from("login_attempts")
          .select("success, created_at").eq("login", login).gte("created_at", windowAgo)
          .order("created_at", { ascending: false }).limit(10);
        const fails = (attempts || []).filter(a => !a.success);
        // Ketma-ket 5 ta muvaffaqiyatsiz urinishdan keyin (oxirgi muvaffaqiyatlisiga qadar) bloklaymiz
        let consecutiveFails = 0;
        for (const a of (attempts || [])) {
          if (a.success) break;
          consecutiveFails++;
        }
        if (consecutiveFails >= 5) {
          return err("Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin qayta urining.", 429);
        }
        return j({ ok: true });
      }

      // ══ 16. Login natijasini qayd etish (auth talab qilinmaydi) ══
      case "record_login_result": {
        const login = normLogin(payload.login as string);
        const success = !!payload.success;
        if (!login) return j({ ok: true });
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
        await admin.from("login_attempts").insert({ login, ip, success });
        return j({ ok: true });
      }

      // ══ 17. Push-bildirishnoma obunasini saqlash (fon rejimida ishlashi uchun) ══
      case "save_push_subscription": {
        if (!caller) return err("Ruxsat yo'q", 403);
        const { endpoint, p256dh, authKey, rol, kompaniyaId, obyektId, login } = payload as Record<string, string>;
        if (!endpoint || !p256dh || !authKey) return err("Noto'g'ri obuna ma'lumoti");
        const { error } = await admin.from("push_subscriptions").upsert({
          user_id: caller.id, login, rol, kompaniya_id: kompaniyaId, obyekt_id: obyektId || null,
          endpoint, p256dh, auth_key: authKey,
        }, { onConflict: "endpoint" });
        if (error) return err(error.message);
        return j({ ok: true });
      }

      // ══ 18. Push-bildirishnoma obunasini o'chirish ══
      case "remove_push_subscription": {
        if (!caller) return err("Ruxsat yo'q", 403);
        const { endpoint } = payload as Record<string, string>;
        if (!endpoint) return j({ ok: true });
        await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", caller.id);
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
