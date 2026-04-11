// Firebase Cloud Function — Gündəlik Kredit Ödəniş Bildirişi
// Hər gün saat 10:00 (Bakı vaxtı = UTC+4) → UTC 06:00
// Heç bir istifadəci app açmasa belə işləyir.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

  for (const sale of sales) {
    if (sale.returnedAt) continue;
    if (String(sale.saleType || "").toLowerCase() !== "kredit") continue;

    const sched = buildCreditSchedule(sale);
    const custName = sale.customerName || "-";
    const invNo = sale.invNo || invFallback("ST", sale.uid);
    const accName =
      accounts.find((a) => a.uid === Number(sale.paymentAccountId || 1))?.name || "Kassa";

    // İlkin ödəniş — satış günündə
    const saleDateISO = String(sale.date || "").slice(0, 10);
    if (saleDateISO === todayISO && sched.down > 0.000001) {
      const downPaid = Math.min(sched.down, n(sale.paidTotal));
      const downRem = Math.max(0, sched.down - downPaid);
      if (downRem > 0.000001) {
        dueList.push({
          customer: custName, invNo,
          payType: "İlkin ödəniş",
          amount: sched.down, remaining: downRem, account: accName,
        });
      }
    }

    // Aylıq taksitlər
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
