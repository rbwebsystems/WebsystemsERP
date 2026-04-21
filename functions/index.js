// Firebase Cloud Function — Gündəlik Kredit Ödəniş Bildirişi
// Hər gün saat 10:00 (Bakı vaxtı = UTC+4) → UTC 06:00
// Heç bir istifadəci app açmasa belə işləyir.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { createHash } from "node:crypto";

initializeApp();
const db = getFirestore();

// ─── Köməkçi funksiyalar ────────────────────────────────────────────────────

function money(v) {
  const n = Math.max(0, Number(v) || 0);
  return n.toLocaleString("az-AZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function n(v) {
  return Number(v) || 0;
}

function addMonthsISO(isoDate, months) {
  const [y, m, d] = String(isoDate || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1 + months, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function buildCreditSchedule(sale) {
  const term = Math.max(0, Number(sale.credit?.termMonths) || 0);
  const toCents = (v) => Math.round(Math.max(0, n(v)) * 100);
  const fromCents = (c) => Math.max(0, c) / 100;

  const totalC = toCents(sale.amount);
  const downC = Math.min(totalC, toCents(sale.credit?.downPayment));
  const remC = Math.max(0, totalC - downC);
  const monthlyBase = term > 0 ? Math.floor(remC / term) : 0;
  const monthlyRem = term > 0 ? remC % term : 0;

  const paidC = toCents(sale.paidTotal);
  const downAppliedC = Math.min(downC, paidC);
  let paidLeftC = Math.max(0, paidC - downAppliedC);

  const rows = [];
  for (let i = 1; i <= term; i++) {
    const amtC = monthlyBase + (i <= monthlyRem ? 1 : 0);
    const due = addMonthsISO(sale.date, i);
    const paidThisC = Math.min(amtC, paidLeftC);
    paidLeftC -= paidThisC;
    const remainingC = Math.max(0, amtC - paidThisC);
    rows.push({
      idx: i,
      due,
      amount: fromCents(amtC),
      paid: fromCents(paidThisC),
      remaining: fromCents(remainingC),
    });
  }

  return { term, down: fromCents(downC), rows };
}

function buildCreditScheduleAggregated(salesArr, dateISO) {
  const arr = (salesArr || []).filter(Boolean);
  if (!arr.length) {
    return buildCreditSchedule({
      amount: "0",
      paidTotal: "0",
      date: dateISO || "",
      credit: { termMonths: 0, downPayment: "0" },
    });
  }
  const ref = arr[0];
  const totalAmount = arr.reduce((a, x) => a + n(x.amount), 0);
  const totalDown = arr.reduce((a, x) => a + n(x.credit?.downPayment || 0), 0);
  const totalPaid = arr.reduce((a, x) => a + n(x.paidTotal), 0);
  const term = Math.max(0, Math.floor(n(ref.credit?.termMonths) || 0));
  return buildCreditSchedule({
    amount: String(totalAmount),
    paidTotal: String(totalPaid),
    date: dateISO || String(ref.date || "").slice(0, 10),
    credit: {
      ...(ref.credit || {}),
      termMonths: term,
      downPayment: String(totalDown),
    },
  });
}

function kreditInvoiceGroupKeyCloud(sale) {
  const inv = String(sale?.invNo || "").trim();
  const cid = String(sale?.customerId || "");
  if (!inv) return `kredit:uid:${sale?.uid}`;
  return `kredit:inv:${cid}:${inv}`;
}

function kreditInvoiceSiblingsCloud(sales, sale) {
  const inv = String(sale.invNo || "").trim();
  const cid = String(sale.customerId || "");
  if (!inv) return [sale];
  return sales.filter(
    (s) =>
      !s.returnedAt &&
      String(s.saleType || "").toLowerCase() === "kredit" &&
      String(s.customerId || "") === cid &&
      String(s.invNo || "").trim() === inv
  );
}

function kreditInvoiceScheduleDateISOCloud(siblings) {
  return (siblings || []).reduce((min, x) => {
    const d = String(x.date || "").slice(0, 10);
    if (!d) return min;
    if (!min || d < min) return d;
    return min;
  }, "");
}

function saleRemainingCloud(s) {
  return Math.max(0, n(s.amount) - n(s.paidTotal));
}

function invFallback(prefix, uid) {
  return `${prefix.toUpperCase()}-${String(uid || "").padStart(4, "0")}`;
}

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram xətası:", err);
  }
}

// ─── Hər şirkət üçün bugünkü kredit ödənişlərini tap və göndər ────────────

async function processCompany(companyId, companyData) {
  const settings = companyData.settings || {};
  const token = (settings.telegramToken || "").trim();
  const chatId = (settings.telegramChatId || "").trim();
  if (!token || !chatId) return; // Telegram qurulmayıb

  const companyName = settings.companyName || companyId;

  const today = new Date();
  const yy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(today.getUTCDate()).padStart(2, "0");
  // Bakı vaxtı = UTC+4, funksiya saat 06:00 UTC-də işləyir = 10:00 Bakı
  const todayISO = `${yy}-${mm}-${dd}`;
  const todayLabel = `${dd}.${mm}.${yy}`;

  const sales = companyData.sales || [];
  const accounts = companyData.accounts || [{ uid: 1, name: "Kassa" }];

  const dueList = [];
  const seenInv = new Set();

  for (const sale of sales) {
    if (sale.returnedAt) continue;
    if (String(sale.saleType || "").toLowerCase() !== "kredit") continue;

    const gk = kreditInvoiceGroupKeyCloud(sale);
    if (seenInv.has(gk)) continue;
    seenInv.add(gk);

    const siblings = kreditInvoiceSiblingsCloud(sales, sale);
    const anchor = kreditInvoiceScheduleDateISOCloud(siblings);
    const invRem = siblings.reduce((a, x) => a + saleRemainingCloud(x), 0);
    if (invRem <= 0.000001) continue;

    const sched = buildCreditScheduleAggregated(siblings, anchor);
    const rep = siblings.slice().sort((a, b) => Number(a.uid) - Number(b.uid))[0] || sale;
    const custName = rep.customerName || "-";
    const invNo = rep.invNo || invFallback("ST", rep.uid);
    const accName =
      accounts.find((a) => a.uid === Number(rep.paymentAccountId || 1))?.name || "Kassa";

    const saleDateISO = anchor;
    if (saleDateISO === todayISO && sched.down > 0.000001) {
      const totalPaid = siblings.reduce((a, x) => a + n(x.paidTotal), 0);
      const downPaid = Math.min(sched.down, totalPaid);
      const downRem = Math.max(0, sched.down - downPaid);
      if (downRem > 0.000001) {
        dueList.push({
          customer: custName, invNo,
          payType: "İlkin ödəniş",
          amount: sched.down, remaining: downRem, account: accName,
        });
      }
    }

    for (const row of sched.rows) {
      if (row.due === todayISO && row.remaining > 0.000001) {
        dueList.push({
          customer: custName, invNo,
          payType: `Aylıq ödəniş (${row.idx}/${sched.term})`,
          amount: row.amount, remaining: row.remaining, account: accName,
        });
      }
    }
  }

  if (dueList.length === 0) {
    await sendTelegram(
      token, chatId,
      `📅 <b>Gündəlik Kredit Bildirişi — ${todayLabel}</b>\n` +
      `Şirkət: <b>${companyName}</b>\n\n` +
      `✅ Bu gün ödənilməli kredit öhdəliyi yoxdur.`
    );
    return;
  }

  const lines = dueList
    .map(
      (d, i) =>
        `${i + 1}. 👤 <b>${d.customer}</b>  |  📄 ${d.invNo}\n` +
        `   🏷 Növ: ${d.payType}\n` +
        `   💰 Məbləğ: <b>${money(d.amount)} AZN</b>  (Qalıq: ${money(d.remaining)} AZN)\n` +
        `   🏦 Hesab: ${d.account}`
    )
    .join("\n\n");

  await sendTelegram(
    token, chatId,
    `📅 <b>Gündəlik Kredit Ödənişləri — ${todayLabel}</b>\n` +
    `Şirkət: <b>${companyName}</b>\n` +
    `Cəmi: <b>${dueList.length}</b> ödəniş bu gün\n\n` +
    lines
  );

  console.log(`[${companyId}] ${dueList.length} kredit ödənişi göndərildi.`);
}

// ─── Scheduled Function: hər gün saat 06:00 UTC (= 10:00 Bakı) ────────────

// ─── Auth: İstifadəçi adı + şifrəni server-tərəfdə yoxla, custom token ver ──

function getCompanyIdFromUsernameServer(username) {
  const idx = String(username || "").indexOf("_");
  if (idx <= 0) return null;
  return username.slice(0, idx).trim().toLowerCase();
}

const DEVELOPER_COMPANY_SENTINEL = "__developer__";

function normAuth(s) {
  return String(s || "").trim().toLowerCase();
}

function sanitizeUidPart(s) {
  return String(s || "x")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 100);
}

