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

export const issueAuthToken = onCall(
  { region: "europe-west1", cors: [/rbsoft\.az$/, /localhost/] },
  async (request) => {
    const { username, password, companyId: companyIdFromClient } = request.data || {};
    if (!username || !password) {
      throw new HttpsError("invalid-argument", "İstifadəçi adı və şifrə tələb olunur.");
    }

    const norm = (s) => String(s || "").trim().toLowerCase();
    const sanitizeUidPart = (s) =>
      String(s || "x")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_{2,}/g, "_")
        .slice(0, 72);

    console.log("[issueAuthToken]", {
      usernameNorm: norm(username),
      companyIdFromClient: companyIdFromClient != null && companyIdFromClient !== "" ? String(companyIdFromClient) : "(yox)",
    });

    // Admin SDK ilə meta oxu (Firestore Rules-u keçir)
    let metaData;
    try {
      const snap = await db.collection("config").doc("meta").get();
      if (!snap.exists) throw new Error("meta yoxdur");
      metaData = snap.data();
    } catch (e) {
      throw new HttpsError("internal", "Sistem konfiqurasiyası oxuna bilmədi.");
    }

    const users = metaData.users || [];
    const companies = metaData.companies || [];
    const unameNorm = String(username).trim().toLowerCase();

    let user = users.find((u) => u.username === username);
    if (!user) user = users.find((u) => String(u.username || "").trim().toLowerCase() === unameNorm);

    if (!user || !user.active) {
      throw new HttpsError("unauthenticated", "İstifadəçi tapılmadı və ya deaktivdir.");
    }

    const hashPass = (p) => createHash("sha256").update(String(p)).digest("hex");
    const inputHash = hashPass(password);
    const stored = String(user.pass || "");
    // Həm hash, həm plain-text yoxla (migration dövrü üçün)
    if (stored !== inputHash && stored !== password) {
      throw new HttpsError("unauthenticated", "Şifrə yanlışdır.");
    }

    // Plain-text şifrə idisə — avtomatik hash-ə çevir
    if (stored === password && stored !== inputHash) {
      user.pass = inputHash;
      try {
        await db.collection("config").doc("meta").set(metaData);
      } catch (_) {}
    }

    const isDev = user.role === "developer";
    const rawId = String(user.companyId || getCompanyIdFromUsernameServer(username) || "");

    // Firestore document ID ilə exact uyğunluq üçün companies array-dən götür
    let matchedCompany = companies.find((c) => norm(c.id) === norm(rawId));
    if (!matchedCompany && !rawId && isDev) matchedCompany = companies[0] || null;

    const hintNorm = norm(companyIdFromClient);
    if (hintNorm) {
      const byHint = companies.find((c) => norm(c.id) === hintNorm);
      if (!byHint) {
        throw new HttpsError("not-found", "Seçilmiş şirkət (companyId) tapılmadı.");
      }
      if (!isDev) {
        if (matchedCompany && norm(matchedCompany.id) !== hintNorm) {
          throw new HttpsError("permission-denied", "Bu şirkət üçün giriş icazəsi yoxdur.");
        }
        matchedCompany = byHint;
      }
    }

    if (!isDev && !matchedCompany) {
      throw new HttpsError("not-found", "Şirkət tapılmadı (companyId boş və ya uyğunsuzdur).");
    }

    // Token claim: tenant üçün real şirkət id; developer üçün sentinel (heç vaxt boş string deyil)
    const exactCompanyId = isDev ? DEVELOPER_COMPANY_SENTINEL : String(matchedCompany?.id || "").trim();
    if (!exactCompanyId) {
      throw new HttpsError("failed-precondition", "companyId token üçün müəyyən edilə bilmədi.");
    }

    const erpKey = sanitizeUidPart(user.uid != null ? String(user.uid) : String(username));
    const compKey = sanitizeUidPart(isDev ? "dev" : exactCompanyId);
    let firebaseUid = `tenant_${compKey}_${erpKey}`;
    if (firebaseUid.length > 128) firebaseUid = firebaseUid.slice(0, 128);

    const tokenRole = isDev ? "developer" : user.role === "admin" ? "admin" : "tenant";
    const claims = {
      erp_session: true,
      role: tokenRole,
      companyId: exactCompanyId,
    };

    // İstifadəçini Firebase Auth-da yarat (yoxdursa)
    try {
      await getAdminAuth().getUser(firebaseUid);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        await getAdminAuth().createUser({ uid: firebaseUid });
      } else {
        throw err;
      }
    }

    await getAdminAuth().setCustomUserClaims(firebaseUid, claims);
    const customToken = await getAdminAuth().createCustomToken(firebaseUid, claims);

    console.log("[issueAuthToken] ok", { firebaseUid, companyId: exactCompanyId, role: claims.role });

    return { token: customToken, companyId: exactCompanyId, firebaseUid };
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