/** Meta + şifrə yoxlaması — tenant və developer callable üçün ortaq. */
async function verifyErpPassword(username, password) {
  if (!username || !password) {
    throw new HttpsError("invalid-argument", "İstifadəçi adı və şifrə tələb olunur.");
  }

  let metaData;
  try {
    const snap = await db.collection("config").doc("meta").get();
    if (!snap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Firestore-da config/meta sənədi yoxdur. Admin panelindən və ya bir dəfəlik migrasiya ilə meta yaradın."
      );
    }
    metaData = snap.data();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("[verifyErpPassword] config/meta oxuma:", e);
    throw new HttpsError(
      "unavailable",
      `Meta oxuna bilmədi (${e?.code || e?.message || "xəta"}). Firestore əlçatanlığını və Functions service account icazəsini yoxlayın.`
    );
  }

  const users = metaData.users || [];
  const unameNorm = String(username).trim().toLowerCase();

  let user = users.find((u) => u.username === username);
  if (!user) user = users.find((u) => String(u.username || "").trim().toLowerCase() === unameNorm);

  if (!user) {
    throw new HttpsError("unauthenticated", "İstifadəçi tapılmadı.");
  }

  // ⚠ active yoxlaması /erp_users merge-dən SONRA aparılır (aşağıda).
  // config/meta.active köhnə ola bilər (tenant admin saveMeta yalnız /erp_users-a yazır)
  // — ona görə deaktiv statusu həmişə /erp_users-dən də yoxlamaq lazımdır.

  // Tenant istifadəçilər şifrəni və active flag-ini /erp_users/{companyId}-ə yazır.
  // Admin SDK hər iki yola çıxış edir — daha yeni dəyəri oradan götür.
  const cid = String(user.companyId || "").trim();
  if (cid) {
    try {
      const isolatedSnap = await db.collection("erp_users").doc(cid).get();
      if (isolatedSnap.exists) {
        const isolatedUsers = isolatedSnap.data()?.users || [];
        const fresh = isolatedUsers.find((u) => String(u.uid) === String(user.uid));
        if (fresh) {
          // /erp_users-dəki giriş üstündür: pass, active, mustChangePassword və s.
          user = { ...user, ...fresh };
          console.log("[verifyErpPassword] /erp_users qeydi istifadə edildi", {
            uid: user.uid, cid, active: user.active,
          });
        }
      }
    } catch (e) {
      console.warn("[verifyErpPassword] /erp_users oxuma uğursuz, fallback config/meta", e?.code);
    }
  }

  // Indi final active yoxlaması (merge sonrası)
  if (!user.active) {
    throw new HttpsError("unauthenticated", "İstifadəçi deaktiv edilib. Administratorla əlaqə saxlayın.");
  }

  const hashPass = (p) => createHash("sha256").update(String(p)).digest("hex");
  const inputHash = hashPass(password);
  const stored = String(user.pass || "");
  if (stored !== inputHash && stored !== password) {
    throw new HttpsError("unauthenticated", "Şifrə yanlışdır.");
  }

  if (stored === password && stored !== inputHash) {
    user.pass = inputHash;
    try {
      await db.collection("config").doc("meta").set(metaData);
    } catch (_) {}
  }

  return { user, metaData, companies: metaData.companies || [] };
}

/** Admin Auth xətalarını brauzerdə oxunaqlı HttpsError-a çevir (internal kodu mesajı gizlədir). */
function mapAuthAdminError(err, firebaseUid) {
  if (err instanceof HttpsError) throw err;
  const code = String(err?.code || "");
  const msg = String(err?.errorInfo?.message || err?.message || err || "");
  const low = `${code} ${msg}`.toLowerCase();

  if (low.includes("signblob") || (low.includes("permission") && low.includes("iam"))) {
    throw new HttpsError(
      "failed-precondition",
      "Custom token imzalanmadı: Cloud Functions xidmət hesabına «Service Account Token Creator» (iam.serviceAccounts.signBlob) icazəsi lazımdır. " +
        "Google Cloud Console → IAM → `{PROJECT_ID}@appspot.gserviceaccount.com` və ya Functions üçün istifadə olunan hesaba `roles/iam.serviceAccountTokenCreator` verin. " +
        `Detal: ${msg || code}`
    );
  }
  if (code === "auth/invalid-argument" || code === "auth/invalid-custom-claims" || code === "auth/invalid-claims") {
    throw new HttpsError("failed-precondition", `Auth claim/xidmət xətası: ${msg || code}`);
  }
  if (code === "auth/uid-already-exists") {
    throw new HttpsError("already-exists", `UID artıq mövcuddur: ${firebaseUid}`);
  }

  console.error("[mintFirebaseCustomToken]", firebaseUid, err);
  throw new HttpsError(
    "failed-precondition",
    `Firebase Auth əməliyyatı uğursuz oldu: ${msg || code || "naməlum"}. Firebase Console → Functions → Logs.`
  );
}

async function mintFirebaseCustomToken(firebaseUid, claims) {
  try {
    try {
      await getAdminAuth().getUser(firebaseUid);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        await getAdminAuth().createUser({ uid: firebaseUid });
      } else {
        mapAuthAdminError(err, firebaseUid);
      }
    }
    const safeClaims = {};
    for (const [k, v] of Object.entries(claims || {})) {
      if (typeof v === "boolean") safeClaims[k] = v;
      else if (v == null) continue;
      else safeClaims[k] = typeof v === "string" ? v : String(v);
    }
    const roleForAssert = String(safeClaims.role || "").trim();
    const companyIdForAssert = String(safeClaims.companyId ?? "").trim();
    if (roleForAssert === "tenant" && !companyIdForAssert) {
      console.error("[mintFirebaseCustomToken] tenant üçün companyId boşdur — token yaradılmır", { firebaseUid, safeClaims });
      throw new HttpsError("failed-precondition", "companyId tapılmadı");
    }
    if (roleForAssert === "developer" && !companyIdForAssert) {
      console.error("[mintFirebaseCustomToken] developer üçün companyId boşdur — token yaradılmır", { firebaseUid, safeClaims });
      throw new HttpsError("failed-precondition", "companyId tapılmadı");
    }

    await getAdminAuth().setCustomUserClaims(firebaseUid, safeClaims);

    let persisted = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      const reRead = await getAdminAuth().getUser(firebaseUid);
      persisted = reRead.customClaims || {};
      const pc = String(persisted.companyId ?? "").trim();
      if (roleForAssert !== "tenant" && roleForAssert !== "developer") break;
      if (pc) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    console.log("[mintFirebaseCustomToken] Auth-da saxlanmış claim-lər", {
      firebaseUid,
      role: persisted.role,
      hasCompanyId: !!String(persisted.companyId ?? "").trim(),
      companyId: persisted.companyId,
    });
    if (roleForAssert === "tenant" && !String(persisted.companyId ?? "").trim()) {
      console.error("[mintFirebaseCustomToken] tenant: Auth getUser sonrası companyId boş", { firebaseUid, persisted });
      throw new HttpsError("failed-precondition", "companyId tapılmadı (Auth-da saxlanmadı)");
    }
    if (roleForAssert === "developer" && !String(persisted.companyId ?? "").trim()) {
      console.error("[mintFirebaseCustomToken] developer: Auth getUser sonrası companyId boş", { firebaseUid, persisted });
      throw new HttpsError("failed-precondition", "companyId tapılmadı (Auth-da saxlanmadı)");
    }

    return await getAdminAuth().createCustomToken(firebaseUid, safeClaims);
  } catch (err) {
    mapAuthAdminError(err, firebaseUid);
  }
}

/**
 * Per-company user izolyasiyası: tenant login sonrası həmin şirkətin user siyahısını
 * /erp_users/{companyId} altına yazır. Admin SDK ilə — Firestore rules-i keçir.
 * Fire-and-forget: tokenin qaytarılmasını gecikdirmir.
 * Məqsəd: client /erp_users/{companyId}-dan YALNIZ öz şirkətinin userlarını oxusun;
 *         config/meta.users-a ehtiyac qalmasın (digər şirkətlərin hash-ləri görünməsin).
 */
async function syncCompanyUsersToIsolatedPath(companyId, allUsers) {
  const cid = String(companyId || "").trim();
  if (!cid) return;
  try {
    const companyUsers = (allUsers || []).filter(
      (u) => u && u.role !== "developer" &&
        (!u.companyId || normAuth(u.companyId) === normAuth(cid))
    );

    // ⚠ Qoruyucu birləşdirmə: mövcud /erp_users-də user daha yeni şifrə/flag
    // saxlaya bilər (tenant-ın config/meta-ya yazma icazəsi yoxdur).
    // config/meta ilə overwrite etsək dəyişikliklər itəcək. Ona görə hər user üçün
    // mövcud qeyddən pass və mustChangePassword-u üstün tuturuq.
    let existingUsers = [];
    try {
      const existingSnap = await db.collection("erp_users").doc(cid).get();
      if (existingSnap.exists) existingUsers = existingSnap.data()?.users || [];
    } catch (_) {}

    const merged = companyUsers.map((metaUser) => {
      const fresh = existingUsers.find((e) => String(e.uid) === String(metaUser.uid));
      if (!fresh) return metaUser;
      return {
        ...metaUser,
        // /erp_users-dəki şifrə və mustChangePassword dəyərlərinə üstünlük ver
        pass: fresh.pass != null ? fresh.pass : metaUser.pass,
        mustChangePassword: fresh.mustChangePassword != null ? fresh.mustChangePassword : metaUser.mustChangePassword,
      };
    });

    await db.collection("erp_users").doc(cid).set({
      users: merged,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[syncCompanyUsersToIsolatedPath] ${cid}: ${merged.length} user sinxronlaşdı (merge).`);
  } catch (e) {
    console.warn(`[syncCompanyUsersToIsolatedPath] ${cid} xətası:`, e?.code || e?.message);
  }
}

/**
 * Tenant istifadəçinin şifrəsini dəyişir.
 * Admin SDK ilə /erp_users/{companyId}-i yeniləyir — Firestore rules-ı keçir.
 * Cari şifrə serverda yoxlanılır; uğurlu olduqda hash yazılır.
 */
export const changeUserPassword = onCall(
  { region: "europe-west1", cors: [/rbsoft\.az$/, /localhost/] },
  async (request) => {
    const { uid, companyId, currentPassword, newPassword } = request.data || {};
    if (!uid || !companyId || !currentPassword || !newPassword) {
      throw new HttpsError("invalid-argument", "uid, companyId, currentPassword və newPassword tələb olunur.");
    }
    if (String(newPassword).length < 4) {
      throw new HttpsError("invalid-argument", "Yeni şifrə ən azı 4 simvol olmalıdır.");
    }
    const hashPass = (p) => createHash("sha256").update(String(p)).digest("hex");

    // İstifadəçini /erp_users/{cid}-dən, yoxsa config/meta-dan tap
    let storedUser = null;
    const cid = String(companyId).trim();
    try {
      const isolatedSnap = await db.collection("erp_users").doc(cid).get();
      if (isolatedSnap.exists) {
        const isoUsers = isolatedSnap.data()?.users || [];
        storedUser = isoUsers.find((u) => String(u.uid) === String(uid)) || null;
      }
    } catch (_) {}

    if (!storedUser) {
      const metaSnap = await db.collection("config").doc("meta").get();
      if (!metaSnap.exists) throw new HttpsError("failed-precondition", "Meta tapılmadı.");
      const metaUsers = metaSnap.data()?.users || [];
      storedUser = metaUsers.find((u) => String(u.uid) === String(uid)) || null;
    }
    if (!storedUser || !storedUser.active) {
      throw new HttpsError("unauthenticated", "İstifadəçi tapılmadı.");
    }

    // Cari şifrəni yoxla
    const curHash = hashPass(currentPassword);
    const stored = String(storedUser.pass || "");
    if (stored !== curHash && stored !== currentPassword) {
      throw new HttpsError("unauthenticated", "Hazırkı şifrə yanlışdır.");
    }

    const newHash = hashPass(newPassword);

    // ─── 1) /erp_users/{cid} – Admin SDK ilə yenilə ─────────────────────────
    try {
      const isolatedSnap = await db.collection("erp_users").doc(cid).get();
      let users = [];
      if (isolatedSnap.exists) users = isolatedSnap.data()?.users || [];
      const idx = users.findIndex((u) => String(u.uid) === String(uid));
      if (idx !== -1) {
        users[idx] = { ...users[idx], pass: newHash, mustChangePassword: false };
      } else {
        users.push({ ...storedUser, pass: newHash, mustChangePassword: false });
      }
      await db.collection("erp_users").doc(cid).set({ users, updatedAt: new Date().toISOString() });
      console.log("[changeUserPassword] /erp_users yeniləndi", { uid, cid });
    } catch (e) {
      console.error("[changeUserPassword] /erp_users yazma xətası", e?.code, e?.message);
      throw new HttpsError("internal", "Şifrə yenilənərkən xəta baş verdi.");
    }

    // ─── 2) config/meta.users – EYNİ ZAMANDA yenilə ─────────────────────────
    // Növbəti issueAuthToken → syncCompanyUsersToIsolatedPath çağırışının
    // /erp_users-i köhnə config/meta ilə üstdən yazmasının qarşısını alır.
    try {
      const metaSnap = await db.collection("config").doc("meta").get();
      if (metaSnap.exists) {
        const metaData = metaSnap.data() || {};
        const metaUsers = Array.isArray(metaData.users) ? [...metaData.users] : [];
        const mIdx = metaUsers.findIndex((u) => String(u.uid) === String(uid));
        if (mIdx !== -1) {
          metaUsers[mIdx] = { ...metaUsers[mIdx], pass: newHash, mustChangePassword: false };
          metaData.users = metaUsers;
          await db.collection("config").doc("meta").set(metaData);
          console.log("[changeUserPassword] config/meta yeniləndi", { uid });
        }
      }
    } catch (e) {
      console.warn("[changeUserPassword] config/meta yazma xətası (non-fatal)", e?.code, e?.message);
    }

    return { ok: true };
  }
);

/** ERP giriş: developer və tenant ayrı axınlar; developer tenant token yalnız allowImpersonation ilə. */
export const issueAuthToken = onCall(
  { region: "europe-west1", cors: [/rbsoft\.az$/, /localhost/] },
  async (request) => {
    const { username, password, companyId: companyIdFromClient, allowImpersonation } = request.data || {};
    const hint = String(companyIdFromClient ?? "").trim();
    const allowImp = allowImpersonation === true;
    const usernameNorm = normAuth(username);

    console.log("[issueAuthToken] request payload", {
      usernameNorm,
      companyIdFromClient: hint || "(yox)",
      allowImpersonation: allowImp,
    });

    const { user, metaData, companies } = await verifyErpPassword(username, password);
    const erpRoleNorm = normAuth(user.role || "");
    /** Meta-da rol səhv yazılsa belə, "developer" istifadəçi adı tenant token ala bilməz. */
    const isDeveloperErpUser = erpRoleNorm === "developer" || usernameNorm === "developer";

    const mintDeveloperToken = async () => {
      let firebaseUid = `developer_${sanitizeUidPart(username)}`;
      if (firebaseUid.length > 128) firebaseUid = firebaseUid.slice(0, 128);
      const claims = {
        role: "developer",
        companyId: DEVELOPER_COMPANY_SENTINEL,
        erp_session: true,
        erpRole: "developer",
      };
      console.log("[issueAuthToken] createCustomToken əvvəl (developer)", {
        login: usernameNorm,
        companyId: claims.companyId,
        firebaseUid,
        role: claims.role,
      });
      const customToken = await mintFirebaseCustomToken(firebaseUid, claims);
      console.log("[issueAuthToken] developer hazır", {
        hasCompanyId: !!String(claims.companyId || "").trim(),
        role: claims.role,
        firebaseUid,
      });
      return { token: customToken, companyId: DEVELOPER_COMPANY_SENTINEL, firebaseUid };
    };

    const mintTenantToken = async (exactCompanyId, erpRoleClaim, opts = {}) => {
      const supportImpersonation = opts.supportImpersonation === true;
      const uidPart = sanitizeUidPart(exactCompanyId);
      if (!uidPart) {
        console.error("[issueAuthToken] UID üçün companyId sanitize boş", { exactCompanyId });
        throw new HttpsError("failed-precondition", "companyId tapılmadı");
      }
      let firebaseUid = `tenant_${uidPart}`;
      if (firebaseUid.length > 128) firebaseUid = firebaseUid.slice(0, 128);
      const claims = {
        companyId: String(exactCompanyId),
        role: "tenant",
        erp_session: true,
        erpRole: erpRoleClaim === "admin" ? "admin" : "user",
        ...(supportImpersonation ? { support_impersonation: true } : {}),
      };
      console.log("[issueAuthToken] createCustomToken əvvəl (tenant)", {
        login: usernameNorm,
        tapılanCompanyId: exactCompanyId,
        firebaseUid,
        role: claims.role,
      });
      const customToken = await mintFirebaseCustomToken(firebaseUid, claims);
      console.log("[issueAuthToken] tenant hazır", {
        hasCompanyId: !!String(exactCompanyId || "").trim(),
        role: claims.role,
        firebaseUid,
      });
      return { token: customToken, companyId: exactCompanyId, firebaseUid };
    };

    if (isDeveloperErpUser) {
      if (hint && !allowImp) {
        console.warn("[issueAuthToken] developer + companyId bloklandı (allowImpersonation yoxdur)", { hint });
        throw new HttpsError("permission-denied", "Developer şirkətə birbaşa daxil ola bilməz");
      }
      if (hint && allowImp) {
        const hintNorm = normAuth(hint);
        const byHint = companies.find((c) => normAuth(c.id) === hintNorm);
        if (!byHint) {
          throw new HttpsError("not-found", "Seçilmiş şirkət (companyId) tapılmadı.");
        }
        const exactCompanyId = String(byHint.id ?? "").trim();
        if (!exactCompanyId || exactCompanyId === "undefined" || exactCompanyId === "null") {
          console.error("[issueAuthToken] impersonation: exactCompanyId etibarsız", { byHint });
          throw new HttpsError("failed-precondition", "companyId tapılmadı");
        }
        console.log("[issueAuthToken] developer impersonation → tenant token", { exactCompanyId });
        const impResult = await mintTenantToken(exactCompanyId, "admin", { supportImpersonation: true });
        syncCompanyUsersToIsolatedPath(exactCompanyId, metaData.users || []).catch(() => {});
        return impResult;
      }
      console.log("[issueAuthToken] developer token (companyId göndərilməyib)");
      return await mintDeveloperToken();
    }

    // ——— Yalnız real şirkət istifadəçisi (tenant Firebase claim) ———
    if (erpRoleNorm === "developer" || usernameNorm === "developer") {
      throw new HttpsError("permission-denied", "Developer tenant token alın bilməz");
    }
    if (erpRoleNorm && erpRoleNorm !== "admin" && erpRoleNorm !== "user") {
      throw new HttpsError("permission-denied", "Bu istifadəçi tipi şirkət girişi üçün uyğun deyil.");
    }

    if (!hint) {
      throw new HttpsError("invalid-argument", "Tenant üçün companyId mütləqdir (məs. URL ?company= şirkət_id).");
    }

    const rawId = String(user.companyId || getCompanyIdFromUsernameServer(username) || "").trim();
    const hintNorm = normAuth(hint);
    let matchedCompany = companies.find((c) => normAuth(c.id) === normAuth(rawId));
    const byHint = companies.find((c) => normAuth(c.id) === hintNorm);

    console.log("[issueAuthToken] tenant trace", {
      login: usernameNorm,
      erpRoleNorm,
      hint,
      userCompanyId: user.companyId ?? null,
      fromUsername: getCompanyIdFromUsernameServer(username),
      rawId: rawId || null,
      matchedByRawId: matchedCompany?.id ?? null,
      matchedByHint: byHint?.id ?? null,
    });

    if (!byHint) {
      throw new HttpsError("not-found", "Seçilmiş şirkət (companyId) tapılmadı.");
    }
    if (matchedCompany && normAuth(matchedCompany.id) !== hintNorm) {
      console.warn("[issueAuthToken] tenant: client şirkət hint-i user.companyId ilə uyğun gəlmir", {
        username: usernameNorm,
        userCompanyId: user.companyId ?? null,
        companyIdFromClient: hint,
        rawId: rawId || null,
        matchedByRawId: matchedCompany?.id ?? null,
        matchedByHint: byHint?.id ?? null,
        səbəb: "Brauzerdə seçilmiş/URL şirkət başqa, istifadəçinin şirkəti başqa — issueAuthToken bloklayır",
      });
      throw new HttpsError("permission-denied", "Bu şirkət üçün giriş icazəsi yoxdur.");
    }
    matchedCompany = byHint;

    const exactCompanyId = String(matchedCompany.id ?? "").trim();
    if (!exactCompanyId || exactCompanyId === "undefined" || exactCompanyId === "null") {
      console.error("[issueAuthToken] exactCompanyId boş/etibarsız", { matchedCompany });
      throw new HttpsError("failed-precondition", "companyId tapılmadı");
    }

    const erpRoleClaim = user.role === "admin" ? "admin" : "user";
    const result = await mintTenantToken(exactCompanyId, erpRoleClaim);

    // Background: sync this company's users to /erp_users/{companyId} for client-side isolation.
    // Non-blocking — token is already returned; sync failure does not affect login.
    syncCompanyUsersToIsolatedPath(exactCompanyId, metaData.users || []).catch(() => {});

    return result;
  }
);

export const dailyCreditReminder = onSchedule(
  {
    schedule: "0 6 * * *",   // cron: hər gün 06:00 UTC = 10:00 Bakı (UTC+4)
    timeZone: "UTC",
    region: "europe-west1",
    memory: "256MiB",
  },
  async () => {
    console.log("dailyCreditReminder başladı");

    // Bütün şirkətlərin ID-lərini meta-dan al
    const metaSnap = await db.collection("config").doc("meta").get();
    if (!metaSnap.exists) {
      console.log("Meta tapılmadı.");
      return;
    }
    const metaData = metaSnap.data();
    const companies = metaData.companies || [];

    await Promise.all(
      companies.map(async (c) => {
        try {
          const cid = String(c.id || "").trim();
          if (!cid) return;
          const snap = await db.collection("companies").doc(cid).get();
          if (!snap.exists) return;
          await processCompany(cid, snap.data());
        } catch (err) {
          console.error(`Şirkət ${c.id} xətası:`, err);
        }
      })
    );

    console.log("dailyCreditReminder tamamlandı.");
  }
);
