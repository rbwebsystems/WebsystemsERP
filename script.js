// Bakfon ERP - LocalStorage və ya Firestore (realtime)

const BASE_STORAGE_KEY = "bakfon_erp_v1";
const META_KEY = "bakfon_erp_meta_v1";

const defaultDB = () => ({
  cust: [],
  supp: [],
  prod: [],
  purch: [],
  sales: [],
  staff: [],
  cash: [],
  cashCounts: [],
  dayCloses: [],
  overdueNotes: [],
  accounts: [{ uid: 1, name: "Kassa", type: "cash" }],
  counters: { purchInv: 1, salesInv: 1 },
  expenseCats: [
    { name: "Kommunal", subs: ["İşıq", "Su", "Qaz", "İnternet"] },
    { name: "Ofis", subs: ["Kantselyariya", "Təmir", "İcarə"] },
    { name: "Digər", subs: ["Digər"] },
  ],
  audit: [],
  trash: [],
  settings: { companyName: "Bakfon", companyAddress: "", companyPhone: "", currency: "AZN", currencySymbol: "₼" },
});

const defaultMeta = () => ({ companies: [], users: [], session: null });
let meta = defaultMeta();
let db = defaultDB();

const useFirestore = () => typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG && typeof firebase !== "undefined";
let firestoreUnsubMeta = null;
let firestoreUnsubCompany = null;
let firestoreInitialized = false;
let firestoreAuthReady = false;
let firestoreAuthPromise = null;

function setLoading(text) {
  const el = byId("loadingText");
  const ov = byId("loadingOverlay");
  if (el) el.textContent = text || "Yüklənir...";
  if (ov) ov.classList.toggle("hidden", !text);
}

function initFirestore() {
  if (!useFirestore() || firestoreInitialized) return;
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    // Long polling bəzən WebSocket-dən daha etibarlı sinxron verir (şəbəkə/brauzerə görə)
    firebase.firestore().settings({ experimentalForceLongPolling: true });
    firestoreInitialized = true;
  } catch (e) {
    console.warn("Firebase init xətası:", e);
  }
}

function ensureFirestoreAuth() {
  if (!useFirestore() || !firestoreInitialized) return Promise.resolve(false);
  if (firestoreAuthReady) return Promise.resolve(true);
  if (firestoreAuthPromise) return firestoreAuthPromise;
  if (!firebase.auth) {
    console.warn("Firebase Auth yüklənməyib (firebase-auth-compat.js).");
    return Promise.resolve(false);
  }

  firestoreAuthPromise = new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      firestoreAuthReady = !!ok;
      resolve(!!ok);
    };

    try {
      firebase.auth().onAuthStateChanged(
        (user) => {
          if (user) return finish(true);
          // anonymous sign-in
          firebase
            .auth()
            .signInAnonymously()
            .then(() => finish(true))
            .catch((e) => {
              console.warn("Anon auth xətası:", e);
              finish(false);
            });
        },
        (e) => {
          console.warn("Auth state xətası:", e);
          finish(false);
        }
      );
    } catch (e) {
      console.warn("Auth init xətası:", e);
      finish(false);
    }
  });
  return firestoreAuthPromise;
}

function getMetaRef() {
  if (!firestoreInitialized) return null;
  return firebase.firestore().collection("config").doc("meta");
}

function getCompanyRef(companyId) {
  if (!firestoreInitialized) return null;
  const cid = String(companyId || "").trim() || "default";
  return firebase.firestore().collection("companies").doc(cid);
}

function loadMetaSync() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return defaultMeta();
    return { ...defaultMeta(), ...JSON.parse(raw) };
  } catch {
    return defaultMeta();
  }
}

function loadCompanyDBSync() {
  try {
    const cid = meta?.session?.companyId || meta?.companies?.[0]?.id || "default";
    const raw = localStorage.getItem(companyDBKey(cid));
    if (!raw) return defaultDB();
    return { ...defaultDB(), ...JSON.parse(raw) };
  } catch {
    return defaultDB();
  }
}

async function loadMetaAsync() {
  if (!useFirestore()) return loadMetaSync();
  const ref = getMetaRef();
  if (!ref) return loadMetaSync();
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const remote = { ...defaultMeta(), ...snap.data() };
      // session (login) heç vaxt buluddan götürülmür; hər cihaz öz sessiyasını lokal saxlayır
      return { ...remote, session: loadMetaSync().session || null };
    }
    const local = loadMetaSync();
    if (local && (local.companies?.length || local.users?.length)) {
      const { session, ...rest } = local || {};
      await ref.set(JSON.parse(JSON.stringify({ ...rest, session: null })));
      return local;
    }
  } catch (e) {
    console.warn("Firestore meta oxuma xətası:", e);
  }
  return loadMetaSync();
}

async function loadCompanyDBAsync() {
  if (!useFirestore()) return loadCompanyDBSync();
  const cid = meta?.session?.companyId || meta?.companies?.[0]?.id || "default";
  const ref = getCompanyRef(cid);
  if (!ref) return loadCompanyDBSync();
  try {
    const snap = await ref.get();
    if (snap.exists) return { ...defaultDB(), ...snap.data() };
    const local = loadCompanyDBSync();
    const hasData = local.cust?.length || local.sales?.length || local.staff?.length || local.purch?.length;
    if (hasData) {
      await ref.set(JSON.parse(JSON.stringify(local)));
      return local;
    }
  } catch (e) {
    console.warn("Firestore company oxuma xətası:", e);
  }
  return loadCompanyDBSync();
}

function subscribeRealtime() {
  if (!useFirestore()) return;
  unsubscribeRealtime();
  const metaRef = getMetaRef();
  if (metaRef) {
    firestoreUnsubMeta = metaRef.onSnapshot(
      (snap) => {
        if (snap.exists) {
          const next = { ...defaultMeta(), ...snap.data() };
          meta.companies = next.companies || meta.companies;
          meta.users = next.users || meta.users;
          applyAccessUI();
        }
      },
      (err) => console.warn("Firestore meta listener:", err)
    );
  }
  const cid = meta?.session?.companyId;
  if (cid) {
    const companyRef = getCompanyRef(cid);
    if (companyRef) {
      firestoreUnsubCompany = companyRef.onSnapshot(
        (snap) => {
          if (snap.exists) {
            db = { ...defaultDB(), ...snap.data() };
            renderAll();
            if (Date.now() - lastFirestoreWriteAt > 2000) toast("Məlumat yeniləndi", "ok", 1500);
          }
        },
        (err) => console.warn("Firestore company listener:", err)
      );
    }
  }
}

function unsubscribeRealtime() {
  if (firestoreUnsubMeta) {
    firestoreUnsubMeta();
    firestoreUnsubMeta = null;
  }
  if (firestoreUnsubCompany) {
    firestoreUnsubCompany();
    firestoreUnsubCompany = null;
  }
}

/** Buluddan (Firestore) cari şirkət məlumatını oxuyub ekranı yenilə. silent=true olanda toast göstərilmir (avtomatik yeniləmə üçün). */
async function refreshFromCloud(silent) {
  if (!useFirestore() || !meta?.session?.companyId) {
    if (!silent) toast("Realtime aktiv deyil və ya şirkət seçilməyib", "err", 2500);
    return;
  }
  const cid = meta.session.companyId;
  const ref = getCompanyRef(cid);
  if (!ref) {
    if (!silent) toast("Firestore bağlantısı yoxdur", "err", 2500);
    return;
  }
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      if (!silent) toast("Buluda hələ məlumat yazılmayıb", "ok", 2000);
      return;
    }
    const raw = snap.data();
    let data = {};
    try {
      data = typeof raw === "object" && raw !== null ? JSON.parse(JSON.stringify(raw)) : {};
    } catch (parseErr) {
      console.warn("Məlumat parse xətası:", parseErr);
      data = raw || {};
    }
    db = { ...defaultDB(), ...data };
    ensureAuditTrash();
    renderAll();
    if (!silent) toast("Məlumat buluddan yeniləndi", "ok", 2000);
  } catch (e) {
    console.warn("Buluddan yeniləmə xətası:", e);
    const msg = (e && e.message) ? String(e.message) : "Yeniləmə xətası";
    toast(msg, "err", 4000);
  }
}

const uiState = {
  page: {
    purch: 1,
    sales: 1,
    debts: 1,
    cred: 1,
    cash: 1,
  },
};

function ensureAccounts() {
  if (!db.accounts || !Array.isArray(db.accounts) || db.accounts.length === 0) {
    db.accounts = [{ uid: 1, name: "Kassa", type: "cash" }];
  }
  // ensure unique ids
  if (!db.accounts.some((a) => a.uid === 1)) {
    db.accounts.unshift({ uid: 1, name: "Kassa", type: "cash" });
  }
}

function accountBalance(accountUid) {
  const id = Number(accountUid);
  let bal = 0;
  for (const op of db.cash) {
    if (Number(op.accountId) !== id) continue;
    bal += op.type === "in" ? n(op.amount) : -n(op.amount);
  }
  return bal;
}

function accountOptionsHtml(selectedId) {
  ensureAccounts();
  return db.accounts
    .map((a) => `<option value="${a.uid}" ${String(a.uid) === String(selectedId) ? "selected" : ""}>${escapeHtml(a.name)} (${a.type})</option>`)
    .join("");
}

function fillCashAccountSelect() {
  const sel = byId("cashAccount");
  if (!sel) return;
  ensureAccounts();
  const cur = sel.value || "all";
  sel.innerHTML =
    `<option value="all">Bütün hesablar</option>` +
    db.accounts.map((a) => `<option value="${a.uid}">${escapeHtml(a.name)} (${a.type})</option>`).join("");
  sel.value = cur;
}

function getSelectedCashAccountId() {
  const v = byId("cashAccount")?.value || "all";
  return v === "all" ? null : Number(v);
}

function openAccount(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  ensureAccounts();
  const a = idx !== null ? db.accounts[idx] : { name: "", type: "cash" };
  openModal(`
    <h2>${idx !== null ? "Hesab redaktə" : "Yeni hesab"}</h2>
    <form onsubmit="saveAccount(event, ${idx})">
      <div class="grid-3">
        <input id="acc_name" class="span-2" placeholder="Hesab adı" value="${escapeHtml(a.name || "")}" required>
        <select id="acc_type">
          <option value="cash" ${a.type === "cash" ? "selected" : ""}>kassa</option>
          <option value="bank" ${a.type === "bank" ? "selected" : ""}>bank</option>
          <option value="card" ${a.type === "card" ? "selected" : ""}>kart</option>
        </select>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Yarat"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function renderAccountsManagerTable() {
  const el = byId("mdlAccountsTbl");
  if (!el) return;
  ensureAccounts();
  el.innerHTML = (db.accounts || [])
    .map((a, i) => {
      const bal = accountBalance(a.uid);
      const delDisabled = a.uid === 1 ? "disabled" : "";
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.type)}</td>
        <td>${money(bal)} AZN</td>
        <td class="tbl-actions">
          ${userCanEdit() ? `<button class="icon-btn edit" onclick="closeMdl();openAccount(${i})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
          ${userCanDelete("accounts") ? `<button class="icon-btn delete" onclick="closeMdl();delAccount(${i})" title="Sil" ${delDisabled}><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
}

function openAccountsManager() {
  if (!userCanSection("accounts")) return alert("Hesablar bölməsinə giriş icazəniz yoxdur.");
  openModal(`
    <h2>Hesablar</h2>
    <div class="modal-footer" style="justify-content:space-between; margin-bottom:10px;">
      <div class="muted">Hesab yarat, redaktə et, sil və qalıqlara bax.</div>
      ${userCanEdit() ? `<button class="btn-main" type="button" onclick="closeMdl();openAccount()"><i class="fas fa-plus"></i> Yeni hesab</button>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Ad</th><th>Tip</th><th>Balans</th><th>Əməliyyat</th></tr></thead>
        <tbody id="mdlAccountsTbl"></tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
  renderAccountsManagerTable();
}

function saveAccount(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  ensureAccounts();
  const name = val("acc_name").trim();
  const type = val("acc_type");
  if (!name) return;

  if (idx === null) {
    const uid = genId(db.accounts, 1);
    db.accounts.push({ uid, name, type });
  } else {
    const keepUid = db.accounts[idx].uid;
    // protect built-in Kassa uid=1
    db.accounts[idx] = { uid: keepUid, name, type };
  }
  saveDB();
  renderAccountsManagerTable();
  closeMdl();
}

function delAccount(idx) {
  if (!userCanDelete("accounts")) return alert("Sil icazəsi yoxdur.");
  ensureAccounts();
  const a = db.accounts[idx];
  if (!a) return;
  if (a.uid === 1) return alert("Əsas Kassa silinə bilməz.");
  const used = db.cash.some((c) => Number(c.accountId) === Number(a.uid));
  if (used) return alert("Bu hesabda əməliyyat var, silmək olmaz.");
  appConfirm("Hesab silinsin?").then((ok) => {
    if (!ok) return;
    db.accounts.splice(idx, 1);
    saveDB();
    renderAccountsManagerTable();
  });
}

function companyDBKey(companyId) {
  return `${BASE_STORAGE_KEY}::${String(companyId || "").trim() || "default"}`;
}

function loadCompanyDB() {
  try {
    const cid = meta?.session?.companyId || meta?.companies?.[0]?.id || "default";
    const raw = localStorage.getItem(companyDBKey(cid));
    if (!raw) return defaultDB();
    const parsed = JSON.parse(raw);
    return { ...defaultDB(), ...parsed };
  } catch {
    return defaultDB();
  }
}

function saveCompanyDB() {
  const cid = meta?.session?.companyId || meta?.companies?.[0]?.id || "default";
  if (useFirestore()) {
    lastFirestoreWriteAt = Date.now();
    const ref = getCompanyRef(cid);
    if (ref) {
      const data = JSON.parse(JSON.stringify(db));
      ref.set(data).catch((e) => console.warn("Firestore company yazma xətası:", e));
    }
  } else {
    localStorage.setItem(companyDBKey(cid), JSON.stringify(db));
  }
}

let lastSavedAt = 0;
let lastSavedToastAt = 0;
let lastFirestoreWriteAt = 0;
function updateLastSavedEl() {
  const el = byId("lastSavedEl");
  if (!el) return;
  lastSavedAt = Date.now();
  const d = new Date();
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
  el.textContent = "Saxlanıldı " + t;
  el.classList.add("saved-flash");
  setTimeout(() => el.classList.remove("saved-flash"), 1800);
  if (lastSavedAt - lastSavedToastAt > 2500) {
    lastSavedToastAt = lastSavedAt;
    toast("Məlumat avtomatik saxlanıldı", "ok", 1500);
  }
}

function saveDB() {
  ensureAuditTrash();
  saveCompanyDB();
  updateLastSavedEl();
  renderAll();
}

function logEvent(action, target, details = {}) {
  ensureAuditTrash();
  const u = currentUser();
  db.audit.push({
    uid: genId(db.audit, 1),
    ts: nowISODateTimeLocal(),
    user: userDisplay(u),
    action,
    target,
    details,
  });
  if (db.audit.length > 5000) db.audit = db.audit.slice(db.audit.length - 5000);
}

function auditExplain(a) {
  if (!a) return "-";
  const act = String(a.action || "");
  const tgt = String(a.target || "");
  const d = a.details && typeof a.details === "object" ? a.details : {};

  const verbAz =
    act === "create" ? "yaratdı" :
    act === "update" ? "yenilədi" :
    act === "delete" ? "sildi" :
    act === "restore" ? "bərpa etdi" :
    act === "export" ? "export etdi" :
    act === "import" ? "import etdi" :
    act === "reset" ? "sıfırladı" :
    act === "recalc" ? "yenidən hesabladı" :
    act;

  const targetAz =
    tgt === "sales" ? "satış" :
    tgt === "purch" ? "alış" :
    tgt === "cash" ? "kassa əməliyyatı" :
    tgt === "cust" ? "müştəri" :
    tgt === "supp" ? "təchizatçı" :
    tgt === "prod" ? "məhsul" :
    tgt === "staff" ? "əməkdaş" :
    tgt === "accounts" ? "hesab" :
    tgt === "users" ? "istifadəçi" :
    tgt === "company" ? "şirkət" :
    tgt === "settings" ? "ayarlar" :
    tgt === "tools" ? "alətlər" :
    tgt === "trash" ? "səbət" :
    tgt;

  const uid = d.uid ?? d.saleUid ?? d.purchUid ?? d.customerId ?? d.accountId ?? d.transferId ?? null;
  const inv = d.invNo || d.inv || null;
  const amount = d.amount != null ? `${money(d.amount)} AZN` : null;
  const extraBits = [];
  if (inv) extraBits.push(`Qaimə: ${inv}`);
  if (uid != null && uid !== "") extraBits.push(`ID: ${uid}`);
  if (amount) extraBits.push(`Məbləğ: ${amount}`);
  if (d.kind) extraBits.push(`Növ: ${d.kind}`);

  const base = `${verbAz} (${targetAz || "-"})`;
  return extraBits.length ? `${base} • ${extraBits.join(" • ")}` : base;
}

function productMetaByName(name) {
  const nm = String(name || "").trim().toLowerCase();
  if (!nm) return { cat: "", subCat: "" };
  const p = (db.prod || []).find((x) => String(x.name || "").trim().toLowerCase() === nm);
  return { cat: String(p?.cat || "").trim(), subCat: String(p?.subCat || "").trim() };
}

function stockFillCatOptions() {
  const catEl = byId("stockCat");
  const subEl = byId("stockSubcat");
  if (!catEl || !subEl) return;
  const cats = new Map(); // cat -> Set(subs)
  for (const pr of db.prod || []) {
    const c = String(pr.cat || "").trim();
    const s = String(pr.subCat || "").trim();
    if (!c) continue;
    if (!cats.has(c)) cats.set(c, new Set());
    if (s) cats.get(c).add(s);
  }
  const catList = Array.from(cats.keys()).sort((a, b) => a.localeCompare(b));
  const curCat = String(catEl.value || "");
  catEl.innerHTML =
    `<option value="">Kateqoriya (hamısı)</option>` +
    catList.map((c) => `<option value="${escapeAttr(c)}" ${c === curCat ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  if (!catEl.value) {
    subEl.innerHTML = `<option value="">Alt kateqoriya (hamısı)</option>`;
  } else {
    const subs = Array.from(cats.get(catEl.value) || []).sort((a, b) => a.localeCompare(b));
    const curSub = String(subEl.value || "");
    subEl.innerHTML =
      `<option value="">Alt kateqoriya (hamısı)</option>` +
      subs.map((s) => `<option value="${escapeAttr(s)}" ${s === curSub ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
  }
}

function onStockCatChange() {
  const subEl = byId("stockSubcat");
  if (subEl) subEl.value = "";
  stockFillCatOptions();
  renderAll();
}

function setDebtsStatus(status) {
  const st = String(status || "all");
  const input = byId("debtsStatus");
  if (input) input.value = st;
  renderAll();
}

function setOverdueView(status) {
  const input = byId("overdueView");
  if (input) input.value = status;
  renderAll();
}

function showDebtSub(sectionId) {
  if (!sectionId) {
    updateDebtSubSelectVisibility("");
    updateDebtSubEnabled();
    updateDebtSectionVisibility();
    return;
  }
  const debtNav = Array.from(document.querySelectorAll(".nav-link")).find((el) => el.getAttribute("onclick")?.includes("showSec('debts'"));
  showSec(sectionId, debtNav || null);
  document.querySelectorAll(".debt-type-select").forEach((s) => {
    s.value = sectionId;
  });
  updateDebtSubSelectVisibility(sectionId);
  updateDebtSubEnabled();
  updateDebtSectionVisibility();
  renderAll();
}

function updateDebtSubSelectVisibility(sectionId) {
  document.querySelectorAll(".debt-sub-select").forEach((el) => {
    el.style.display = "";
  });
}

function updateDebtSubEnabled() {
  const activeType = document.querySelector(".debt-type-select")?.value || "";
  document.querySelectorAll(".debt-sub-select").forEach((el) => {
    const forSec = el.getAttribute("data-debt-sub-for") || "";
    const enabled = !!activeType && activeType === forSec;
    el.disabled = !enabled;
    if (!enabled) el.value = "";
  });
}

function updateDebtSectionVisibility() {
  const activeSec =
    byId("debts")?.classList.contains("active") ? "debts" :
    byId("creditor")?.classList.contains("active") ? "creditor" :
    byId("overdue")?.classList.contains("active") ? "overdue" :
    "";
  const activeType = document.querySelector(".debt-type-select")?.value || "";
  const showDebts = activeSec === "debts" && activeType === "debts" && !!(byId("debtsStatus")?.value || "");
  const showCred = activeSec === "creditor" && activeType === "creditor" && !!(byId("credStatus")?.value || "");
  const showOver = activeSec === "overdue" && activeType === "overdue" && !!(byId("overdueView")?.value || "");
  const d = byId("debtsContent"); if (d) d.style.display = showDebts ? "" : "none";
  const c = byId("creditorContent"); if (c) c.style.display = showCred ? "" : "none";
  const o = byId("overdueContent"); if (o) o.style.display = showOver ? "" : "none";
}

function onDebtTypeChange(sel) {
  const sectionId = String(sel?.value || "");
  if (byId("debtsStatus")) byId("debtsStatus").value = "";
  if (byId("credStatus")) byId("credStatus").value = "";
  if (byId("overdueView")) byId("overdueView").value = "";
  showDebtSub(sectionId);
}

function seedDevTestData() {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  if (!isTestCompany()) return alert("Bu funksiya yalnız test şirkətində aktivdir.");
  appConfirm(
    "DevTest test bazası yüklənsin?\n\nDiqqət: Cari şirkətin datası tam dəyişəcək (demo data ilə əvəz olunacaq).",
    "Test baza"
  ).then((ok) => {
    if (!ok) return;
    ensureAuditTrash();

    const now = nowISODateTimeLocal();
    const daysAgo = (nDays) => {
      const d = new Date();
      d.setDate(d.getDate() - nDays);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}T10:00`;
    };

    db = defaultDB();
    ensureAuditTrash();
    ensureAccounts();
    ensureCounters();

    // accounts
    db.accounts = [
      { uid: 1, name: "Kassa", type: "cash" },
      { uid: 2, name: "Bank", type: "bank" },
      { uid: 3, name: "POS", type: "pos" },
    ];

    // staff
    db.staff = [
      { uid: 1, createdAt: now, name: "Rüstəm Bayramov", role: "Menecer", phone: "0500000000", baseSalary: "800", commPct: "2" },
      { uid: 2, createdAt: now, name: "Aysel Əliyeva", role: "Satış", phone: "0510000000", baseSalary: "600", commPct: "3" },
      { uid: 3, createdAt: now, name: "Elvin Məmmədov", role: "Kassir", phone: "0700000000", baseSalary: "550", commPct: "0" },
    ];

    // suppliers
    db.supp = [
      { uid: 1000, createdAt: now, co: "Smart Distribyutor MMC", per: "Nihat", mob: "0551111111", voen: "1234567890" },
      { uid: 1001, createdAt: now, co: "Telefon Center", per: "Kamran", mob: "0502222222", voen: "0987654321" },
    ];

    // products (with categories/subcategories)
    db.prod = [
      { uid: 1, createdAt: now, name: "iPhone 15 Pro Max 256", cat: "Telefon", subCat: "iPhone" },
      { uid: 2, createdAt: now, name: "Samsung S24 Ultra 256", cat: "Telefon", subCat: "Samsung" },
      { uid: 3, createdAt: now, name: "AirPods Pro 2", cat: "Aksesuar", subCat: "AirPods" },
      { uid: 4, createdAt: now, name: "Adapter Type-C 20W", cat: "Aksesuar", subCat: "Adapter" },
    ];

    // customers
    db.cust = [
      { uid: 1, createdAt: now, sur: "Həsənov", name: "Rəşad", father: "Eldar", fin: "A1B2C3D", seriaNum: "AZE1234567", ph1: "0503333333", ph2: "", ph3: "", work: "Ofis", addr: "Bakı", zam: "" , creditLimit: "3000"},
      { uid: 2, createdAt: now, sur: "Quliyeva", name: "Günay", father: "Ramil", fin: "Q9W8E7R", seriaNum: "AZE7654321", ph1: "0514444444", ph2: "", ph3: "", work: "Mağaza", addr: "Sumqayıt", zam: "", creditLimit: "1500" },
      { uid: 3, createdAt: now, sur: "Əliyev", name: "Murad", father: "Namiq", fin: "M3N4B5V", seriaNum: "AA123456", ph1: "0705555555", ph2: "", ph3: "", work: "", addr: "Xırdalan", zam: "" , creditLimit: "0"},
    ];

    // purchases: 2 serial phones + 2 bulk lots
    db.purch = [
      {
        uid: 1,
        invNo: "AL-001",
        date: daysAgo(25),
        supp: db.supp[0].co,
        name: db.prod[0].name,
        code: "",
        qty: 1,
        imei1: "356111111111111",
        imei2: "",
        seria: "",
        amount: "3200",
        unitPrice: "",
        payType: "nagd",
        paidTotal: "1200",
        employeeId: 1,
        paymentAccountId: 2,
      },
      {
        uid: 2,
        invNo: "AL-002",
        date: daysAgo(20),
        supp: db.supp[1].co,
        name: db.prod[1].name,
        code: "",
        qty: 1,
        imei1: "356222222222222",
        imei2: "",
        seria: "",
        amount: "2800",
        unitPrice: "",
        payType: "kocurme",
        paidTotal: "2800",
        employeeId: 1,
        paymentAccountId: 2,
      },
      {
        uid: 3,
        invNo: "AL-003",
        date: daysAgo(15),
        supp: db.supp[0].co,
        name: db.prod[3].name,
        code: "ADP-20W",
        qty: 20,
        imei1: "",
        imei2: "",
        seria: "",
        amount: String(20 * 9),
        unitPrice: "9",
        payType: "nagd",
        paidTotal: String(20 * 9),
        employeeId: 3,
        paymentAccountId: 1,
      },
      {
        uid: 4,
        invNo: "AL-004",
        date: daysAgo(8),
        supp: db.supp[0].co,
        name: db.prod[3].name,
        code: "ADP-20W",
        qty: 10,
        imei1: "",
        imei2: "",
        seria: "",
        amount: String(10 * 8.5),
        unitPrice: "8.5",
        payType: "nagd",
        paidTotal: "0",
        employeeId: 3,
        paymentAccountId: 1,
      },
      {
        uid: 5,
        invNo: "AL-005",
        date: daysAgo(6),
        supp: db.supp[1].co,
        name: db.prod[2].name,
        code: "APP2",
        qty: 8,
        imei1: "",
        imei2: "",
        seria: "",
        amount: String(8 * 140),
        unitPrice: "140",
        payType: "kredit",
        paidTotal: String(4 * 140),
        employeeId: 1,
        paymentAccountId: 2,
      },
    ];

    // sales: one cash sale, one credit sale, one bulk FIFO-like sale
    db.sales = [
      {
        uid: 1,
        invNo: "ST-001",
        date: daysAgo(18),
        saleType: "nagd",
        customerId: 3,
        customerName: "Əliyev Murad Namiq",
        employeeId: 2,
        employeeName: "Aysel Əliyeva",
        productName: db.purch[1].name,
        code: "",
        qty: 1,
        bulkPurchUid: null,
        bulkAllocations: null,
        imei1: db.purch[1].imei1,
        imei2: "",
        seria: "",
        amount: "3300",
        unitPrice: "",
        itemKey: itemKeyFromPurch(db.purch[1]),
        payments: [{ uid: 1, date: daysAgo(18), amount: 3300, source: "sale_info" }],
        paidTotal: "3300",
        credit: null,
        paymentAccountId: 1,
        lastPayAmount: 3300,
      },
      {
        uid: 2,
        invNo: "ST-002",
        date: daysAgo(10),
        saleType: "kredit",
        customerId: 1,
        customerName: "Həsənov Rəşad Eldar",
        employeeId: 2,
        employeeName: "Aysel Əliyeva",
        productName: db.purch[0].name,
        code: "",
        qty: 1,
        bulkPurchUid: null,
        bulkAllocations: null,
        imei1: db.purch[0].imei1,
        imei2: "",
        seria: "",
        amount: "3800",
        unitPrice: "",
        itemKey: itemKeyFromPurch(db.purch[0]),
        payments: [{ uid: 1, date: daysAgo(10), amount: 800, source: "down" }],
        paidTotal: "800",
        credit: { termMonths: 6, downPayment: 800, monthlyPayment: (3800 - 800) / 6 },
        paymentAccountId: 1,
        lastPayAmount: 800,
      },
      {
        uid: 3,
        invNo: "ST-003",
        date: daysAgo(3),
        saleType: "nagd",
        customerId: 2,
        customerName: "Quliyeva Günay Ramil",
        employeeId: 3,
        employeeName: "Elvin Məmmədov",
        productName: db.prod[3].name,
        code: "ADP-20W",
        qty: 7,
        bulkPurchUid: null,
        bulkAllocations: [{ purchUid: 3, qty: 7 }],
        imei1: "",
        imei2: "",
        seria: "",
        amount: String(7 * 15),
        unitPrice: "15",
        itemKey: "FIFO:ADP-20W",
        payments: [{ uid: 1, date: daysAgo(3), amount: 105, source: "sale_info" }],
        paidTotal: "105",
        credit: null,
        paymentAccountId: 1,
        lastPayAmount: 105,
      },
    ];

    // cash ops to reflect payments (simple)
    db.cash = [
      { uid: 1, type: "in", date: daysAgo(18), source: "Satış ödənişi (test)", amount: "3300", note: "ST-001", link: { kind: "sale", saleUid: 1 }, meta: { customerId: 3 }, accountId: 1 },
      { uid: 2, type: "in", date: daysAgo(10), source: "Debitor ödəniş (test)", amount: "800", note: "ST-002 down", link: { kind: "sale", saleUid: 2 }, meta: { customerId: 1, payKind: "down" }, accountId: 1 },
      { uid: 3, type: "in", date: daysAgo(3), source: "Satış ödənişi (test)", amount: "105", note: "ST-003", link: { kind: "sale", saleUid: 3 }, meta: { customerId: 2 }, accountId: 1 },
      { uid: 4, type: "out", date: daysAgo(15), source: "Alış ödənişi (test)", amount: String(20 * 9), note: "AL-003", link: { kind: "purch_payment", purchUid: 3 }, meta: { purchUid: 3 }, accountId: 1 },
    ];

    // counters
    db.counters = { purchInv: 6, salesInv: 4 };

    logEvent("reset", "company", { companyId: meta?.session?.companyId || "devtest", seeded: true });
    saveDB();
    toast("Test baza yükləndi", "ok", 2000);
  });
}

function ensureOverdueTestPack() {
  const cid = String(meta?.session?.companyId || "").toLowerCase();
  if (cid !== "devtest") return;
  ensureAuditTrash();
  if (!db.settings) db.settings = defaultDB().settings;
  if (db.settings.__overdueTestPackV1) return;

  const lateDaysList = [2, 6, 11, 19, 28, 37, 52, 67, 89, 121];
  const today = new Date();
  const guarantorUid = (db.cust && db.cust[0] ? db.cust[0].uid : null);

  for (let i = 0; i < lateDaysList.length; i++) {
    const lateDays = lateDaysList[i];
    const due = new Date(today);
    due.setHours(10, 0, 0, 0);
    due.setDate(due.getDate() - lateDays);
    const dueISO = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
    const saleDateISO = addMonthsISO(dueISO, -1) + "T10:00";

    const custUid = genId(db.cust, 1);
    const saleUid = genId(db.sales, 1);
    const invNo = nextInvNo("sales");

    const amount = 1200 + i * 140;
    const down = 200 + (i % 3) * 50;
    const termMonths = 6;
    const monthly = (amount - down) / termMonths;
    const extraMonthlyPaid = i % 2 === 0 ? 0 : 1;
    const paidTotal = Math.min(amount, down + extraMonthlyPaid * monthly);

    const sur = `Test${i + 1}`;
    const name = `Gecikmə`;
    const father = `Müştəri`;
    db.cust.push({
      uid: custUid,
      createdAt: nowISODateTimeLocal(),
      sur,
      name,
      father,
      fin: `TST${String(1000 + i)}`,
      seriaNum: `AZE${String(100000 + i)}`,
      ph1: `0500000${String(100 + i)}`,
      ph2: "",
      ph3: "",
      work: "Test",
      addr: "Bakı",
      zam: guarantorUid || "",
      creditLimit: "0",
    });

    const emp = db.staff && db.staff.length ? db.staff[i % db.staff.length] : { uid: "", name: "-" };
    db.sales.push({
      uid: saleUid,
      invNo,
      date: saleDateISO,
      saleType: "kredit",
      customerId: custUid,
      customerName: `${sur} ${name} ${father}`,
      employeeId: emp.uid || "",
      employeeName: emp.name || "-",
      productName: `Test Məhsul ${i + 1}`,
      code: `TST-P${i + 1}`,
      qty: 1,
      bulkPurchUid: null,
      bulkAllocations: null,
      imei1: "",
      imei2: "",
      seria: "",
      amount: String(amount),
      unitPrice: "",
      itemKey: `TEST-OVD-${saleUid}`,
      payments: paidTotal > 0 ? [{ uid: 1, date: saleDateISO, amount: paidTotal, source: "down" }] : [],
      paidTotal: String(paidTotal),
      credit: { termMonths, downPayment: down, monthlyPayment: monthly },
      paymentAccountId: 1,
      lastPayAmount: paidTotal,
    });
  }

  db.settings.__overdueTestPackV1 = true;
  logEvent("create", "tools", { kind: "overdue_test_pack", count: 10 });
  saveCompanyDB();
}

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return { companies: [], users: [], session: null };
    const parsed = JSON.parse(raw);
    return { companies: [], users: [], session: null, ...parsed };
  } catch {
    return { companies: [], users: [], session: null };
  }
}

function saveMeta() {
  if (useFirestore()) {
    const ref = getMetaRef();
    if (ref) {
      const { session, ...rest } = meta || {};
      const data = JSON.parse(JSON.stringify({ ...rest, session: null }));
      ref.set(data).catch((e) => console.warn("Firestore meta yazma xətası:", e));
    }
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } else {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }
  updateLastSavedEl();
}

function ensureMetaDefaults() {
  if (!meta.companies || !Array.isArray(meta.companies)) meta.companies = [];
  if (!meta.users || !Array.isArray(meta.users)) meta.users = [];

  if (meta.companies.length === 0) {
    meta.companies.push({ id: "bakfon", name: "Bakfon" });
  }
  const devIdx = meta.users.findIndex((u) => u.username === "developer");
  if (devIdx === -1) {
    meta.users.push({
      uid: 1,
      username: "developer",
      pass: "developer",
      fullName: "Developer",
      role: "developer",
      active: true,
      companyId: null,
      perms: { sections: ["*"] },
      createdAt: nowISODateTimeLocal(),
    });
  } else {
    const u = meta.users[devIdx];
    if (!u.uid) u.uid = 1;
    u.role = "developer";
    u.active = true;
    u.companyId = null;
    if (!u.perms) u.perms = { sections: ["*"] };
    if (!Array.isArray(u.perms.sections) || u.perms.sections.length === 0) u.perms.sections = ["*"];
    if (!u.perms.sections.includes("*")) u.perms.sections.unshift("*");
    if (!u.pass) u.pass = "developer";
    if (!u.fullName) u.fullName = "Developer";
    if (!u.createdAt) u.createdAt = nowISODateTimeLocal();
  }
  meta.users.forEach((u) => {
    if (u.role !== "developer" && (u.companyId == null || u.companyId === "")) {
      u.companyId = getCompanyIdFromUsername(u.username) || meta.companies[0]?.id || null;
    }
  });
  if (!meta.session || !meta.session.companyId) {
    meta.session = null;
  }
  saveMeta();
}

function currentUser() {
  const uid = meta?.session?.userUid;
  return meta.users.find((u) => Number(u.uid) === Number(uid)) || null;
}

function userDisplay(u) {
  if (!u) return "-";
  const un = String(u.username || "").trim();
  const staffUid = u.staffUid != null && u.staffUid !== "" ? String(u.staffUid) : null;
  if (staffUid && db.staff && db.staff.length) {
    const staff = db.staff.find((s) => String(s.uid) === staffUid);
    if (staff && staff.name) return `${staff.name} (${un})`;
  }
  const fn = String(u.fullName || "").trim();
  if (fn && un) return `${fn} (${un})`;
  return fn || un || "-";
}

function currentActorName() {
  return userDisplay(currentUser()) || "-";
}

function operationActorName(rec, fallback = "-") {
  if (rec && String(rec.actor || "").trim()) return String(rec.actor).trim();
  if (rec && String(rec.actorName || "").trim()) return String(rec.actorName).trim();
  return fallback || "-";
}

function initHeaderCompactSearch() {
  const boxes = Array.from(document.querySelectorAll(".header-actions .search-container"));
  boxes.forEach((box) => {
    if (!box || box.dataset.compactInit === "1") return;
    const input = box.querySelector("input[type='text']");
    const btn = box.querySelector(".search-btn");
    if (!input || !btn) return;
    box.dataset.compactInit = "1";
    box.classList.add("search-collapsible");

    const open = () => box.classList.add("open");
    const closeIfEmpty = () => {
      if (String(input.value || "").trim()) return;
      box.classList.remove("open");
    };

    btn.addEventListener("click", () => {
      if (!box.classList.contains("open")) {
        open();
        input.focus();
        return;
      }
      if (document.activeElement !== input) input.focus();
    });

    input.addEventListener("focus", open);
    input.addEventListener("blur", () => setTimeout(closeIfEmpty, 120));
    if (String(input.value || "").trim()) open();
  });
}

function isDeveloper() {
  const u = currentUser();
  return !!u && u.role === "developer";
}

function isAdmin() {
  const u = currentUser();
  return !!u && u.role === "admin";
}

/**
 * Test şirkətinə aid olan hər şeyi yalnız orada göstərmək üçün.
 * Yeni düymə/funksiya əlavə edəndə bu yoxlamadan istifadə edin – digər şirkətlər görməz və təsirlənməz.
 * Nümunə: if (isTestCompany()) { ... düymə və ya HTML ... }
 * Test şirkətin ID-si "test" olmalıdır (Şirkətlər bölməsində).
 */
function isTestCompany() {
  const cid = (meta?.session?.companyId || "").toLowerCase();
  return cid === "test" || cid === "devtest";
}

/** Yalnız admin və developer təsisçi/sahibkar mədaxili edə bilər; adi userlər bu seçimi görməz. */
function userCanOwnerIncome() {
  return isDeveloper() || isAdmin();
}

function userCanSection(sectionId) {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (!companyAllowsSection(sectionId) && !isDeveloper()) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const secs = u.perms?.sections || [];
  return secs.includes("*") || secs.includes(sectionId);
}

function companyAllowsSection(sectionId) {
  const cid = meta?.session?.companyId;
  if (!cid) return true;
  const c = (meta.companies || []).find((x) => x.id === cid);
  if (!c) return true;
  const secs = c.sections;
  if (!Array.isArray(secs) || secs.length === 0) return true;
  return secs.includes(sectionId);
}

function userCanAction(action, sectionId = "*") {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const acts = u.perms?.actions || {};
  const key = `${sectionId}.${action}`;
  const anyKey = `*.${action}`;
  if (Object.prototype.hasOwnProperty.call(acts, key)) return !!acts[key];
  if (Object.prototype.hasOwnProperty.call(acts, anyKey)) return !!acts[anyKey];
  return null; // fallback to legacy flags
}

function userCanEdit(sectionId = "*") {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("edit", sectionId);
  if (act !== null) return act;
  return !!u.perms?.canEdit;
}

function userCanDelete(sectionId = "*") {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("delete", sectionId);
  if (act !== null) return act;
  return !!u.perms?.canDelete;
}

function userCanPay(sectionId = "*") {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("pay", sectionId);
  if (act !== null) return act;
  return !!u.perms?.canPay;
}

function userCanRefund(sectionId = "*") {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("refund", sectionId);
  if (act !== null) return act;
  return !!u.perms?.canRefund;
}

function userCanExport() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("export", "*");
  if (act !== null) return act;
  return !!u.perms?.canExport;
}

function userCanImport() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("import", "*");
  if (act !== null) return act;
  return !!u.perms?.canImport;
}

function userCanReset() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  const act = userCanAction("reset", "*");
  if (act !== null) return act;
  return !!u.perms?.canReset;
}

function toast(msg, kind = "ok", ms = 2600) {
  const wrap = byId("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${kind} small`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity .2s ease, transform .2s ease";
  }, Math.max(200, ms - 250));
  setTimeout(() => el.remove(), ms);
}

function openAuditDetails(uid) {
  const a = (db.audit || []).find((x) => Number(x.uid) === Number(uid));
  if (!a) return;
  const explain = auditExplain(a);
  let detailsText = "";
  try {
    detailsText = JSON.stringify(a.details ?? {}, null, 2);
  } catch (e) {
    try {
      detailsText = String(a.details ?? "");
    } catch {
      detailsText = "";
    }
  }
  const hasDetails =
    detailsText.trim() !== "" &&
    detailsText.trim() !== "{}" &&
    detailsText.trim() !== "null" &&
    detailsText.trim() !== "undefined";
  let rawText = "";
  try {
    rawText = JSON.stringify(a ?? {}, null, 2);
  } catch (e) {
    try {
      rawText = String(a ?? "");
    } catch {
      rawText = "";
    }
  }
  openModal(`
    <h2>Audit detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(a.ts)}</div></div>
      <div class="info-row"><div class="info-label">İstifadəçi</div><div class="info-value">${escapeHtml(a.user || "-")}</div></div>
      <div class="info-row"><div class="info-label">Əməliyyat</div><div class="info-value">${escapeHtml(a.action || "-")}</div></div>
      <div class="info-row"><div class="info-label">Hədəf</div><div class="info-value">${escapeHtml(a.target || "-")}</div></div>
      <div class="info-row"><div class="info-label">Açıqlama</div><div class="info-value">${escapeHtml(explain)}</div></div>
    </div>
    <div class="card" style="padding:0;">
      ${hasDetails ? "" : `<div class="muted" style="padding:12px 14px;">Bu əməliyyat üçün detallı məlumat yazılmayıb.</div>`}
      <pre style="margin:0;padding:14px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(detailsText || "{}")}</pre>
      <div class="muted" style="padding:10px 14px;border-top:1px solid rgba(0,0,0,.06);">Raw</div>
      <pre style="margin:0;padding:14px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(rawText || "{}")}</pre>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function applyAccessUI() {
  const dev = isDeveloper();
  const admin = isAdmin();
  document.querySelectorAll(".dev-only").forEach((el) => {
    if (el.id === "devMenu") el.style.display = dev ? (el.style.display === "flex" ? "flex" : "none") : "none";
    else el.style.display = dev ? "flex" : "none";
  });
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.style.display = (admin || dev) ? "flex" : "none";
  });

  // Hide sections the user can't access (nav links)
  document.querySelectorAll(".nav-link").forEach((el) => {
    const on = el.getAttribute("onclick") || "";
    const m = on.match(/showSec\('([^']+)'/);
    if (!m) return;
    const secId = m[1];
    if (el.classList.contains("dev-only") || el.classList.contains("admin-only")) return;
    el.style.display = userCanSection(secId) ? "flex" : "none";
  });

  // Realtime / Cloud sync indicator (yalnız ikon, kliklə buluddan yenilə)
  const realtimeEl = byId("realtimeIndicator");
  if (realtimeEl) {
    if (useFirestore() && meta?.session?.companyId) {
      realtimeEl.innerHTML = "<i class=\"fas fa-cloud\"></i>";
      realtimeEl.classList.remove("hidden");
      realtimeEl.title = "Realtime sinxron. Kliklə buluddan yenilə.";
      realtimeEl.style.cursor = "pointer";
      realtimeEl.onclick = () => refreshFromCloud();
    } else {
      realtimeEl.classList.add("hidden");
      realtimeEl.onclick = null;
    }
  }
}

function toggleDevMenu() {
  const menu = byId("devMenu");
  if (!menu) return;
  const open = menu.style.display !== "none";
  menu.style.display = open ? "none" : "flex";
}

function sectionLabelAz(id) {
  const map = {
    dash: "Dashboard",
    cust: "Müştərilər",
    supp: "Təchizatçılar",
    prod: "Məhsullar",
    purch: "Alışlar",
    stock: "Anbar",
    sales: "Satışlar",
    staff: "Əməkdaşlar",
    debts: "Borclar - Debitor",
    overdue: "Borclar - Kreditlər",
    creditor: "Borclar - Kreditor",
    cash: "Kassa",
    accounts: "Hesablar",
    audit: "Audit",
    trash: "Səbət",
    tools: "Alətlər",
    reports: "Hesabatlar",
    profile: "Profil",
  };
  return map[id] || id;
}

function showLoginOverlay(show) {
  const ov = byId("loginOverlay");
  const landing = byId("publicLanding");
  if (!ov) return;
  ov.style.display = "none";
  if (landing) landing.style.display = show ? "flex" : "none";
  document.body.classList.toggle("login-open", !!show);
  if (show) prepareLoginForm();
}

function prepareLoginForm() {
  const sel = byId("loginCompany");
  if (sel) {
    sel.innerHTML = meta.companies.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.id)})</option>`).join("");
    const fromUrl = window.__loginCompanyFromUrl;
    if (fromUrl && meta.companies.some((c) => c.id === fromUrl)) sel.value = fromUrl;
  }
  const hint = byId("loginHint");
  if (hint) hint.innerText = window.__loginCompanyFromUrl ? "Link ünvanı ilə giriş." : "Keçid ünvanında ?company=ŞİRKƏT_ID olmalıdır.";
  const uEl = byId("loginUser");
  const remEl = byId("loginRemember");
  const saved = (() => {
    try {
      return localStorage.getItem("loginRememberUsername");
    } catch {
      return null;
    }
  })();
  if (uEl && saved) uEl.value = saved;
  if (remEl) remEl.checked = !!saved;
}

function toggleLoginPassword() {
  const inp = byId("loginPass");
  const btn = byId("loginPassToggle");
  if (!inp || !btn) return;
  const icon = btn.querySelector("i");
  if (inp.type === "password") {
    inp.type = "text";
    if (icon) icon.className = "fas fa-eye-slash";
    btn.setAttribute("aria-label", "Şifrəni gizlət");
  } else {
    inp.type = "password";
    if (icon) icon.className = "fas fa-eye";
    btn.setAttribute("aria-label", "Şifrəni göstər");
  }
}

function openLoginModal() {
  const ov = byId("loginOverlay");
  if (!ov) return;
  prepareLoginForm();
  ov.style.display = "flex";
  document.body.classList.add("landing-login-open");
  closeLpMenu();
  setTimeout(() => byId("loginUser")?.focus(), 0);
}

function closeLoginModal() {
  const ov = byId("loginOverlay");
  if (!ov) return;
  ov.style.display = "none";
  document.body.classList.remove("landing-login-open");
}

function setupLandingPage() {
  const nav = byId("lpNav");
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle("lp-nav-scrolled", window.scrollY > 20);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  initLpHeroTypewriter();
}

/** Ana səhifə hero: çap maşını tipli mətn (reduced-motion-da statik). */
function initLpHeroTypewriter() {
  const landing = byId("publicLanding");
  const titleHost = byId("lpTypeTitle");
  const leadHost = byId("lpTypeLead");
  const cTitle = byId("lpTypeTitleCursor");
  const cLead = byId("lpTypeLeadCursor");
  if (!landing || !titleHost || !leadHost) return;

  const titleP1 = "Müəssisənizi ";
  const titleAccent = "Ağıllı";
  const titleP2 = " idarə edin.";
  const lead =
    "RBSoft ilə maliyyə, anbar, satış və insan resurslarını tək platformadan izləyin. Biznesiniz üçün minimalist və effektiv həll.";

  function landingVisible() {
    try {
      if (window.getComputedStyle(landing).display === "none") return false;
      return true;
    } catch {
      return false;
    }
  }

  function applyStatic() {
    titleHost.innerHTML =
      titleP1 + '<span class="lp-hero-accent">' + titleAccent + "</span>" + titleP2;
    leadHost.textContent = lead;
    if (cTitle) cTitle.classList.add("is-done");
    if (cLead) cLead.classList.add("is-done");
  }

  if (!landingVisible()) {
    applyStatic();
    return;
  }

  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyStatic();
      return;
    }
  } catch {
    applyStatic();
    return;
  }

  if (titleHost.getAttribute("data-lp-typed") === "1") return;
  titleHost.textContent = "";
  leadHost.textContent = "";
  if (cTitle) cTitle.classList.remove("is-done");
  if (cLead) cLead.classList.add("is-done");

  const p1Len = titleP1.length;
  const acLen = titleAccent.length;
  const p2Len = titleP2.length;
  const titleTotal = p1Len + acLen + p2Len;
  let idx = 0;
  const msTitle = 32;
  const msLead = 14;

  function tickTitle() {
    if (!landingVisible()) {
      applyStatic();
      return;
    }
    idx += 1;
    if (idx <= p1Len) {
      titleHost.textContent = titleP1.slice(0, idx);
    } else if (idx <= p1Len + acLen) {
      const a = titleAccent.slice(0, idx - p1Len);
      titleHost.innerHTML = titleP1 + '<span class="lp-hero-accent">' + a + "</span>";
    } else if (idx <= titleTotal) {
      const p2 = titleP2.slice(0, idx - p1Len - acLen);
      titleHost.innerHTML =
        titleP1 + '<span class="lp-hero-accent">' + titleAccent + "</span>" + p2;
    }
    if (idx < titleTotal) {
      setTimeout(tickTitle, msTitle);
    } else {
      titleHost.setAttribute("data-lp-typed", "1");
      if (cTitle) cTitle.classList.add("is-done");
      if (cLead) cLead.classList.remove("is-done");
      let j = 0;
      function tickLead() {
        if (!landingVisible()) {
          leadHost.textContent = lead;
          if (cLead) cLead.classList.add("is-done");
          return;
        }
        j += 1;
        leadHost.textContent = lead.slice(0, j);
        if (j < lead.length) setTimeout(tickLead, msLead);
        else if (cLead) cLead.classList.add("is-done");
      }
      setTimeout(tickLead, 240);
    }
  }

  setTimeout(tickTitle, 380);
}

function toggleLpMenu() {
  const m = byId("lpNavMobile");
  const icon = byId("lpBurgerIcon");
  if (!m) return;
  const hidden = window.getComputedStyle(m).display === "none";
  m.style.display = hidden ? "flex" : "none";
  if (icon) icon.className = hidden ? "fas fa-xmark" : "fas fa-bars";
}

function closeLpMenu() {
  const m = byId("lpNavMobile");
  const icon = byId("lpBurgerIcon");
  if (m) m.style.display = "none";
  if (icon) icon.className = "fas fa-bars";
}

function doLoginWithCompany(companyId) {
  const pending = window.__pendingLogin;
  if (!pending) return;
  const { u, pass } = pending;
  window.__pendingLogin = null;
  const c = meta.companies.find((x) => x.id === companyId);
  if (!c) return alert("Şirkət tapılmadı.");
  meta.session = { companyId: c.id, userUid: u.uid };
  saveMeta();
  if (useFirestore()) {
    loadCompanyDBAsync().then((data) => {
      db = data;
      unsubscribeRealtime();
      subscribeRealtime();
      startRealtimeAutoRefresh();
      showLoginOverlay(false);
      applyAccessUI();
      logEvent("login", "auth", { companyId: c.id });
      renderAll();
    });
  } else {
    db = loadCompanyDB();
    showLoginOverlay(false);
    applyAccessUI();
    logEvent("login", "auth", { companyId: c.id });
    renderAll();
  }
}

function login(e) {
  e.preventDefault();
  const username = val("loginUser").trim();
  const pass = val("loginPass");
  try {
    if (byId("loginRemember")?.checked) localStorage.setItem("loginRememberUsername", username);
    else localStorage.removeItem("loginRememberUsername");
  } catch {}
  const unameNorm = String(username || "").trim().toLowerCase();
  let u = meta.users.find((x) => x.username === username);
  if (!u) {
    u = meta.users.find((x) => String(x.username || "").trim().toLowerCase() === unameNorm);
  }
  if (!u && unameNorm === "developer") {
    u = meta.users.find((x) => x && x.active && x.role === "developer");
  }
  if (!u || !u.active) return alert("İstifadəçi tapılmadı (və ya deaktivdir).");
  if (u.pass !== pass) return alert("Şifrə yanlışdır.");
  window.__pendingLogin = { u, pass };
  if (u.role === "developer") {
    const devCompany = meta.companies.find((x) => x.id === "devtest") || meta.companies[0];
    if (!devCompany) return alert("Developer şirkəti tapılmadı.");
    closeLoginModal();
    doLoginWithCompany(devCompany.id);
    return;
  }
  const norm = (s) => (s == null || s === "" ? "" : String(s).trim().toLowerCase());
  const companyFromUsername = getCompanyIdFromUsername(username);
  if (companyFromUsername) {
    const c = meta.companies.find((x) => norm(x.id) === norm(companyFromUsername));
    if (!c) return alert("İstifadəçi adındakı şirkət tapılmadı (format: şirkətadı_ad, məs: baktel_rustamb).");
    if (u.companyId != null && u.companyId !== "" && norm(u.companyId) !== norm(companyFromUsername)) return alert("Bu istifadəçi yalnız öz şirkətinə daxil ola bilər.");
    doLoginWithCompany(c.id);
    return;
  }
  const companyIdFromUrl = (window.__loginCompanyFromUrl || val("loginCompany") || "").trim();
  if (!companyIdFromUrl) return alert("İstifadəçi adı şirkət_adı formatında olmalıdır (məs: baktel_rustamb) və ya keçid ünvanında ?company=ŞİRKƏT_ID göstərilməlidir.");
  const urlCid = norm(companyIdFromUrl);
  const userCid = norm(u.companyId);
  if (userCid && urlCid && userCid !== urlCid) return alert("Bu istifadəçi yalnız öz şirkətinə daxil ola bilər.");
  if (!userCid && meta.companies[0] && norm(meta.companies[0].id) !== urlCid) return alert("Bu şirkət üçün icazəniz yoxdur.");
  const c = meta.companies.find((x) => norm(x.id) === urlCid);
  if (!c) return alert("Şirkət tapılmadı.");
  doLoginWithCompany(c.id);
}

function logout() {
  try {
    logEvent("logout", "auth", {});
  } catch {}
  if (realtimeAutoRefreshTimer) {
    clearInterval(realtimeAutoRefreshTimer);
    realtimeAutoRefreshTimer = null;
  }
  if (headerClockInterval) {
    clearInterval(headerClockInterval);
    headerClockInterval = null;
  }
  meta.session = null;
  saveMeta();
  closeMdl();
  showLoginOverlay(true);
  applyAccessUI();
}

function n(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

function money(v) {
  return n(v).toFixed(2);
}

function nowISODate() {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function nowISODateTimeLocal() {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}-${mm}-${dd}T${hh}:${mi}`;
}

function fmtDT(input) {
  if (!input) return "-";
  const s = String(input);
  const [datePart, timePartRaw] = s.split("T");
  const [y, m, d] = (datePart || "").split("-").map(Number);
  if (!y || !m || !d) return escapeHtml(s);
  const dd = String(d).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const yy = String(y);
  let timePart = (timePartRaw || "").slice(0, 5);
  if (!timePart || timePart === "00:00") return `${dd}.${mm}.${yy}`;
  return `${dd}.${mm}.${yy} ${timePart}`;
}

function monthRange(monthStr) {
  // monthStr: YYYY-MM
  if (!monthStr) return null;
  const [y, m] = String(monthStr).split("-").map(Number);
  if (!y || !m) return null;
  const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
  const to = new Date(y, m, 1, 0, 0, 0, 0).getTime() - 1;
  return { from, to };
}

function inMonth(dtStr, monthStr) {
  const r = monthRange(monthStr);
  if (!r) return true;
  const t = datePartMs(dtStr);
  if (t === null) return false;
  return t >= r.from && t <= r.to;
}

function pad4(num) {
  return String(Number(num) || 0).padStart(4, "0");
}

function pad6(num) {
  return String(Number(num) || 0).padStart(6, "0");
}

function ensureCounters() {
  if (!db.counters) db.counters = { purchInv: 1, salesInv: 1 };
  if (typeof db.counters.purchInv !== "number") db.counters.purchInv = 1;
  if (typeof db.counters.salesInv !== "number") db.counters.salesInv = 1;
}

function ensureAuditTrash() {
  if (!db.audit || !Array.isArray(db.audit)) db.audit = [];
  if (!db.trash || !Array.isArray(db.trash)) db.trash = [];
  if (!db.settings) db.settings = defaultDB().settings;
  if (!db.cashCounts || !Array.isArray(db.cashCounts)) db.cashCounts = [];
  if (!db.dayCloses || !Array.isArray(db.dayCloses)) db.dayCloses = [];
  if (!db.overdueNotes || !Array.isArray(db.overdueNotes)) db.overdueNotes = [];
}

function nextInvNo(kind) {
  ensureCounters();
  if (kind === "purch") {
    const n0 = db.counters.purchInv++;
    return "AL-" + String(n0).padStart(3, "0");
  }
  const n0 = db.counters.salesInv++;
  return "ST-" + String(n0).padStart(3, "0");
}
function previewInvNo(kind) {
  ensureCounters();
  if (kind === "purch") return "AL-" + String(db.counters.purchInv || 1).padStart(3, "0");
  return "ST-" + String(db.counters.salesInv || 1).padStart(3, "0");
}

function invFallback(kind, uid) {
  return kind === "purch" ? "AL-000" : "ST-000";
}

function ensureInvNoFormat() {
  const pad3 = (n) => String(n).padStart(3, "0");
  let purchNum = 0;
  let salesNum = 0;
  (db.purch || [])
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || Number(a.uid) - Number(b.uid))
    .forEach((p) => {
      purchNum++;
      p.invNo = "AL-" + pad3(purchNum);
    });
  (db.sales || [])
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || Number(a.uid) - Number(b.uid))
    .forEach((s) => {
      salesNum++;
      s.invNo = "ST-" + pad3(salesNum);
    });
  if (!db.counters) db.counters = { purchInv: 1, salesInv: 1 };
  db.counters.purchInv = Math.max(db.counters.purchInv || 1, purchNum + 1);
  db.counters.salesInv = Math.max(db.counters.salesInv || 1, salesNum + 1);
}

function runInvNoMigrationIfNeeded() {
  if (!db) return;
  const needsPurch = (db.purch || []).some((p) => !/^AL-\d+$/.test(String(p.invNo || "").trim()));
  const needsSales = (db.sales || []).some((s) => !/^ST-\d+$/.test(String(s.invNo || "").trim()));
  if (needsPurch || needsSales) {
    ensureInvNoFormat();
    saveDB();
  }
}

function genId(list, minStart = 1) {
  const max = list.reduce((a, x) => Math.max(a, Number(x.uid) || 0), 0);
  return Math.max(minStart, max + 1);
}

const THEME_KEY = "bakfon_theme";
const SKIN_KEY = "bakfon_skin";
const SIDEBAR_COLLAPSED_KEY = "bakfon_sidebar_collapsed";

const SKINS = [
  { id: "teal", name: "Navy Teal (sistem)", accent: "#1a4754", accentHover: "#16404f", accentLight: "#e8f4f8", sidebarLight: "#1a4754", sidebarDark: "#0a1929" },
  { id: "blue", name: "Ocean Blue", accent: "#2563eb", accentHover: "#1d4ed8", accentLight: "#dbeafe", sidebarLight: "#1e40af", sidebarDark: "#0b1220" },
  { id: "violet", name: "Violet", accent: "#7c3aed", accentHover: "#6d28d9", accentLight: "#ede9fe", sidebarLight: "#5b21b6", sidebarDark: "#14102a" },
  { id: "slate", name: "Slate", accent: "#334155", accentHover: "#1e293b", accentLight: "#e2e8f0", sidebarLight: "#1e293b", sidebarDark: "#0b1220" },
  { id: "rose", name: "Rose", accent: "#e11d48", accentHover: "#be123c", accentLight: "#ffe4e6", sidebarLight: "#9f1239", sidebarDark: "#2b0b16" },
];

function getSkinId() {
  try {
    return String(localStorage.getItem(SKIN_KEY) || "teal").trim() || "teal";
  } catch {
    return "teal";
  }
}

function applySkin() {
  const id = getSkinId();
  const skin = SKINS.find((s) => s.id === id) || SKINS[0];
  const root = document.documentElement;
  const isDark = getTheme() === "dark";
  root.style.setProperty("--accent", skin.accent);
  root.style.setProperty("--accent-hover", skin.accentHover);
  root.style.setProperty("--accent-light", skin.accentLight);
  root.style.setProperty("--sidebar-solid", isDark ? skin.sidebarDark : skin.sidebarLight);
}

function setSkin(id) {
  const sid = SKINS.some((s) => s.id === id) ? id : "teal";
  try {
    localStorage.setItem(SKIN_KEY, sid);
  } catch {}
  applySkin();
}
function getTheme() {
  try {
    const t = (localStorage.getItem(THEME_KEY) || "light").toLowerCase();
    return t === "dark" ? "dark" : "light";
  } catch (e) {
    return "light";
  }
}
function setTheme(mode) {
  const m = mode === "dark" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, m);
  } catch (e) {}
  applyTheme();
}
function applyTheme() {
  const isDark = getTheme() === "dark";
  document.body.classList.toggle("theme-dark", isDark);
  applySkin();
}

function applySidebarState() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch (e) {}
  document.body.classList.toggle("sidebar-collapsed", !!collapsed);
}

function toggleSidebar() {
  const next = !document.body.classList.contains("sidebar-collapsed");
  document.body.classList.toggle("sidebar-collapsed", next);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
  } catch (e) {}
}

function expandSidebarIfCollapsed() {
  if (!document.body.classList.contains("sidebar-collapsed")) return;
  document.body.classList.remove("sidebar-collapsed");
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
  } catch (e) {}
}

function setupNavTooltips() {
  document.querySelectorAll(".nav-link").forEach((el) => {
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw) return;
    el.setAttribute("data-tip", raw);
    el.setAttribute("title", raw); // native fallback tooltip
  });
}

function isOnline() {
  try {
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

function showOfflineBlock(show) {
  const ov = byId("loadingOverlay");
  const txt = byId("loadingText");
  document.body.classList.toggle("offline-block", !!show);
  if (ov) ov.classList.toggle("hidden", !show);
  if (txt && show) txt.textContent = "İnternet yoxdur. Sistem offline işləmək üçün nəzərdə tutulmayıb.";
}

function getCurrentCompanyName() {
  const cid = meta?.session?.companyId;
  if (!cid) return "";
  const c = meta.companies.find((x) => x.id === cid);
  return c ? (c.name || c.id) : cid;
}

function refreshHeaderBar() {
  const titleEl = byId("appHeaderTitle");
  if (titleEl) {
    if (!meta?.session) {
      titleEl.textContent = "";
    } else {
      const u = meta.users?.find((x) => x.uid === meta.session.userUid);
      const firstName = u ? (userDisplay(u).split(" ")[0] || "") : "";
      const cname = getCurrentCompanyName();
      titleEl.textContent = firstName ? "Xoş gəldiniz, " + firstName + "!" : (cname || "");
    }
  }
  updateHeaderDateTime();
  updateNotificationsIndicator();
}

function getNotifications() {
  ensureAuditTrash();
  const out = [];

  // Negative account balances
  for (const a of db.accounts || []) {
    const bal = accountBalance(Number(a.uid));
    if (bal < -0.000001) {
      out.push({
        kind: "neg",
        title: "Mənfi balans",
        text: `${a.name}: ${money(bal)} AZN`,
      });
    }
  }

  // Overdue credit installments (summary by customer)
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dayMs = 24 * 60 * 60 * 1000;
  const toDayStart = (iso) => {
    const [y, m, d] = String(iso || "").slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d).getTime();
  };
  const todayT = toDayStart(todayISO);
  const byCust = new Map();
  (db.sales || [])
    .filter((s) => !s.returnedAt && String(s.saleType || "").toLowerCase() === "kredit")
    .forEach((s) => {
      const sched = buildCreditSchedule(s);
      for (const r of sched.rows) {
        if (r.remaining <= 0.000001) continue;
        const dueT = toDayStart(r.due);
        if (dueT == null || todayT == null) continue;
        const daysLate = Math.floor((todayT - dueT) / dayMs);
        if (daysLate < 1) continue;
        const cid = String(s.customerId || "");
        if (!byCust.has(cid)) byCust.set(cid, { customerId: cid, customer: s.customerName || cid, dueTotal: 0, maxLate: 0 });
        const g = byCust.get(cid);
        g.dueTotal += Math.max(0, n(r.remaining));
        g.maxLate = Math.max(g.maxLate, daysLate);
      }
    });
  for (const g of byCust.values()) {
    out.push({
      kind: "overdue",
      title: "Vaxtı keçmiş kredit",
      text: `${g.customer}: ${money(g.dueTotal)} AZN • ${g.maxLate} gün`,
      action: () => showSec("overdue", document.querySelector(`.nav-link[onclick*="showSec('overdue'"]`) || null),
    });
  }

  // Low stock for bulk purchases (remaining qty <= threshold)
  const thr = Math.max(1, Math.floor(n(db.settings?.lowStockThreshold || 3)));
  const low = [];
  (db.purch || [])
    .filter((p) => !p.returnedAt)
    .filter((p) => purchIsBulk(p))
    .forEach((p) => {
      const rem = purchRemainingQty(p);
      if (rem <= thr) {
        low.push({ name: p.name || "-", rem, code: p.code || "-" });
      }
    });
  if (low.length) {
    const top = low
      .slice()
      .sort((a, b) => a.rem - b.rem)
      .slice(0, 5)
      .map((x) => `${x.name} (${x.code}) • ${x.rem}`)
      .join(", ");
    out.push({
      kind: "stock",
      title: "Anbar azalıb",
      text: `${low.length} məhsul • hədd ≤ ${thr}. Nümunə: ${top}`,
      action: () => showSec("stock", document.querySelector(`.nav-link[onclick*="showSec('stock'"]`) || null),
    });
  }

  return out;
}

function updateNotificationsIndicator() {
  const badge = byId("notifBadge");
  if (!badge) return;
  if (!meta?.session) {
    badge.classList.add("hidden");
    return;
  }
  const n0 = getNotifications().length;
  badge.textContent = String(n0);
  badge.classList.toggle("hidden", n0 <= 0);
}

function updateHeaderDateTime() {
  const el = byId("headerDateTime");
  if (!el) return;
  const d = new Date();
  const dateStr = d.toLocaleDateString("az-AZ", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = d.toLocaleTimeString("az-AZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  el.textContent = dateStr + "  " + timeStr;
}

function showSec(id, el) {
  if (meta?.session && !userCanSection(id)) {
    alert("Bu bölməyə icazə yoxdur.");
    return;
  }
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
  const sec = document.getElementById(id);
  if (sec) {
    sec.classList.add("active");
  }
  if (el) el.classList.add("active");
  if (id === "debts") {
    document.querySelectorAll(".debt-type-select").forEach((s) => {
      s.value = "";
    });
    updateDebtSubSelectVisibility("");
    updateDebtSubEnabled();
    updateDebtSectionVisibility();
  }
  refreshHeaderBar();
  if (meta?.session) try { sessionStorage.setItem("bakfon_lastSection", id); } catch (e) {}
}

function pagePrev(key) {
  uiState.page[key] = Math.max(1, (uiState.page[key] || 1) - 1);
  renderAll();
}

function pageNext(key) {
  uiState.page[key] = (uiState.page[key] || 1) + 1;
  renderAll();
}

function getPageSize(selectId, def = 50) {
  const v = Number(byId(selectId)?.value);
  return v > 0 ? v : def;
}

function parseDateOnly(v) {
  // v: YYYY-MM-DD
  if (!v) return null;
  const [y, m, d] = String(v).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function datePartMs(dtStr) {
  if (!dtStr) return null;
  const s = String(dtStr);
  const [datePart] = s.split("T");
  return parseDateOnly(datePart);
}

function inDateRange(dtStr, fromId, toId) {
  const fromMs = parseDateOnly(byId(fromId)?.value);
  const toMs = parseDateOnly(byId(toId)?.value);
  if (!fromMs && !toMs) return true;
  const ms = datePartMs(dtStr);
  if (ms === null) return false;
  if (fromMs && ms < fromMs) return false;
  if (toMs && ms > toMs) return false;
  return true;
}

function paginate(list, pageKey, pageSize, infoElId) {
  const page = Math.max(1, uiState.page[pageKey] || 1);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  uiState.page[pageKey] = safePage;
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;
  const slice = list.slice(start, end);
  const info = byId(infoElId);
  if (info) info.innerText = `${safePage}/${pages} • ${total}`;
  return slice;
}

// Modal helpers
const modal = document.getElementById("mdlMain");
function renderModalWithNav(rawHtml) {
  const hist = window.__modalHistory || [];
  const canBack = hist.length > 0;
  const nav = canBack
    ? `<div class="modal-nav-top"><button class="btn-cancel" type="button" onclick="modalBack()"><i class="fas fa-arrow-left"></i> Geri</button></div>`
    : "";
  return `${nav}${rawHtml}`;
}
function openModal(html) {
  const body = document.getElementById("modalContent");
  if (!body) return;
  const now = Date.now();
  const alreadyOpen = modal.style.display === "flex";
  const justClosed = window.__modalJustClosedAt && now - window.__modalJustClosedAt < 350;
  const curRaw = window.__currentModalRaw || "";
  if ((alreadyOpen || justClosed) && curRaw) {
    window.__modalHistory = window.__modalHistory || [];
    window.__modalHistory.push(curRaw);
  } else if (!alreadyOpen) {
    window.__modalHistory = [];
  }
  window.__currentModalRaw = html;
  body.innerHTML = renderModalWithNav(html);
  modal.style.display = "flex";
  window.__modalJustClosedAt = 0;
}
function modalBack() {
  const body = document.getElementById("modalContent");
  const hist = window.__modalHistory || [];
  if (!body || !hist.length) return;
  const prevRaw = hist.pop();
  window.__currentModalRaw = prevRaw;
  body.innerHTML = renderModalWithNav(prevRaw);
  modal.style.display = "flex";
}
function closeMdl() {
  modal.style.display = "none";
  window.__modalJustClosedAt = Date.now();
  setTimeout(() => {
    const stillClosed = modal.style.display !== "flex";
    if (stillClosed && window.__modalJustClosedAt && Date.now() - window.__modalJustClosedAt >= 320) {
      window.__modalHistory = [];
      window.__currentModalRaw = "";
    }
  }, 340);
}

function appAlert(msg, title = "Bildiriş") {
  const text = msg == null ? "" : String(msg);
  openModal(`
    <h2>${escapeHtml(title)}</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Məlumat</div><div class="info-value" style="white-space:pre-wrap;">${escapeHtml(text)}</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
  return false;
}

function appConfirm(msg, title = "Təsdiq") {
  const text = msg == null ? "" : String(msg);
  return new Promise((resolve) => {
    const yes = () => resolveAndClose(true);
    const no = () => resolveAndClose(false);
    const onKey = (e) => {
      if (e.key === "Escape") no();
      if (e.key === "Enter") yes();
    };
    const cleanup = () => document.removeEventListener("keydown", onKey);
    const resolveAndClose = (v) => {
      cleanup();
      closeMdl();
      resolve(v);
    };
    document.addEventListener("keydown", onKey);
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      <div class="info-block">
        <div class="info-row"><div class="info-label">Sual</div><div class="info-value" style="white-space:pre-wrap;">${escapeHtml(text)}</div></div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="button" onclick="window.__appConfirmResolve && window.__appConfirmResolve(true)">Bəli</button>
        <button class="btn-cancel" type="button" onclick="window.__appConfirmResolve && window.__appConfirmResolve(false)">Xeyr</button>
      </div>
    `);
    window.__appConfirmResolve = resolveAndClose;
  });
}

function appRequireNote(title = "Qeyd", message = "Qeyd daxil edin") {
  return new Promise((resolve) => {
    const finish = (val) => {
      window.__appRequireNoteResolve = null;
      resolve(val);
      closeMdl();
    };
    openModal(`
      <h2>${escapeHtml(title)}</h2>
      <div class="info-block">
        <div class="info-row"><div class="info-label">Məlumat</div><div class="info-value" style="white-space:pre-wrap;">${escapeHtml(message)}</div></div>
      </div>
      <div class="grid-3">
        <textarea id="appRequireNoteInput" class="span-3" placeholder="Qeyd yazın..." style="min-height:110px;"></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="button" onclick="window.__appRequireNoteResolve && window.__appRequireNoteResolve()">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="window.__appRequireNoteResolve && window.__appRequireNoteResolve(true)">Ləğv et</button>
      </div>
    `);
    window.__appRequireNoteResolve = (cancel) => {
      if (cancel) return finish(null);
      const txt = (byId("appRequireNoteInput")?.value || "").trim();
      if (!txt) return alert("Qeyd məcburidir.");
      finish(txt);
    };
  });
}

// Override built-in popup alerts in this app scope
function alert(msg) {
  return appAlert(msg);
}

function getLastDayCloseDate() {
  const list = (db.dayCloses || [])
    .map((x) => String(x.date || "").slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return list.length ? list[list.length - 1] : "";
}

// Search
function filterTable(id, q) {
  const query = (q || "").toLowerCase();
  document.querySelectorAll(`#${id} tr`).forEach((r) => {
    // textContent includes hidden text nodes; innerText does not.
    r.style.display = (r.textContent || "").toLowerCase().includes(query) ? "" : "none";
  });
}

// Keys for inventory items
function itemKeyFromPurch(p) {
  if (Number(p.qty || 1) > 1 || (p.code || "").trim()) return `BULK:${p.uid}`;
  const ser = (p.seria || "").trim();
  const i1 = (p.imei1 || "").trim();
  const i2 = (p.imei2 || "").trim();
  if (ser) return `SER:${ser}`;
  if (i1) return `I1:${i1}`;
  if (i2) return `I2:${i2}`;
  return `FALLBACK:${p.uid}`;
}

function soldKeySet() {
  return new Set(db.sales.filter((s) => !s.returnedAt).map((s) => s.itemKey).filter(Boolean));
}

function purchIsBulk(p) {
  return Number(p.qty || 1) > 1 || (p.code || "").trim().length > 0;
}

function bulkSoldQty(purchUid) {
  return (db.sales || [])
    .filter((s) => !s.returnedAt)
    .reduce((a, s) => {
      if (String(s.bulkPurchUid || "") === String(purchUid)) {
        return a + Math.max(0, n(s.qty || 0));
      }
      const allocs = s.bulkAllocations || null;
      if (Array.isArray(allocs) && allocs.length) {
        for (const al of allocs) {
          if (String(al.purchUid || "") === String(purchUid)) a += Math.max(0, n(al.qty || 0));
        }
      }
      return a;
    }, 0);
}

function purchRemainingQty(p) {
  if (p && p.returnedAt) return 0;
  if (!purchIsBulk(p)) return soldKeySet().has(itemKeyFromPurch(p)) ? 0 : 1;
  const total = Math.max(0, Math.floor(n(p.qty || 0)));
  const sold = bulkSoldQty(p.uid);
  return Math.max(0, total - sold);
}

function canDeletePurchase(p) {
  if (!purchIsBulk(p)) return !soldKeySet().has(itemKeyFromPurch(p));
  return bulkSoldQty(p.uid) <= 0.000001;
}

function purchRemaining(p) {
  if (p && p.returnedAt) return 0;
  return Math.max(0, n(p.amount) - n(p.paidTotal));
}

function saleRemaining(s) {
  return Math.max(0, n(s.amount) - n(s.paidTotal));
}

function debtStatus(total, rem) {
  if (rem <= 0.000001) return "paid";
  if (rem >= total - 0.000001) return "unpaid";
  return "partial";
}

function debtLabel(st) {
  if (st === "paid") return "TAM ÖDƏNİLİB";
  if (st === "partial") return "QİSMƏN";
  return "ÖDƏNİLMƏYİB";
}

function addMonthsISO(dateISO, addMonths) {
  const [y, m, d] = String(dateISO || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(dateISO || "").slice(0, 10) || "";
  const targetM = (m - 1) + addMonths;
  const yy = y + Math.floor(targetM / 12);
  const mm0 = ((targetM % 12) + 12) % 12;
  const lastDay = new Date(yy, mm0 + 1, 0).getDate();
  const dd = Math.min(d, lastDay);
  return `${yy}-${String(mm0 + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function buildCreditSchedule(sale) {
  const term = Math.max(0, Number(sale.credit?.termMonths) || 0);
  const toCents = (v) => Math.round(Math.max(0, n(v)) * 100);
  const fromCents = (c) => (Math.max(0, c) / 100);

  const totalC = toCents(sale.amount);
  const downC = Math.min(totalC, toCents(sale.credit?.downPayment));
  const remC = Math.max(0, totalC - downC);
  const monthlyBase = term > 0 ? Math.floor(remC / term) : 0;
  const monthlyRem = term > 0 ? (remC % term) : 0;

  const paidC = toCents(sale.paidTotal);
  const downAppliedC = Math.min(downC, paidC);
  let paidLeftC = Math.max(0, paidC - downAppliedC);

  const rows = [];
  for (let i = 1; i <= term; i++) {
    // First `monthlyRem` rows get +0.01 so total cents matches exactly.
    const amtC = monthlyBase + (i <= monthlyRem ? 1 : 0);
    const due = addMonthsISO(sale.date, i);
    const paidThisC = Math.min(amtC, paidLeftC);
    paidLeftC -= paidThisC;
    const remainingC = Math.max(0, amtC - paidThisC);
    const amt = fromCents(amtC);
    const paidThis = fromCents(paidThisC);
    const remaining = fromCents(remainingC);
    const st = debtStatus(amt, remaining);
    rows.push({ idx: i, due, amount: amt, paid: paidThis, remaining, status: st });
  }

  const down = fromCents(downC);
  const remAfterDown = fromCents(remC);
  const monthly = term > 0 ? (remAfterDown / term) : 0;
  return { term, down, remAfterDown, monthly, rows };
}

function runCreditRoundingMigration() {
  ensureAuditTrash();
  if (!db.settings) db.settings = defaultDB().settings;
  let changed = false;
  for (const s of db.sales || []) {
    if (String(s.saleType || "").toLowerCase() !== "kredit") continue;
    const amount = Math.max(0, n(s.amount));
    if (!s.credit) s.credit = {};
    const term = Math.max(1, Math.floor(n(s.credit.termMonths || 0)));
    const down = Math.min(amount, Math.max(0, n(s.credit.downPayment || 0)));
    const paidFromPayments = sumPayments(s.payments || []);
    const paid = Math.min(amount, Math.max(0, paidFromPayments || n(s.paidTotal)));
    const monthly = term > 0 ? (Math.max(0, amount - down) / term) : 0;

    if (n(s.paidTotal) !== paid) {
      s.paidTotal = String(paid);
      changed = true;
    }
    if (n(s.credit.downPayment) !== down || Number(s.credit.termMonths) !== term || n(s.credit.monthlyPayment) !== monthly) {
      s.credit.termMonths = term;
      s.credit.downPayment = down;
      s.credit.monthlyPayment = monthly;
      changed = true;
    }
  }
  return changed;
}

function runActorBackfillMigration() {
  let changed = false;
  const fb = (v) => String(v || "").trim();

  for (const c of db.cash || []) {
    if (!fb(c.actor)) {
      let actor = "";
      const kind = c.link?.kind || "";
      if (kind === "sale" || kind === "sale_payment" || kind === "return_refund") {
        const s = (db.sales || []).find((x) => Number(x.uid) === Number(c.link?.saleUid));
        actor = fb(s?.actorName) || fb(s?.employeeName) || getStaffName(s?.employeeId);
      } else if (kind === "debtor_payment") {
        const firstSaleUid = c.meta?.allocations?.[0]?.saleUid ?? c.meta?.allocations?.[0]?.salesUid ?? null;
        const s = firstSaleUid ? (db.sales || []).find((x) => Number(x.uid) === Number(firstSaleUid)) : null;
        actor = fb(s?.actorName) || fb(s?.employeeName) || getStaffName(s?.employeeId);
      } else if (kind === "creditor_invoice_payment" || kind === "purch_payment" || kind === "purch_payment_adj" || kind === "creditor_payment") {
        const p = (db.purch || []).find((x) => Number(x.uid) === Number(c.link?.purchUid));
        actor = fb(p?.actorName) || getStaffName(p?.employeeId);
      }
      c.actor = actor || "-";
      changed = true;
    }
  }

  for (const s of db.sales || []) {
    if (!fb(s.actorName)) {
      s.actorName = fb(s.employeeName) || getStaffName(s.employeeId) || "-";
      changed = true;
    }
  }

  for (const p of db.purch || []) {
    if (!fb(p.actorName)) {
      p.actorName = getStaffName(p.employeeId) || "-";
      changed = true;
    }
  }

  for (const t of db.staff || []) {
    if (!fb(t.actorName)) {
      t.actorName = fb(t.name) || "-";
      changed = true;
    }
  }

  return changed;
}

function runMigrations() {
  ensureAuditTrash();
  if (!db.settings) db.settings = defaultDB().settings;
  const TARGET_SCHEMA_VERSION = 2;
  let ver = Math.max(0, Math.floor(n(db.settings.__schemaVersion || 0)));
  let changed = false;

  // v1: normalize all existing credit sales for cent-accurate schedule behavior
  if (ver < 1) {
    const did = runCreditRoundingMigration();
    if (did) {
      logEvent("update", "tools", { kind: "credit_round_migration_v2" });
      changed = true;
    }
    db.settings.__creditRoundV2 = true; // backward compatibility marker
    ver = 1;
  }

  // v2: backfill actor/actorName on historical records
  if (ver < 2) {
    const did = runActorBackfillMigration();
    if (did) {
      logEvent("update", "tools", { kind: "actor_backfill_migration_v1" });
      changed = true;
    }
    ver = 2;
  }

  db.settings.__schemaVersion = TARGET_SCHEMA_VERSION;
  if (changed || n(db.settings.__schemaVersion || 0) !== TARGET_SCHEMA_VERSION) {
    saveCompanyDB();
  }
}

// ========= Customers =========
function openCust(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const c =
    idx !== null
      ? db.cust[idx]
      : { sur: "", name: "", father: "", fin: "", seriaNum: "", ph1: "", ph2: "", ph3: "", work: "", addr: "", zam: "", creditLimit: "0" };

  const guarantorOptions =
    `<option value="">Zamin seç (istəyə bağlı)</option>` +
    db.cust
      .map((g) => `<option value="${g.uid}" ${String(c.zam) === String(g.uid) ? "selected" : ""}>${g.sur} ${g.name} (${g.uid})</option>`)
      .join("");

  openModal(`
    <h2>${idx !== null ? "Müştəri Redaktə" : "Yeni Müştəri"}</h2>
    <form onsubmit="saveCust(event, ${idx})">
      <div class="grid-3">
        <input id="f_sur" value="${escapeHtml(c.sur)}" placeholder="Soyad" required>
        <input id="f_name" value="${escapeHtml(c.name)}" placeholder="Ad" required>
        <input id="f_father" value="${escapeHtml(c.father)}" placeholder="Ata Adı">

        <input id="f_fin" value="${escapeHtml(c.fin)}" placeholder="FİN" maxlength="7" required>
        <input id="f_ser" value="${escapeHtml(c.seriaNum)}" placeholder="ŞV Seriya №" class="span-2">

        <input id="f_ph1" value="${escapeHtml(c.ph1)}" placeholder="Mobil 1" required>
        <input id="f_ph2" value="${escapeHtml(c.ph2 || "")}" placeholder="Mobil 2">
        <input id="f_ph3" value="${escapeHtml(c.ph3 || "")}" placeholder="Mobil 3">

        <input id="f_work" value="${escapeHtml(c.work || "")}" placeholder="İş yeri" class="span-2">
        <input id="f_addr" value="${escapeHtml(c.addr || "")}" placeholder="Ünvan" class="span-3">

        <select id="f_zam" class="span-3">${guarantorOptions}</select>
        <input type="number" step="0.01" id="f_climit" value="${escapeAttr(String(c.creditLimit ?? "0"))}" class="span-3" placeholder="Kredit limit (AZN) (0 = limitsiz)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda Saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveCust(e, idx) {
  e.preventDefault();
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  if (idx === null && !userCanEdit()) return alert("Əlavə etmə icazəsi yoxdur.");
  const isNew = idx === null;
  const actorName = currentActorName();
  const data = {
    uid: idx !== null ? db.cust[idx].uid : genId(db.cust, 1),
    createdAt: idx !== null ? (db.cust[idx].createdAt || db.cust[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    sur: val("f_sur"),
    name: val("f_name"),
    father: val("f_father"),
    fin: val("f_fin").toUpperCase(),
    seriaNum: val("f_ser").toUpperCase(),
    ph1: val("f_ph1"),
    ph2: val("f_ph2"),
    ph3: val("f_ph3"),
    work: val("f_work"),
    addr: val("f_addr"),
    zam: val("f_zam"),
    creditLimit: String(Math.max(0, n(val("f_climit")))),
    actorName,
  };
  if (idx !== null) db.cust[idx] = data;
  else db.cust.push(data);
  logEvent(isNew ? "create" : "update", "cust", { uid: data.uid });
  saveDB();
  closeMdl();
}

// ----- Müştəri Excel/CSV import -----
const CUST_IMPORT_HEADER_MAP = {
  sur: ["soyad", "surname", "familiya"],
  name: ["ad", "name", "adı"],
  father: ["ata", "father", "ata adı", "ataadi"],
  fin: ["fin", "fın", "vəsiqə"],
  seriaNum: ["seriya", "seria", "şv", "seriya №", "seriya no"],
  ph1: ["mobil", "telefon", "phone", "tel", "nomre", "nömrə", "mobil 1", "gsm"],
  ph2: ["mobil 2", "telefon 2", "phone2"],
  ph3: ["mobil 3", "telefon 3"],
  work: ["iş", "ish", "work", "is yeri", "iş yeri"],
  addr: ["ünvan", "unvan", "addr", "address", "adres"],
  creditLimit: ["kredit limit", "limit", "credit"],
};

function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findCustImportColIndex(headers, field) {
  const keys = [field, ...(CUST_IMPORT_HEADER_MAP[field] || [])];
  const normalized = headers.map(normalizeHeader);
  for (const k of keys) {
    const idx = normalized.findIndex((h) => h === k || h.includes(k) || k.includes(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseCustImportFile(rawRows) {
  if (!rawRows || rawRows.length < 2) return { headers: [], rows: [], colMap: null };
  const headers = rawRows[0].map((c) => String(c ?? "").trim());
  const colMap = {};
  for (const field of ["sur", "name", "father", "fin", "seriaNum", "ph1", "ph2", "ph3", "work", "addr", "creditLimit"]) {
    const idx = findCustImportColIndex(headers, field);
    if (idx >= 0) colMap[field] = idx;
  }
  const rows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => String(c ?? "").trim());
    const hasAny = cells.some((c) => c.length > 0);
    if (!hasAny) continue;
    rows.push(cells);
  }
  return { headers, rows, colMap };
}

function openCustImport() {
  if (!userCanEdit()) return alert("İmport üçün redaktə icazəsi lazımdır.");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const isCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      let rawRows = [];
      try {
        if (isCsv) {
          const text = (e.target.result || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          rawRows = text.split("\n").map((line) => {
            const out = [];
            let cur = "";
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
              const ch = line[i];
              if (ch === '"') inQuotes = !inQuotes;
              else if ((ch === "," || ch === ";") && !inQuotes) {
                out.push(cur.trim());
                cur = "";
              } else cur += ch;
            }
            out.push(cur.trim());
            return out;
          });
        } else {
          if (typeof XLSX === "undefined") return alert("Excel oxuma üçün kitabxana yüklənməyib. Səhifəni yeniləyin.");
          const wb = XLSX.read(e.target.result, { type: "array", raw: false });
          const firstSheet = wb.SheetNames[0] ? wb.Sheets[wb.SheetNames[0]] : null;
          if (!firstSheet) return alert("Excel faylında vərəq tapılmadı.");
          rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });
        }
      } catch (err) {
        return alert("Fayl oxuna bilmədi: " + (err.message || err));
      }
      const { headers, rows, colMap } = parseCustImportFile(rawRows);
      if (rows.length === 0) return alert("Faylda mətn sətiri tapılmadı (birinci sətir başlıq sayılır).");
      const needSur = (colMap.sur ?? -1) < 0;
      const needName = (colMap.name ?? -1) < 0;
      const needPh1 = (colMap.ph1 ?? -1) < 0;
      const needFin = (colMap.fin ?? -1) < 0;
      if (needSur || needName || needPh1 || needFin) {
        const missing = [];
        if (needSur) missing.push("Soyad");
        if (needName) missing.push("Ad");
        if (needPh1) missing.push("Mobil/Telefon");
        if (needFin) missing.push("FİN");
        return alert("Başlıq sətirində aşağıdakı sütunlardan biri tapılmadı: " + missing.join(", ") + ".\n\nMümkün başlıq adları: Soyad, Ad, Ata, FİN, Seriya, Mobil, Telefon, İş yeri, Ünvan, Kredit limit.");
      }
      const now = nowISODateTimeLocal();
      const nextUid = genId(db.cust, 1);
      let added = 0;
      const finSet = new Set((db.cust || []).map((c) => String(c.fin || "").toLowerCase()));
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i];
        const get = (field) => {
          const idx = colMap[field];
          return idx >= 0 && idx < cells.length ? cells[idx] : "";
        };
        const finVal = get("fin");
        if (!finVal) continue;
        const finKey = finVal.toLowerCase();
        if (finSet.has(finKey)) continue;
        finSet.add(finKey);
        const sur = get("sur") || "";
        const name = get("name") || "";
        if (!sur.trim() && !name.trim()) continue;
        db.cust.push({
          uid: nextUid + added,
          createdAt: now,
          sur,
          name,
          father: get("father"),
          fin: finVal.toUpperCase(),
          seriaNum: (get("seriaNum") || "").toUpperCase(),
          ph1: get("ph1") || "",
          ph2: get("ph2"),
          ph3: get("ph3"),
          work: get("work"),
          addr: get("addr"),
          zam: "",
          creditLimit: String(Math.max(0, n(get("creditLimit")) || 0)),
        });
        added++;
      }
      if (added > 0) {
        logEvent("import", "cust", { count: added });
        saveDB();
        closeMdl();
        renderAll();
        toast(added + " müştəri əlavə edildi.", "ok", 2500);
      } else {
        toast("Əlavə edilən müştəri yoxdur (FİN təkrarlana bilər və ya məcburi sahələr boşdur).", "warn", 3000);
      }
    };
    if (isCsv) reader.readAsText(file, "UTF-8");
    else reader.readAsArrayBuffer(file);
  };
  input.click();
}

// ========= Suppliers =========
function openSupp(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const s = idx !== null ? db.supp[idx] : { co: "", per: "", mob: "", voen: "" };
  openModal(`
    <h2>${idx !== null ? "Təchizatçı Redaktə" : "Yeni Təchizatçı"}</h2>
    <form onsubmit="saveSupp(event, ${idx})">
      <div class="grid-3">
        <input id="f_co" value="${escapeHtml(s.co)}" placeholder="Şirkət Adı" class="span-3" required>
        <input id="f_per" value="${escapeHtml(s.per)}" placeholder="Məsul Şəxs" class="span-2">
        <input id="f_mob" value="${escapeHtml(s.mob)}" placeholder="Mobil">
        <input id="f_voen" value="${escapeHtml(s.voen)}" placeholder="VÖEN" class="span-3">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda Saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveSupp(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isNew = idx === null;
  const actorName = currentActorName();
  const data = {
    uid: idx !== null ? db.supp[idx].uid : genId(db.supp, 1000),
    createdAt: idx !== null ? (db.supp[idx].createdAt || db.supp[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    co: val("f_co"),
    per: val("f_per"),
    mob: val("f_mob"),
    voen: val("f_voen"),
    actorName,
  };
  if (idx !== null) db.supp[idx] = data;
  else db.supp.push(data);
  logEvent(isNew ? "create" : "update", "supp", { uid: data.uid });
  saveDB();
  closeMdl();
}

// ========= Products =========
function openProd(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const p = idx !== null ? db.prod[idx] : { name: "", cat: "", subCat: "" };
  openModal(`
    <h2>${idx !== null ? "Məhsul Redaktə" : "Yeni Məhsul"}</h2>
    <form onsubmit="saveProd(event, ${idx})">
      <div class="grid-3">
        <input id="f_p_name" value="${escapeHtml(p.name)}" placeholder="Məhsul Adı" class="span-3" required>
        <input id="f_p_cat" value="${escapeHtml(p.cat || "")}" placeholder="Kateqoriya" class="span-2">
        <input id="f_p_subcat" value="${escapeHtml(p.subCat || "")}" placeholder="Alt kateqoriya">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda Saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveProd(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isNew = idx === null;
  const actorName = currentActorName();
  const oldName = idx !== null ? String(db.prod[idx]?.name || "") : "";
  const nextName = val("f_p_name");
  if (idx !== null && oldName.trim() && String(nextName || "").trim() !== oldName.trim()) {
    const usedInPurch = (db.purch || []).some((p) => String(p.name || "").trim() === oldName.trim());
    const usedInSales = (db.sales || []).some((s) => String(s.productName || "").trim() === oldName.trim());
    if (usedInPurch || usedInSales) return alert("Bu məhsul adı alış/satışda istifadə olunub. Adı dəyişmək olmaz.");
  }
  const data = {
    uid: idx !== null ? db.prod[idx].uid : genId(db.prod, 1),
    createdAt: idx !== null ? (db.prod[idx].createdAt || db.prod[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    name: nextName,
    cat: val("f_p_cat"),
    subCat: val("f_p_subcat"),
    actorName,
  };
  if (idx !== null) db.prod[idx] = data;
  else db.prod.push(data);
  logEvent(isNew ? "create" : "update", "prod", { uid: data.uid });
  saveDB();
  closeMdl();
}

// ========= Purchases =========
function openPurchInfo(idx) {
  const p = db.purch[idx];
  if (!p) return;
  const invNo = p.invNo || invFallback("purch", p.uid);
  const staff = p.employeeId && db.staff ? db.staff.find((s) => String(s.uid) === String(p.employeeId)) : null;
  const staffName = staff ? staff.name : "-";
  const payTypeLabel = { nagd: "Nəğd", kocurme: "Köçürmə", kredit: "Kredit" }[String(p.payType || "").toLowerCase()] || (p.payType || "-");
  openModal(`
    <h2>Alış – Məlumat</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Qaimə №</div><div class="info-value">${escapeHtml(invNo)}</div></div>
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(p.date)}</div></div>
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(p.supp || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məhsul (marka/model)</div><div class="info-value">${escapeHtml(p.name || "-")}</div></div>
      <div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(p.code || "-")}</div></div>
      <div class="info-row"><div class="info-label">Say</div><div class="info-value">${purchIsBulk(p) ? String(Math.max(1, Math.floor(n(p.qty || 1)))) : "1"}</div></div>
      <div class="info-row"><div class="info-label">IMEI 1</div><div class="info-value">${escapeHtml(p.imei1 || "-")}</div></div>
      <div class="info-row"><div class="info-label">IMEI 2</div><div class="info-value">${escapeHtml(p.imei2 || "-")}</div></div>
      <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(p.seria || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ (AZN)</div><div class="info-value">${money(p.amount)}</div></div>
      <div class="info-row"><div class="info-label">Ödəniş növü</div><div class="info-value">${escapeHtml(payTypeLabel)}</div></div>
      <div class="info-row"><div class="info-label">Ödənilən (AZN)</div><div class="info-value">${money(p.paidTotal)}</div></div>
      <div class="info-row"><div class="info-label">Alış edən əməkdaş</div><div class="info-value">${escapeHtml(staffName)}</div></div>
    </div>
    <div class="modal-footer">
      ${userCanEdit() ? `<button class="btn-main" type="button" onclick="closeMdl();openPurch(${idx})">Redaktə</button>` : ""}
      ${!p.returnedAt && canDeletePurchase(p) ? `<button class="btn-cancel" type="button" onclick="openReturnPurch(${idx})">Qaytar</button>` : ""}
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openPurchInfoByInv(invNoRaw) {
  const invNo = String(invNoRaw || "").trim();
  if (!invNo) return;
  const rows = (db.purch || [])
    .filter((p) => String(p.invNo || "").trim() === invNo)
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  if (!rows.length) return alert("Qaimə tapılmadı.");
  const head = rows[0];
  const supp = head.supp || "-";
  const staff = head.employeeId && db.staff ? db.staff.find((s) => String(s.uid) === String(head.employeeId)) : null;
  const staffName = staff ? staff.name : "-";
  const totalAmount = rows.reduce((a, p) => a + n(p.amount), 0);
  const totalPaid = rows.reduce((a, p) => a + n(p.paidTotal), 0);
  const totalRem = Math.max(0, totalAmount - totalPaid);
  const listRows = rows
    .map((p, i) => {
      const isBulk = purchIsBulk(p);
      const qty = isBulk ? Math.max(1, Math.floor(n(p.qty || 1))) : 1;
      const unit = isBulk ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : n(p.amount) / qty) : n(p.amount);
      return `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(p.name || "-")}</td>
        <td>${escapeHtml(p.imei1 || "-")}</td>
        <td>${escapeHtml(p.imei2 || "-")}</td>
        <td>${escapeHtml(p.seria || "-")}</td>
        <td>${escapeHtml(p.code || "-")}</td>
        <td>${qty}</td>
        <td>${money(unit)} AZN</td>
        <td>${money(p.amount)} AZN</td>
      </tr>`;
    })
    .join("");
  openModal(`
    <h2>Alış – Qaimə Məlumatı</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Qaimə №</div><div class="info-value">${escapeHtml(invNo)}</div></div>
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(head.date)}</div></div>
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(supp)}</div></div>
      <div class="info-row"><div class="info-label">Alış edən əməkdaş</div><div class="info-value">${escapeHtml(staffName)}</div></div>
    </div>
    <div class="table-wrap" style="margin-top:10px;">
      <table>
        <thead><tr><th>#</th><th>Məhsul</th><th>IMEI 1</th><th>IMEI 2</th><th>Seriya</th><th>Kod</th><th>Say</th><th>1 ədəd qiymət</th><th>Məbləğ</th></tr></thead>
        <tbody>${listRows}</tbody>
        <tfoot><tr class="total-row"><td colspan="8">Cəmi</td><td>${money(totalAmount)} AZN</td></tr></tfoot>
      </table>
    </div>
    <div class="info-block" style="margin-top:10px;">
      <div class="info-row"><div class="info-label">Ödənilən</div><div class="info-value">${money(totalPaid)} AZN</div></div>
      <div class="info-row"><div class="info-label">Qalıq</div><div class="info-value">${money(totalRem)} AZN</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openPurchInvoiceEdit(invNoRaw) {
  const invNo = String(invNoRaw || "").trim();
  if (!invNo) return;
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const rows = (db.purch || [])
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => String(p.invNo || "").trim() === invNo)
    .sort((a, b) => String(a.p.date || "").localeCompare(String(b.p.date || "")));
  if (!rows.length) return alert("Qaimə tapılmadı.");
  const body = rows
    .map(({ p, idx }, i) => {
      const isBulk = purchIsBulk(p);
      const qty = isBulk ? Math.max(1, Math.floor(n(p.qty || 1))) : 1;
      const unit = isBulk ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : n(p.amount) / qty) : n(p.amount);
      return `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(p.name || "-")}</td>
        <td>${escapeHtml(p.imei1 || "-")}</td>
        <td>${escapeHtml(p.imei2 || "-")}</td>
        <td>${escapeHtml(p.seria || "-")}</td>
        <td>${escapeHtml(p.code || "-")}</td>
        <td>${qty}</td>
        <td>${money(unit)} AZN</td>
        <td>${money(p.amount)} AZN</td>
        <td class="tbl-actions">
          <button class="icon-btn edit" type="button" onclick="closeMdl();openPurch(${idx})" title="Redaktə"><i class="fas fa-pen"></i></button>
          ${userCanDelete("purch") ? `<button class="icon-btn delete" type="button" onclick="delPurchInvoiceRow(${idx}, '${escapeAttr(invNo)}')" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  openModal(`
    <h2>Qaimə redaktəsi — ${escapeHtml(invNo)}</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Məhsul</th><th>IMEI 1</th><th>IMEI 2</th><th>Seriya</th><th>Kod</th><th>Say</th><th>1 ədəd</th><th>Məbləğ</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function delPurchInvoiceRow(idx, invNoRaw) {
  const invNo = String(invNoRaw || "").trim();
  const p = db.purch[idx];
  if (!p) return;
  if (!userCanDelete("purch")) return alert("Sil icazəsi yoxdur.");
  if (n(p.paidTotal) > 0.000001) return alert("Bu məhsul sətrində ödəniş var. Silmək olmaz.");
  if (!canDeletePurchase(p)) return alert("Bu məhsul satılıb. Silmək olmaz.");
  appConfirm("Bu məhsul sətri silinsin?").then((ok) => {
    if (!ok) return;
    ensureAuditTrash();
    const u = currentUser();
    const deletedBy = u ? u.username : "-";
    const deletedAt = nowISODateTimeLocal();
    db.trash.push({ uid: genId(db.trash, 1), type: "purch", item: p, deletedAt, deletedBy });
    logEvent("delete", "purch", { uid: p.uid, invNo });
    db.purch.splice(idx, 1);
    saveDB();
    const left = (db.purch || []).some((x) => String(x.invNo || "").trim() === invNo);
    if (left) openPurchInvoiceEdit(invNo);
    else closeMdl();
  });
}

function delPurchInvoice(invNoRaw) {
  const invNo = String(invNoRaw || "").trim();
  if (!invNo) return;
  if (!userCanDelete("purch")) return alert("Sil icazəsi yoxdur.");
  const rows = (db.purch || [])
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => String(p.invNo || "").trim() === invNo);
  if (!rows.length) return alert("Qaimə tapılmadı.");
  for (const { p } of rows) {
    if (n(p.paidTotal) > 0.000001) return alert("Bu qaimədə ödəniş olan alış var. Silmək olmaz.");
    if (!canDeletePurchase(p)) return alert("Bu qaimədə satılmış məhsul var. Silmək olmaz.");
  }
  appConfirm(`Qaimə silinsin? (${invNo})`).then((ok) => {
    if (!ok) return;
    ensureAuditTrash();
    const u = currentUser();
    const deletedBy = u ? u.username : "-";
    const deletedAt = nowISODateTimeLocal();
    rows
      .slice()
      .sort((a, b) => b.idx - a.idx)
      .forEach(({ p, idx }) => {
        db.trash.push({ uid: genId(db.trash, 1), type: "purch", item: p, deletedAt, deletedBy });
        logEvent("delete", "purch", { uid: p.uid, invNo });
        db.purch.splice(idx, 1);
      });
    saveDB();
  });
}

function openReturnPurch(idx) {
  if (!userCanEdit()) return alert("İcazə yoxdur.");
  const p = db.purch[idx];
  if (!p) return;
  if (p.returnedAt) return alert("Bu alış artıq qaytarılıb.");
  if (!canDeletePurchase(p)) return alert("Bu alış satılıb (və ya say ilə satış edilib). Qaytarmaq olmaz.");
  openModal(`
    <h2>Alış qaytarma</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(p.supp || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(p.name || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ</div><div class="info-value">${money(p.amount)} AZN</div></div>
    </div>
    <form onsubmit="saveReturnPurch(event, ${idx})">
      <div class="grid-3">
        <input type="datetime-local" id="pret_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="pret_refund" class="span-2" placeholder="Geri qaytarılan məbləğ (AZN) (0 ola bilər)">
        <select id="pret_acc" class="span-3" required>${accountOptionsHtml(1)}</select>
        <input id="pret_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-cancel" type="button" onclick="closeMdl();openPurchInfo(${idx})">Geri</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveReturnPurch(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return;
  const p = db.purch[idx];
  if (!p) return;
  if (p.returnedAt) return alert("Bu alış artıq qaytarılıb.");
  if (!canDeletePurchase(p)) return alert("Bu alış satılıb (və ya say ilə satış edilib). Qaytarmaq olmaz.");
  const date = val("pret_date");
  const refund = Math.max(0, n(val("pret_refund")));
  const accId = Number(val("pret_acc") || 1);
  const note = val("pret_note");
  if (refund > 0.000001) {
    addCashOp({
      type: "in",
      date,
      source: `Alış qaytarma (${p.supp || "-"})`,
      amount: refund,
      note: note || `Alış qaytarma #${p.uid}`,
      link: { kind: "purch_return_refund", purchUid: p.uid },
      meta: { purchUid: p.uid },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "in", kind: "purch_return_refund", purchUid: p.uid, amount: refund });
  }
  p.returnedAt = date;
  p.returnNote = note || "";
  logEvent("return", "purch", { uid: p.uid, invNo: p.invNo || invFallback("purch", p.uid), refund });
  saveDB();
  closeMdl();
}

function openPurch(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const p =
    idx !== null
      ? db.purch[idx]
      : { date: nowISODateTimeLocal(), supp: "", name: "", code: "", qty: 1, imei1: "", imei2: "", seria: "", amount: "", unitPrice: "", paidTotal: "0", payType: "nagd", employeeId: "", paymentAccountId: 1 };

  const suppOptions = db.supp.map((s) => `<option value="${escapeAttr(s.co)}" ${p.supp === s.co ? "selected" : ""}>${escapeHtml(s.co)}</option>`).join("");
  const prodOptions = db.prod.map((x) => `<option value="${escapeAttr(x.name)}" ${p.name === x.name ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
  const staffOptions = `<option value="">— Əməkdaş seçin —</option>` + (db.staff || []).map((s) => `<option value="${s.uid}" ${String(p.employeeId || "") === String(s.uid) ? "selected" : ""}>${escapeHtml(s.name)}${s.role ? " – " + escapeHtml(s.role) : ""}</option>`).join("");
  ensureAccounts();
  const payAccOptions = accountOptionsHtml(Number(p.paymentAccountId || 1));
  const invVal = idx !== null ? (p.invNo || invFallback("purch", p.uid)) : previewInvNo("purch");
  window.__purchDraftItems = [];

  const isBulk = purchIsBulk(p);
  const prefUnit = isBulk ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1)))) : n(p.amount);
  openModal(`
    <h2>${idx !== null ? "Alış Redaktə" : "Yeni Alış"}</h2>
    <form onsubmit="savePurch(event, ${idx})">
      <div class="grid-3">
        <input id="f_p_inv" class="span-3" value="${escapeAttr(invVal)}" placeholder="Qaimə № (auto)" readonly required>
        <input type="datetime-local" id="f_p_date" value="${escapeAttr(p.date)}" required>
        <select id="f_p_supp" class="span-2" required>
          <option value="">Təchizatçı seç</option>
          ${suppOptions}
        </select>
        <select id="f_p_staff" class="span-3">${staffOptions}</select>

        <select id="f_p_prod" class="span-3" ${idx !== null ? "required" : ""}>
          <option value="">Məhsul seç</option>
          ${prodOptions}
        </select>

        <div class="span-3 paybox">
          <label class="chk">
            <input type="checkbox" id="f_p_bulk" onchange="togglePurchBulk()" ${purchIsBulk(p) ? "checked" : ""}>
            <span>Say ilə alış (IMEI/Seriyasız)</span>
          </label>
        </div>

        <div id="pBulkBox" class="grid-3 span-3" style="display:none;">
          <input id="f_p_code" class="span-2" value="${escapeHtml(p.code || "")}" placeholder="Kod (məs: IP16PM-256)">
          <input type="number" step="1" min="1" id="f_p_qty" value="${escapeAttr(String(p.qty || 1))}" placeholder="Say">
        </div>

        <div id="pSerialBox" class="grid-3 span-3" style="display:none;">
          <input id="f_p_i1" value="${escapeHtml(p.imei1 || "")}" placeholder="IMEI 1">
          <input id="f_p_i2" value="${escapeHtml(p.imei2 || "")}" placeholder="IMEI 2">
          <input id="f_p_ser" value="${escapeHtml(p.seria || "")}" placeholder="Seriya №">
        </div>

        <input type="number" step="0.01" id="f_p_amount" value="${escapeAttr(isBulk ? String(prefUnit) : String(p.amount))}" placeholder="${isBulk ? "1 ədəd qiymət (AZN)" : "Məbləğ (AZN)"}" class="span-2" ${idx !== null ? "required" : ""}>
        <select id="f_p_payType">
          <option value="nagd" ${p.payType === "nagd" ? "selected" : ""}>nagd</option>
          <option value="kocurme" ${p.payType === "kocurme" ? "selected" : ""}>kocurme</option>
          <option value="kredit" ${p.payType === "kredit" ? "selected" : ""}>kredit</option>
        </select>
        <input type="number" step="0.01" id="f_p_paid" value="${escapeAttr(p.paidTotal || "0")}" placeholder="Ödənilən (AZN)">
        <select id="f_p_pay_acc" class="span-3">${payAccOptions}</select>
        <div id="pTotalHint" class="span-3 muted small" style="display:${isBulk ? "" : "none"}">Cəmi: —</div>
        ${idx === null ? `<div class="span-3 modal-footer" style="padding:0;justify-content:flex-start;border-top:none;">
          <button class="btn-secondary" type="button" onclick="addPurchDraftItem()"><i class="fas fa-plus"></i> Əlavə et</button>
        </div>
        <div class="span-3">
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Məhsul</th><th>Növ</th><th>Kod/IMEI</th><th>Say</th><th>Məbləğ</th><th></th></tr></thead>
              <tbody id="purchDraftList"><tr><td colspan="7">Məhsul əlavə edilməyib</td></tr></tbody>
              <tfoot><tr class="total-row"><td colspan="5">Maya dəyəri cəmi</td><td id="purchDraftTotal">0.00 AZN</td><td></td></tr></tfoot>
            </table>
          </div>
        </div>` : ""}
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Mədaxil et"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
  togglePurchBulk();
  const upd = () => {
    const bulk = !!byId("f_p_bulk")?.checked;
    const hint = byId("pTotalHint");
    if (!hint) return;
    if (!bulk) {
      hint.style.display = "none";
      return;
    }
    hint.style.display = "";
    const qty = Math.max(1, Math.floor(n(val("f_p_qty") || 1)));
    const unit = Math.max(0, n(val("f_p_amount") || 0));
    hint.textContent = `Cəmi: ${money(unit * qty)} AZN`;
  };
  byId("f_p_qty") && (byId("f_p_qty").oninput = upd);
  byId("f_p_amount") && (byId("f_p_amount").oninput = upd);
  byId("f_p_bulk") && (byId("f_p_bulk").onchange = () => { togglePurchBulk(); upd(); });
  upd();
  if (idx === null) renderPurchDraftItems();
}

function readPurchDraftFromForm() {
  const isBulk = !!byId("f_p_bulk")?.checked;
  const name = val("f_p_prod");
  if (!name) return { error: "Məhsul seçin." };
  const qty = isBulk ? Math.max(1, Math.floor(n(val("f_p_qty") || 1))) : 1;
  const unitOrAmount = Math.max(0, n(val("f_p_amount") || 0));
  if (unitOrAmount <= 0) return { error: "Məbləğ düzgün deyil." };
  const item = {
    isBulk,
    name,
    code: isBulk ? val("f_p_code").trim() : "",
    qty,
    imei1: isBulk ? "" : val("f_p_i1").trim(),
    imei2: isBulk ? "" : val("f_p_i2").trim(),
    seria: isBulk ? "" : val("f_p_ser").trim(),
    unitPrice: isBulk ? unitOrAmount : null,
    amount: isBulk ? unitOrAmount * qty : unitOrAmount,
  };
  if (!isBulk && !item.imei1 && !item.imei2 && !item.seria) return { error: "IMEI və ya Seriya daxil edin." };
  return { item };
}

function renderPurchDraftItems() {
  const tb = byId("purchDraftList");
  const totalEl = byId("purchDraftTotal");
  if (!tb || !totalEl) return;
  const arr = window.__purchDraftItems || [];
  if (!arr.length) {
    tb.innerHTML = `<tr><td colspan="7">Məhsul əlavə edilməyib</td></tr>`;
    totalEl.textContent = "0.00 AZN";
    return;
  }
  const total = arr.reduce((a, x) => a + n(x.amount), 0);
  tb.innerHTML = arr
    .map((x, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(x.name)}</td>
      <td>${x.isBulk ? "Sayla" : "Seriyalı"}</td>
      <td>${escapeHtml(x.isBulk ? (x.code || "-") : (x.imei1 || x.imei2 || x.seria || "-"))}</td>
      <td>${x.qty}</td>
      <td>${money(x.amount)} AZN</td>
      <td><button type="button" class="icon-btn delete" onclick="removePurchDraftItem(${i})"><i class="fas fa-trash"></i></button></td>
    </tr>`)
    .join("");
  totalEl.textContent = `${money(total)} AZN`;
}

function addPurchDraftItem() {
  const r = readPurchDraftFromForm();
  if (r.error) return alert(r.error);
  const arr = window.__purchDraftItems || [];
  arr.push(r.item);
  window.__purchDraftItems = arr;
  renderPurchDraftItems();
  if (r.item.isBulk) {
    byId("f_p_code").value = "";
    byId("f_p_qty").value = "1";
  } else {
    byId("f_p_i1").value = "";
    byId("f_p_i2").value = "";
    byId("f_p_ser").value = "";
  }
  byId("f_p_amount").value = "";
}

function removePurchDraftItem(i) {
  const arr = window.__purchDraftItems || [];
  if (i < 0 || i >= arr.length) return;
  arr.splice(i, 1);
  window.__purchDraftItems = arr;
  renderPurchDraftItems();
}

async function savePurch(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isNew = idx === null;
  const prevPaid = idx !== null ? n(db.purch[idx]?.paidTotal) : 0;
  if (isNew) {
    const draft = window.__purchDraftItems || [];
    if (!draft.length) return alert("Ən azı bir məhsul əlavə edin.");
    const supp = val("f_p_supp");
    if (!supp) return alert("Təchizatçı seçin.");
    const invNo = nextInvNo("purch");
    const date = val("f_p_date");
    const employeeId = (val("f_p_staff") || "").trim() || undefined;
    const actorName = currentActorName();
    const payType = val("f_p_payType");
    const paidTotal = Math.max(0, n(val("f_p_paid")));
    const paymentAccountId = Number(val("f_p_pay_acc") || 1);
    draft.forEach((it, i) => {
      const uid = genId(db.purch, 1);
      const row = {
        uid,
        invNo,
        date,
        supp,
        name: it.name,
        code: it.code || "",
        qty: Math.max(1, Math.floor(n(it.qty || 1))),
        imei1: it.isBulk ? "" : (it.imei1 || ""),
        imei2: it.isBulk ? "" : (it.imei2 || ""),
        seria: it.isBulk ? "" : (it.seria || ""),
        amount: String(Math.max(0, n(it.amount))),
        unitPrice: it.isBulk ? String(Math.max(0, n(it.unitPrice || 0))) : "",
        payType,
        paidTotal: String(i === 0 ? paidTotal : 0),
        employeeId,
        actorName,
        paymentAccountId,
      };
      db.purch.push(row);
      logEvent("create", "purch", { uid: row.uid, invNo: row.invNo });
    });
    if (paidTotal > 0.000001) {
      addCashOp({
        type: "out",
        date,
        source: `Təchizatçı ödənişi (${supp || "-"})`,
        amount: paidTotal,
        note: `Alış #${invNo}`,
        link: { kind: "purch_payment", purchUid: db.purch[db.purch.length - draft.length].uid },
        meta: { invNo },
        accountId: paymentAccountId,
      });
      logEvent("create", "cash", { type: "out", kind: "purch_payment", invNo, amount: paidTotal });
    }
    saveDB();
    closeMdl();
    return;
  }
  const isBulk = !!byId("f_p_bulk")?.checked;
  const qty = isBulk ? Math.max(1, Math.floor(n(val("f_p_qty")))) : 1;
  const code = isBulk ? val("f_p_code").trim() : "";
  const statusOfPurch = (p0) => {
    if (!p0) return "-";
    if (p0.returnedAt) return "QAYTARILIB";
    const remQty = purchRemainingQty(p0);
    if (remQty <= 0.000001) return "SATILIB";
    return "ANBARDA";
  };
  const warnExisting = (found, keyLabel, keyValue) => {
    if (!found) return true;
    const inv = found.invNo || invFallback("purch", found.uid);
    const st = statusOfPurch(found);
    const msg =
      `Diqqət: ${keyLabel} artıq sistemdə olub.\n` +
      `${keyLabel}: ${keyValue}\n` +
      `Status: ${st}\n` +
      `Alış: ${inv} • ${found.supp || "-"} • ${String(found.date || "").slice(0, 16)}\n\n` +
      `Yenə də bu alışı əlavə edək?`;
    return false; // async confirm below
  };

  if (!isBulk) {
    const imei1 = val("f_p_i1").trim();
    const imei2 = val("f_p_i2").trim();
    const seria = val("f_p_ser").trim();
    const findMatch = (pred) => (db.purch || []).find((p, pi) => !(idx !== null && pi === idx) && pred(p));
    const m1 = imei1 ? findMatch((p) => String(p.imei1 || "").trim() === imei1) : null;
    if (m1) {
      const inv = m1.invNo || invFallback("purch", m1.uid);
      const st = m1.returnedAt ? "QAYTARILIB" : (purchRemainingQty(m1) <= 0.000001 ? "SATILIB" : "ANBARDA");
      const msg =
        `Diqqət: IMEI 1 artıq sistemdə olub.\nIMEI 1: ${imei1}\nStatus: ${st}\nAlış: ${inv} • ${m1.supp || "-"} • ${String(m1.date || "").slice(0, 16)}\n\nYenə də bu alışı əlavə edək?`;
      const ok = await appConfirm(msg);
      if (!ok) return;
    }
    const m2 = !m1 && imei2 ? findMatch((p) => String(p.imei2 || "").trim() === imei2) : null;
    if (m2) {
      const inv = m2.invNo || invFallback("purch", m2.uid);
      const st = m2.returnedAt ? "QAYTARILIB" : (purchRemainingQty(m2) <= 0.000001 ? "SATILIB" : "ANBARDA");
      const msg =
        `Diqqət: IMEI 2 artıq sistemdə olub.\nIMEI 2: ${imei2}\nStatus: ${st}\nAlış: ${inv} • ${m2.supp || "-"} • ${String(m2.date || "").slice(0, 16)}\n\nYenə də bu alışı əlavə edək?`;
      const ok = await appConfirm(msg);
      if (!ok) return;
    }
    const m3 = !m1 && !m2 && seria ? findMatch((p) => String(p.seria || "").trim() === seria) : null;
    if (m3) {
      const inv = m3.invNo || invFallback("purch", m3.uid);
      const st = m3.returnedAt ? "QAYTARILIB" : (purchRemainingQty(m3) <= 0.000001 ? "SATILIB" : "ANBARDA");
      const msg =
        `Diqqət: Seriya artıq sistemdə olub.\nSeriya: ${seria}\nStatus: ${st}\nAlış: ${inv} • ${m3.supp || "-"} • ${String(m3.date || "").slice(0, 16)}\n\nYenə də bu alışı əlavə edək?`;
      const ok = await appConfirm(msg);
      if (!ok) return;
    }
  } else {
    const codeNorm = String(code || "").trim();
    if (codeNorm) {
      const m = (db.purch || []).find((p, pi) => !(idx !== null && pi === idx) && String(p.code || "").trim() === codeNorm);
      if (m) {
        const inv = m.invNo || invFallback("purch", m.uid);
        const st = m.returnedAt ? "QAYTARILIB" : (purchRemainingQty(m) <= 0.000001 ? "SATILIB" : "ANBARDA");
        const msg =
          `Diqqət: Kod artıq sistemdə olub.\nKod: ${codeNorm}\nStatus: ${st}\nAlış: ${inv} • ${m.supp || "-"} • ${String(m.date || "").slice(0, 16)}\n\nYenə də bu alışı əlavə edək?`;
        const ok = await appConfirm(msg);
        if (!ok) return;
      }
    }
  }
  const employeeId = (val("f_p_staff") || "").trim() || undefined;
  const actorName = currentActorName();
  const unitPrice = isBulk ? Math.max(0, n(val("f_p_amount"))) : null;
  const totalAmount = isBulk ? unitPrice * qty : Math.max(0, n(val("f_p_amount")));
  const finalInvNo = (() => {
    if (idx !== null) return db.purch[idx].invNo || invFallback("purch", db.purch[idx].uid);
    return nextInvNo("purch");
  })();
  const data = {
    uid: idx !== null ? db.purch[idx].uid : genId(db.purch, 1),
    invNo: finalInvNo,
    date: val("f_p_date"),
    supp: val("f_p_supp"),
    name: val("f_p_prod"),
    code,
    qty,
    imei1: isBulk ? "" : val("f_p_i1").trim(),
    imei2: isBulk ? "" : val("f_p_i2").trim(),
    seria: isBulk ? "" : val("f_p_ser").trim(),
    amount: String(Math.max(0, totalAmount)),
    unitPrice: isBulk ? String(unitPrice) : (idx !== null ? (db.purch[idx]?.unitPrice ?? "") : ""),
    payType: val("f_p_payType"),
    paidTotal: String(Math.max(0, n(val("f_p_paid")))),
    employeeId,
    actorName,
    paymentAccountId: Number(val("f_p_pay_acc") || (idx !== null ? db.purch[idx]?.paymentAccountId : 1) || 1),
  };
  if (idx !== null) db.purch[idx] = data;
  else db.purch.push(data);
  logEvent(isNew ? "create" : "update", "purch", { uid: data.uid, invNo: data.invNo });

  // If user entered "paid" in purchase form, reflect it in cash as an outflow.
  // (Default account is cash=1; detailed account selection can be handled from Cash module.)
  const nextPaid = n(data.paidTotal);
  const deltaPaid = nextPaid - prevPaid;
  if (Math.abs(deltaPaid) > 0.000001) {
    const date = data.date || nowISODateTimeLocal();
    const accId = Number(data.paymentAccountId || 1);
    if (deltaPaid > 0) {
      addCashOp({
        type: "out",
        date,
        source: `Təchizatçı ödənişi (${data.supp || "-"})`,
        amount: deltaPaid,
        note: `Alış #${data.uid} (${data.invNo || invFallback("purch", data.uid)})`,
        link: { kind: "purch_payment", purchUid: data.uid },
        meta: { purchUid: data.uid },
        accountId: accId,
      });
      logEvent("create", "cash", { type: "out", kind: "purch_payment", purchUid: data.uid, amount: deltaPaid });
    } else {
      // paid reduced -> treat as returned cash from supplier back to cash
      addCashOp({
        type: "in",
        date,
        source: `Təchizatçı qaytarma (${data.supp || "-"})`,
        amount: Math.abs(deltaPaid),
        note: `Alış ödəniş düzəlişi #${data.uid} (${data.invNo || invFallback("purch", data.uid)})`,
        link: { kind: "purch_payment_adj", purchUid: data.uid },
        meta: { purchUid: data.uid },
        accountId: accId,
      });
      logEvent("create", "cash", { type: "in", kind: "purch_payment_adj", purchUid: data.uid, amount: Math.abs(deltaPaid) });
    }
  }

  saveDB();
  closeMdl();
}

function togglePurchBulk() {
  const bulk = !!byId("f_p_bulk")?.checked;
  const b = byId("pBulkBox");
  const s = byId("pSerialBox");
  if (b) b.style.display = bulk ? "" : "none";
  if (s) s.style.display = bulk ? "none" : "";
  const qtyEl = byId("f_p_qty");
  if (qtyEl) qtyEl.required = bulk;
}

function toggleSaleQty() {
  const sel = byId("f_s_item")?.value || "";
  const isBulk = String(sel).startsWith("bulk:") || String(sel).startsWith("fifo:");
  const box = byId("saleQtyBox");
  const qtyEl = byId("f_s_qty");
  if (box) box.style.display = isBulk ? "" : "none";
  if (qtyEl) {
    qtyEl.required = isBulk;
    if (!isBulk) qtyEl.value = "1";
    if (isBulk && (!qtyEl.value || Number(qtyEl.value) <= 0)) qtyEl.value = "1";
  }
}

// ========= Customer/Supplier Info =========
function openCustInfo(idx) {
  const c = db.cust[idx];
  if (!c) return;
  const guarantor = c.zam ? db.cust.find((x) => String(x.uid) === String(c.zam)) : null;
  openModal(`
    <h2>Müştəri məlumatı</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">ID</div><div class="info-value">${c.uid}</div></div>
      <div class="info-row"><div class="info-label">Ad Soyad Ata</div><div class="info-value">${escapeHtml(`${c.sur} ${c.name} ${c.father}`.trim())}</div></div>
      <div class="info-row"><div class="info-label">Mobil 1</div><div class="info-value">${escapeHtml(c.ph1 || "-")}</div></div>
      <div class="info-row"><div class="info-label">Mobil 2</div><div class="info-value">${escapeHtml(c.ph2 || "-")}</div></div>
      <div class="info-row"><div class="info-label">Mobil 3</div><div class="info-value">${escapeHtml(c.ph3 || "-")}</div></div>
      <div class="info-row"><div class="info-label">İş yeri</div><div class="info-value">${escapeHtml(c.work || "-")}</div></div>
      <div class="info-row"><div class="info-label">FİN</div><div class="info-value">${escapeHtml(c.fin || "-")}</div></div>
      <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(c.seriaNum || "-")}</div></div>
      <div class="info-row"><div class="info-label">Ünvan</div><div class="info-value">${escapeHtml(c.addr || "-")}</div></div>
      <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${guarantor ? escapeHtml(`${guarantor.sur} ${guarantor.name} (${guarantor.uid})`) : "-"}</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openCust(${idx})">Redaktə</button>
      <button class="btn-cancel" type="button" onclick="openCustStatement(${idx})">Hesab çıxarışı</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSuppInfo(idx) {
  const s = db.supp[idx];
  if (!s) return;
  openModal(`
    <h2>Təchizatçı məlumatı</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">ID</div><div class="info-value">${s.uid}</div></div>
      <div class="info-row"><div class="info-label">Şirkət</div><div class="info-value">${escapeHtml(s.co || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məsul şəxs</div><div class="info-value">${escapeHtml(s.per || "-")}</div></div>
      <div class="info-row"><div class="info-label">Mobil</div><div class="info-value">${escapeHtml(s.mob || "-")}</div></div>
      <div class="info-row"><div class="info-label">VÖEN</div><div class="info-value">${escapeHtml(s.voen || "-")}</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openSupp(${idx})">Redaktə</button>
      <button class="btn-cancel" type="button" onclick="openSuppStatement(${idx})">Hesab çıxarışı</button>
      <button class="btn-cancel" type="button" onclick="openSupplierPaymentHistory(${idx})">Ödəniş tarixçəsi</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openPrintWindow(title, html) {
  const w = window.open("", "_blank");
  if (!w) return alert("Print üçün popup bloklandı.");
  const css = `
    <style>
      body{font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:24px;color:#111827;}
      h1{font-size:18px;margin:0 0 12px;}
      .muted{color:#6b7280;}
      .meta{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 16px;}
      .meta div{font-size:12px;}
      table{width:100%;border-collapse:collapse;margin-top:10px;}
      th,td{border:1px solid #e5e7eb;padding:8px 10px;font-size:12px;vertical-align:top;}
      th{background:#f9fafb;text-align:left;}
      .right{text-align:right;}
      .neg{color:#b91c1c;}
      .pos{color:#1a4754;}
      @media print{button{display:none !important;} body{margin:0;}}
    </style>
  `;
  w.document.open();
  w.document.write(`<html><head><title>${escapeHtml(title)}</title>${css}</head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}

function openCustStatement(idx) {
  const c = db.cust[idx];
  if (!c) return;
  const cid = String(c.uid);
  const from = (byId("custFrom")?.value || "").trim();
  const to = (byId("custTo")?.value || "").trim();

  const items = [];
  (db.sales || [])
    .filter((s) => String(s.customerId) === cid)
    .forEach((s) => {
      const inv = s.invNo || invFallback("sales", s.uid);
      const dt = String(s.date || "");
      const returned = !!s.returnedAt;
      items.push({
        date: dt,
        kind: returned ? "Satış (qaytarılıb)" : "Satış",
        ref: inv,
        debit: returned ? 0 : n(s.amount),
        credit: 0,
        note: `${s.productName || "-"}${s.qty && n(s.qty) > 1 ? ` • SAY:${s.qty}` : ""}`,
      });
      (s.payments || []).forEach((p) => {
        items.push({
          date: String(p.date || dt),
          kind: "Ödəniş",
          ref: inv,
          debit: 0,
          credit: n(p.amount),
          note: p.source ? String(p.source) : "",
        });
      });
    });

  const inRange = (d) => {
    const dd = String(d || "").slice(0, 10);
    if (from && dd < from) return false;
    if (to && dd > to) return false;
    return true;
  };
  const rows = items
    .filter((x) => inRange(x.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((x) => x)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let bal = 0;
  const tr = rows
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((x, i) => {
      bal += n(x.debit) - n(x.credit);
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtDT(x.date)}</td>
          <td>${escapeHtml(x.kind)}</td>
          <td>${escapeHtml(x.ref || "-")}</td>
          <td>${escapeHtml(x.note || "")}</td>
          <td class="right">${x.debit ? money(x.debit) : ""}</td>
          <td class="right">${x.credit ? money(x.credit) : ""}</td>
          <td class="right">${money(bal)}</td>
        </tr>
      `;
    })
    .join("");

  const title = `Müştəri hesab çıxarışı`;
  const name = `${c.sur || ""} ${c.name || ""} ${c.father || ""}`.trim() || String(c.uid);
  const head = `
    <div class="statement-head">
      <div class="info-block">
        <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(name)} (${escapeHtml(String(c.uid))})</div></div>
        <div class="info-row"><div class="info-label">Tarix aralığı</div><div class="info-value">${escapeHtml(from || "-")} — ${escapeHtml(to || "-")}</div></div>
        <div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value"><strong>${money(bal)} AZN</strong></div></div>
      </div>
    </div>
  `;
  openModal(`
    <h2>${title}</h2>
    ${head}
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Tip</th><th>Qaimə</th><th>Qeyd</th><th>Məbləğ</th><th>Ödəniş</th><th>Balans</th></tr></thead>
        <tbody>${tr || emptyRow(8)}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openPrintWindow('${escapeAttr(title)}', document.querySelector('#modalContent')?.innerHTML || '')">Print</button>
      <button class="btn-cancel" type="button" onclick="openCustInfo(${idx})">Geri</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSuppStatement(idx) {
  const s = db.supp[idx];
  if (!s) return;
  const suppName = String(s.co || "");
  const from = (byId("repFrom")?.value || "").trim();
  const to = (byId("repTo")?.value || "").trim();

  const items = [];
  (db.purch || [])
    .filter((p) => String(p.supp || "") === suppName)
    .forEach((p) => {
      const inv = p.invNo || invFallback("purch", p.uid);
      const returned = !!p.returnedAt;
      items.push({
        date: String(p.date || ""),
        kind: returned ? "Alış (qaytarılıb)" : "Alış",
        ref: inv,
        debit: returned ? 0 : n(p.amount),
        credit: 0,
        note: p.name || "-",
      });
    });
  (db.cash || [])
    .filter((c) => c.type === "out")
    .filter((c) => c.link && (c.link.kind === "purch_payment" || c.link.kind === "creditor_payment" || c.link.kind === "creditor_invoice_payment"))
    .filter((c) => String(c.link.supp || c.link?.supp || c.link?.suppName || c.link?.supplier || c.link?.supplierName || "") === suppName || String(c.link.supp || "") === suppName)
    .forEach((c) => {
      items.push({
        date: String(c.date || ""),
        kind: "Ödəniş",
        ref: c.link?.purchUid ? (invFallback("purch", c.link.purchUid)) : "-",
        debit: 0,
        credit: n(c.amount),
        note: c.note || "",
      });
    });

  const inRange = (d) => {
    const dd = String(d || "").slice(0, 10);
    if (from && dd < from) return false;
    if (to && dd > to) return false;
    return true;
  };

  let bal = 0;
  const tr = items
    .filter((x) => inRange(x.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((x, i) => {
      bal += n(x.debit) - n(x.credit);
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtDT(x.date)}</td>
          <td>${escapeHtml(x.kind)}</td>
          <td>${escapeHtml(x.ref || "-")}</td>
          <td>${escapeHtml(x.note || "")}</td>
          <td class="right">${x.debit ? money(x.debit) : ""}</td>
          <td class="right">${x.credit ? money(x.credit) : ""}</td>
          <td class="right">${money(bal)}</td>
        </tr>
      `;
    })
    .join("");

  const title = `Təchizatçı hesab çıxarışı`;
  openModal(`
    <h2>${title}</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(suppName)} (${escapeHtml(String(s.uid))})</div></div>
      <div class="info-row"><div class="info-label">Tarix aralığı</div><div class="info-value">${escapeHtml(from || "-")} — ${escapeHtml(to || "-")}</div></div>
      <div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value"><strong>${money(bal)} AZN</strong></div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Tip</th><th>Qaimə</th><th>Qeyd</th><th>Məbləğ</th><th>Ödəniş</th><th>Balans</th></tr></thead>
        <tbody>${tr || emptyRow(8)}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openPrintWindow('${escapeAttr(title)}', document.querySelector('#modalContent')?.innerHTML || '')">Print</button>
      <button class="btn-cancel" type="button" onclick="openSuppInfo(${idx})">Geri</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSupplierPaymentHistory(idx) {
  const s = db.supp[idx];
  if (!s) return;

  const rows = db.cash
    .filter((c) => c.type === "out")
    .filter((c) => c.link && (c.link.kind === "creditor_payment" || c.link.kind === "creditor_invoice_payment"))
    .filter((c) => String(c.link.supp) === String(s.co))
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .flatMap((c) => {
      const allocs = c.meta?.allocations?.length
        ? c.meta.allocations
        : [{ purchUid: c.link?.purchUid ?? "-", amount: c.amount }];
      return allocs.map(
        (a) => `
        <tr>
          <td>${c.uid}</td>
          <td>${fmtDT(c.date)}</td>
          <td>${a.purchUid ?? "-"}</td>
          <td class="amt-out">-${money(a.amount)} AZN</td>
          <td>${escapeHtml(c.note || "")}</td>
        </tr>`
      );
    })
    .join("");

  openModal(`
    <h2>Təchizatçı ödəniş tarixçəsi</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(s.co)}</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Əməliyyat</th><th>Tarix</th><th>Qaimə</th><th>Məbləğ</th><th>Qeyd</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">Tarixçə boşdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="openSuppInfo(${idx})">Geri</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

// ========= Staff =========
function openStaff(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const s = idx !== null ? db.staff[idx] : { name: "", role: "", phone: "", baseSalary: "0", commPct: "0" };
  openModal(`
    <h2>${idx !== null ? "Əməkdaş Redaktə" : "Yeni Əməkdaş"}</h2>
    <form onsubmit="saveStaff(event, ${idx})">
      <div class="grid-3">
        <input id="f_st_name" value="${escapeHtml(s.name)}" placeholder="Ad Soyad" class="span-3" required>
        <input id="f_st_role" value="${escapeHtml(s.role || "")}" placeholder="Vəzifə" class="span-2">
        <input id="f_st_phone" value="${escapeHtml(s.phone || "")}" placeholder="Telefon">
        <input type="number" step="0.01" id="f_st_salary" value="${escapeAttr(String(s.baseSalary ?? "0"))}" class="span-2" placeholder="Standart maaş (AZN)">
        <input type="number" step="0.01" id="f_st_comm" value="${escapeAttr(String(s.commPct ?? "0"))}" placeholder="Satışdan faiz (%)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Yadda saxla"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveStaff(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isNew = idx === null;
  const actorName = currentActorName();
  const data = {
    uid: idx !== null ? db.staff[idx].uid : genId(db.staff, 1),
    createdAt: idx !== null ? (db.staff[idx].createdAt || db.staff[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    name: val("f_st_name"),
    role: val("f_st_role"),
    phone: val("f_st_phone"),
    baseSalary: String(Math.max(0, n(val("f_st_salary")))),
    commPct: String(Math.max(0, n(val("f_st_comm")))),
    actorName,
  };
  if (idx !== null) db.staff[idx] = data;
  else db.staff.push(data);
  logEvent(isNew ? "create" : "update", "staff", { uid: data.uid });
  saveDB();
  closeMdl();
}

// ========= Əməkhaqqı hesabla (əməkdaşlar bölməsindən) =========
function openStaffPayrollCalc() {
  const d = new Date();
  const currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  openModal(`
    <h2>Əməkhaqqı hesabı</h2>
    <p class="muted">Seçilmiş ay üçün hər əməkdaşın baza maaşı + satışdan faiz (bonus) ilə yekun məbləğ.</p>
    <div class="grid-3" style="margin-bottom:14px;">
      <label style="display:flex;align-items:center;gap:8px;">
        <span>Ay:</span>
        <input type="month" id="payrollCalcMonth" value="${currentMonth}" onchange="updateStaffPayrollTable()" class="select-small">
      </label>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Əməkdaş</th><th>Baza maaş</th><th>Satış cəmi (ay)</th><th>Faiz %</th><th>Komissiya</th><th>Yekun</th></tr></thead>
        <tbody id="staffPayrollTableBody"></tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
  updateStaffPayrollTable();
}

function updateStaffPayrollTable() {
  const monthKey = byId("payrollCalcMonth")?.value || "";
  const tbody = byId("staffPayrollTableBody");
  if (!tbody) return;
  if (!monthKey) {
    tbody.innerHTML = "<tr><td colspan=\"7\">Ay seçin</td></tr>";
    return;
  }
  const salesInMonth = (db.sales || [])
    .filter((s) => !s.returnedAt)
    .filter((s) => inMonth(s.date, monthKey));
  const byEmp = new Map();
  for (const s of salesInMonth) {
    const empId = String(s.employeeId || "");
    if (!empId) continue;
    byEmp.set(empId, (byEmp.get(empId) || 0) + n(s.amount));
  }
  const staffSorted = (db.staff || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  let grandTotal = 0;
  const rows = staffSorted
    .map((st, i) => {
      const salesSum = byEmp.get(String(st.uid)) || 0;
      const base = Math.max(0, n(st.baseSalary || 0));
      const pct = Math.max(0, n(st.commPct || 0));
      const comm = salesSum * (pct / 100);
      const total = base + comm;
      grandTotal += total;
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(st.name)}</td>
        <td>${money(base)} AZN</td>
        <td>${money(salesSum)} AZN</td>
        <td>${money(pct)}%</td>
        <td>${money(comm)} AZN</td>
        <td>${money(total)} AZN</td>
      </tr>`;
    })
    .join("");
  tbody.innerHTML = rows + (rows ? `<tr class="total-row"><td colspan="6"><strong>Cəmi</strong></td><td><strong>${money(grandTotal)} AZN</strong></td></tr>` : "<tr><td colspan=\"7\">Əməkdaş yoxdur</td></tr>");
}

// ========= Əməkdaş əməkhaqqı ödə (Ödə düyməsi) =========
function staffSalaryPaidForMonth(staffUid, monthKey) {
  return (db.cash || []).filter(
    (c) => c.type === "out" && c.link && c.link.kind === "staff_salary" && String(c.link.staffUid) === String(staffUid) && String(c.link.monthKey || "") === String(monthKey)
  ).reduce((a, c) => a + n(c.amount), 0);
}

function openStaffPay() {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const d = new Date();
  const currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  openModal(`
    <h2>Əməkhaqqı ödə</h2>
    <p class="muted">Ay seçin, sonra hər əməkdaş üçün "Rəsmi ödə" və ya "Nəğd ödə" ilə hesab seçib ödəniş edin. Ödəniş Kassa və Hesablar bölməsində əks olunacaq.</p>
    <div class="grid-3" style="margin-bottom:14px;">
      <label style="display:flex;align-items:center;gap:8px;">
        <span>Ay:</span>
        <input type="month" id="staffPayMonth" value="${currentMonth}" onchange="renderStaffPayList()" class="select-small">
      </label>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Əməkdaş</th><th>Hesablanmış əməkhaqqı</th><th>Ödənilib</th><th>Əməliyyat</th></tr></thead>
        <tbody id="staffPayListBody"></tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
  renderStaffPayList();
}

function renderStaffPayList() {
  const monthKey = byId("staffPayMonth")?.value || "";
  const tbody = byId("staffPayListBody");
  if (!tbody) return;
  if (!monthKey) {
    tbody.innerHTML = "<tr><td colspan=\"5\">Ay seçin</td></tr>";
    return;
  }
  const salesInMonth = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => inMonth(s.date, monthKey));
  const byEmp = new Map();
  for (const s of salesInMonth) {
    const empId = String(s.employeeId || "");
    if (!empId) continue;
    byEmp.set(empId, (byEmp.get(empId) || 0) + n(s.amount));
  }
  const staffSorted = (db.staff || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const rows = staffSorted
    .map((st, i) => {
      const salesSum = byEmp.get(String(st.uid)) || 0;
      const base = Math.max(0, n(st.baseSalary || 0));
      const pct = Math.max(0, n(st.commPct || 0));
      const comm = salesSum * (pct / 100);
      const total = base + comm;
      const paid = staffSalaryPaidForMonth(st.uid, monthKey);
      const paidLabel = paid > 0.000001 ? `${money(paid)} AZN ödənilib` : "—";
      const staffNameJson = JSON.stringify(st.name || "");
      const monthKeyJson = JSON.stringify(monthKey);
      const onclickResmi = `closeMdl(); openStaffPayConfirm(${st.uid}, ${staffNameJson}, ${total}, ${monthKeyJson}, 'resmi')`;
      const onclickNagd = `closeMdl(); openStaffPayConfirm(${st.uid}, ${staffNameJson}, ${total}, ${monthKeyJson}, 'nagd')`;
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(st.name)}</td>
        <td>${money(total)} AZN</td>
        <td>${paidLabel}</td>
        <td class="tbl-actions">
          <button class="btn-mini" type="button" onclick="${escapeAttr(onclickResmi)}">Rəsmi ödə</button>
          <button class="btn-mini" type="button" onclick="${escapeAttr(onclickNagd)}">Nəğd ödə</button>
        </td>
      </tr>`;
    })
    .join("");
  tbody.innerHTML = rows || "<tr><td colspan=\"5\">Əməkdaş yoxdur</td></tr>";
}

function openStaffPayConfirm(staffUid, staffName, amount, monthKey, payType) {
  const payLabel = payType === "resmi" ? "Rəsmi ödəniş" : "Nəğd ödəniş";
  ensureAccounts();
  const accOptions = accountOptionsHtml(1);
  const amt = Math.max(0, n(amount));
  const dateVal = nowISODateTimeLocal().slice(0, 16);
  openModal(`
    <h2>Əməkhaqqı: ${escapeHtml(staffName)} — ${payLabel}</h2>
    <form onsubmit="submitStaffPay(event, ${escapeAttr(String(staffUid))}, ${escapeAttr(JSON.stringify(staffName))}, ${amt}, ${escapeAttr(JSON.stringify(monthKey))}, '${payType}')">
      <div class="grid-3">
        <label class="span-3">Hesab (ödənişin çıxılacağı)</label>
        <select id="staff_pay_acc" class="span-3" required>${accOptions}</select>
        <label class="span-3">Məbləğ (AZN)</label>
        <input type="number" step="0.01" min="0" id="staff_pay_amount" value="${amt}" class="span-2" required>
        <label class="span-3">Tarix</label>
        <input type="datetime-local" id="staff_pay_date" value="${dateVal}" class="span-3" required>
        <label class="span-3">Qeyd (istəyə bağlı)</label>
        <input type="text" id="staff_pay_note" placeholder="Məs: 2024-01 əməkhaqqı" class="span-3">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Ödəniş et</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function submitStaffPay(e, staffUid, staffName, defaultAmount, monthKey, payType) {
  e.preventDefault();
  if (!userCanPay()) return;
  const accId = Number(val("staff_pay_acc") || 1);
  const amount = Math.max(0, n(val("staff_pay_amount")));
  const date = val("staff_pay_date") || nowISODateTimeLocal();
  const note = (val("staff_pay_note") || "").trim() || `Əməkhaqqı ${monthKey} (${payType === "resmi" ? "rəsmi" : "nəğd"})`;
  if (amount <= 0.000001) return alert("Məbləğ 0-dan böyük olmalıdır.");
  const bal = accountBalance(accId);
  if (bal + 0.000001 < amount) {
    alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
    return;
  }
  const payLabel = payType === "resmi" ? "Rəsmi" : "Nəğd";
  addCashOp({
    type: "out",
    date,
    source: `Əməkhaqqı (${staffName}) — ${payLabel}`,
    amount,
    note,
    link: { kind: "staff_salary", staffUid, staffName, monthKey, payType },
    accountId: accId,
  });
  logEvent("create", "cash", { type: "out", kind: "staff_salary", staffUid, monthKey, amount });
  saveDB();
  closeMdl();
  renderAll();
  toast(`Əməkhaqqı ödənildi: ${amount} AZN`, "ok");
}

// ========= Sales (with credit fields) =========
function openSale(idx = null) {
  if (idx !== null && !userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isEdit = idx !== null;
  const current = isEdit ? db.sales[idx] : null;

  const sold = soldKeySet();
  const stockItems = db.purch
    .map((p) => {
      const type = purchIsBulk(p) ? "bulk" : "serial";
      const key = itemKeyFromPurch(p);
      const rem = purchRemainingQty(p);
      return { p, type, key, rem };
    })
    .filter((x) => {
      if (isEdit && current) {
        if (x.type === "bulk" && String(current.bulkPurchUid || "") === String(x.p.uid)) return true;
        if (x.type === "bulk" && Array.isArray(current.bulkAllocations) && current.bulkAllocations.some((a) => String(a.purchUid) === String(x.p.uid))) return true;
        if (x.type === "serial" && current.itemKey === x.key) return true;
      }
      return x.rem > 0;
    });

  const fifoGroups = new Map();
  stockItems
    .filter((x) => x.type === "bulk")
    .forEach((x) => {
      const code = String(x.p.code || "").trim();
      const name = String(x.p.name || "").trim();
      const key = (code || name || "-").replace(/:/g, "_");
      if (!fifoGroups.has(key)) fifoGroups.set(key, { key, code, name, rem: 0 });
      const g = fifoGroups.get(key);
      g.rem += Math.max(0, n(x.rem));
    });

  const custOptions =
    `<option value="">Müştəri seç</option>` +
    db.cust.map((c) => `<option value="${c.uid}">${escapeHtml(c.sur)} ${escapeHtml(c.name)} (${c.uid})</option>`).join("");
  const staffOptions =
    `<option value="">Əməkdaş seç</option>` +
    db.staff.map((s) => `<option value="${s.uid}">${escapeHtml(s.name)}${s.role ? " - " + escapeHtml(s.role) : ""}</option>`).join("");

  const fifoOptions = Array.from(fifoGroups.values())
    .filter((g) => g.rem > 0)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map((g) => `<option value="fifo:${escapeAttr(g.key)}">AUTO FIFO | ${escapeHtml(g.name || "-")} | KOD:${escapeHtml(g.code || "-")} | QALIQ:${Math.floor(g.rem)}</option>`)
    .join("");

  const itemOptions = stockItems.length
    ? stockItems
        .map((x) => {
          const base = `${x.p.name} | ${x.p.supp} | ${x.p.date}`;
          const extra =
            x.type === "bulk"
              ? ` | KOD:${x.p.code || "-"} | QALIQ:${x.rem}`
              : ` | IMEI1:${x.p.imei1 || "-"} IMEI2:${x.p.imei2 || "-"} SER:${x.p.seria || "-"}`;
          return `<option value="${x.type}:${x.p.uid}">${escapeHtml(base + extra)}</option>`;
        })
        .join("")
    : `<option value="">Anbarda satılmamış mal yoxdur</option>`;

  ensureAccounts();
  const accOptions = accountOptionsHtml(current?.paymentAccountId || 1);

  openModal(`
    <h2>${isEdit ? "Satış Redaktə" : "Yeni Satış"}</h2>
    <form onsubmit="saveSale(event, ${idx})">
      <div class="grid-3">
        <input type="datetime-local" id="f_s_date" value="${escapeAttr(current?.date || nowISODateTimeLocal())}" required>

        <select id="f_s_type" class="span-2" onchange="toggleCreditBox()" required>
          <option value="nagd">nagd</option>
          <option value="post">post</option>
          <option value="kredit">kredit</option>
          <option value="kocurme">kocurme</option>
        </select>

        <select id="f_s_customer" class="span-2" required>${custOptions}</select>
        <select id="f_s_staff" required>${staffOptions}</select>

        <select id="f_s_item" class="span-3" ${(stockItems.length || fifoOptions) ? "" : "disabled"} onchange="toggleSaleQty()" ${isEdit ? "required" : ""}>
          ${fifoOptions ? `<optgroup label="AUTO">${fifoOptions}</optgroup>` : ""}
          <optgroup label="Anbar">${itemOptions}</optgroup>
        </select>

        <div id="saleQtyBox" class="grid-3 span-3" style="display:none;">
          <input type="number" step="1" min="1" id="f_s_qty" class="span-3" placeholder="Say">
        </div>

        <input type="number" step="0.01" id="f_s_amount" class="span-2" placeholder="Ümumi məbləğ (AZN)" ${isEdit ? "required" : ""} oninput="recalcCredit()">
        <div id="sTotalHint" class="span-3 muted small" style="display:none">Cəmi: —</div>
        <div class="span-3 paybox">
          <label class="chk">
            <input type="checkbox" id="f_pay_now" onchange="togglePayNow()">
            <span>Ödəniş qəbul et</span>
          </label>
        </div>

        <div id="payNowBox" class="grid-3 span-3" style="display:none;">
          <input type="number" step="0.01" id="f_s_paid" placeholder="Ödəniş məbləği (AZN)" value="${escapeAttr(current?.lastPayAmount ?? "0")}">
          <select id="f_pay_acc" class="span-2">${accOptions}</select>
          <label class="chk span-3">
            <input type="checkbox" id="f_pay_initial">
            <span>İlkin ödənişdir</span>
          </label>
        </div>
        ${!isEdit ? `<div class="span-3 modal-footer" style="padding:0;justify-content:flex-start;border-top:none;">
          <button class="btn-secondary" type="button" onclick="addSaleDraftItem()"><i class="fas fa-plus"></i> Məhsul əlavə et</button>
        </div>
        <div class="span-3">
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Məhsul</th><th>Növ</th><th>Say</th><th>Məbləğ</th><th></th></tr></thead>
              <tbody id="saleDraftList"><tr><td colspan="6">Məhsul əlavə edilməyib</td></tr></tbody>
              <tfoot><tr class="total-row"><td colspan="4">Qaimə cəmi</td><td id="saleDraftTotal">0.00 AZN</td><td></td></tr></tfoot>
            </table>
          </div>
        </div>` : ""}
      </div>

      <div id="creditBox" class="info-block" style="display:none; margin-top:14px;">
        <div class="grid-3">
          <input type="number" step="1" min="1" id="f_cr_term" placeholder="Kredit müddəti (ay)" oninput="recalcCredit()">
          <input type="number" step="0.01" min="0" id="f_cr_down" placeholder="İlkin ödəniş (AZN)" oninput="recalcCredit()">
          <input id="f_cr_monthly" placeholder="Aylıq ödəniş (avto)" readonly>
          <input id="f_cr_rem" class="span-3" placeholder="Qalıq (ilkindən sonra)" readonly>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-main" type="submit">${isEdit ? "Yenilə" : "Satışı yadda saxla"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);

  // Prefill select values
  if (current) {
    byId("f_s_type").value = current.saleType || "nagd";
    byId("f_s_customer").value = String(current.customerId || "");
    byId("f_s_staff").value = String(current.employeeId || "");
    // if bulk, show unit price in input; else show total
    if (current.bulkPurchUid || (Array.isArray(current.bulkAllocations) && current.bulkAllocations.length)) {
      const q = Math.max(1, Math.floor(n(current.qty || 1)));
      const unit = current.unitPrice != null && current.unitPrice !== "" ? n(current.unitPrice) : (n(current.amount) / q);
      byId("f_s_amount").value = String(unit);
    } else {
      byId("f_s_amount").value = String(current.amount || "");
    }

    if (current.bulkPurchUid) {
      byId("f_s_item").value = `bulk:${current.bulkPurchUid}`;
      if (byId("f_s_qty")) byId("f_s_qty").value = String(current.qty || 1);
    } else if (Array.isArray(current.bulkAllocations) && current.bulkAllocations.length) {
      const token = String(current.code || current.productName || "-").trim().replace(/:/g, "_");
      byId("f_s_item").value = `fifo:${token}`;
      if (byId("f_s_qty")) byId("f_s_qty").value = String(current.qty || 1);
    } else {
      const purch = db.purch.find((p) => itemKeyFromPurch(p) === current.itemKey);
      if (purch) byId("f_s_item").value = `serial:${purch.uid}`;
    }

    if (current.saleType === "kredit") {
      toggleCreditBox(true);
      byId("f_cr_term").value = String(current.credit?.termMonths || "");
      byId("f_cr_down").value = String(current.credit?.downPayment || "");
      recalcCredit();
    } else {
      toggleCreditBox(false);
    }
    // pay now
    const paidTotal = n(current.paidTotal);
    byId("f_pay_now").checked = paidTotal > 0.000001;
    togglePayNow(true);
    byId("f_s_paid").value = money(current.lastPayAmount ?? paidTotal);
  } else {
    byId("f_s_type").value = "nagd";
    toggleCreditBox(false);
    byId("f_pay_now").checked = false;
    togglePayNow(true);
  }
  window.__saleDraftItems = [];
  if (!isEdit) renderSaleDraftItems();
  toggleSaleQty();
  const upd = () => {
    const sel = byId("f_s_item")?.value || "";
    const isBulk = String(sel).startsWith("bulk:");
    const hint = byId("sTotalHint");
    if (!hint) return;
    if (!isBulk) {
      hint.style.display = "none";
      return;
    }
    hint.style.display = "";
    const qty = Math.max(1, Math.floor(n(val("f_s_qty") || 1)));
    const unit = Math.max(0, n(val("f_s_amount") || 0));
    hint.textContent = `Cəmi: ${money(unit * qty)} AZN`;
  };
  const qtyEl = byId("f_s_qty");
  const amtEl = byId("f_s_amount");
  qtyEl && (qtyEl.oninput = () => { upd(); recalcCredit(); });
  amtEl && (amtEl.oninput = () => { upd(); recalcCredit(); });
  byId("f_s_item") && (byId("f_s_item").onchange = () => { toggleSaleQty(); upd(); recalcCredit(); });
  upd();
}

function readSaleDraftFromForm() {
  const sel = val("f_s_item");
  if (!sel) return { error: "Məhsul seçin." };
  const [kind, purchUid] = String(sel).split(":");
  if (!kind || !purchUid) return { error: "Məhsul seçimi yanlışdır." };
  const qty = (kind === "bulk" || kind === "fifo") ? Math.max(1, Math.floor(n(val("f_s_qty") || 1))) : 1;
  const unitOrTotal = Math.max(0, n(val("f_s_amount") || 0));
  if (unitOrTotal <= 0) return { error: "Məbləğ düzgün deyil." };
  const amount = (kind === "bulk" || kind === "fifo") ? unitOrTotal * qty : unitOrTotal;
  const opt = byId("f_s_item")?.selectedOptions?.[0];
  const label = (opt?.textContent || "").trim();
  return { item: { kind, purchUid, qty, unitOrTotal, amount, label } };
}

function renderSaleDraftItems() {
  const tb = byId("saleDraftList");
  const totalEl = byId("saleDraftTotal");
  if (!tb || !totalEl) return;
  const arr = window.__saleDraftItems || [];
  if (!arr.length) {
    tb.innerHTML = `<tr><td colspan="6">Məhsul əlavə edilməyib</td></tr>`;
    totalEl.textContent = "0.00 AZN";
    return;
  }
  const total = arr.reduce((a, x) => a + n(x.amount), 0);
  tb.innerHTML = arr
    .map((x, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(x.label || x.purchUid)}</td>
      <td>${x.kind === "bulk" ? "Sayla" : (x.kind === "fifo" ? "FIFO" : "Seriyalı")}</td>
      <td>${x.qty}</td>
      <td>${money(x.amount)} AZN</td>
      <td><button type="button" class="icon-btn delete" onclick="removeSaleDraftItem(${i})"><i class="fas fa-trash"></i></button></td>
    </tr>`)
    .join("");
  totalEl.textContent = `${money(total)} AZN`;
}

function addSaleDraftItem() {
  const r = readSaleDraftFromForm();
  if (r.error) return alert(r.error);
  const arr = window.__saleDraftItems || [];
  arr.push(r.item);
  window.__saleDraftItems = arr;
  renderSaleDraftItems();
  byId("f_s_amount").value = "";
  if (byId("f_s_qty")) byId("f_s_qty").value = "1";
}

function removeSaleDraftItem(i) {
  const arr = window.__saleDraftItems || [];
  if (i < 0 || i >= arr.length) return;
  arr.splice(i, 1);
  window.__saleDraftItems = arr;
  renderSaleDraftItems();
}

function togglePayNow(noRender) {
  const box = byId("payNowBox");
  const chk = byId("f_pay_now");
  if (!box || !chk) return;
  box.style.display = chk.checked ? "" : "none";
  if (!chk.checked) {
    byId("f_s_paid").value = "0";
    if (byId("f_pay_initial")) byId("f_pay_initial").checked = false;
  } else {
    // if credit, default to down payment
    if (byId("f_s_type")?.value === "kredit") {
      recalcCredit();
    }
  }
  if (!noRender) return;
}

function toggleCreditBox(force) {
  const type = byId("f_s_type")?.value;
  const show = typeof force === "boolean" ? force : type === "kredit";
  const box = byId("creditBox");
  if (!box) return;
  box.style.display = show ? "" : "none";
  recalcCredit();
}

function recalcCredit() {
  const type = byId("f_s_type")?.value;
  if (type !== "kredit") return;
  const total = Math.max(0, n(byId("f_s_amount")?.value));
  const term = Math.max(1, Math.floor(n(byId("f_cr_term")?.value || 0)));
  let down = Math.max(0, n(byId("f_cr_down")?.value || 0));
  if (down > total) down = total;
  const rem = Math.max(0, total - down);
  const monthly = term > 0 ? rem / term : 0;
  byId("f_cr_monthly").value = money(monthly);
  byId("f_cr_rem").value = money(rem);

  // paid default to down payment if empty/0
  const paidEl = byId("f_s_paid");
  if (paidEl) {
    const cur = n(paidEl.value);
    const auto = n(paidEl.getAttribute("data-autofill"));
    if (cur === 0 || cur === auto) {
      paidEl.value = money(down);
      paidEl.setAttribute("data-autofill", String(down));
    }
  }
}

async function saveSale(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isEdit = idx !== null;
  const isNew = !isEdit;
  const actorName = currentActorName();
  if (isNew) {
    const draft = window.__saleDraftItems || [];
    if (!draft.length) return alert("Ən azı bir məhsul əlavə edin.");
    const customerId = val("f_s_customer");
    const employeeId = val("f_s_staff");
    const saleType = val("f_s_type");
    const date = val("f_s_date");
    const cust = db.cust.find((c) => String(c.uid) === String(customerId));
    const staff = db.staff.find((s) => String(s.uid) === String(employeeId));
    if (!cust || !staff) return alert("Müştəri və əməkdaş seçin.");

    const totalAmount = draft.reduce((a, x) => a + Math.max(0, n(x.amount)), 0);
    const payNow = !!byId("f_pay_now")?.checked;
    const isInitialPayment = payNow && !!byId("f_pay_initial")?.checked;
    const saleFormPaySource = isInitialPayment ? "down" : "sale_info";
    const payAccountId = payNow ? Number(val("f_pay_acc") || 1) : null;
    let paid = payNow ? Math.max(0, n(val("f_s_paid"))) : 0;
    if (paid > totalAmount) paid = totalAmount;

    if (saleType === "kredit") {
      const lim = Math.max(0, n(cust.creditLimit || 0));
      if (lim > 0.000001) {
        const existing = db.sales
          .filter((s) => String(s.customerId) === String(cust.uid))
          .filter((s) => String(s.saleType) === "kredit")
          .filter((s) => !s.returnedAt)
          .reduce((a, s) => a + saleRemaining(s), 0);
        let down = Math.max(0, n(val("f_cr_down")));
        if (down > totalAmount) down = totalAmount;
        const newDebt = Math.max(0, totalAmount - down);
        const will = existing + newDebt;
        if (will - lim > 0.000001) return alert(`Kredit limit aşılır. Limit: ${money(lim)} AZN, olacaq: ${money(will)} AZN`);
      }
    }

    const sold = soldKeySet();
    const usedByPurch = {};
    const created = [];
    const invNo = nextInvNo("sales");
    let paidLeft = paid;
    const totalDown = saleType === "kredit" ? Math.max(0, n(val("f_cr_down"))) : 0;
    const termMonths = saleType === "kredit" ? Math.max(1, Math.floor(n(val("f_cr_term") || 1))) : 0;

    for (const it of draft) {
      const kind = it.kind;
      const tokenOrUid = String(it.purchUid || "");
      const qty = Math.max(1, Math.floor(n(it.qty || 1)));
      const unitOrTotal = Math.max(0, n(it.unitOrTotal || 0));
      const amount = Math.max(0, n(it.amount || 0));
      let purch = null;
      let bulkPurchUid = null;
      let bulkAllocations = null;
      let key = "";

      if (kind === "fifo") {
        const token = tokenOrUid;
        key = `FIFO:${token}`;
        const matches = (p) => {
          if (!p || p.returnedAt || !purchIsBulk(p)) return false;
          const code = String(p.code || "").trim().replace(/:/g, "_");
          const name = String(p.name || "").trim().replace(/:/g, "_");
          return (code && code === token) || (!code && name === token) || name === token;
        };
        const lots = (db.purch || []).filter(matches).slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
        bulkAllocations = [];
        let left = qty;
        for (const lp of lots) {
          const already = n(usedByPurch[lp.uid] || 0);
          const rem = Math.max(0, purchRemainingQty(lp) - already);
          if (rem <= 0) continue;
          const take = Math.min(left, rem);
          if (take > 0) {
            bulkAllocations.push({ purchUid: lp.uid, qty: take });
            usedByPurch[lp.uid] = already + take;
            left -= take;
          }
          if (left <= 0) break;
        }
        if (left > 0) return alert("FIFO üçün anbarda kifayət qədər say yoxdur.");
        purch = bulkAllocations.length ? db.purch.find((p) => String(p.uid) === String(bulkAllocations[0].purchUid)) : null;
      } else if (kind === "bulk") {
        purch = db.purch.find((p) => String(p.uid) === tokenOrUid);
        if (!purch) return alert("Məhsul tapılmadı.");
        key = itemKeyFromPurch(purch);
        bulkPurchUid = purch.uid;
        const already = n(usedByPurch[purch.uid] || 0);
        const avail = Math.max(0, purchRemainingQty(purch) - already);
        if (qty > avail) return alert("Anbarda kifayət qədər say yoxdur.");
        usedByPurch[purch.uid] = already + qty;
      } else {
        purch = db.purch.find((p) => String(p.uid) === tokenOrUid);
        if (!purch) return alert("Məhsul tapılmadı.");
        key = itemKeyFromPurch(purch);
        if (sold.has(key)) return alert("Bu mal artıq satılıb.");
        sold.add(key);
      }

      const samplePurch = purch || (bulkAllocations && bulkAllocations.length ? db.purch.find((p) => String(p.uid) === String(bulkAllocations[0].purchUid)) : null);
      const base = {
        uid: genId(db.sales, 1),
        invNo,
        date,
        saleType,
        customerId: cust.uid,
        customerName: `${cust.sur} ${cust.name} ${cust.father}`.trim(),
        employeeId: staff.uid,
        employeeName: staff.name,
        actorName,
        productName: samplePurch ? (samplePurch.name || "") : "",
        code: samplePurch ? (samplePurch.code || "") : "",
        qty,
        bulkPurchUid,
        bulkAllocations,
        imei1: samplePurch ? (samplePurch.imei1 || "") : "",
        imei2: samplePurch ? (samplePurch.imei2 || "") : "",
        seria: samplePurch ? (samplePurch.seria || "") : "",
        amount: String(amount),
        unitPrice: (kind === "bulk" || kind === "fifo") ? String(unitOrTotal) : "",
        itemKey: key,
        payments: [],
        paidTotal: "0",
        credit: null,
        paymentAccountId: payAccountId,
        lastPayAmount: 0,
      };

      if (saleType === "kredit") {
        const downShare = totalAmount > 0 ? (Math.max(0, totalDown) * amount / totalAmount) : 0;
        const rem = Math.max(0, amount - downShare);
        base.credit = { termMonths, downPayment: downShare, monthlyPayment: termMonths > 0 ? rem / termMonths : 0 };
      }

      const payForThis = payNow ? Math.min(paidLeft, amount) : 0;
      if (payForThis > 0.000001) {
        addSalePaymentInternal(base, payForThis, base.date, saleFormPaySource);
        base.lastPayAmount = payForThis;
      }
      paidLeft -= payForThis;
      db.sales.push(base);
      created.push(base);
      logEvent("create", "sales", { uid: base.uid, invNo: base.invNo });

      if (payNow && payForThis > 0.000001 && payAccountId) {
        addCashOp({
          type: "in",
          date: base.date,
          source: `Satış ödənişi (${base.customerName})`,
          amount: amountAppliedToSaleLast(base) || payForThis,
          note: (kind === "bulk" || kind === "fifo" || (samplePurch && purchIsBulk(samplePurch)))
            ? `${base.productName} (KOD:${base.code || "-"} • SAY:${base.qty})`
            : `${base.productName} (${base.imei1 || base.imei2 || base.seria || "-"})`,
          link: { kind: "sale_payment", saleUid: base.uid },
          meta: { customerId: base.customerId, invNo: base.invNo, payKind: isInitialPayment ? "down" : "regular" },
          accountId: payAccountId,
        });
      }
    }

    saveDB();
    closeMdl();
    return;
  }
  if (isEdit) {
    const old = db.sales[idx];
    const oldInv = old ? (old.invNo || invFallback("sales", old.uid)) : "-";
    const oldPaid = old ? n(old.paidTotal) : 0;
    const oldDate = old ? fmtDT(old.date) : "-";
    const lastCloseDate = getLastDayCloseDate();
    const saleDateISO = String(old?.date || "").slice(0, 10);
    const inClosedPeriod = !!(lastCloseDate && saleDateISO && saleDateISO <= lastCloseDate);
    if (inClosedPeriod) {
      if (!(isAdmin() || isDeveloper())) {
        return alert(`Bu satış bağlanmış dövrə aiddir (${lastCloseDate}). Redaktə icazəsi yoxdur.`);
      }
      const overrideNote = await appRequireNote(
        "Bağlı dövr redaktəsi",
        `Bu satış bağlanmış dövrə aiddir (${lastCloseDate}).\nAdmin/Developer düzəlişi üçün qeyd yazın (auditə düşəcək).`
      );
      if (!overrideNote) return;
      logEvent("update", "sales_locked_override", {
        uid: old?.uid || null,
        invNo: oldInv,
        saleDate: saleDateISO || "",
        lastCloseDate,
        note: overrideNote,
      });
    }
    const warnMsg =
      `Diqqət: mövcud satışı redaktə edirsiniz.\n\n` +
      `Qaimə: ${oldInv}\n` +
      `Tarix: ${oldDate}\n` +
      `Ödənilən: ${money(oldPaid)} AZN\n\n` +
      `Köhnə satışlarda redaktə etdikdə ödəniş/borc balanslarına təsir ola bilər.\n` +
      `Dəyişiklikləri yadda saxlamaq istədiyinizə əminsiniz?`;
    const ok = await appConfirm(warnMsg);
    if (!ok) return;
  }

  const customerId = val("f_s_customer");
  const employeeId = val("f_s_staff");
  const sel = val("f_s_item");
  const [kind, purchUid] = String(sel || "").split(":");
  const purch = kind === "fifo" ? null : db.purch.find((p) => String(p.uid) === String(purchUid));
  if (!customerId || !employeeId) return;
  if (kind !== "fifo" && !purch) return;

  const key = kind === "fifo" ? `FIFO:${String(purchUid || "")}` : itemKeyFromPurch(purch);
  const sold = soldKeySet();
  let qty = 1;
  let bulkPurchUid = null;
  let bulkAllocations = null;
  if (kind === "bulk") {
    bulkPurchUid = purch.uid;
    qty = Math.max(1, Math.floor(n(val("f_s_qty"))));
    let avail = purchRemainingQty(purch);
    if (isEdit && db.sales[idx] && String(db.sales[idx].bulkPurchUid || "") === String(bulkPurchUid)) {
      avail += Math.max(0, Math.floor(n(db.sales[idx].qty || 0)));
    }
    if (qty > avail) return alert("Anbarda kifayət qədər say yoxdur.");
  } else if (kind === "fifo") {
    qty = Math.max(1, Math.floor(n(val("f_s_qty"))));
    const token = String(purchUid || "").replace(/:/g, "_");
    const matches = (p) => {
      if (!p || p.returnedAt) return false;
      if (!purchIsBulk(p)) return false;
      const code = String(p.code || "").trim().replace(/:/g, "_");
      const name = String(p.name || "").trim().replace(/:/g, "_");
      return (code && code === token) || (!code && name === token) || name === token;
    };
    const lots = (db.purch || [])
      .filter(matches)
      .slice()
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const totalAvail = lots.reduce((a, p) => a + purchRemainingQty(p), 0);
    if (qty > totalAvail) return alert("Anbarda kifayət qədər say yoxdur.");
    bulkAllocations = [];
    let left = qty;
    for (const p of lots) {
      const rem = purchRemainingQty(p);
      if (rem <= 0) continue;
      const take = Math.min(left, rem);
      if (take > 0) bulkAllocations.push({ purchUid: p.uid, qty: take });
      left -= take;
      if (left <= 0) break;
    }
  } else {
    if (!isEdit && sold.has(key)) return alert("Bu mal artıq satılıb.");
    if (isEdit && db.sales[idx] && db.sales[idx].itemKey !== key && sold.has(key)) return alert("Bu mal artıq satılıb.");
  }

  const saleType = val("f_s_type");
  const unitOrTotal = Math.max(0, n(val("f_s_amount")));
  const amount = (kind === "bulk" || kind === "fifo") ? (unitOrTotal * qty) : unitOrTotal;
  const payNow = !!byId("f_pay_now")?.checked;
  const isInitialPayment = payNow && !!byId("f_pay_initial")?.checked;
  const saleFormPaySource = isInitialPayment ? "down" : "sale_info";
  const payAccountId = payNow ? Number(val("f_pay_acc") || 1) : null;
  let paid = payNow ? Math.max(0, n(val("f_s_paid"))) : 0;
  if (paid > amount) paid = amount;

  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  const staff = db.staff.find((s) => String(s.uid) === String(employeeId));
  if (!cust || !staff) return;

  const samplePurch =
    purch ||
    (Array.isArray(bulkAllocations) && bulkAllocations.length
      ? db.purch.find((p) => String(p.uid) === String(bulkAllocations[0].purchUid))
      : null);

  // credit limit check (only for kredit)
  if (val("f_s_type") === "kredit") {
    const lim = Math.max(0, n(cust.creditLimit || 0));
    if (lim > 0.000001) {
      const existing = db.sales
        .filter((s) => String(s.customerId) === String(cust.uid))
        .filter((s) => String(s.saleType) === "kredit")
        .filter((s) => !s.returnedAt)
        .reduce((a, s) => a + saleRemaining(s), 0);
      const qtyNow = (kind === "bulk" || kind === "fifo") ? Math.max(1, Math.floor(n(val("f_s_qty")))) : 1;
      const formTotal = (kind === "bulk" || kind === "fifo") ? (Math.max(0, n(val("f_s_amount"))) * qtyNow) : Math.max(0, n(val("f_s_amount")));
      const newDebt = Math.max(0, formTotal - Math.max(0, n(val("f_cr_down"))));
      const oldDebt = isEdit ? saleRemaining(db.sales[idx]) : 0;
      const will = existing - oldDebt + newDebt;
      if (will - lim > 0.000001) {
        return alert(`Kredit limit aşılır. Limit: ${money(lim)} AZN, olacaq: ${money(will)} AZN`);
      }
    }
  }

  const base = {
    uid: isEdit ? db.sales[idx].uid : genId(db.sales, 1),
    invNo: isEdit ? (db.sales[idx].invNo || invFallback("sales", db.sales[idx].uid)) : nextInvNo("sales"),
    date: val("f_s_date"),
    saleType,
    customerId: cust.uid,
    customerName: `${cust.sur} ${cust.name} ${cust.father}`.trim(),
    employeeId: staff.uid,
    employeeName: staff.name,
    actorName,
    productName: samplePurch ? (samplePurch.name || "") : "",
    code: samplePurch ? (samplePurch.code || "") : "",
    qty,
    bulkPurchUid,
    bulkAllocations,
    imei1: samplePurch ? (samplePurch.imei1 || "") : "",
    imei2: samplePurch ? (samplePurch.imei2 || "") : "",
    seria: samplePurch ? (samplePurch.seria || "") : "",
    amount: String(amount),
    unitPrice: (kind === "bulk" || kind === "fifo") ? String(unitOrTotal) : (isEdit ? db.sales[idx]?.unitPrice ?? "" : ""),
    itemKey: key,
    payments: isEdit ? (db.sales[idx].payments || []) : [],
    paidTotal: "0",
    credit: null,
    paymentAccountId: payAccountId || (isEdit ? db.sales[idx].paymentAccountId : null),
    lastPayAmount: paid,
  };

  if (saleType === "kredit") {
    const termMonths = Math.max(1, Math.floor(n(val("f_cr_term"))));
    let downPayment = Math.max(0, n(val("f_cr_down")));
    if (downPayment > amount) downPayment = amount;
    const rem = Math.max(0, amount - downPayment);
    const monthlyPayment = termMonths > 0 ? rem / termMonths : 0;
    base.credit = {
      termMonths,
      downPayment,
      monthlyPayment,
    };
    // paid becomes at least downPayment if no manual value
    if (payNow && paid <= 0) paid = downPayment;
  }

  // If editing, preserve existing payments and recompute paidTotal, then add a "manual-set" payment only if new paid > old paidTotal
  if (isEdit) {
    const old = db.sales[idx];
    base.payments = old.payments || [];
    base.paidTotal = String(sumPayments(base.payments));
    // allow user to set paid amount by adding payment difference
    const diff = paid - n(base.paidTotal);
    if (diff > 0.000001) {
      addSalePaymentInternal(base, diff, base.date, saleFormPaySource);
    }
  } else {
    // create initial payment if paid > 0
    if (paid > 0.000001) {
      addSalePaymentInternal(base, paid, base.date, saleFormPaySource);
    } else {
      base.paidTotal = "0";
    }
  }

  if (isEdit) db.sales[idx] = base;
  else db.sales.push(base);
  logEvent(isNew ? "create" : "update", "sales", { uid: base.uid, invNo: base.invNo });

  // Cash op if payNow
  if (payNow && paid > 0.000001) {
    if (!payAccountId) {
      alert("Hesab seçilməyib.");
    } else {
      addCashOp({
        type: "in",
        date: base.date,
        source: `Satış ödənişi (${base.customerName})`,
        amount: amountAppliedToSaleLast(base) || paid,
        note: (kind === "bulk" || kind === "fifo" || (samplePurch && purchIsBulk(samplePurch)))
          ? `${base.productName} (KOD:${base.code || "-"} • SAY:${base.qty})`
          : `${base.productName} (${base.imei1 || base.imei2 || base.seria || "-"})`,
        link: { kind: "sale_payment", saleUid: base.uid },
        meta: { customerId: base.customerId, payKind: isInitialPayment ? "down" : "regular" },
        accountId: payAccountId,
      });
    }
  }

  saveDB();
  closeMdl();
}

function sumPayments(payments) {
  return (payments || []).reduce((a, p) => a + n(p.amount), 0);
}

function salePaymentSourceLabel(src) {
  const s = String(src || "").trim().toLowerCase();
  if (s === "down") return "İlkin ödəniş";
  if (s === "monthly") return "Aylıq ödəniş";
  if (s === "cash_edit") return "Nağd ödəniş (kassa düzəlişi)";
  if (s === "sale_info" || s === "sales_form" || s === "regular" || s === "manual") return "Nağd ödəniş";
  if (s === "cash_module_invoice" || s === "cash_module") return "Kassa ödənişi";
  return src ? String(src) : "-";
}

function addSalePaymentInternal(sale, amount, date, source) {
  const a = Math.max(0, n(amount));
  if (a <= 0) return 0;
  const rem = Math.max(0, n(sale.amount) - sumPayments(sale.payments));
  const applied = Math.min(rem, a);
  if (applied <= 0) return 0;

  sale.payments.push({
    uid: genId(sale.payments, 1),
    date: date || nowISODate(),
    amount: applied,
    source: source || "manual",
  });
  sale.paidTotal = String(sumPayments(sale.payments));
  return applied;
}

function applyCustomerPaymentToDebts(customerId, amount, date, source) {
  let left = Math.max(0, n(amount));
  if (left <= 0) return { applied: 0, remaining: left, allocations: [] };

  const debts = db.sales
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => String(s.customerId) === String(customerId))
    .filter(({ s }) => saleRemaining(s) > 0.000001)
    .sort((a, b) => (a.s.date > b.s.date ? 1 : -1));

  const allocations = [];
  for (const d of debts) {
    if (left <= 0.000001) break;
    const rem = saleRemaining(d.s);
    const pay = Math.min(rem, left);
    addSalePaymentInternal(d.s, pay, date, source);
    allocations.push({ saleUid: d.s.uid, amount: pay });
    left -= pay;
  }

  return { applied: n(amount) - left, remaining: left, allocations };
}

// ========= Əməkdaş hesabatı: əməkdaşın satış siyahısı (hesabat tarix aralığına görə) =========
function openStaffReportSales(employeeUid) {
  const staff = db.staff.find((s) => String(s.uid) === String(employeeUid));
  const staffName = staff ? staff.name : employeeUid;
  const repMonth = byId("repMonth")?.value || "";
  const useMonth = !!repMonth;
  const salesList = db.sales
    .filter((s) => String(s.employeeId || "") === String(employeeUid))
    .filter((s) => !s.returnedAt)
    .filter((s) => (useMonth ? inMonth(s.date, repMonth) : inDateRange(s.date, "repFrom", "repTo")))
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1));
  const totalSum = salesList.reduce((a, s) => a + n(s.amount), 0);
  const totalPaid = salesList.reduce((a, s) => a + n(s.paidTotal || 0), 0);
  const totalRem = totalSum - totalPaid;
  const rows = salesList
    .map((s, i) => {
      const idx = db.sales.findIndex((x) => x.uid === s.uid);
      const rem = saleRemaining(s);
      const inv = s.invNo || invFallback("sales", s.uid);
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${fmtDT(s.date)}</td>
        <td>${escapeHtml(inv)}</td>
        <td>${escapeHtml(s.customerName)}</td>
        <td>${escapeHtml(s.productName)}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal || 0)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions"><button class="icon-btn info" onclick="closeMdl(); openSaleInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button></td>
      </tr>`;
    })
    .join("");
  openModal(`
    <h2>Əməkdaş satışları: ${escapeHtml(staffName)}</h2>
    <p class="muted">Hesabat tarix aralığına görə (${useMonth ? repMonth : (byId("repFrom")?.value || "") + " — " + (byId("repTo")?.value || "")})</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Qaimə</th><th>Müştəri</th><th>Məhsul</th><th>Məbləğ</th><th>Ödənən</th><th>Qalıq</th><th></th></tr></thead>
        <tbody>${rows || "<tr><td colspan=\"9\">Satış yoxdur</td></tr>"}</tbody>
      </table>
    </div>
    <div class="info-block" style="margin-top:12px;">
      <div class="info-row"><div class="info-label">Cəmi satış</div><div class="info-value">${money(totalSum)} AZN</div></div>
      <div class="info-row"><div class="info-label">Ödənilən</div><div class="info-value">${money(totalPaid)} AZN</div></div>
      <div class="info-row"><div class="info-label">Qalıq</div><div class="info-value">${money(totalRem)} AZN</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

// ========= Sales info + payments =========
function openSaleInfo(idx) {
  const s = db.sales[idx];
  if (!s) return;
  const cust = db.cust.find((c) => String(c.uid) === String(s.customerId));
  const guarantor = cust?.zam ? db.cust.find((c) => String(c.uid) === String(cust.zam)) : null;
  const rem = saleRemaining(s);
  const st = debtStatus(n(s.amount), rem);

  let creditHtml = "";
  let scheduleHtml = "";
  if (s.saleType === "kredit" && s.credit) {
    const sch = buildCreditSchedule(s);
    creditHtml = `
      <div class="info-block">
        <div class="info-row"><div class="info-label">Kredit müddəti</div><div class="info-value">${sch.term} ay</div></div>
        <div class="info-row"><div class="info-label">İlkin ödəniş</div><div class="info-value">${money(s.credit.downPayment)} AZN</div></div>
        <div class="info-row"><div class="info-label">Aylıq ödəniş</div><div class="info-value">${money(s.credit.monthlyPayment)} AZN</div></div>
        <div class="info-row"><div class="info-label">Qalıq (ilkindən sonra)</div><div class="info-value">${money(sch.remAfterDown)} AZN</div></div>
      </div>
    `;
    const rows = sch.rows
      .map(
        (r) => `
      <tr>
        <td>${r.idx}</td>
        <td>${r.due}</td>
        <td>${money(r.amount)} AZN</td>
        <td>${money(r.paid)} AZN</td>
        <td>${money(r.remaining)} AZN</td>
        <td><span class="pill ${r.status}">${debtLabel(r.status)}</span></td>
      </tr>`
      )
      .join("");
    scheduleHtml = `
      <div class="info-block">
        <div class="info-row"><div class="info-label">Ödəniş cədvəli</div><div class="info-value">Aylıq plan</div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Tarix</th><th>Aylıq</th><th>Ödənən</th><th>Qalıq</th><th>Status</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6">Cədvəl yoxdur</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  openModal(`
    <h2>Satış məlumatı</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Satış tarixi</div><div class="info-value">${fmtDT(s.date)}</div></div>
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)} (${s.customerId})</div></div>
      <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${guarantor ? escapeHtml(`${guarantor.sur} ${guarantor.name} (${guarantor.uid})`) : "-"}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(s.productName)}</div></div>
      <div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(s.code || "-")}</div></div>
      <div class="info-row"><div class="info-label">Say</div><div class="info-value">${String(Math.max(1, Math.floor(n(s.qty || 1))))}</div></div>
      <div class="info-row"><div class="info-label">IMEI 1</div><div class="info-value">${escapeHtml(s.imei1 || "-")}</div></div>
      <div class="info-row"><div class="info-label">IMEI 2</div><div class="info-value">${escapeHtml(s.imei2 || "-")}</div></div>
      <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(s.seria || "-")}</div></div>
      <div class="info-row"><div class="info-label">Satış növü</div><div class="info-value">${escapeHtml(String(s.saleType).toUpperCase())}</div></div>
      <div class="info-row"><div class="info-label">Əməkdaş</div><div class="info-value">${escapeHtml(operationActorName(s, s.employeeName || "-"))}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ</div><div class="info-value">${money(s.amount)} AZN</div></div>
      <div class="info-row"><div class="info-label">Ödənilən</div><div class="info-value">${money(s.paidTotal)} AZN</div></div>
      <div class="info-row"><div class="info-label">Qalıq</div><div class="info-value">${money(rem)} AZN</div></div>
      <div class="info-row"><div class="info-label">Status</div><div class="info-value"><span class="pill ${st}">${debtLabel(st)}</span></div></div>
    </div>
    ${creditHtml}
    ${scheduleHtml}
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openSalePayment(${idx})">Ödəniş et</button>
      <button class="btn-cancel" type="button" onclick="openReturnSale(${idx})">Qaytar</button>
      <button class="btn-cancel" type="button" onclick="printSale(${idx})">Çap</button>
      <button class="btn-cancel" type="button" onclick="openPaymentHistory('sale', ${idx})">Ödəniş tarixçəsi</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openPaymentHistory(kind, idx) {
  if (kind !== "sale") return;
  const s = db.sales[idx];
  const rows = (s.payments || [])
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .map(
      (p) => `
      <tr>
        <td>${p.uid}</td>
        <td>${fmtDT(p.date)}</td>
        <td>${money(p.amount)} AZN</td>
        <td>${escapeHtml(salePaymentSourceLabel(p.source))}</td>
      </tr>`
    )
    .join("");
  openModal(`
    <h2>Ödəniş tarixçəsi</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)} (${s.customerId})</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(s.productName)}</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Məbləğ</th><th>Mənbə</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">Tarixçə boşdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openSalePayment(${idx})">Ödəniş et</button>
      <button class="btn-cancel" type="button" onclick="openSaleInfo(${idx})">Geri</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSalePayment(idx) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const s = db.sales[idx];
  const rem = saleRemaining(s);
  if (rem <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
  const defAcc = Number(s.paymentAccountId || 1);
  const isCredit = String(s.saleType || "").toLowerCase() === "kredit";
  const payTypeOptions = isCredit
    ? `<select id="pay_kind" class="span-3" required>
         <option value="monthly" selected>Aylıq ödəniş</option>
         <option value="down">İlkin ödəniş</option>
       </select>`
    : `<input type="hidden" id="pay_kind" value="regular">`;
  openModal(`
    <h2>Ödəniş et</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)}</div></div>
      <div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value">${money(rem)} AZN</div></div>
    </div>
    <form onsubmit="saveSalePayment(event, ${idx})">
      <div class="grid-3">
        <input type="datetime-local" id="pay_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="pay_amount" placeholder="Məbləğ (AZN)" class="span-2" max="${escapeAttr(String(Math.max(0, rem)))}" required>
        <select id="pay_acc" class="span-3" required>${accountOptionsHtml(defAcc)}</select>
        ${payTypeOptions}
        <input id="pay_note" placeholder="Qeyd (istəyə bağlı)" class="span-3">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="openSaleInfo(${idx})">Geri</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveSalePayment(e, idx) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const s = db.sales[idx];
  const rem = saleRemaining(s);
  if (rem <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
  const date = val("pay_date");
  const amount = Math.max(0, n(val("pay_amount")));
  const accId = Number(val("pay_acc") || 1);
  const payKind = val("pay_kind") || "regular";
  if (amount <= 0) return;
  if (amount - rem > 0.000001) return alert(`Məbləğ qalıq borcdan çox ola bilməz. Qalıq: ${money(rem)} AZN`);

  const applied = addSalePaymentInternal(s, amount, date, payKind === "down" ? "down" : payKind === "monthly" ? "monthly" : "sale_info");
  if (applied <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");

  // Cash operation: payment into cash only if this is cash payment (assume nagd) or user pays cash from cash module.
  // Here we treat it as cash-in (kassa) by default.
  addCashOp({
    type: "in",
    date,
    source: `Debitor ödəniş (${s.customerName})`,
    amount: applied,
    note: val("pay_note") || `Satış #${s.uid}`,
    link: { kind: "sale", saleUid: s.uid },
    meta: { customerId: s.customerId, payKind },
    accountId: accId,
  }, { clampToApplied: true, applied });
  logEvent("create", "cash", { type: "in", kind: "sale", amount: applied, saleUid: s.uid });

  saveDB();
  openPaymentHistory("sale", idx);
}

function amountAppliedToSaleLast(sale) {
  const last = (sale.payments || [])[sale.payments.length - 1];
  return last ? n(last.amount) : 0;
}

function openDebtorInfo(customerId) {
  const items = (db.sales || [])
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => String(s.customerId) === String(customerId))
    .filter(({ s }) => !s.returnedAt)
    .sort((a, b) => String(a.s.date).localeCompare(String(b.s.date)) * -1);

  const custName = items[0]?.s.customerName || customerId;

  const rows = items
    .map(({ s, idx }, i) => {
      const rem = saleRemaining(s);
      const st = debtStatus(n(s.amount), rem);
      const invNo = s.invNo || invFallback("sales", s.uid);
      const key = (s.imei1 || s.imei2 || s.seria || "").trim();
      const payDisabled = rem <= 0.000001 ? "disabled" : "";
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(invNo)}</td>
        <td>${fmtDT(s.date)}</td>
        <td>${escapeHtml(s.productName)}</td>
        <td>${escapeHtml(key || "-")}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td><span class="pill ${st}">${debtLabel(st)}</span></td>
        <td class="tbl-actions">
          <button class="icon-btn info" onclick="openSaleInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button>
          <button class="btn-mini-pay" type="button" onclick="openSalePayment(${idx})" ${payDisabled}>Ödəniş et</button>
        </td>
      </tr>`;
    })
    .join("");

  openModal(`
    <h2>Debitor detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custName)}</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Tarix</th><th>Məhsul</th><th>IMEI/Seriya</th><th>Məbləğ</th><th>Ödənilən</th><th>Qalıq</th><th>Status</th><th>Əməliyyat</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="10">Satış yoxdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openDebtorPayment(customerId) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const rem = db.sales
    .filter((s) => String(s.customerId) === String(customerId))
    .filter((s) => !s.returnedAt)
    .reduce((a, s) => a + saleRemaining(s), 0);
  if (rem <= 0.000001) {
    alert("Borc yoxdur.");
    return;
  }
  // pick first sale idx for existing payment UI; we'll apply across debts by customer
  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  openModal(`
    <h2>Debitor ödəniş</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(cust ? `${cust.sur} ${cust.name}` : customerId)}</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq</div><div class="info-value">${money(rem)} AZN</div></div>
    </div>
    <form onsubmit="saveDebtorPayment(event, '${escapeAttr(customerId)}')">
      <div class="grid-3">
        <input type="datetime-local" id="deb_pay_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="deb_pay_amount" class="span-2" placeholder="Məbləğ (AZN)" required>
        <select id="deb_pay_acc" class="span-3" required>${accountOptionsHtml(1)}</select>
        <input id="deb_pay_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveDebtorPayment(e, customerId) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const date = val("deb_pay_date");
  const amount = Math.max(0, n(val("deb_pay_amount")));
  const accId = Number(val("deb_pay_acc") || 1);
  if (amount <= 0) return;

  const applied = applyCustomerPaymentToDebts(customerId, amount, date, "debts_module");
  if (applied.applied <= 0.000001) {
    alert("Borc yoxdur.");
    return;
  }

  // cash in
  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  addCashOp({
    type: "in",
    date,
    source: `Müştəri ödənişi (${cust ? `${cust.sur} ${cust.name}` : customerId})`,
    amount: applied.applied,
    note: val("deb_pay_note") || "Debitor ödəniş",
    link: { kind: "debtor_payment", customerId },
    meta: { allocations: applied.allocations },
    accountId: accId,
  });

  saveDB();
  closeMdl();
}

// ========= Cash =========
function addCashOp(op, opts = {}) {
  const actor = userDisplay(currentUser()) || op.actor || "-";
  const data = {
    uid: genId(db.cash, 1),
    type: op.type, // in | out
    date: op.date || nowISODate(),
    source: op.source || "",
    amount: Math.max(0, n(op.amount)),
    note: op.note || "",
    link: op.link || null,
    meta: op.meta || null,
    accountId: Number(op.accountId || 1),
    actor: op.actor || actor || "-",
  };
  if (opts.clampToApplied && typeof opts.applied === "number") data.amount = Math.max(0, n(opts.applied));
  if (data.amount <= 0) return;
  // Prevent negative balance: if outflow and not enough balance, block.
  if (data.type === "out") {
    const bal = accountBalance(data.accountId);
    if (bal + 0.000001 < data.amount) {
      alert(`Hesab balansı kifayət etmir. Balans: ${money(bal)} AZN, çıxış: ${money(data.amount)} AZN`);
      return;
    }
  }
  db.cash.push(data);
}

function openEditCashOp(uid) {
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  const kind = c.link?.kind || "";
  const canEditAmount = isDeveloper() || kind === "expense" || kind === "income" || kind === "";
  const accOptions = accountOptionsHtml(c.accountId || 1);
  openModal(`
    <h2>Əməliyyatı redaktə et</h2>
    <form onsubmit="saveEditCashOp(event, ${c.uid})">
      <div class="grid-3">
        <label class="span-3">Tarix</label>
        <input type="datetime-local" id="edit_cash_date" value="${(c.date || "").slice(0, 16)}" class="span-3" required>
        <label class="span-3">Məbləğ (AZN)</label>
        <input type="number" step="0.01" id="edit_cash_amount" class="span-3" value="${n(c.amount)}" ${canEditAmount ? "" : "readonly"} required>
        ${!canEditAmount ? "<p class=\"span-3 muted small\">Bu əməliyyat növündə məbləğ dəyişdirilə bilməz.</p>" : ""}
        <label class="span-3">Mənbə / Açıqlama</label>
        <input type="text" id="edit_cash_source" class="span-3" value="${escapeHtml(c.source || "")}" required>
        <label class="span-3">Hesab</label>
        <select id="edit_cash_acc" class="span-3" required>${accOptions}</select>
        <label class="span-3">Qeyd</label>
        <input type="text" id="edit_cash_note" class="span-3" value="${escapeHtml(c.note || "")}" placeholder="İstəyə bağlı">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function openCashInfo(uid) {
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  const accountName = (db.accounts || []).find((a) => Number(a.uid) === Number(c.accountId || 1))?.name || `#${Number(c.accountId || 1)}`;
  const kind = c.link?.kind || (c.type === "in" ? "income" : "expense");
  const actor = operationActorName(c, "-");
  const metaText = c.meta ? JSON.stringify(c.meta, null, 2) : "-";
  openModal(`
    <h2>Kassa əməliyyatı məlumatı</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">ID</div><div class="info-value">${escapeHtml(String(c.uid))}</div></div>
      <div class="info-row"><div class="info-label">Tip</div><div class="info-value">${c.type === "in" ? "Gəlir" : "Xərc"}</div></div>
      <div class="info-row"><div class="info-label">Növ</div><div class="info-value">${escapeHtml(String(kind))}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ</div><div class="info-value"><strong>${money(c.amount)} AZN</strong></div></div>
      <div class="info-row"><div class="info-label">Hesab</div><div class="info-value">${escapeHtml(accountName)}</div></div>
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(c.date)}</div></div>
      <div class="info-row"><div class="info-label">Mənbə</div><div class="info-value">${escapeHtml(c.source || "-")}</div></div>
      <div class="info-row"><div class="info-label">Əməkdaş</div><div class="info-value">${escapeHtml(actor)}</div></div>
      <div class="info-row"><div class="info-label">Qeyd</div><div class="info-value">${escapeHtml(c.note || "-")}</div></div>
    </div>
    <div class="card" style="padding:0;">
      <div class="muted" style="padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.06);">Əlavə məlumat (meta)</div>
      <pre style="margin:0;padding:14px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(metaText)}</pre>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function syncCashOpAmountToLinked(c, oldAmount, newAmount) {
  const kind = c.link?.kind || "";
  const oldA = n(oldAmount);
  const newA = n(newAmount);
  if (Math.abs(oldA - newA) < 0.000001) return;

  if (kind === "sale_payment") {
    const s = db.sales.find((x) => Number(x.uid) === Number(c.link?.saleUid));
    if (!s || !s.payments) return;
    const pi = (s.payments || []).findIndex((p) => String(p.date).slice(0, 16) === String(c.date).slice(0, 16) && Math.abs(n(p.amount) - oldA) < 0.000001);
    if (pi >= 0) {
      s.payments[pi].amount = newA;
      s.paidTotal = String(sumPayments(s.payments));
    }
    return;
  }

  if (kind === "creditor_invoice_payment") {
    const p = db.purch.find((x) => Number(x.uid) === Number(c.link?.purchUid));
    if (!p) return;
    const newPaid = Math.max(0, Math.min(n(p.amount), n(p.paidTotal) - oldA + newA));
    p.paidTotal = String(newPaid);
    return;
  }

  if (kind === "debtor_payment") {
    const allocs = (c.meta?.allocations || []).slice();
    const oldTotal = allocs.reduce((a, x) => a + n(x.amount), 0);
    let diff = newA - oldTotal;
    if (Math.abs(diff) < 0.000001) return;
    const cashDate = String(c.date).slice(0, 16);

    if (diff < 0) {
      let toSubtract = -diff;
      for (let idx = allocs.length - 1; idx >= 0 && toSubtract > 0.000001; idx--) {
        const alloc = allocs[idx];
        const amt = n(alloc.amount);
        const sub = Math.min(amt, toSubtract);
        const s = db.sales.find((x) => Number(x.uid) === Number(alloc.saleUid || alloc.salesUid));
        if (s && s.payments) {
          const pi = (s.payments || []).findIndex((p) => String(p.date).slice(0, 16) === cashDate && Math.abs(n(p.amount) - amt) < 0.000001);
          if (pi >= 0) {
            const newPayAmt = amt - sub;
            if (newPayAmt < 0.000001) s.payments.splice(pi, 1);
            else s.payments[pi].amount = newPayAmt;
            s.paidTotal = String(sumPayments(s.payments));
          }
        }
        alloc.amount = amt - sub;
        if (alloc.amount < 0.000001) allocs.splice(idx, 1);
        toSubtract -= sub;
      }
      c.meta = { ...c.meta, allocations: allocs.filter((a) => n(a.amount) > 0.000001) };
    } else {
      const first = allocs[0];
      if (first) {
        const s = db.sales.find((x) => Number(x.uid) === Number(first.saleUid || first.salesUid));
        if (s) {
          s.payments = s.payments || [];
          const payEntry = s.payments.find((p) => String(p.date).slice(0, 16) === cashDate && Math.abs(n(p.amount) - n(first.amount)) < 0.000001);
          if (payEntry) {
            payEntry.amount = n(payEntry.amount) + diff;
            first.amount = n(first.amount) + diff;
          } else {
            s.payments.push({ uid: genId(s.payments, 1), date: c.date, amount: diff, source: "cash_edit" });
            first.amount = n(first.amount) + diff;
          }
          s.paidTotal = String(sumPayments(s.payments));
        }
        c.meta = { ...c.meta, allocations: allocs };
      }
    }
    return;
  }

  if (kind === "creditor_payment") {
    const allocs = (c.meta?.allocations || []).slice();
    const oldTotal = allocs.reduce((a, x) => a + n(x.amount), 0);
    let diff = newA - oldTotal;
    if (Math.abs(diff) < 0.000001) return;

    if (diff < 0) {
      let toSubtract = -diff;
      for (let idx = allocs.length - 1; idx >= 0 && toSubtract > 0.000001; idx--) {
        const alloc = allocs[idx];
        const amt = n(alloc.amount);
        const sub = Math.min(amt, toSubtract);
        const p = db.purch.find((x) => Number(x.uid) === Number(alloc.purchUid));
        if (p) {
          p.paidTotal = String(Math.max(0, n(p.paidTotal) - sub));
        }
        alloc.amount = amt - sub;
        if (alloc.amount < 0.000001) allocs.splice(idx, 1);
        toSubtract -= sub;
      }
      c.meta = { ...c.meta, allocations: allocs.filter((a) => n(a.amount) > 0.000001) };
    } else {
      const first = allocs[0];
      if (first) {
        const p = db.purch.find((x) => Number(x.uid) === Number(first.purchUid));
        if (p) {
          const cap = Math.max(0, n(p.amount) - n(p.paidTotal));
          const add = Math.min(diff, cap);
          p.paidTotal = String(n(p.paidTotal) + add);
          first.amount = n(first.amount) + add;
        }
        c.meta = { ...c.meta, allocations: allocs };
      }
    }
  }
}

async function saveEditCashOp(e, uid) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  const kind = c.link?.kind || "";
  const canEditAmount = isDeveloper() || kind === "expense" || kind === "income" || kind === "";
  const date = byId("edit_cash_date")?.value || c.date;
  const newAmount = canEditAmount ? Math.max(0, n(byId("edit_cash_amount")?.value)) : n(c.amount);
  const oldAmount = n(c.amount);
  const source = (byId("edit_cash_source")?.value || "").trim() || c.source;
  const note = (byId("edit_cash_note")?.value || "").trim();
  const accountId = Number(byId("edit_cash_acc")?.value || c.accountId || 1);
  if (newAmount <= 0 && canEditAmount) return alert("Məbləğ 0-dan böyük olmalıdır.");

  const isDebtorOrCreditor = kind === "debtor_payment" || kind === "sale_payment" || kind === "creditor_payment" || kind === "creditor_invoice_payment";
  if (canEditAmount && isDebtorOrCreditor && newAmount < oldAmount - 0.000001) {
    const msg = kind === "debtor_payment" || kind === "sale_payment"
      ? "Məbləği azaltsanız müştərinin debitor qalığı artacaq (status qalıq/borclu ola bilər). Davam?"
      : "Məbləği azaltsanız təchizatçının kreditor qalığı artacaq. Davam?";
    const ok = await appConfirm(msg);
    if (!ok) return;
  }

  const updated = { ...c, date, amount: String(newAmount), source, note, accountId };
  if (isDebtorOrCreditor) {
    syncCashOpAmountToLinked(c, oldAmount, newAmount);
    if (c.meta) updated.meta = c.meta;
  }
  db.cash[i] = updated;
  saveDB();
  closeMdl();
  renderAll();
}

function delCashOp(uid) {
  if (!userCanDelete("cash")) return alert("Sil icazəsi yoxdur.");
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  appConfirm("Kassa əməliyyatı silinsin?").then((ok) => {
    if (!ok) return;
  ensureAuditTrash();
  const u = currentUser();
  db.trash.push({ uid: genId(db.trash, 1), type: "cash", item: c, deletedAt: nowISODateTimeLocal(), deletedBy: u ? u.username : "-" });
  logEvent("delete", "cash", { uid: c.uid, kind: c.link?.kind || "" });

  // Rollback linked effects
  const kind = c.link?.kind || "";
  if (kind === "transfer" && c.link?.transferId) {
    const trId = String(c.link.transferId);
    // delete both legs
    const all = (db.cash || []).filter((x) => x.link && x.link.kind === "transfer" && String(x.link.transferId) === trId);
    for (const leg of all) {
      const j = db.cash.findIndex((x) => Number(x.uid) === Number(leg.uid));
      if (j >= 0) db.cash.splice(j, 1);
    }
    saveDB();
    return;
  }

  if (kind === "expense") {
    // only cash record, safe to remove
  } else if (kind === "creditor_invoice_payment") {
    const purchUid = c.link?.purchUid;
    const p = db.purch.find((x) => Number(x.uid) === Number(purchUid));
    if (p) {
      const alloc = c.meta?.allocations?.reduce((a, x) => a + n(x.amount), 0) || n(c.amount);
      p.paidTotal = String(Math.max(0, n(p.paidTotal) - alloc));
    }
  } else if (kind === "creditor_payment") {
    const allocs = c.meta?.allocations || [];
    for (const a of allocs) {
      const p = db.purch.find((x) => Number(x.uid) === Number(a.purchUid));
      if (p) p.paidTotal = String(Math.max(0, n(p.paidTotal) - n(a.amount)));
    }
  } else if (kind === "debtor_payment") {
    // allocations contain saleUid if applyCustomerPaymentToDebts provides it; fallback: no rollback
    const allocs = c.meta?.allocations || [];
    for (const a of allocs) {
      const saleUid = a.saleUid ?? a.salesUid ?? null;
      if (!saleUid) continue;
      const s = db.sales.find((x) => Number(x.uid) === Number(saleUid));
      if (!s) continue;
      // remove one payment entry matching amount+date best-effort
      const amt = n(a.amount);
      const pi = (s.payments || []).findIndex((p) => n(p.amount) === amt && String(p.date) === String(c.date));
      if (pi >= 0) s.payments.splice(pi, 1);
      s.paidTotal = String(sumPayments(s.payments || []));
    }
  } else if (kind === "sale_payment" || kind === "sale") {
    const saleUid = c.link?.saleUid;
    const s = db.sales.find((x) => Number(x.uid) === Number(saleUid));
    if (s) {
      const pi = (s.payments || []).findIndex((p) => String(p.date) === String(c.date) && n(p.amount) === n(c.amount));
      if (pi >= 0) s.payments.splice(pi, 1);
      s.paidTotal = String(sumPayments(s.payments || []));
    }
  } else if (kind === "purch_payment" || kind === "purch_payment_adj") {
    const purchUid = c.link?.purchUid;
    const p = db.purch.find((x) => Number(x.uid) === Number(purchUid));
    if (p) {
      // Reverse the effect on purchase paidTotal.
      // purch_payment: cash out increased paidTotal
      // purch_payment_adj: cash in decreased paidTotal (we revert by increasing)
      const sign = kind === "purch_payment" ? -1 : +1;
      p.paidTotal = String(Math.max(0, n(p.paidTotal) + sign * n(c.amount)));
    }
  }

  db.cash.splice(i, 1);
  saveDB();
  renderAll();
  });
}

function cashTotals() {
  ensureAccounts();
  const income = db.cash.filter((c) => c.type === "in").reduce((a, b) => a + n(b.amount), 0);
  const expense = db.cash.filter((c) => c.type === "out").reduce((a, b) => a + n(b.amount), 0);
  const kassa = db.accounts.find((a) => a.uid === 1) ? accountBalance(1) : income - expense;
  return { income, expense, balance: income - expense, kassa };
}

function totalAccountsBalance() {
  ensureAccounts();
  return (db.accounts || []).reduce((a, acc) => a + accountBalance(acc.uid), 0);
}

function openCashOp() {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const custOptions = `<option value="">Müştəri seç</option>` + db.cust.map((c) => `<option value="${c.uid}">${escapeHtml(c.sur)} ${escapeHtml(c.name)} (${c.uid})</option>`).join("");
  const suppOptions = `<option value="">Təchizatçı seç</option>` + db.supp.map((s) => `<option value="${escapeAttr(s.co)}">${escapeHtml(s.co)} (${s.uid})</option>`).join("");
  const catOptions = db.expenseCats.map((c) => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  const accOptions = accountOptionsHtml(1);

  openModal(`
    <h2>Yeni əməliyyat</h2>
    <form onsubmit="saveCashOp(event)">
      <div class="grid-3">
        <select id="cash_kind" class="span-3" onchange="toggleCashKind()">
          <option value="cust_pay">Müştəri ödənişi (Debitor)</option>
          <option value="supp_pay">Təchizatçı ödənişi (Kreditor)</option>
          <option value="transfer">Hesablar arası transfer</option>
          <option value="income">Mədaxil (digər)</option>
          <option value="expense">Xərc</option>
        </select>

        <input type="datetime-local" id="cash_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="cash_amount" class="span-2" placeholder="Məbləğ (AZN)" required>

        <div id="cash_acc_box" class="span-3">
          <select id="cash_acc" class="span-3" required>${accOptions}</select>
        </div>

        <div id="cash_transfer_box" class="span-3" style="display:none;">
          <div class="grid-3">
            <select id="cash_from_acc" class="span-3" required>${accOptions}</select>
            <select id="cash_to_acc" class="span-3" required>${accOptions}</select>
          </div>
        </div>

        <div id="cash_customer_box" class="span-3">
          <div class="grid-3">
            <select id="cash_customer" class="span-3" onchange="refreshCustomerInvoices()" required>${custOptions}</select>
            <select id="cash_customer_invoice" class="span-3" onchange="refreshCashPayKind()">
              <option value="">Qaimə seç (istəyə bağlı)</option>
            </select>
            <div id="cash_pay_kind_box" class="span-3" style="display:none;">
              <select id="cash_pay_kind" class="span-3">
                <option value="monthly" selected>Aylıq ödəniş</option>
                <option value="down">İlkin ödəniş</option>
              </select>
            </div>
          </div>
        </div>

        <div id="cash_supplier_box" class="span-3" style="display:none;">
          <div class="grid-3">
            <select id="cash_supplier" class="span-3" onchange="refreshSupplierInvoices()">${suppOptions}</select>
            <select id="cash_supplier_invoice" class="span-3">
              <option value="">Qaimə seç (istəyə bağlı)</option>
            </select>
          </div>
        </div>

        <div id="cash_income_box" class="span-3" style="display:none;">
          <div class="grid-3">
            <select id="cash_income_from" class="span-3" onchange="toggleIncomeSourceBox()">
              <option value="">Mənbə seç (istəyə bağlı)</option>
              ${userCanOwnerIncome() ? '<option value="owner">Təsisçi / Sahibkar</option>' : ""}
              <option value="supplier">Təchizatçı</option>
              <option value="other">Digər</option>
            </select>
            <select id="cash_income_supplier" class="span-3" style="display:none;">
              ${suppOptions}
            </select>
            <input id="cash_income_source" class="span-3" placeholder="Mədaxil mənbəyi (məs: Təchizatçıdan qaytarma)">
          </div>
        </div>

        <div id="cash_expense_box" class="span-3" style="display:none;">
          <div class="grid-3">
            <div class="select-plus span-2">
              <select id="exp_cat" onchange="refreshSubcats()">${catOptions}</select>
              <button class="mini-btn" type="button" title="Kateqoriya əlavə et" onclick="addExpenseCategory()"><i class="fas fa-plus"></i></button>
            </div>
            <div class="select-plus">
              <select id="exp_sub"></select>
              <button class="mini-btn" type="button" title="Alt kateqoriya əlavə et" onclick="addExpenseSubcategory()"><i class="fas fa-plus"></i></button>
            </div>
          </div>
        </div>

        <input id="cash_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>

      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);

  refreshSubcats();
  toggleCashKind();
}

function toggleCashKind() {
  const kind = byId("cash_kind")?.value;
  const custBox = byId("cash_customer_box");
  const suppBox = byId("cash_supplier_box");
  const expBox = byId("cash_expense_box");
  const incBox = byId("cash_income_box");
  const trBox = byId("cash_transfer_box");
  const accBox = byId("cash_acc_box");
  if (!custBox || !expBox) return;
  if (kind === "expense") {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "none";
    expBox.style.display = "";
    if (trBox) trBox.style.display = "none";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = false;
    byId("cash_acc").required = true;
  } else {
    expBox.style.display = "none";
    if (kind === "supp_pay") {
      custBox.style.display = "none";
      if (suppBox) suppBox.style.display = "";
      if (incBox) incBox.style.display = "none";
      if (trBox) trBox.style.display = "none";
      if (accBox) accBox.style.display = "";
      byId("cash_customer").required = false;
      byId("cash_acc").required = true;
      refreshSupplierInvoices();
    } else if (kind === "transfer") {
      custBox.style.display = "none";
      if (suppBox) suppBox.style.display = "none";
      if (incBox) incBox.style.display = "none";
      if (trBox) trBox.style.display = "";
      if (accBox) accBox.style.display = "none";
      byId("cash_customer").required = false;
      byId("cash_acc").required = false;
      if (byId("cash_from_acc")) byId("cash_from_acc").required = true;
      if (byId("cash_to_acc")) byId("cash_to_acc").required = true;
    } else if (kind === "income") {
      custBox.style.display = "none";
      if (suppBox) suppBox.style.display = "none";
      if (incBox) incBox.style.display = "";
      if (trBox) trBox.style.display = "none";
      if (accBox) accBox.style.display = "";
      byId("cash_customer").required = false;
      byId("cash_acc").required = true;
      toggleIncomeSourceBox();
    } else {
      custBox.style.display = "";
      if (suppBox) suppBox.style.display = "none";
      if (incBox) incBox.style.display = "none";
      if (trBox) trBox.style.display = "none";
      if (accBox) accBox.style.display = "";
      byId("cash_customer").required = true;
      byId("cash_acc").required = true;
      refreshCustomerInvoices();
    }
  }
}

function toggleIncomeSourceBox() {
  const from = byId("cash_income_from")?.value || "";
  const supSel = byId("cash_income_supplier");
  if (supSel) supSel.style.display = from === "supplier" ? "" : "none";
}

function refreshCustomerInvoices() {
  const customerId = byId("cash_customer")?.value || "";
  const sel = byId("cash_customer_invoice");
  if (!sel) return;
  const inv = db.sales
    .filter((s) => String(s.customerId) === String(customerId))
    .filter((s) => !s.returnedAt)
    .filter((s) => saleRemaining(s) > 0.000001)
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .map((s) => {
      const invNo = s.invNo || invFallback("sales", s.uid);
      return `<option value="${s.uid}">Qaimə #${escapeHtml(invNo)} • ${fmtDT(s.date)} • Qalıq ${money(saleRemaining(s))}</option>`;
    })
    .join("");
  sel.innerHTML = `<option value="">Qaimə seç (istəyə bağlı)</option>` + inv;
}

function refreshCashPayKind() {
  const saleUid = byId("cash_customer_invoice")?.value;
  const box = byId("cash_pay_kind_box");
  if (!box) return;
  if (!saleUid) {
    box.style.display = "none";
    return;
  }
  const s = db.sales.find((x) => Number(x.uid) === Number(saleUid));
  const isCredit = String(s?.saleType || "").toLowerCase() === "kredit";
  box.style.display = isCredit ? "" : "none";
}

function refreshSupplierInvoices() {
  const supp = byId("cash_supplier")?.value || "";
  const sel = byId("cash_supplier_invoice");
  if (!sel) return;
  const inv = db.purch
    .filter((p) => String(p.supp) === String(supp))
    .filter((p) => purchRemaining(p) > 0.000001)
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .map((p) => `<option value="${p.uid}">Qaimə #${p.uid} • ${fmtDT(p.date)} • ${escapeHtml(p.name)} • Qalıq ${money(purchRemaining(p))}</option>`)
    .join("");
  sel.innerHTML = `<option value="">Qaimə seç (istəyə bağlı)</option>` + inv;
}

function refreshSubcats() {
  const catName = byId("exp_cat")?.value;
  const cat = db.expenseCats.find((c) => c.name === catName) || db.expenseCats[0];
  const subSel = byId("exp_sub");
  if (!subSel) return;
  subSel.innerHTML = (cat?.subs || []).map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("");
}

function addExpenseCategory() {
  const name = prompt("Kateqoriya adı:");
  if (!name) return;
  if (db.expenseCats.some((c) => c.name.toLowerCase() === name.toLowerCase())) return alert("Bu kateqoriya var.");
  db.expenseCats.push({ name, subs: ["Digər"] });
  const sel = byId("exp_cat");
  sel.innerHTML = db.expenseCats.map((c) => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = name;
  refreshSubcats();
  saveDB();
}

function addExpenseSubcategory() {
  const catName = byId("exp_cat")?.value;
  const cat = db.expenseCats.find((c) => c.name === catName);
  if (!cat) return;
  const name = prompt("Alt kateqoriya adı:");
  if (!name) return;
  if (cat.subs.some((s) => s.toLowerCase() === name.toLowerCase())) return alert("Bu alt kateqoriya var.");
  cat.subs.push(name);
  refreshSubcats();
  byId("exp_sub").value = name;
  saveDB();
}

function saveCashOp(e) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const kind = val("cash_kind");
  const date = val("cash_date");
  const amount = Math.max(0, n(val("cash_amount")));
  const note = val("cash_note");
  const accId = Number(val("cash_acc") || 1);

  if (amount <= 0) return;

  if (kind === "transfer") {
    const fromAcc = Number(val("cash_from_acc") || 0);
    const toAcc = Number(val("cash_to_acc") || 0);
    if (!fromAcc || !toAcc) return alert("Hesab seçin.");
    if (fromAcc === toAcc) return alert("Eyni hesablar arasında transfer olmaz.");
    const bal = accountBalance(fromAcc);
    if (bal + 0.000001 < amount) return alert(`Hesab balansı kifayət etmir. Balans: ${money(bal)} AZN`);
    const trId = "tr_" + String(Date.now()) + "_" + String(genId(db.cash, 1));
    addCashOp({
      type: "out",
      date,
      source: `Transfer → ${db.accounts.find((a) => a.uid === toAcc)?.name || toAcc}`,
      amount,
      note,
      link: { kind: "transfer", transferId: trId, from: fromAcc, to: toAcc },
      accountId: fromAcc,
    });
    addCashOp({
      type: "in",
      date,
      source: `Transfer ← ${db.accounts.find((a) => a.uid === fromAcc)?.name || fromAcc}`,
      amount,
      note,
      link: { kind: "transfer", transferId: trId, from: fromAcc, to: toAcc },
      accountId: toAcc,
    });
    logEvent("create", "cash", { type: "transfer", kind: "transfer", amount, from: fromAcc, to: toAcc });
    saveDB();
    closeMdl();
    return;
  }

  if (kind === "income") {
    const from = val("cash_income_from");
    if (from === "owner" && !userCanOwnerIncome()) {
      alert("Təsisçi mədaxili yalnız admin və ya developer edə bilər.");
      return;
    }
    const supp = val("cash_income_supplier");
    const src = (val("cash_income_source") || "").trim();
    const label =
      from === "owner"
        ? (src || "Təsisçi mədaxili")
        : from === "supplier" && supp
          ? `Təchizatçı mədaxil (${supp})`
          : (src || "Mədaxil");
    addCashOp({
      type: "in",
      date,
      source: label,
      amount,
      note,
      link: { kind: "income", from: from || "other", supp: from === "supplier" ? supp : "" },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "in", kind: "income", amount, from, supp });
    saveDB();
    closeMdl();
    return;
  }

  if (kind === "expense") {
    const bal = accountBalance(accId);
    if (bal + 0.000001 < amount) {
      alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
      return;
    }
    const cat = val("exp_cat");
    const sub = val("exp_sub");
    addCashOp({
      type: "out",
      date,
      source: `Xərc: ${cat} / ${sub}`,
      amount,
      note,
      link: { kind: "expense", cat, sub },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "out", kind: "expense", amount });
    saveDB();
    closeMdl();
    return;
  }

  if (kind === "supp_pay") {
    const bal = accountBalance(accId);
    if (bal + 0.000001 < amount) {
      alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
      return;
    }
    const supp = val("cash_supplier");
    if (!supp) return;
    const invoiceUid = val("cash_supplier_invoice");

    if (invoiceUid) {
      const p = db.purch.find((x) => Number(x.uid) === Number(invoiceUid));
      if (!p) return;
      const rem = purchRemaining(p);
      const a = Math.min(rem, amount);
      if (a <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
      p.paidTotal = String(n(p.paidTotal) + a);

      addCashOp({
        type: "out",
        date,
        source: `Təchizatçı ödənişi (${supp})`,
        amount: a,
        note: note || `Qaimə #${p.uid}`,
        link: { kind: "creditor_invoice_payment", supp, purchUid: p.uid },
        meta: { allocations: [{ purchUid: p.uid, amount: a }] },
        accountId: accId,
      });
      logEvent("create", "cash", { type: "out", kind: "creditor_invoice_payment", amount: a, purchUid: p.uid });

      saveDB();
      closeMdl();
      return;
    }

    const applied = applySupplierPaymentToCreditor(supp, amount, date, "cash_module_creditor");
    if (applied.applied <= 0.000001) {
      alert("Bu təchizatçı üzrə borc yoxdur (və ya artıq ödənilib).");
      return;
    }

    addCashOp({
      type: "out",
      date,
      source: `Təchizatçı ödənişi (${supp})`,
      amount: applied.applied,
      note: note || "Kreditor ödəniş",
      link: { kind: "creditor_payment", supp },
      meta: { allocations: applied.allocations },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "out", kind: "creditor_payment", amount: applied.applied, supp });

    saveDB();
    closeMdl();
    return;
  }

  // customer payment
  const customerId = val("cash_customer");
  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  if (!cust) return;

  const saleUid = val("cash_customer_invoice");
  if (saleUid) {
    const s = db.sales.find((x) => Number(x.uid) === Number(saleUid));
    if (!s) return;
    if (String(s.customerId) !== String(customerId)) return;
    if (s.returnedAt) return alert("Bu qaimə qaytarılıb.");
    s.payments = s.payments || [];
    const rem = saleRemaining(s);
    const a = Math.min(rem, amount);
    if (a <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
    const isCreditSale = String(s.saleType || "").toLowerCase() === "kredit";
    const cashPayKind = isCreditSale ? (val("cash_pay_kind") || "monthly") : "regular";
    const paySource = cashPayKind === "down" ? "down" : cashPayKind === "monthly" ? "monthly" : "cash_module_invoice";
    addSalePaymentInternal(s, a, date, paySource);
    addCashOp({
      type: "in",
      date,
      source: `Müştəri ödənişi (${cust.sur} ${cust.name})`,
      amount: a,
      note: note || `Qaimə #${s.invNo || invFallback("sales", s.uid)}`,
      link: { kind: "debtor_payment", customerId },
      meta: { allocations: [{ saleUid: s.uid, amount: a }], payKind: cashPayKind },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "in", kind: "debtor_invoice_payment", amount: a, customerId, saleUid: s.uid });

    saveDB();
    closeMdl();
    return;
  }

  const applied = applyCustomerPaymentToDebts(customerId, amount, date, "cash_module");
  if (applied.applied <= 0.000001) {
    alert("Bu müştərinin borcu yoxdur (və ya borc artıq ödənilib).");
    return;
  }

  const generalPayKind = val("cash_pay_kind") || "regular";
  addCashOp({
    type: "in",
    date,
    source: `Müştəri ödənişi (${cust.sur} ${cust.name})`,
    amount: applied.applied,
    note: note || `Debitor ödəniş`,
    link: { kind: "debtor_payment", customerId },
    meta: { allocations: applied.allocations, payKind: generalPayKind },
    accountId: accId,
  });
  logEvent("create", "cash", { type: "in", kind: "debtor_payment", amount: applied.applied, customerId });

  saveDB();
  closeMdl();
}

// ========= Debts filters =========
function filterDebts() {
  const q = (byId("srcDebts")?.value || "").toLowerCase();
  document.querySelectorAll("#tblDebts tr").forEach((r) => {
    r.style.display = r.innerText.toLowerCase().includes(q) ? "" : "none";
  });
}

function filterCreditOnly() {
  const q = (byId("srcCreditOnly")?.value || "").toLowerCase();
  document.querySelectorAll("#tblDebts tr").forEach((r) => {
    const isCredit = r.getAttribute("data-sale-type") === "kredit";
    if (!q) {
      r.style.display = "";
      return;
    }
    r.style.display = isCredit && r.innerText.toLowerCase().includes(q) ? "" : "none";
  });
}

function filterCreditor() {
  const q = (byId("srcCred")?.value || "").toLowerCase();
  document.querySelectorAll("#tblCreditor tr").forEach((r) => {
    r.style.display = r.innerText.toLowerCase().includes(q) ? "" : "none";
  });
}

function reapplyActiveSearchFilters() {
  const inputs = Array.from(document.querySelectorAll(".search-container input[type='text']"));
  for (const inp of inputs) {
    const q = String(inp.value || "");
    if (!q.trim()) continue;
    const handler = inp.getAttribute("onkeyup");
    if (!handler) continue;
    try {
      // Keep filtered rows after each render/realtime refresh.
      new Function(handler).call(inp);
    } catch (e) {}
  }
}

function applySupplierPaymentToCreditor(suppName, amount, date, source) {
  let left = Math.max(0, n(amount));
  if (left <= 0) return { applied: 0, remaining: left, allocations: [] };

  const purchases = db.purch
    .filter((p) => String(p.supp) === String(suppName))
    .filter((p) => purchRemaining(p) > 0.000001)
    .sort((a, b) => (a.date > b.date ? 1 : -1)); // oldest first

  const allocations = [];
  for (const p of purchases) {
    if (left <= 0.000001) break;
    const rem = purchRemaining(p);
    const pay = Math.min(rem, left);
    p.paidTotal = String(n(p.paidTotal) + pay);
    allocations.push({ purchUid: p.uid, amount: pay });
    left -= pay;
  }

  return { applied: n(amount) - left, remaining: left, allocations };
}

function openCreditorPayment(groupIdx) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const g = (window.__credGroups || [])[groupIdx];
  if (!g) return;
  const rem = g.rem;

  openModal(`
    <h2>Kreditor ödənişi</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(g.supp)}</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq</div><div class="info-value">${money(rem)} AZN</div></div>
    </div>
    <form onsubmit="saveCreditorPayment(event, ${groupIdx})">
      <div class="grid-3">
        <input type="datetime-local" id="cred_pay_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="cred_pay_amount" class="span-2" placeholder="Məbləğ (AZN)" required>
        <select id="cred_pay_acc" class="span-3" required>${accountOptionsHtml(1)}</select>
        <input id="cred_pay_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="openCreditorInfo(${groupIdx})">Geri</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveCreditorPayment(e, groupIdx) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const g = (window.__credGroups || [])[groupIdx];
  if (!g) return;

  const date = val("cred_pay_date");
  const amount = Math.max(0, n(val("cred_pay_amount")));
  const accId = Number(val("cred_pay_acc") || 1);
  if (amount <= 0) return;

  const bal = accountBalance(accId);
  if (bal + 0.000001 < amount) {
    alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
    return;
  }

  const applied = applySupplierPaymentToCreditor(g.supp, amount, date, "cash_module_creditor");
  if (applied.applied <= 0.000001) {
    alert("Bu təchizatçı üzrə borc yoxdur (və ya artıq ödənilib).");
    return;
  }

  addCashOp({
    type: "out",
    date,
    source: `Təchizatçı ödənişi (${g.supp})`,
    amount: applied.applied,
    note: val("cred_pay_note") || "Kreditor ödəniş",
    link: { kind: "creditor_payment", supp: g.supp },
    meta: { allocations: applied.allocations },
    accountId: accId,
  });

  saveDB();
  // reopen updated info (groupIdx might change after regroup; just show creditor module)
  closeMdl();
}

function openCreditorInfo(groupIdx) {
  const g = (window.__credGroups || [])[groupIdx];
  if (!g) return;

  const rows = g.purchases
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .map((p) => {
      const total = n(p.amount);
      const paid = n(p.paidTotal);
      const rem = purchRemaining(p);
      const st = debtStatus(total, rem);
      return `
      <tr>
        <td>${p.uid}</td>
        <td>${fmtDT(p.date)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${money(total)} AZN</td>
        <td>${money(paid)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td><span class="pill ${st}">${debtLabel(st)}</span></td>
        <td class="tbl-actions">
          <button class="btn-mini-pay" type="button" onclick="openCreditorInvoicePayment(${p.uid})">Ödəniş et</button>
        </td>
      </tr>`;
    })
    .join("");

  openModal(`
    <h2>Kreditor detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(g.supp)}</div></div>
      <div class="info-row"><div class="info-label">Cəmi məbləğ</div><div class="info-value">${money(g.total)} AZN</div></div>
      <div class="info-row"><div class="info-label">Cəmi ödənilən</div><div class="info-value">${money(g.paid)} AZN</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq</div><div class="info-value">${money(g.rem)} AZN</div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Qaimə (Alış ID)</th><th>Tarix</th><th>Məhsul</th><th>Məbləğ</th><th>Ödənilən</th><th>Qalıq</th><th>Status</th><th>Ödəniş</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="8">Bu təchizatçı üzrə alış yoxdur</td></tr>`}</tbody>
      </table>
    </div>

    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openCreditorPayment(${groupIdx})">Ümumi ödəniş</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openCreditorInvoicePayment(purchUid) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const p = db.purch.find((x) => Number(x.uid) === Number(purchUid));
  if (!p) return;
  const rem = purchRemaining(p);
  openModal(`
    <h2>Qaimə ödənişi</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(p.supp)}</div></div>
      <div class="info-row"><div class="info-label">Qaimə (Alış ID)</div><div class="info-value">${p.uid}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(p.name)}</div></div>
      <div class="info-row"><div class="info-label">Qalıq</div><div class="info-value">${money(rem)} AZN</div></div>
    </div>
    <form onsubmit="saveCreditorInvoicePayment(event, ${p.uid})">
      <div class="grid-3">
        <input type="datetime-local" id="inv_pay_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="inv_pay_amount" class="span-2" placeholder="Məbləğ (AZN)" required>
        <select id="inv_pay_acc" class="span-3" required>${accountOptionsHtml(1)}</select>
        <input id="inv_pay_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveCreditorInvoicePayment(e, purchUid) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const p = db.purch.find((x) => Number(x.uid) === Number(purchUid));
  if (!p) return;
  const date = val("inv_pay_date");
  const amount = Math.max(0, n(val("inv_pay_amount")));
  const accId = Number(val("inv_pay_acc") || 1);
  if (amount <= 0) return;
  const rem = purchRemaining(p);
  const applied = Math.min(rem, amount);
  if (applied <= 0.000001) return;

  const bal = accountBalance(accId);
  if (bal + 0.000001 < applied) {
    alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
    return;
  }

  p.paidTotal = String(n(p.paidTotal) + applied);

  addCashOp({
    type: "out",
    date,
    source: `Təchizatçı ödənişi (${p.supp})`,
    amount: applied,
    note: val("inv_pay_note") || `Qaimə #${p.uid}`,
    link: { kind: "creditor_invoice_payment", supp: p.supp, purchUid: p.uid },
    meta: { allocations: [{ purchUid: p.uid, amount: applied }] },
    accountId: accId,
  });

  saveDB();
  closeMdl();
}

// ========= Admin (Companies/Users/Profile) =========
function openCompany(idx = null) {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  const c = idx !== null ? meta.companies[idx] : { id: "", name: "", sections: [] };
  const allSections = [
    "dash",
    "cust",
    "supp",
    "prod",
    "purch",
    "stock",
    "sales",
    "staff",
    "debts",
    "creditor",
    "cash",
    "accounts",
    "audit",
    "trash",
    "tools",
    "reports",
  ];
  const enabled = Array.isArray(c.sections) && c.sections.length > 0 ? c.sections : allSections;
  const secChecks = allSections
    .map((s) => {
      const on = enabled.includes(s);
      return `<label class="chk"><input type="checkbox" class="coSec" value="${s}" ${on ? "checked" : ""}><span>${escapeHtml(sectionLabelAz(s))}</span></label>`;
    })
    .join("");
  openModal(`
    <h2>${idx !== null ? "Şirkət redaktə" : "Yeni şirkət"}</h2>
    <form onsubmit="saveCompany(event, ${idx})">
      <div class="grid-3">
        <input id="co_name" class="span-2" placeholder="Şirkət adı" value="${escapeHtml(c.name || "")}" required>
        <input id="co_id" placeholder="Kod (unikal)" value="${escapeHtml(c.id || "")}" ${idx !== null ? "disabled" : ""} required>
      </div>
      <div class="info-block">
        <div class="info-row">
          <div class="info-label">Modullar</div>
          <div class="info-value" style="display:flex;flex-wrap:wrap;gap:12px;">
            ${secChecks}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Yarat"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveCompany(e, idx) {
  e.preventDefault();
  if (!isDeveloper()) return;
  const name = val("co_name").trim();
  const id = (val("co_id") || "").trim().toLowerCase();
  const sections = Array.from(document.querySelectorAll(".coSec"))
    .filter((x) => x.checked)
    .map((x) => x.value);
  if (!name || !id) return;
  if (idx === null) {
    if (meta.companies.some((c) => c.id === id)) return alert("Bu kodla şirkət var.");
    meta.companies.push({ id, name, sections });
  } else {
    meta.companies[idx] = { ...meta.companies[idx], name, sections };
  }
  saveMeta();
  closeMdl();
  renderAll();
}

function useCompany(companyId) {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  const c = meta.companies.find((x) => x.id === companyId);
  if (!c) return;
  meta.session.companyId = c.id;
  saveMeta();
  if (useFirestore()) {
    loadCompanyDBAsync().then((data) => {
      db = data;
      unsubscribeRealtime();
      subscribeRealtime();
      renderAll();
    });
  } else {
    db = loadCompanyDB();
    renderAll();
  }
}

function delCompany(idx) {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  const c = meta.companies[idx];
  if (!c) return;
  appConfirm("Şirkət silinsin? (məlumatlar LocalStorage-da qalacaq)").then((ok) => {
    if (!ok) return;
    meta.companies.splice(idx, 1);
    if (meta.companies.length === 0) meta.companies.push({ id: "bakfon", name: "Bakfon" });
    if (meta.session && !meta.companies.some((x) => x.id === meta.session.companyId)) {
      meta.session.companyId = meta.companies[0].id;
      if (useFirestore()) loadCompanyDBAsync().then((data) => { db = data; subscribeRealtime(); });
      else db = loadCompanyDB();
    }
    saveMeta();
    renderAll();
  });
  return;
}

function resetCompanyData() {
  if (!userCanReset()) return alert("Reset icazəsi yoxdur.");
  const cid = meta?.session?.companyId;
  if (!cid) return;
  appConfirm("Bu şirkətin bütün datası sıfırlansın?").then((ok) => {
    if (!ok) return;
    const empty = defaultDB();
    if (useFirestore()) {
      const ref = getCompanyRef(cid);
      if (ref) ref.set(empty).then(() => { db = empty; logEvent("reset", "company", { companyId: cid }); renderAll(); });
    } else {
      localStorage.setItem(companyDBKey(cid), JSON.stringify(empty));
      db = loadCompanyDB();
      logEvent("reset", "company", { companyId: cid });
      renderAll();
    }
  });
  return;
}

function getCompanyIdFromUsername(username) {
  if (!username || typeof username !== "string") return null;
  const idx = username.indexOf("_");
  if (idx <= 0) return null;
  return username.slice(0, idx).trim().toLowerCase();
}

function userBelongsToCompany(u, cid) {
  if (!cid) return false;
  const norm = (s) => (s == null || s === "" ? "" : String(s).trim().toLowerCase());
  if (u.role === "developer" && (u.companyId == null || u.companyId === "")) return false;
  const prefixCid = getCompanyIdFromUsername(u.username);
  if (prefixCid) return norm(prefixCid) === norm(cid);
  return norm(u.companyId) === norm(cid);
}

function usersForCurrentCompany() {
  const cid = meta?.session?.companyId;
  if (!cid) return [];
  return meta.users.filter((u) => userBelongsToCompany(u, cid));
}

function openUser(uidOrNull = null) {
  if (!isDeveloper() && !isAdmin()) return alert("İcazə yoxdur.");
  const cid = meta?.session?.companyId;
  const u =
    uidOrNull !== null && uidOrNull !== undefined && uidOrNull !== ""
      ? meta.users.find((x) => String(x.uid) === String(uidOrNull))
      : null;
  if (uidOrNull != null && uidOrNull !== "" && !u) return;
  if (!isDeveloper() && u && cid && !userBelongsToCompany(u, cid)) return alert("Bu istifadəçi başqa şirkətə aiddir.");
  const editingUser = u || {
          uid: genId(meta.users, 1),
          fullName: "",
          username: "",
          staffUid: "",
          pass: "",
          role: "user",
          active: true,
          companyId: cid || null,
          perms: {
            sections: ["dash", "cust", "supp", "prod", "purch", "stock", "sales", "staff", "debts", "creditor", "cash", "accounts", "reports"],
            canEdit: false,
            canDelete: false,
            canPay: false,
            canRefund: false,
            canExport: false,
            canImport: false,
            canReset: false,
            actions: {},
          },
        };
  if (!editingUser.perms) editingUser.perms = { sections: [], canEdit: false, canDelete: false };
  if (typeof editingUser.perms.canEdit !== "boolean") editingUser.perms.canEdit = false;
  if (typeof editingUser.perms.canDelete !== "boolean") editingUser.perms.canDelete = false;
  if (typeof editingUser.perms.canPay !== "boolean") editingUser.perms.canPay = false;
  if (typeof editingUser.perms.canRefund !== "boolean") editingUser.perms.canRefund = false;
  if (typeof editingUser.perms.canExport !== "boolean") editingUser.perms.canExport = false;
  if (typeof editingUser.perms.canImport !== "boolean") editingUser.perms.canImport = false;
  if (typeof editingUser.perms.canReset !== "boolean") editingUser.perms.canReset = false;
  if (!editingUser.perms.actions || typeof editingUser.perms.actions !== "object") editingUser.perms.actions = {};

  const actionMatrixSecs = ["cash", "sales", "purch", "prod", "accounts", "cust", "supp"];
  const actionCols = [
    { key: "edit", label: "Edit" },
    { key: "delete", label: "Delete" },
    { key: "pay", label: "Pay" },
    { key: "refund", label: "Refund" },
  ];
  const actionMatrix = `
    <table class="perm-matrix">
      <thead>
        <tr>
          <th>Bölmə</th>
          ${actionCols.map((c) => `<th>${c.label}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${actionMatrixSecs
          .map((s) => {
            return `
              <tr>
                <td>${escapeHtml(sectionLabelAz(s))}</td>
                ${actionCols
                  .map((c) => {
                    const k = `${s}.${c.key}`;
                    const on = !!editingUser.perms.actions?.[k];
                    return `<td><label class="chk" style="justify-content:center;"><input type="checkbox" class="permAct" data-key="${escapeAttr(k)}" ${on ? "checked" : ""}><span></span></label></td>`;
                  })
                  .join("")}
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
    <p class="muted small" style="margin-top:10px;">Qeyd: Bu cədvəldə işarələnən icazələr bölmə+əməliyyat üzrə daha dəqiq nəzarətdir (məs: <strong>sales.pay</strong>). Köhnə “ümumi” icazələr (aşağıdakı checkbox-lar) geriyə uyğunluq üçündür.</p>
  `;
  const sections = [
    "dash",
    "cust",
    "supp",
    "prod",
    "purch",
    "stock",
    "sales",
    "staff",
    "debts",
    "overdue",
    "creditor",
    "cash",
    "accounts",
    "audit",
    "trash",
    "tools",
    "reports",
  ];
  const checks = sections
    .map((s) => {
      const on = (editingUser.perms?.sections || []).includes("*") || (editingUser.perms?.sections || []).includes(s);
      return `<label class="chk"><input type="checkbox" class="permSec" value="${s}" ${on ? "checked" : ""}><span>${escapeHtml(sectionLabelAz(s))}</span></label>`;
    })
    .join("");
  const isNew = uidOrNull == null || uidOrNull === "";
  openModal(`
    <h2>${isNew ? "Yeni istifadəçi" : "İstifadəçi redaktə"}</h2>
    <form onsubmit="saveUser(event)">
      <input type="hidden" id="u_uid" value="${escapeAttr(isNew ? "" : String(editingUser.uid))}">
      <div class="grid-3">
        <input id="u_full" class="span-3" placeholder="Ad Soyad" value="${escapeHtml(editingUser.fullName || "")}" required>
        <input id="u_name" class="span-2" placeholder="${escapeAttr((cid || "") + "_ad (məs: " + (cid || "baktel") + "_rustamb)")}" value="${escapeHtml(editingUser.username || "")}" ${!isNew ? "disabled" : ""} required>
        <select id="u_staff" class="span-3" title="Əməkdaş">
          <option value="">— Əməkdaş seçin —</option>
          ${(db.staff || []).map((s) => `<option value="${s.uid}" ${String(editingUser.staffUid || "") === String(s.uid) ? "selected" : ""}>${escapeHtml(s.name)}${s.role ? " - " + escapeHtml(s.role) : ""}</option>`).join("")}
        </select>
        <select id="u_role">
          <option value="user" ${editingUser.role === "user" ? "selected" : ""}>user</option>
          <option value="admin" ${editingUser.role === "admin" ? "selected" : ""}>admin</option>
          <option value="developer" ${editingUser.role === "developer" ? "selected" : ""}>developer</option>
        </select>
        <input id="u_pass" class="span-3" placeholder="Şifrə" type="password" value="${escapeHtml(editingUser.pass || "")}" required>
        <label class="chk span-3"><input type="checkbox" id="u_active" ${editingUser.active ? "checked" : ""}><span>Aktiv</span></label>
        <div class="span-3 info-block">
          <div class="info-row">
            <div class="info-label">İcazələr</div>
            <div class="info-value" style="display:flex;flex-wrap:wrap;gap:12px;">
              <label class="chk"><input type="checkbox" id="u_can_edit" ${editingUser.perms.canEdit ? "checked" : ""}><span>Redaktə edə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_delete" ${editingUser.perms.canDelete ? "checked" : ""}><span>Silə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_pay" ${editingUser.perms.canPay ? "checked" : ""}><span>Ödəniş edə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_ref" ${editingUser.perms.canRefund ? "checked" : ""}><span>Qaytarma edə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_exp" ${editingUser.perms.canExport ? "checked" : ""}><span>Export edə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_imp" ${editingUser.perms.canImport ? "checked" : ""}><span>Import edə bilsin</span></label>
              <label class="chk"><input type="checkbox" id="u_can_reset" ${editingUser.perms.canReset ? "checked" : ""}><span>Reset edə bilsin</span></label>
            </div>
          </div>
        </div>
        <div class="span-3 info-block">
          <div class="info-row">
            <div class="info-label">Detallı icazələr</div>
            <div class="info-value">${actionMatrix}</div>
          </div>
        </div>
        <div class="span-3 info-block">
          <div class="info-row"><div class="info-label">Bölmələr</div><div class="info-value" style="display:flex;flex-wrap:wrap;gap:10px;">${checks}</div></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${isNew ? "Yarat" : "Yenilə"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveUser(e) {
  e.preventDefault();
  if (!isDeveloper() && !isAdmin()) return;
  const uidVal = (val("u_uid") || "").trim();
  const fullName = val("u_full").trim();
  const username = val("u_name").trim();
  const staffUid = (val("u_staff") || "").trim();
  const pass = val("u_pass");
  const role = val("u_role");
  const active = !!byId("u_active")?.checked;
  const canEdit = !!byId("u_can_edit")?.checked;
  const canDelete = !!byId("u_can_delete")?.checked;
  const canPay = !!byId("u_can_pay")?.checked;
  const canRefund = !!byId("u_can_ref")?.checked;
  const canExport = !!byId("u_can_exp")?.checked;
  const canImport = !!byId("u_can_imp")?.checked;
  const canReset = !!byId("u_can_reset")?.checked;
  const actions = {};
  document.querySelectorAll(".permAct").forEach((el) => {
    const k = el.getAttribute("data-key");
    if (!k) return;
    if (el.checked) actions[k] = true;
  });
  const sections = Array.from(document.querySelectorAll(".permSec"))
    .filter((x) => x.checked)
    .map((x) => x.value);
  if (!username || !pass) return;
  const cid = (meta?.session?.companyId || "").trim().toLowerCase();
  const prefix = getCompanyIdFromUsername(username);
  if (uidVal === "") {
    if (!cid) return alert("Cari şirkət müəyyən deyil.");
    if (!prefix || prefix !== cid) return alert("İstifadəçi adı şirkət adı ilə başlamalıdır: " + (meta?.session?.companyId || cid) + "_ (məs: " + (meta?.session?.companyId || cid) + "_rustamb).");
    if (meta.users.some((u) => u.username === username)) return alert("Bu istifadəçi adı var.");
    meta.users.push({ uid: genId(meta.users, 1), fullName, username, staffUid: staffUid || undefined, pass, role, active, companyId: cid || null, perms: { sections, canEdit, canDelete, canPay, canRefund, canExport, canImport, canReset, actions }, createdAt: nowISODateTimeLocal() });
  } else {
    const idx = meta.users.findIndex((x) => String(x.uid) === String(uidVal));
    if (idx === -1) return;
    const keep = meta.users[idx];
    if (!isDeveloper() && cid && !userBelongsToCompany(keep, cid)) return alert("Bu istifadəçi başqa şirkətə aiddir.");
    meta.users[idx] = { ...keep, fullName, staffUid: staffUid || undefined, pass, role, active, companyId: keep.companyId || prefix || cid, perms: { sections, canEdit, canDelete, canPay, canRefund, canExport, canImport, canReset, actions } };
  }
  saveMeta();
  closeMdl();
  renderAll();
}

function delUser(uid) {
  if (!isDeveloper() && !isAdmin()) return alert("İcazə yoxdur.");
  const idx = meta.users.findIndex((x) => String(x.uid) === String(uid));
  const u = idx >= 0 ? meta.users[idx] : null;
  if (!u) return;
  const cid = meta?.session?.companyId;
  if (!isDeveloper() && cid && !userBelongsToCompany(u, cid)) return alert("Bu istifadəçi başqa şirkətə aiddir.");
  if (u.username === "developer") return alert("Developer silinə bilməz.");
  if (u.role === "admin" && !isDeveloper()) return alert("Admin istifadəçisini yalnız developer silə bilər.");
  appConfirm("İstifadəçi silinsin?").then((ok) => {
    if (!ok) return;
    meta.users.splice(idx, 1);
    saveMeta();
    renderAll();
  });
  return;
}

function renderProfile() {
  const u = currentUser();
  const c = meta.companies.find((x) => x.id === meta?.session?.companyId);
  const box = byId("profileBox");
  if (!box) return;
  if (!u) {
    box.innerHTML = `<div class="info-row"><div class="info-label">Status</div><div class="info-value">Giriş yoxdur</div></div>`;
    return;
  }
  box.innerHTML = `
    <div class="info-row"><div class="info-label">Şirkət</div><div class="info-value">${escapeHtml(c?.name || "-")} (${escapeHtml(c?.id || "")})</div></div>
    <div class="info-row"><div class="info-label">İstifadəçi</div><div class="info-value">${escapeHtml(u.username)}</div></div>
    <div class="info-row"><div class="info-label">Rol</div><div class="info-value">${escapeHtml(u.role)}</div></div>
    <div class="info-row"><div class="info-label">Şifrə</div><div class="info-value"><button class="btn-cancel" type="button" onclick="openChangePassword()">Şifrəni dəyiş</button></div></div>
  `;
}

function closeProfileMenu() {
  const el = byId("profileDropdown");
  if (el) el.classList.remove("profile-dropdown-open");
  document.removeEventListener("click", _profileMenuOutsideClick);
}
function _profileMenuOutsideClick(e) {
  const dd = byId("profileDropdown");
  const btn = byId("profileMenuBtn");
  if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) closeProfileMenu();
}
function toggleProfileMenu(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!meta?.session) return showLoginOverlay(true);
  const btn = byId("profileMenuBtn");
  let dd = byId("profileDropdown");
  if (!dd) {
    dd = document.createElement("div");
    dd.id = "profileDropdown";
    dd.className = "profile-dropdown";
    document.body.appendChild(dd);
  }
  const theme = getTheme();
  dd.innerHTML = `
    <button type="button" class="profile-dropdown-item" onclick="closeProfileMenu();openProfile();"><i class="fas fa-user"></i> Profil</button>
    <button type="button" class="profile-dropdown-item" onclick="closeProfileMenu();openChangePassword();"><i class="fas fa-key"></i> Şifrəni dəyiş</button>
    <div class="profile-dropdown-sep"></div>
    <button type="button" class="profile-dropdown-item ${theme === "light" ? "profile-dropdown-item-active" : ""}" onclick="closeProfileMenu();setTheme('light');"><i class="fas fa-sun"></i> Açıq tema</button>
    <button type="button" class="profile-dropdown-item ${theme === "dark" ? "profile-dropdown-item-active" : ""}" onclick="closeProfileMenu();setTheme('dark');"><i class="fas fa-moon"></i> Qaranlıq tema</button>
    <div class="profile-dropdown-sep"></div>
    <button type="button" class="profile-dropdown-item profile-dropdown-item-danger" onclick="closeProfileMenu();logout();"><i class="fas fa-right-from-bracket"></i> Çıxış</button>
  `;
  if (dd.classList.contains("profile-dropdown-open")) {
    closeProfileMenu();
    return;
  }
  const rect = btn.getBoundingClientRect();
  const minW = Math.max(rect.width, 200);
  dd.style.minWidth = minW + "px";
  dd.style.left = "";
  dd.style.right = (window.innerWidth - rect.right) + "px";
  dd.style.top = (rect.bottom + 6) + "px";
  dd.classList.add("profile-dropdown-open");
  document.addEventListener("click", _profileMenuOutsideClick);
}

function openProfile() {
  if (!meta?.session) return showLoginOverlay(true);
  const u = currentUser();
  const c = meta.companies.find((x) => x.id === meta?.session?.companyId);
  if (!u) return;
  const theme = getTheme();
  closeProfileMenu();
  openModal(`
    <div class="profile-modal">
      <h2 class="profile-title">Profil</h2>
      <div class="profile-section">
        <div class="profile-row"><span class="profile-label">Şirkət</span><span class="profile-value">${escapeHtml(c?.name || "-")} <small class="muted">(${escapeHtml(c?.id || "")})</small></span></div>
        <div class="profile-row"><span class="profile-label">İstifadəçi</span><span class="profile-value">${escapeHtml(u.username)}</span></div>
        <div class="profile-row"><span class="profile-label">Rol</span><span class="profile-value">${escapeHtml(u.role)}</span></div>
      </div>
      <div class="profile-section">
        <div class="profile-row">
          <span class="profile-label">Tema</span>
          <span class="profile-value profile-actions">
            <button type="button" class="btn-main btn-sm ${theme === "light" ? "" : "btn-theme-inactive"}" onclick="setTheme('light');closeMdl();" title="Açıq"><i class="fas fa-sun"></i> Açıq</button>
            <button type="button" class="btn-main btn-sm ${theme === "dark" ? "" : "btn-theme-inactive"}" onclick="setTheme('dark');closeMdl();" title="Qaranlıq"><i class="fas fa-moon"></i> Qaranlıq</button>
          </span>
        </div>
      </div>
    </div>
    <div class="modal-footer modal-footer-actions">
      <button class="btn-main" type="button" onclick="openChangePassword()"><i class="fas fa-key"></i> Şifrəni dəyiş</button>
      <button class="btn-cancel" type="button" onclick="triggerProfilePhotoUpload()"><i class="fas fa-camera"></i> Şəkil yüklə</button>
      <button class="btn-cancel" type="button" onclick="logout()"><i class="fas fa-right-from-bracket"></i> Çıxış</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openReturnSale(idx) {
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const s = db.sales[idx];
  if (!s) return;
  if (s.returnedAt) return alert("Bu satış artıq qaytarılıb.");
  ensureAccounts();
  const accOptions = accountOptionsHtml(1);
  openModal(`
    <h2>Satışı qaytar</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Qaimə</div><div class="info-value">${escapeHtml(s.invNo || invFallback("sales", s.uid))}</div></div>
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(s.productName)}</div></div>
    </div>
    <form onsubmit="saveReturnSale(event, ${idx})">
      <div class="grid-3">
        <input type="datetime-local" id="ret_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="ret_refund" class="span-2" placeholder="Geri qaytarılacaq məbləğ (AZN) (istəyə bağlı)" value="0">
        <select id="ret_acc" class="span-3">${accOptions}</select>
        <input id="ret_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-cancel" type="button" onclick="openSaleInfo(${idx})">Geri</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function openSkins() {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  const cur = getSkinId();
  const cards = SKINS
    .map((s) => {
      const on = s.id === cur;
      return `
        <button type="button" class="card" style="text-align:left;padding:14px;border:${on ? "2px solid var(--accent)" : "1px solid var(--border-color)"};background:var(--bg-main);" onclick="setSkin('${escapeAttr(s.id)}');closeMdl();">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div>
              <div style="font-weight:700;">${escapeHtml(s.name)}</div>
              <div class="muted" style="font-size:.9rem;">Accent: ${escapeHtml(s.accent)}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="width:18px;height:18px;border-radius:6px;background:${escapeAttr(s.accent)};border:1px solid rgba(0,0,0,.15);display:inline-block;"></span>
              <span style="width:18px;height:18px;border-radius:6px;background:${escapeAttr(s.sidebarLight)};border:1px solid rgba(0,0,0,.15);display:inline-block;"></span>
            </div>
          </div>
        </button>`;
    })
    .join("");
  openModal(`
    <h2>Skinlər / Rəng palitraları</h2>
    <p class="muted" style="margin:0 0 12px 0;">İstədiyiniz palitranı seçin. Seçim cihazda yadda qalır.</p>
    <div style="display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:12px;">
      ${cards}
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function saveReturnSale(e, idx) {
  e.preventDefault();
  if (!userCanRefund()) return alert("Qaytarma icazəsi yoxdur.");
  const s = db.sales[idx];
  if (!s) return;
  if (s.returnedAt) return;
  const date = val("ret_date");
  const refund = Math.max(0, n(val("ret_refund")));
  const accId = Number(val("ret_acc") || 1);
  const note = val("ret_note");
  if (refund > 0.000001) {
    if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
    const bal = accountBalance(accId);
    if (bal + 0.000001 < refund) return alert("Hesab balansı kifayət etmir.");
    addCashOp({
      type: "out",
      date,
      source: `Qaytarma (${s.customerName})`,
      amount: refund,
      note: note || `Satış qaytarma #${s.uid}`,
      link: { kind: "return_refund", saleUid: s.uid },
      meta: { saleUid: s.uid },
      accountId: accId,
    });
    logEvent("create", "cash", { type: "out", kind: "return_refund", saleUid: s.uid, amount: refund });
  }
  s.returnedAt = date;
  s.returnNote = note || "";
  logEvent("return", "sales", { uid: s.uid, invNo: s.invNo || invFallback("sales", s.uid), refund });
  saveDB();
  openSaleInfo(idx);
}

function printSale(idx) {
  const s = db.sales[idx];
  if (!s) return;
  const inv = s.invNo || invFallback("sales", s.uid);
  const set = db.settings || defaultDB().settings;
  const html = `
  <html><head><title>${inv}</title>
    <style>
      body{font-family:Arial, sans-serif;padding:18px;}
      h1{font-size:18px;margin:0 0 10px;}
      .row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed #ddd;padding:6px 0;}
      .k{font-weight:700;color:#555;}
      .v{font-weight:700;}
    </style>
  </head><body>
    <h1>${escapeHtml(set.companyName || "Şirkət")} • Satış qaiməsi • ${inv}</h1>
    <div style="color:#555;font-weight:700;margin-bottom:10px;">
      ${escapeHtml((set.companyAddress || "").trim())}${set.companyPhone ? " • " + escapeHtml(set.companyPhone) : ""}
    </div>
    <div class="row"><div class="k">Tarix</div><div class="v">${fmtDT(s.date)}</div></div>
    <div class="row"><div class="k">Müştəri</div><div class="v">${escapeHtml(s.customerName)}</div></div>
    <div class="row"><div class="k">Məhsul</div><div class="v">${escapeHtml(s.productName)}</div></div>
    <div class="row"><div class="k">Kod</div><div class="v">${escapeHtml(s.code || "-")}</div></div>
    <div class="row"><div class="k">Say</div><div class="v">${String(Math.max(1, Math.floor(n(s.qty || 1))))}</div></div>
    <div class="row"><div class="k">IMEI 1</div><div class="v">${escapeHtml(s.imei1 || "-")}</div></div>
    <div class="row"><div class="k">IMEI 2</div><div class="v">${escapeHtml(s.imei2 || "-")}</div></div>
    <div class="row"><div class="k">Seriya №</div><div class="v">${escapeHtml(s.seria || "-")}</div></div>
    <div class="row"><div class="k">Məbləğ</div><div class="v">${money(s.amount)} ${escapeHtml(set.currency || "AZN")}</div></div>
    <div class="row"><div class="k">Ödənilən</div><div class="v">${money(s.paidTotal)} ${escapeHtml(set.currency || "AZN")}</div></div>
    <div class="row"><div class="k">Qalıq</div><div class="v">${money(saleRemaining(s))} ${escapeHtml(set.currency || "AZN")}</div></div>
  </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return alert("Popup bloklandı.");
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

function saleTypeLabel(t) {
  const map = { nagd: "Nəğd", post: "Post", kredit: "Kredit", kocurme: "Köçürmə" };
  return map[String(t || "").toLowerCase()] || String(t || "-");
}

function getStaffName(uid) {
  if (!uid) return "-";
  const s = (db.staff || []).find((x) => String(x.uid) === String(uid));
  return s ? (s.name || "-") : "-";
}

function buildMelumatHtml(q) {
  if (!q) return "<p class=\"muted\">Axtarış sözü daxil edin.</p>";
  const qq = q.trim().toLowerCase();
  const blocks = [];
  const shownKeys = new Set();

  db.purch.forEach((p, pIdx) => {
    const inv = p.invNo || invFallback("purch", p.uid);
    const unitPurch = purchIsBulk(p) ? (n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1)))) : n(p.amount);
    const hay = `${inv} ${p.supp} ${p.name} ${p.imei1} ${p.imei2} ${p.seria} ${p.code} ${p.amount} ${money(p.amount)} ${money(unitPurch)}`.toLowerCase();
    if (!hay.includes(qq)) return;
    const key = itemKeyFromPurch(p);
    if (shownKeys.has(key)) return;
    shownKeys.add(key);

    const purchStaffName = operationActorName(p, getStaffName(p.employeeId));
    const purchStatusText = p.returnedAt ? "QAYTARILIB" : "AKTİV";
    const purchActions = `
      <div class="modal-footer" style="justify-content:flex-start;gap:10px;margin-top:10px;">
        <button class="btn-cancel" type="button" onclick="closeMdl();openPurchInfo(${pIdx})">Info</button>
        ${!p.returnedAt && userCanRefund("purch") ? `<button class="btn-cancel" type="button" onclick="closeMdl();openReturnPurch(${pIdx})">Qaytar</button>` : ""}
      </div>
    `;

    let saleHtml = "";
    if (purchIsBulk(p)) {
      const sales = (db.sales || []).filter((s) => !s.returnedAt && String(s.bulkPurchUid || "") === String(p.uid));
      saleHtml = sales.length
        ? sales.map((s) => {
            const saleStaffName = operationActorName(s, s.employeeName || getStaffName(s.employeeId));
            const inv = s.invNo || invFallback("sales", s.uid);
            const rem = saleRemaining(s);
            const st = debtStatus(n(s.amount), rem);
            return `
              <div class="info-row"><div class="info-label">Satış qaimə №</div><div class="info-value">${escapeHtml(inv)}</div></div>
              <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName || "-")}</div></div>
              <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(s.date)}</div></div>
              <div class="info-row"><div class="info-label">Növ</div><div class="info-value">${escapeHtml(saleTypeLabel(s.saleType))}</div></div>
              <div class="info-row"><div class="info-label">Satış məbləğ</div><div class="info-value">${money(s.amount)} AZN</div></div>
              <div class="info-row"><div class="info-label">Ödəniş statusu</div><div class="info-value">${escapeHtml(debtLabel(st))}</div></div>
              ${rem > 0.000001 ? `<div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value">${money(rem)} AZN</div></div>` : ""}
              <div class="info-row"><div class="info-label">Satış edən</div><div class="info-value">${escapeHtml(saleStaffName)}</div></div>
            `;
          }).join("")
        : "<div class=\"info-row\"><div class=\"info-label\">Satış</div><div class=\"info-value\">Satılmayıb</div></div>";
    } else {
      const s = (db.sales || []).find((s) => !s.returnedAt && s.itemKey === key);
      const saleStaffName = s ? operationActorName(s, s.employeeName || getStaffName(s.employeeId)) : "-";
      saleHtml = s
        ? (() => {
            const inv = s.invNo || invFallback("sales", s.uid);
            const rem = saleRemaining(s);
            const st = debtStatus(n(s.amount), rem);
            return `
              <div class="info-row"><div class="info-label">Satış qaimə №</div><div class="info-value">${escapeHtml(inv)}</div></div>
              <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName || "-")}</div></div>
              <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(s.date)}</div></div>
              <div class="info-row"><div class="info-label">Növ</div><div class="info-value">${escapeHtml(saleTypeLabel(s.saleType))}</div></div>
              <div class="info-row"><div class="info-label">Satış məbləğ</div><div class="info-value">${money(s.amount)} AZN</div></div>
              <div class="info-row"><div class="info-label">Ödəniş statusu</div><div class="info-value">${escapeHtml(debtLabel(st))}</div></div>
              ${rem > 0.000001 ? `<div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value">${money(rem)} AZN</div></div>` : ""}
              <div class="info-row"><div class="info-label">Satış edən</div><div class="info-value">${escapeHtml(saleStaffName)}</div></div>
            `;
          })()
        : "<div class=\"info-row\"><div class=\"info-label\">Satış</div><div class=\"info-value\">Satılmayıb</div></div>";
    }

    blocks.push(`
      <div class="info-block melumat-block" style="margin-bottom:16px;">
        <div class="info-row"><div class="info-label">Status</div><div class="info-value">${escapeHtml(purchStatusText)}</div></div>
        <div class="info-row"><div class="info-label">Məhsul (marka/model)</div><div class="info-value">${escapeHtml(p.name || "-")}</div></div>
        <div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(p.code || "-")}</div></div>
        <div class="info-row"><div class="info-label">IMEI 1</div><div class="info-value">${escapeHtml(p.imei1 || "-")}</div></div>
        <div class="info-row"><div class="info-label">IMEI 2</div><div class="info-value">${escapeHtml(p.imei2 || "-")}</div></div>
        <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(p.seria || "-")}</div></div>
        <div class="info-row"><div class="info-label">Alış</div><div class="info-value">${escapeHtml(inv)} • ${escapeHtml(p.supp || "-")} • ${fmtDT(p.date)}</div></div>
        <div class="info-row"><div class="info-label">Alış məbləğ</div><div class="info-value">${money(p.amount)} AZN${purchIsBulk(p) ? ` • 1 ədəd: ${money(unitPurch)} AZN` : ""}</div></div>
        <div class="info-row"><div class="info-label">Alış edən əməkdaş</div><div class="info-value">${escapeHtml(purchStaffName)}</div></div>
        ${saleHtml}
        ${purchActions}
      </div>
    `);
  });

  db.sales.forEach((s, sIdx) => {
    const inv = s.invNo || invFallback("sales", s.uid);
    const unitSale = Math.max(1, Math.floor(n(s.qty || 1))) > 1 ? (n(s.amount) / Math.max(1, Math.floor(n(s.qty || 1)))) : n(s.amount);
    const hay = `${inv} ${s.customerName} ${s.productName} ${s.imei1} ${s.imei2} ${s.seria} ${s.code} ${s.amount} ${money(s.amount)} ${money(unitSale)}`.toLowerCase();
    if (!hay.includes(qq)) return;
    const key = s.itemKey || (s.bulkPurchUid ? `BULK:${s.bulkPurchUid}` : null);
    if (key && shownKeys.has(key)) return;
    const p = key ? (s.bulkPurchUid ? db.purch.find((x) => String(x.uid) === String(s.bulkPurchUid)) : db.purch.find((x) => itemKeyFromPurch(x) === key)) : null;
    if (p) shownKeys.add(key || key);
    const name = p ? (p.name || "-") : (s.productName || "-");
    const code = p ? (p.code || "-") : (s.code || "-");
    const imei1 = p ? (p.imei1 || "-") : (s.imei1 || "-");
    const imei2 = p ? (p.imei2 || "-") : (s.imei2 || "-");
    const seria = p ? (p.seria || "-") : (s.seria || "-");
    const purchInv = p ? (p.invNo || invFallback("purch", p.uid)) : "-";
    const supp = p ? (p.supp || "-") : "-";
    const purchDate = p ? fmtDT(p.date) : "-";
    const purchStaffName = p ? operationActorName(p, getStaffName(p.employeeId)) : "-";
    const saleStaffName = operationActorName(s, s.employeeName || getStaffName(s.employeeId));
    const rem = saleRemaining(s);
    const st = debtStatus(n(s.amount), rem);
    const saleActions = `
      <div class="modal-footer" style="justify-content:flex-start;gap:10px;margin-top:10px;">
        <button class="btn-cancel" type="button" onclick="closeMdl();openSaleInfo(${sIdx})">Info</button>
        ${rem > 0.000001 && userCanPay("sales") ? `<button class="btn-main" type="button" onclick="closeMdl();openSalePayment(${sIdx})">Ödəniş et</button>` : ""}
        ${!s.returnedAt && userCanRefund("sales") ? `<button class="btn-cancel" type="button" onclick="closeMdl();openReturnSale(${sIdx})">Qaytar</button>` : ""}
      </div>
    `;

    blocks.push(`
      <div class="info-block melumat-block" style="margin-bottom:16px;">
        <div class="info-row"><div class="info-label">Məhsul (marka/model)</div><div class="info-value">${escapeHtml(name)}</div></div>
        <div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(code)}</div></div>
        <div class="info-row"><div class="info-label">IMEI 1</div><div class="info-value">${escapeHtml(imei1)}</div></div>
        <div class="info-row"><div class="info-label">IMEI 2</div><div class="info-value">${escapeHtml(imei2)}</div></div>
        <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(seria)}</div></div>
        <div class="info-row"><div class="info-label">Alış</div><div class="info-value">${escapeHtml(purchInv)} • ${escapeHtml(supp)} • ${purchDate}</div></div>
        ${p ? `<div class="info-row"><div class="info-label">Alış məbləğ</div><div class="info-value">${money(p.amount)} AZN${purchIsBulk(p) ? ` • 1 ədəd: ${money(n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1))))} AZN` : ""}</div></div>` : ""}
        <div class="info-row"><div class="info-label">Alış edən əməkdaş</div><div class="info-value">${escapeHtml(purchStaffName)}</div></div>
        <div class="info-row"><div class="info-label">Satış qaimə №</div><div class="info-value">${escapeHtml(inv)}</div></div>
        <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName || "-")}</div></div>
        <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(s.date)}</div></div>
        <div class="info-row"><div class="info-label">Növ</div><div class="info-value">${escapeHtml(saleTypeLabel(s.saleType))}</div></div>
        <div class="info-row"><div class="info-label">Satış məbləğ</div><div class="info-value">${money(s.amount)} AZN${Math.max(1, Math.floor(n(s.qty || 1))) > 1 ? ` • 1 ədəd: ${money(unitSale)} AZN` : ""}</div></div>
        <div class="info-row"><div class="info-label">Ödəniş statusu</div><div class="info-value">${escapeHtml(debtLabel(st))}</div></div>
        ${rem > 0.000001 ? `<div class="info-row"><div class="info-label">Qalıq borc</div><div class="info-value">${money(rem)} AZN</div></div>` : ""}
        <div class="info-row"><div class="info-label">Satış edən</div><div class="info-value">${escapeHtml(saleStaffName)}</div></div>
        ${saleActions}
      </div>
    `);
    if (key) shownKeys.add(key);
  });

  db.cust.forEach((c) => {
    const hay = `${pad4(c.uid)} ${c.sur} ${c.name} ${c.father} ${c.ph1} ${c.ph2} ${c.ph3} ${c.fin} ${c.seriaNum} ${c.work} ${c.addr}`.toLowerCase();
    if (!hay.includes(qq)) return;
    const guarantor = c.zam ? db.cust.find((x) => String(x.uid) === String(c.zam)) : null;
    blocks.push(`
      <div class="info-block melumat-block" style="margin-bottom:16px;">
        <div class="info-row"><div class="info-label">ID</div><div class="info-value">${c.uid}</div></div>
        <div class="info-row"><div class="info-label">Ad Soyad Ata</div><div class="info-value">${escapeHtml(`${c.sur || ""} ${c.name || ""} ${c.father || ""}`.trim()) || "-"}</div></div>
        <div class="info-row"><div class="info-label">Mobil 1</div><div class="info-value">${escapeHtml(c.ph1 || "-")}</div></div>
        <div class="info-row"><div class="info-label">Mobil 2</div><div class="info-value">${escapeHtml(c.ph2 || "-")}</div></div>
        <div class="info-row"><div class="info-label">Mobil 3</div><div class="info-value">${escapeHtml(c.ph3 || "-")}</div></div>
        <div class="info-row"><div class="info-label">İş yeri</div><div class="info-value">${escapeHtml(c.work || "-")}</div></div>
        <div class="info-row"><div class="info-label">FİN</div><div class="info-value">${escapeHtml(c.fin || "-")}</div></div>
        <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(c.seriaNum || "-")}</div></div>
        <div class="info-row"><div class="info-label">Ünvan</div><div class="info-value">${escapeHtml(c.addr || "-")}</div></div>
        <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${guarantor ? escapeHtml(`${guarantor.sur || ""} ${guarantor.name || ""} (${guarantor.uid})`) : "-"}</div></div>
      </div>
    `);
  });

  db.supp.forEach((s) => {
    const hay = `${s.uid} ${s.co} ${s.mob} ${s.voen}`.toLowerCase();
    if (!hay.includes(qq)) return;
    blocks.push(`
      <div class="info-block melumat-block" style="margin-bottom:16px;">
        <div class="info-row"><div class="info-label">Təchizatçı</div><div class="info-value">${escapeHtml(s.co || "-")} (${escapeHtml(s.uid || "")})</div></div>
        <div class="info-row"><div class="info-label">Mobil</div><div class="info-value">${escapeHtml(s.mob || "-")}</div></div>
        <div class="info-row"><div class="info-label">VOEN</div><div class="info-value">${escapeHtml(s.voen || "-")}</div></div>
      </div>
    `);
  });

  return blocks.length ? blocks.join("") : "<p class=\"muted\">Nəticə tapılmadı.</p>";
}

function openGlobalSearch() {
  if (!meta?.session) return showLoginOverlay(true);
  openModal(`
    <h2>Qlobal axtarış</h2>
    <div class="grid-3">
      <input id="gs_q" class="span-3" placeholder="IMEI / Seriya / Kod / Qaimə / Ad ..." oninput="runGlobalSearch()">
    </div>
    <h3 style="margin:20px 0 10px;font-size:1.1rem;">Məlumat</h3>
    <div id="gs_melumat" class="melumat-content">Axtarış sözü daxil edin.</div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
  setTimeout(() => byId("gs_q")?.focus(), 0);
}

function runGlobalSearch() {
  const q = (byId("gs_q")?.value || "").trim();
  const melumatEl = byId("gs_melumat");
  if (!melumatEl) return;
  melumatEl.innerHTML = buildMelumatHtml(q);
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validateCompanyDBShape(data) {
  const errors = [];
  if (!isPlainObject(data)) return { ok: false, errors: ["DB obyekt deyil."] };

  const mustBeArrays = [
    "cust",
    "supp",
    "prod",
    "purch",
    "sales",
    "staff",
    "cash",
    "accounts",
    "counters",
    "expenseCats",
    "audit",
    "trash",
    "cashCounts",
    "overdueNotes",
  ];
  for (const k of mustBeArrays) {
    if (k in data && !Array.isArray(data[k])) errors.push(`${k} array deyil.`);
  }

  if ("settings" in data && data.settings != null && !isPlainObject(data.settings)) {
    errors.push("settings obyekt deyil.");
  }

  return { ok: errors.length === 0, errors };
}

function exportCompany() {
  if (!userCanExport()) return alert("Export icazəsi yoxdur.");
  const cid = meta?.session?.companyId;
  if (!cid) return;
  const payload = {
    _type: "bakfon-erp-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    companyId: cid,
    data: db,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `erp_${cid}_${nowISODate()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  logEvent("export", "company", { companyId: cid });
}

function importCompany(ev) {
  if (!userCanImport()) return alert("Import icazəsi yoxdur.");
  const f = ev.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const parsed = JSON.parse(String(r.result || "{}"));
      const incoming = isPlainObject(parsed) && parsed._type === "bakfon-erp-backup" ? parsed.data : parsed; // köhnə export dəstəyi
      const check = validateCompanyDBShape(incoming);
      if (!check.ok) {
        return alert(`Import dayandırıldı.\n\nXətalar:\n- ${check.errors.join("\n- ")}`);
      }
      appConfirm("Bu import cari şirkətin bütün məlumatını yenisi ilə əvəz edəcək.\n\nDavam edək?").then((ok) => {
        if (!ok) return;
        db = { ...defaultDB(), ...incoming };
        saveDB();
        logEvent("import", "company", { companyId: meta?.session?.companyId || "-" });
        alert("Import olundu.");
        renderAll();
      });
    } catch {
      alert("JSON oxunmadı.");
    }
  };
  r.readAsText(f);
  ev.target.value = "";
}

function recalcAll() {
  if (!userCanReset()) return alert("Recalculate icazəsi yoxdur.");
  // recompute sales paidTotal from payments
  for (const s of db.sales) {
    s.paidTotal = String(sumPayments(s.payments || []));
  }
  // clamp purchase paidTotal
  for (const p of db.purch) {
    p.paidTotal = String(Math.max(0, n(p.paidTotal)));
  }
  logEvent("recalc", "tools", {});
  saveDB();
  alert("Yenidən hesablandı.");
}

function openQrTool() {
  openModal(`
    <h2>QR</h2>
    <div class="grid-3">
      <input id="qr_txt" class="span-3" placeholder="Mətn / Kod / IMEI / Seriya...">
    </div>
    <div class="info-block">
      <div class="info-row"><div class="info-label">QR</div><div class="info-value"><canvas id="qr_canvas"></canvas></div></div>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="genQr()">Yarat</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSettings() {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  ensureAuditTrash();
  const s = db.settings || defaultDB().settings;
  openModal(`
    <h2>Ayarlar</h2>
    <form onsubmit="saveSettings(event)">
      <div class="grid-3">
        <input id="set_name" class="span-3" placeholder="Şirkət adı" value="${escapeHtml(s.companyName || "")}" required>
        <input id="set_addr" class="span-3" placeholder="Ünvan" value="${escapeHtml(s.companyAddress || "")}">
        <input id="set_phone" class="span-2" placeholder="Telefon" value="${escapeHtml(s.companyPhone || "")}">
        <input id="set_curr" placeholder="Valyuta (AZN)" value="${escapeHtml(s.currency || "AZN")}">
        <input id="set_sym" class="span-2" placeholder="Simvol (₼)" value="${escapeHtml(s.currencySymbol || "₼")}">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveSettings(e) {
  e.preventDefault();
  if (!isDeveloper()) return;
  ensureAuditTrash();
  db.settings = {
    companyName: val("set_name").trim(),
    companyAddress: val("set_addr").trim(),
    companyPhone: val("set_phone").trim(),
    currency: val("set_curr").trim() || "AZN",
    currencySymbol: val("set_sym").trim() || "₼",
  };
  logEvent("update", "settings", {});
  saveDB();
  closeMdl();
}

function genQr() {
  const t = (byId("qr_txt")?.value || "").trim();
  const canvas = byId("qr_canvas");
  if (!t || !canvas) return;
  if (!window.QRCode) return alert("QR kitabxanası yüklənmədi.");
  window.QRCode.toCanvas(canvas, t, { width: 220 }, (err) => {
    if (err) alert("QR alınmadı.");
  });
}

function refundedForSale(saleUid) {
  return (db.cash || [])
    .filter((c) => c.type === "out" && c.link && c.link.kind === "return_refund" && String(c.link.saleUid) === String(saleUid))
    .reduce((a, c) => a + n(c.amount), 0);
}

function openReturnAdvancePay(saleUid) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  ensureAuditTrash();
  ensureAccounts();
  const s = (db.sales || []).find((x) => Number(x.uid) === Number(saleUid));
  if (!s) return alert("Satış tapılmadı.");
  if (!s.returnedAt) return alert("Bu satış qaytarılmayıb.");
  const paid = Math.max(0, n(s.paidTotal));
  const refunded = refundedForSale(s.uid);
  const left = Math.max(0, paid - refunded);
  if (left <= 0.000001) return alert("Qaytarılacaq avans yoxdur.");

  const defAcc = Number(s.paymentAccountId || 1);
  const accOptions = accountOptionsHtml(defAcc);
  openModal(`
    <h2>Qaytarma avansını qaytar</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Qaimə</div><div class="info-value">${escapeHtml(s.invNo || invFallback("sales", s.uid))}</div></div>
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName || "-")}</div></div>
      <div class="info-row"><div class="info-label">Ödənən</div><div class="info-value">${money(paid)} AZN</div></div>
      <div class="info-row"><div class="info-label">Əvvəl qaytarılıb</div><div class="info-value">${money(refunded)} AZN</div></div>
      <div class="info-row"><div class="info-label">Qalıq</div><div class="info-value"><strong>${money(left)} AZN</strong></div></div>
    </div>
    <form onsubmit="saveReturnAdvancePay(event, ${s.uid})">
      <div class="grid-3">
        <input type="datetime-local" id="ra_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="ra_amount" class="span-2" value="${escapeAttr(String(left))}" placeholder="Məbləğ (AZN)" required>
        <select id="ra_acc" class="span-3" required>${accOptions}</select>
        <input id="ra_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-cancel" type="button" onclick="openReturnedSalesCreditReport()">Geri</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveReturnAdvancePay(e, saleUid) {
  e.preventDefault();
  if (!userCanPay()) return;
  ensureAuditTrash();
  const s = (db.sales || []).find((x) => Number(x.uid) === Number(saleUid));
  if (!s) return alert("Satış tapılmadı.");
  const paid = Math.max(0, n(s.paidTotal));
  const refunded = refundedForSale(s.uid);
  const left = Math.max(0, paid - refunded);
  const date = val("ra_date");
  const amount = Math.max(0, n(val("ra_amount")));
  const accId = Number(val("ra_acc") || 1);
  const note = val("ra_note");
  if (amount <= 0.000001) return alert("Məbləğ 0-dan böyük olmalıdır.");
  if (amount - left > 0.000001) return alert("Məbləğ qalıqdan böyük ola bilməz.");
  const bal = accountBalance(accId);
  if (bal + 0.000001 < amount) return alert("Hesab balansı kifayət etmir.");
  addCashOp({
    type: "out",
    date,
    source: `Qaytarma avansı (${s.customerName || "-"})`,
    amount,
    note: note || `Avans qaytarma #${s.uid}`,
    link: { kind: "return_refund", saleUid: s.uid },
    meta: { saleUid: s.uid, kind: "advance" },
    accountId: accId,
  });
  logEvent("create", "cash", { type: "out", kind: "return_refund", saleUid: s.uid, amount });
  saveDB();
  openReturnedSalesCreditReport();
}

function totalReturnedSalesCreditLeft() {
  return (db.sales || [])
    .filter((s) => !!s.returnedAt)
    .reduce((a, s) => {
      const paid = Math.max(0, n(s.paidTotal));
      const refunded = refundedForSale(s.uid);
      return a + Math.max(0, paid - refunded);
    }, 0);
}

function salePaymentMismatches() {
  // Compare sale.payments entries vs cash ops that represent those payments.
  // This helps find "kassada artiq/eskik" sources quickly.
  const cashByKey = new Map();
  for (const c of db.cash || []) {
    const kind = c.link?.kind || "";
    if (c.type !== "in") continue;
    if (kind !== "sale" && kind !== "sale_payment") continue;
    const k = `${String(c.link?.saleUid || "")}::${String(c.date)}::${money(c.amount)}`;
    cashByKey.set(k, (cashByKey.get(k) || 0) + 1);
  }

  let missingCashTotal = 0;
  let missingCashCount = 0;
  const missingCashSamples = [];

  for (const s of db.sales || []) {
    for (const p of s.payments || []) {
      const k = `${String(s.uid)}::${String(p.date)}::${money(p.amount)}`;
      const left = cashByKey.get(k) || 0;
      if (left > 0) cashByKey.set(k, left - 1);
      else {
        missingCashTotal += n(p.amount);
        missingCashCount++;
        if (missingCashSamples.length < 10) {
          missingCashSamples.push({
            saleUid: s.uid,
            invNo: s.invNo || invFallback("sales", s.uid),
            date: p.date,
            amount: n(p.amount),
            customer: s.customerName || "-",
          });
        }
      }
    }
  }

  // leftover cashByKey entries mean cash ops exist without a matching sale payment entry
  let orphanCashTotal = 0;
  let orphanCashCount = 0;
  const orphanCashSamples = [];
  for (const c of db.cash || []) {
    const kind = c.link?.kind || "";
    if (c.type !== "in") continue;
    if (kind !== "sale" && kind !== "sale_payment") continue;
    const k = `${String(c.link?.saleUid || "")}::${String(c.date)}::${money(c.amount)}`;
    const left = cashByKey.get(k) || 0;
    if (left > 0) {
      cashByKey.set(k, left - 1);
      orphanCashTotal += n(c.amount);
      orphanCashCount++;
      if (orphanCashSamples.length < 10) {
        orphanCashSamples.push({ saleUid: c.link?.saleUid, date: c.date, amount: n(c.amount), source: c.source || "", uid: c.uid });
      }
    }
  }

  return { missingCashTotal, missingCashCount, missingCashSamples, orphanCashTotal, orphanCashCount, orphanCashSamples };
}

function systemCashBalanceForSelected() {
  const cashAccId = getSelectedCashAccountId();
  if (cashAccId) return accountBalance(Number(cashAccId));
  const income = (db.cash || []).filter((c) => c.type === "in").reduce((a, b) => a + n(b.amount), 0);
  const expense = (db.cash || []).filter((c) => c.type === "out").reduce((a, b) => a + n(b.amount), 0);
  return income - expense;
}

function openCashReconcile() {
  if (!userCanPay()) return alert("İcazə yoxdur.");
  ensureAuditTrash();
  const sys = systemCashBalanceForSelected();
  const accId = getSelectedCashAccountId() || 1;
  openModal(`
    <h2>Kassa sayımı</h2>
    <p class="muted" style="margin:0 0 12px 0;">Faktiki kassadakı məbləği yazın. Sistemlə fərq çıxacaq. Fərqi istəsəniz “kassa düzəlişi” kimi yazdırın.</p>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Sistem qalığı</div><div class="info-value"><strong>${money(sys)} AZN</strong></div></div>
    </div>
    <form onsubmit="saveCashReconcile(event)">
      <div class="grid-3">
        <input type="datetime-local" id="cc_date" value="${nowISODateTimeLocal()}" required>
        <input type="number" step="0.01" id="cc_physical" class="span-2" placeholder="Faktiki sayım (AZN)" required>
        <select id="cc_acc" class="span-3" required>${accountOptionsHtml(Number(accId))}</select>
        <input id="cc_note" class="span-3" placeholder="Qeyd (istəyə bağlı)">
      </div>
      <div class="info-block">
        <div class="info-row"><div class="info-label">Fərq (faktiki − sistem)</div><div class="info-value" id="cc_diff">0.00</div></div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Fərqi düzəliş kimi yaz</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
  const physEl = byId("cc_physical");
  const diffEl = byId("cc_diff");
  const update = () => {
    const phys = n(physEl?.value || 0);
    const diff = phys - sys;
    if (diffEl) diffEl.textContent = `${diff >= 0 ? "+" : ""}${money(diff)} AZN`;
  };
  if (physEl) physEl.oninput = update;
  update();
}

function saveCashReconcile(e) {
  e.preventDefault();
  if (!userCanPay()) return;
  ensureAuditTrash();
  const date = val("cc_date");
  const physical = Math.max(0, n(val("cc_physical")));
  const accId = Number(val("cc_acc") || 1);
  const note = val("cc_note");
  const sys = accountBalance(accId);
  const diff = physical - sys;
  if (Math.abs(diff) < 0.000001) return alert("Fərq yoxdur.");

  const type = diff > 0 ? "in" : "out";
  const amt = Math.abs(diff);
  addCashOp({
    type,
    date,
    source: "Kassa düzəlişi (sayım fərqi)",
    amount: amt,
    note: note || "",
    link: { kind: "cash_adjust", accountId: accId },
    meta: { physical, system: sys, diff },
    accountId: accId,
  });
  db.cashCounts.push({ uid: genId(db.cashCounts, 1), date, accountId: accId, physical, system: sys, diff, note: note || "" });
  logEvent("create", "cash", { type, kind: "cash_adjust", amount: amt, accountId: accId });
  saveDB();
  closeMdl();
}

function openCashDiffAnalysis() {
  ensureAuditTrash();
  const adv = totalReturnedSalesCreditLeft();
  const mm = salePaymentMismatches();
  const last = (db.cashCounts || []).slice().sort((a, b) => (a.date > b.date ? -1 : 1))[0] || null;
  const lastHtml = last
    ? `<div class="info-row"><div class="info-label">Son sayım</div><div class="info-value">${fmtDT(last.date)} • Faktiki ${money(last.physical)} AZN • Sistem ${money(last.system)} AZN • Fərq ${last.diff >= 0 ? "+" : ""}${money(last.diff)} AZN</div></div>`
    : `<div class="info-row"><div class="info-label">Son sayım</div><div class="info-value">Yoxdur</div></div>`;

  const mis1 = mm.missingCashCount
    ? `<div class="info-row"><div class="info-label">Satış ödənişi var, kassaya düşməyib</div><div class="info-value">${mm.missingCashCount} əməliyyat • ${money(mm.missingCashTotal)} AZN</div></div>`
    : `<div class="info-row"><div class="info-label">Satış ödənişi var, kassaya düşməyib</div><div class="info-value">Yoxdur</div></div>`;
  const mis2 = mm.orphanCashCount
    ? `<div class="info-row"><div class="info-label">Kassaya satış mədaxili var, satışda ödəniş yoxdur</div><div class="info-value">${mm.orphanCashCount} əməliyyat • ${money(mm.orphanCashTotal)} AZN</div></div>`
    : `<div class="info-row"><div class="info-label">Kassaya satış mədaxili var, satışda ödəniş yoxdur</div><div class="info-value">Yoxdur</div></div>`;

  openModal(`
    <h2>Artıq / Əskik analizi</h2>
    <div class="info-block">
      ${lastHtml}
      <div class="info-row"><div class="info-label">Qaytarma avansı</div><div class="info-value">${money(adv)} AZN</div></div>
      ${mis1}
      ${mis2}
    </div>
    <p class="muted" style="margin:0 0 12px 0;">Detallı siyahı üçün: “Qaytarma avansları”. Sayım fərqini düzəltmək üçün: “Kassa sayımı”.</p>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openDayClose() {
  if (!userCanPay("cash")) return alert("İcazə yoxdur.");
  ensureAuditTrash();
  const accId = getSelectedCashAccountId();
  const ts = nowISODateTimeLocal();
  const date = ts.slice(0, 10);
  const accounts = (db.accounts || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rows = (accId ? accounts.filter((a) => Number(a.uid) === Number(accId)) : accounts)
    .map((a) => {
      const bal = accountBalance(Number(a.uid));
      return `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.type || "-")}</td><td style="text-align:right;"><strong>${money(bal)} AZN</strong></td></tr>`;
    })
    .join("");
  const total = totalAccountsBalance();
  openModal(`
    <h2>Gün sonu</h2>
    <p class="muted" style="margin:0 0 12px 0;">Bu əməliyyat “snapshot” saxlayır (balansların şəkli). Kassa sayımındakı kimi düzəliş yazmır.</p>
    <div class="grid-3">
      <input type="datetime-local" id="dc_ts" value="${ts}" required>
      <input id="dc_note" class="span-2" placeholder="Qeyd (istəyə bağlı)">
    </div>
    <div class="info-block" style="margin-top:12px;">
      <div class="info-row"><div class="info-label">Ümumi balans</div><div class="info-value"><strong>${money(total)} AZN</strong></div></div>
      <div class="info-row"><div class="info-label">Seçilmiş hesab</div><div class="info-value">${accId ? `#${accId}` : "Hamısı"}</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Hesab</th><th>Tip</th><th>Balans</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">Hesab yoxdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="saveDayClose()">Yadda saxla</button>
      <button class="btn-cancel" type="button" onclick="openDayCloseHistory()">Tarixçə</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function saveDayClose() {
  if (!userCanPay("cash")) return;
  ensureAuditTrash();
  const ts = val("dc_ts") || nowISODateTimeLocal();
  const note = val("dc_note") || "";
  const accId = getSelectedCashAccountId();
  const accounts = (db.accounts || []).slice().map((a) => ({ uid: a.uid, name: a.name, type: a.type, balance: accountBalance(Number(a.uid)) }));
  const snapshot = accId ? accounts.filter((a) => Number(a.uid) === Number(accId)) : accounts;
  const u = currentUser();
  db.dayCloses.push({
    uid: genId(db.dayCloses, 1),
    ts,
    date: ts.slice(0, 10),
    accountId: accId ? Number(accId) : null,
    totalBalance: totalAccountsBalance(),
    accounts: snapshot,
    note,
    user: u ? u.username : "-",
  });
  logEvent("create", "day_close", { ts, accountId: accId || null });
  saveDB();
  toast("Gün sonu saxlandı", "ok", 1800);
  closeMdl();
}

function openDayCloseHistory() {
  ensureAuditTrash();
  const rows = (db.dayCloses || [])
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) * -1)
    .map((x) => {
      const acc = x.accountId ? `#${x.accountId}` : "Hamısı";
      return `
        <tr>
          <td>${x.uid}</td>
          <td>${fmtDT(x.ts)}</td>
          <td>${escapeHtml(acc)}</td>
          <td style="text-align:right;"><strong>${money(x.totalBalance)} AZN</strong></td>
          <td>${escapeHtml(x.user || "-")}</td>
          <td>${escapeHtml(x.note || "")}</td>
        </tr>
      `;
    })
    .join("");
  openModal(`
    <h2>Gün sonu tarixçəsi</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Hesab</th><th>Ümumi balans</th><th>İstifadəçi</th><th>Qeyd</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">Tarixçə boşdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="openDayClose()">Geri</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openOverdueInfo(saleUid) {
  ensureAuditTrash();
  const sale = (db.sales || []).find((s) => Number(s.uid) === Number(saleUid));
  if (!sale) return alert("Satış tapılmadı.");
  const cid = String(sale.customerId || "");
  const cust = (db.cust || []).find((c) => String(c.uid) === cid) || null;
  const guarantor = cust?.zam ? (db.cust || []).find((x) => String(x.uid) === String(cust.zam)) : null;
  const custName = sale.customerName || cid;
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dayMs = 24 * 60 * 60 * 1000;
  const toDayStart = (iso) => {
    const [y, m, d] = String(iso || "").slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d).getTime();
  };
  const todayT = toDayStart(todayISO);

  const items = [];
  const inv = sale.invNo || invFallback("sales", sale.uid);
  const sched = buildCreditSchedule(sale);
  for (const r of sched.rows) {
    if (r.remaining <= 0.000001) continue;
    const dueT = toDayStart(r.due);
    if (dueT == null || todayT == null) continue;
    const daysLate = Math.floor((todayT - dueT) / dayMs);
    if (daysLate < 1) continue;
    items.push({ inv, due: r.due, monthly: r.amount, remaining: r.remaining, daysLate, saleUid: sale.uid, idx: r.idx });
  }

  items.sort((a, b) => (b.daysLate - a.daysLate) || String(a.due).localeCompare(String(b.due)));
  const rowsHtml = items
    .map(
      (x, i) => `
    <tr>
      <td>${i + 1}</td>
        <td>${escapeHtml(x.inv)} • ${x.idx}. ay</td>
      <td>${escapeHtml(x.due)}</td>
      <td>${money(x.monthly)} AZN</td>
      <td>${money(x.remaining)} AZN</td>
      <td>${x.daysLate}</td>
    </tr>`
    )
    .join("");

  const notes = (db.overdueNotes || [])
    .filter((n0) => String(n0.customerId) === cid)
    .slice()
    .sort((a, b) => (a.ts > b.ts ? -1 : 1));

  const notesHtml = notes
    .map(
      (n0) => `
    <div class="info-block" style="margin:10px 0;">
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(n0.ts)}</div></div>
      <div class="info-row"><div class="info-label">Kim</div><div class="info-value">${escapeHtml(n0.user || "-")}</div></div>
      <div class="info-row"><div class="info-label">Qeyd</div><div class="info-value">${escapeHtml(n0.text || "")}</div></div>
    </div>`
    )
    .join("");

  const payHistHtml = (sale.payments || [])
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${fmtDT(p.date)}</td>
        <td>${money(p.amount)} AZN</td>
        <td>${escapeHtml(salePaymentSourceLabel(p.source))}</td>
      </tr>
    `)
    .join("");

  const total = n(sale.amount);
  const paid = n(sale.paidTotal);
  const rem = saleRemaining(sale);
  const credit = buildCreditSchedule(sale);
  const saleDate = String(sale.date || "").slice(0, 10);
  const dueStart = credit.rows[0]?.due || "-";
  const empName = operationActorName(sale, sale.employeeName || getStaffName(sale.employeeId));

  openModal(`
    <h2>Gecikmə detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custName)}</div></div>
      <div class="info-row"><div class="info-label">Ad Soyad Ata</div><div class="info-value">${escapeHtml(cust ? `${cust.sur || ""} ${cust.name || ""} ${cust.father || ""}`.trim() : custName)}</div></div>
      <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${escapeHtml(guarantor ? `${guarantor.sur || ""} ${guarantor.name || ""} ${guarantor.father || ""}`.trim() : "-")}</div></div>
      <div class="info-row"><div class="info-label">Qaimə</div><div class="info-value">${escapeHtml(inv)}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(sale.productName || "-")}</div></div>
      <div class="info-row"><div class="info-label">Satış tarixi</div><div class="info-value">${fmtDT(sale.date)}</div></div>
      <div class="info-row"><div class="info-label">İlk ödəniş günü</div><div class="info-value">${escapeHtml(dueStart)}</div></div>
      <div class="info-row"><div class="info-label">Müddət</div><div class="info-value">${credit.term} ay</div></div>
      <div class="info-row"><div class="info-label">Rəsmiləşdirən əməkdaş</div><div class="info-value">${escapeHtml(empName || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ / Ödənilən / Qalıq</div><div class="info-value"><strong>${money(total)} / ${money(paid)} / ${money(rem)} AZN</strong></div></div>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Gecikən aylıqlar</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Ödəniş günü</th><th>Aylıq</th><th>Qalıq</th><th>Gecikmə (gün)</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="6">Gecikən aylıq yoxdur.</td></tr>`}</tbody>
      </table>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Ödəniş cədvəli</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Ödəniş günü</th><th>Məbləğ</th><th>Ödənilib</th><th>Qalıq</th><th>Status</th></tr></thead>
        <tbody>
          ${credit.rows.map((r) => `<tr><td>${r.idx}</td><td>${escapeHtml(r.due)}</td><td>${money(r.amount)} AZN</td><td>${money(r.paid)} AZN</td><td>${money(r.remaining)} AZN</td><td>${escapeHtml(debtLabel(r.status))}</td></tr>`).join("") || `<tr><td colspan="6">Cədvəl yoxdur</td></tr>`}
        </tbody>
      </table>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Ödəniş tarixçəsi</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Məbləğ</th><th>Mənbə</th></tr></thead>
        <tbody>${payHistHtml || `<tr><td colspan="4">Ödəniş yoxdur</td></tr>`}</tbody>
      </table>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Qeyd əlavə et</h3>
    <form onsubmit="saveOverdueNote(event, '${escapeAttr(cid)}', '${escapeAttr(sale.uid)}')">
      <div class="grid-3">
        <input id="ov_note" class="span-3" placeholder="Qeyd..." required>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="button" onclick="openOverduePayment('${escapeAttr(sale.uid)}')">Ödəniş et</button>
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Qeydlər</h3>
    ${notesHtml || `<p class="muted">Qeyd yoxdur.</p>`}
  `);
}

function saveOverdueNote(e, customerId, saleUid = null) {
  e.preventDefault();
  ensureAuditTrash();
  const cid = String(customerId || "");
  const text = (byId("ov_note")?.value || "").trim();
  if (!text) return;
  const u = currentUser();
  db.overdueNotes.push({ uid: genId(db.overdueNotes, 1), customerId: cid, text, ts: nowISODateTimeLocal(), user: u ? u.username : "-" });
  logEvent("create", "overdue_note", { customerId: cid });
  saveDB();
  if (saleUid != null && saleUid !== "") openOverdueInfo(saleUid);
  else closeMdl();
}

function openOverduePayment(saleUid) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const idx = (db.sales || []).findIndex((s) => Number(s.uid) === Number(saleUid));
  if (idx < 0) return alert("Satış tapılmadı.");
  const s = db.sales[idx];
  if (!s || s.returnedAt) return alert("Bu satış aktiv deyil.");
  if (saleRemaining(s) <= 0.000001) return alert("Qalıq borc yoxdur.");
  openSalePayment(idx);
}

function openReturnedSalesCreditReport() {
  ensureAuditTrash();
  const rows = (db.sales || [])
    .filter((s) => !!s.returnedAt)
    .map((s) => {
      const paid = Math.max(0, n(s.paidTotal));
      const refunded = refundedForSale(s.uid);
      const creditLeft = Math.max(0, paid - refunded);
      return { s, paid, refunded, creditLeft };
    })
    .filter((x) => x.creditLeft > 0.000001)
    .sort((a, b) => (a.s.returnedAt > b.s.returnedAt ? -1 : 1));

  const body = rows
    .map((x, i) => {
      const inv = x.s.invNo || invFallback("sales", x.s.uid);
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(inv)}</td>
          <td>${fmtDT(x.s.returnedAt || x.s.date)}</td>
          <td>${escapeHtml(x.s.customerName || "-")}</td>
          <td>${money(x.paid)} AZN</td>
          <td>${money(x.refunded)} AZN</td>
          <td><strong>${money(x.creditLeft)} AZN</strong></td>
          <td class="tbl-actions"><button class="btn-mini-pay" type="button" onclick="openReturnAdvancePay(${x.s.uid})">Qaytar</button></td>
        </tr>`;
    })
    .join("");

  const totalLeft = rows.reduce((a, x) => a + x.creditLeft, 0);
  openModal(`
    <h2>Qaytarma avansları (kassada qalan)</h2>
    <p class="muted" style="margin:0 0 12px 0;">
      Qaytarılan satışlarda ödənən məbləğ geri qaytarılmayıbsa, bu məbləğ kassada qalır.
      Burada: <strong>Avans = Ödənən − Refund</strong>.
    </p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Qaytarma tarixi</th><th>Müştəri</th><th>Ödənən</th><th>Qaytarılıb</th><th>Kassada qalan</th><th>Əməliyyat</th></tr></thead>
        <tbody>
          ${body || `<tr><td colspan="8">Qaytarma avansı yoxdur.</td></tr>`}
          ${body ? `<tr class="total-row"><td colspan="6"><strong>Cəmi</strong></td><td><strong>${money(totalLeft)} AZN</strong></td><td></td></tr>` : ""}
        </tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function exportTableToCsv(tableBodyId, filename) {
  const tbody = byId(tableBodyId);
  if (!tbody) return alert("Cədvəl tapılmadı.");
  const table = tbody.closest("table");
  if (!table) return;
  const rows = Array.from(table.querySelectorAll("tr"));
  const csv = rows
    .map((r) =>
      Array.from(r.querySelectorAll("th,td"))
        .map((c) => `"${String(c.innerText || "").replaceAll('"', '""').trim()}"`)
        .join(",")
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function activeSectionId() {
  const sec = document.querySelector(".section.active");
  return sec ? sec.id : "dash";
}

function exportCsvCurrent() {
  if (!userCanExport()) return alert("Export icazəsi yoxdur.");
  const sid = activeSectionId();
  const map = {
    cust: "tblCust",
    supp: "tblSupp",
    prod: "tblProd",
    purch: "tblPurch",
    stock: "tblStock",
    sales: "tblSales",
    staff: "tblStaff",
    debts: "tblDebts",
    creditor: "tblCreditor",
    cash: "tblCash",
    accounts: "tblAccounts",
    companies: "tblCompanies",
    users: "tblUsers",
    audit: "tblAudit",
    trash: "tblTrash",
    reports: "tblPayroll",
  };
  const bodyId = map[sid];
  if (!bodyId) return alert("Bu bölmə üçün CSV yoxdur.");
  const cid = meta?.session?.companyId || "company";
  exportTableToCsv(bodyId, `csv_${cid}_${sid}_${nowISODate()}.csv`);
  logEvent("export", "csv", { section: sid });
  toast("CSV yükləndi", "ok");
}

function clearAudit() {
  if (!userCanReset()) return alert("İcazə yoxdur.");
  appConfirm("Audit təmizlənsin?").then((ok) => {
    if (!ok) return;
    db.audit = [];
    saveDB();
    renderAll();
  });
  return;
}

function emptyTrash() {
  if (!userCanReset()) return alert("İcazə yoxdur.");
  appConfirm("Səbət tam boşaldılsın?").then((ok) => {
    if (!ok) return;
    db.trash = [];
    saveDB();
    renderAll();
  });
  return;
}

function restoreTrash(uid) {
  if (!userCanEdit()) return alert("İcazə yoxdur.");
  const i = db.trash.findIndex((t) => Number(t.uid) === Number(uid));
  if (i < 0) return;
  const t = db.trash[i];
  const it = t.item;
  const existsUid = (arr, x) => (arr || []).some((z) => z && x && String(z.uid) === String(x.uid));
  if (!it || it.uid == null) return alert("Bərpa üçün məlumat tapılmadı.");
  if (t.type === "cust") {
    if (existsUid(db.cust, it)) return alert("Bu müştəri artıq mövcuddur (UID təkrarı).");
    db.cust.push(it);
  } else if (t.type === "supp") {
    if (existsUid(db.supp, it)) return alert("Bu təchizatçı artıq mövcuddur (UID təkrarı).");
    db.supp.push(it);
  } else if (t.type === "prod") {
    if (existsUid(db.prod, it)) return alert("Bu məhsul artıq mövcuddur (UID təkrarı).");
    db.prod.push(it);
  } else if (t.type === "staff") {
    if (existsUid(db.staff, it)) return alert("Bu əməkdaş artıq mövcuddur (UID təkrarı).");
    db.staff.push(it);
  } else if (t.type === "purch") {
    if (existsUid(db.purch, it)) return alert("Bu alış artıq mövcuddur (UID təkrarı).");
    db.purch.push(it);
  } else if (t.type === "sales") {
    if (existsUid(db.sales, it)) return alert("Bu satış artıq mövcuddur (UID təkrarı).");
    db.sales.push(it);
  } else if (t.type === "cash") {
    if (existsUid(db.cash, it)) return alert("Bu kassa əməliyyatı artıq mövcuddur (UID təkrarı).");
    db.cash.push(it);
  }
  db.trash.splice(i, 1);
  logEvent("restore", "trash", { type: t.type });
  saveDB();
}

function deleteTrash(uid) {
  if (!userCanDelete("trash")) return alert("Sil icazəsi yoxdur.");
  const i = db.trash.findIndex((t) => Number(t.uid) === Number(uid));
  if (i < 0) return;
  appConfirm("Səbətdən tam silinsin?").then((ok) => {
    if (!ok) return;
    db.trash.splice(i, 1);
    logEvent("delete", "trash", { uid });
    saveDB();
    renderAll();
  });
  return;
}
function openChangePassword() {
  const u = currentUser();
  if (!u) return;
  openModal(`
    <h2>Şifrəni dəyiş</h2>
    <form onsubmit="changePassword(event)">
      <div class="grid-3">
        <input id="pw_old" class="span-3" placeholder="Köhnə şifrə" type="password" required>
        <input id="pw_new" class="span-3" placeholder="Yeni şifrə" type="password" required>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yenilə</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function changePassword(e) {
  e.preventDefault();
  const u = currentUser();
  if (!u) return;
  const old = val("pw_old");
  const nw = val("pw_new");
  if (u.pass !== old) return alert("Köhnə şifrə yanlışdır.");
  const idx = meta.users.findIndex((x) => x.uid === u.uid);
  if (idx < 0) return;
  meta.users[idx].pass = nw;
  saveMeta();
  closeMdl();
  renderProfile();
}

// ========= Render =========
function renderAll() {
  if (!meta.session) {
    showLoginOverlay(true);
    applyAccessUI();
    return;
  }
  showLoginOverlay(false);
  runInvNoMigrationIfNeeded();
  applyAccessUI();
  refreshHeaderBar();
  startHeaderClock();
  const sold = soldKeySet();

  // customers
  const custList = db.cust
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => inDateRange(c.createdAt || c.date, "custFrom", "custTo"))
    .slice()
    .sort((a, b) => String(a.c.createdAt || a.c.date || "").localeCompare(String(b.c.createdAt || b.c.date || "")) * -1);
  byId("tblCust").innerHTML = custList
    .map(({ c, idx }, i) => {
      const guarantor = c.zam ? db.cust.find((x) => String(x.uid) === String(c.zam)) : null;
      const canE = userCanEdit();
      const canD = userCanDelete("cust");
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${pad4(c.uid)}</td>
        <td>${escapeHtml(`${c.sur} ${c.name} ${c.father}`.trim())}</td>
        <td>${escapeHtml(c.ph1)}</td>
        <td>${escapeHtml(c.fin)}</td>
        <td>${escapeHtml(c.seriaNum)}</td>
        <td>${guarantor ? escapeHtml(`${guarantor.sur} ${guarantor.name}`) : "-"}</td>
        <td class="tbl-actions">
          <button class="icon-btn info" onclick="openCustInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button>
          ${canE ? `<button class="icon-btn edit" onclick="openCust(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
          ${canD ? `<button class="icon-btn delete" onclick="delItem('cust', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  // suppliers
  const suppList = db.supp
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => inDateRange(s.createdAt || s.date, "suppFrom", "suppTo"))
    .slice()
    .sort((a, b) => String(a.s.createdAt || a.s.date || "").localeCompare(String(b.s.createdAt || b.s.date || "")) * -1);
  byId("tblSupp").innerHTML = suppList
    .map(
      ({ s, idx }, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${s.uid}</td>
      <td>${escapeHtml(s.co)}</td>
      <td>${escapeHtml(s.per || "-")}</td>
      <td>${escapeHtml(s.mob || "-")}</td>
      <td>${escapeHtml(s.voen || "-")}</td>
      <td class="tbl-actions">
        <button class="icon-btn info" onclick="openSuppInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button>
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openSupp(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete("supp") ? `<button class="icon-btn delete" onclick="delItem('supp', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // products
  const prodList = db.prod
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => inDateRange(p.createdAt || p.date, "prodFrom", "prodTo"))
    .slice()
    .sort((a, b) => String(a.p.createdAt || a.p.date || "").localeCompare(String(b.p.createdAt || b.p.date || "")) * -1);
  byId("tblProd").innerHTML = prodList
    .map(
      ({ p, idx }, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.cat || "-")}</td>
      <td>${escapeHtml(p.subCat || "-")}</td>
      <td class="tbl-actions">
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openProd(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete("prod") ? `<button class="icon-btn delete" onclick="delItem('prod', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // purchases (latest first) + date filter + pagination
  const purchStatus = byId("purchStatus")?.value || "active";
  const purchGroupsMap = new Map();
  (db.purch || [])
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => (purchStatus === "all" ? true : purchStatus === "returned" ? !!p.returnedAt : !p.returnedAt))
    .filter(({ p }) => inDateRange(p.date, "purchFrom", "purchTo"))
    .forEach(({ p, idx }) => {
      const inv = String(p.invNo || invFallback("purch", p.uid));
      if (!purchGroupsMap.has(inv)) {
        purchGroupsMap.set(inv, { invNo: inv, supp: p.supp || "-", date: p.date || "", rows: [], idxList: [] });
      }
      const g = purchGroupsMap.get(inv);
      g.rows.push(p);
      g.idxList.push(idx);
      if (String(p.date || "") > String(g.date || "")) g.date = p.date || g.date;
      if (!g.supp && p.supp) g.supp = p.supp;
    });
  const purchListAll = Array.from(purchGroupsMap.values()).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) * -1);

  const purchPageSize = getPageSize("purchPageSize", 50);
  const purchList = paginate(purchListAll, "purch", purchPageSize, "purchPageInfo");
  const purchAmountTotal = purchListAll.reduce((a, g) => a + g.rows.reduce((x, p) => x + n(p.amount), 0), 0);
  const purchPaidTotal = purchListAll.reduce((a, g) => a + g.rows.reduce((x, p) => x + n(p.paidTotal), 0), 0);
  const purchRemTotal = Math.max(0, purchAmountTotal - purchPaidTotal);
  const purchFootEl = byId("tblPurchFoot");
  if (purchFootEl) {
    purchFootEl.innerHTML = `<tr class="total-row">
      <td colspan="5"><strong>Cəm</strong> (Qaimə: ${purchListAll.length})</td>
      <td><strong>${money(purchAmountTotal)} AZN</strong></td>
      <td><strong>${money(purchPaidTotal)} AZN</strong></td>
      <td><strong>${money(purchRemTotal)} AZN</strong></td>
      <td></td>
    </tr>`;
  }

  byId("tblPurch").innerHTML = purchList
    .map((g, i) => {
      const amountSum = g.rows.reduce((a, p) => a + n(p.amount), 0);
      const paidSum = g.rows.reduce((a, p) => a + n(p.paidTotal), 0);
      const rem = Math.max(0, amountSum - paidSum);
      const latestRow = g.rows
        .slice()
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
      const actor = latestRow ? operationActorName(latestRow, getStaffName(latestRow.employeeId) || "-") : "-";
      const actions = `
        <button class="icon-btn info" onclick="openPurchInfoByInv('${escapeAttr(g.invNo)}')" title="Məlumat"><i class="fas fa-circle-info"></i></button>
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openPurchInvoiceEdit('${escapeAttr(g.invNo)}')" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete("purch") ? `<button class="icon-btn delete" onclick="delPurchInvoice('${escapeAttr(g.invNo)}')" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      `;
      const searchText = [
        g.invNo,
        g.date,
        g.supp,
        ...g.rows.map((p) => [p.name, p.code, p.imei1, p.imei2, p.seria, p.amount, p.paidTotal, p.payType, p.qty]).flat(),
      ]
        .filter((x) => x != null && String(x).trim() !== "")
        .join(" ");
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(g.invNo)}</td>
        <td>${fmtDT(g.date)}</td>
        <td>${escapeHtml(g.supp || "-")}</td>
        <td>${escapeHtml(actor || "-")}</td>
        <td>${money(amountSum)} AZN</td>
        <td>${money(paidSum)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions">${actions}<span style="display:none">${escapeHtml(searchText)}</span></td>
      </tr>`;
    })
    .join("");

  // stock (do NOT depend on purch date/status filters; show all inventory)
  stockFillCatOptions();
  const stockListAll = (db.purch || [])
    .slice(0, 5000) /* safety */
    .map((p) => ({ p }));

  const stockFiltered = stockListAll
    .filter(({ p }) => inDateRange(p.date, "stockFrom", "stockTo"))
    .filter(({ p }) => {
      const st = byId("stockStatus")?.value || "stock";
      const remQty = purchRemainingQty(p);
      const isReturned = !!p.returnedAt;
      const isSold = !isReturned && remQty <= 0;
      if (st === "all") return true;
      if (st === "returned") return isReturned;
      if (st === "sold") return isSold;
      if (st === "stock") return !isReturned && !isSold;
      return true;
    })
    .filter(({ p }) => {
      const cat = String(byId("stockCat")?.value || "").trim();
      const sub = String(byId("stockSubcat")?.value || "").trim();
      if (!cat && !sub) return true;
      const meta = productMetaByName(p.name);
      if (cat && meta.cat !== cat) return false;
      if (sub && meta.subCat !== sub) return false;
      return true;
    });
  const stockAmountTotal = stockFiltered.reduce((a, { p }) => a + n(p.amount), 0);
  const stockRemainingValue = stockFiltered.reduce((a, { p }) => {
    const remQty = purchRemainingQty(p);
    const isReturned = !!p.returnedAt;
    const isSold = !isReturned && remQty <= 0;
    if (isReturned || isSold) return a;
    const qtyAll = Math.max(1, Math.floor(n(p.qty || 1)));
    const unit = purchIsBulk(p) ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : (n(p.amount) / qtyAll)) : n(p.amount);
    return a + (purchIsBulk(p) ? remQty * unit : unit);
  }, 0);
  const stockFootEl = byId("tblStockFoot");
  if (stockFootEl) {
    stockFootEl.innerHTML = `<tr class="total-row">
      <td colspan="6"><strong>Cəm</strong> (Sətir: ${stockFiltered.length})</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td><strong>${money(stockAmountTotal)} AZN</strong><br><small class="muted">Anbar dəyəri: ${money(stockRemainingValue)} AZN</small></td>
    </tr>`;
  }

  byId("tblStock").innerHTML = stockFiltered
    .slice(0, 2000) /* safety */
    .map(({ p }, i) => {
      const key = itemKeyFromPurch(p);
      const remQty = purchRemainingQty(p);
      const isReturned = !!p.returnedAt;
      const isSold = !isReturned && remQty <= 0;
      const statusText = isReturned ? "QAYTARILIB" : isSold ? "SATILIB" : "ANBARDA";
      const rowClass = isReturned ? "row-sold" : isSold ? "row-sold" : "row-stock";
      const badgeClass = isReturned ? "badge-sold" : isSold ? "badge-sold" : "badge-stock";
      const qtyAll = Math.max(1, Math.floor(n(p.qty || 1)));
      const unit = purchIsBulk(p) ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : (n(p.amount) / qtyAll)) : n(p.amount);
      const priceHtml = purchIsBulk(p)
        ? `${money(unit)} AZN <small class="muted">(cəmi ${money(p.amount)} AZN)</small>`
        : `${money(p.amount)} AZN`;
      return `
      <tr class="${rowClass}">
        <td>${i + 1}</td>
        <td><span class="status-badge ${badgeClass}">${statusText}</span></td>
        <td>${fmtDT(p.date)}</td>
        <td>${escapeHtml(p.supp)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.code || "")}</td>
        <td>${purchIsBulk(p) ? String(remQty) : ""}</td>
        <td>${escapeHtml(p.imei1 || "")}</td>
        <td>${escapeHtml(p.imei2 || "")}</td>
        <td>${escapeHtml(p.seria || "")}</td>
        <td>${priceHtml}</td>
      </tr>`;
    })
    .join("");

  // sales + date filter + pagination
  const salesStatus = byId("salesStatus")?.value || "active";
  const salesListAll = db.sales
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => (salesStatus === "all" ? true : salesStatus === "returned" ? !!s.returnedAt : !s.returnedAt))
    .filter(({ s }) => inDateRange(s.date, "salesFrom", "salesTo"))
    .sort((a, b) => String(a.s.date).localeCompare(String(b.s.date)) * -1);

  const salesPageSize = getPageSize("salesPageSize", 50);
  const salesList = paginate(salesListAll, "sales", salesPageSize, "salesPageInfo");
  const salesAmountTotal = salesListAll.reduce((a, { s }) => a + n(s.amount), 0);
  const salesPaidTotal = salesListAll.reduce((a, { s }) => a + n(s.paidTotal), 0);
  const salesRemTotal = Math.max(0, salesAmountTotal - salesPaidTotal);
  const salesFootEl = byId("tblSalesFoot");
  if (salesFootEl) {
    salesFootEl.innerHTML = `<tr class="total-row">
      <td colspan="8"><strong>Cəm</strong> (Sətir: ${salesListAll.length})</td>
      <td><strong>${money(salesAmountTotal)} AZN</strong></td>
      <td><strong>${money(salesPaidTotal)} AZN</strong></td>
      <td><strong>${money(salesRemTotal)} AZN</strong></td>
      <td></td>
    </tr>`;
  }

  byId("tblSales").innerHTML = salesList
    .map(({ s, idx }, i) => {
      const rem = saleRemaining(s);
      const invNo = s.invNo || invFallback("sales", s.uid);
      const p = s.bulkPurchUid ? db.purch.find((x) => String(x.uid) === String(s.bulkPurchUid)) : (s.itemKey ? db.purch.find((x) => itemKeyFromPurch(x) === s.itemKey) : null);
      const searchText = [
        s.uid,
        invNo,
        s.date,
        s.customerName,
        s.customerId,
        s.productName,
        s.code,
        s.qty,
        s.saleType,
        operationActorName(s, s.employeeName),
        s.employeeId,
        s.imei1,
        s.imei2,
        s.seria,
        s.amount,
        s.paidTotal,
        // also include linked purchase identifiers so IMEI/Seriya search works even if not shown in table
        p?.invNo,
        p?.code,
        p?.imei1,
        p?.imei2,
        p?.seria,
      ]
        .filter((x) => x != null && String(x).trim() !== "")
        .join(" ");
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(invNo)}</td>
        <td>${fmtDT(s.date)}</td>
        <td>${escapeHtml(s.customerName)}</td>
        <td>${escapeHtml(s.productName)}</td>
        <td>${String(Math.max(1, Math.floor(n(s.qty || 1))))}</td>
        <td>${escapeHtml(String(s.saleType).toUpperCase())}</td>
        <td>${escapeHtml(operationActorName(s, s.employeeName || ""))}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions">
          <button class="icon-btn info" onclick="openSaleInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button>
          ${userCanEdit() ? `<button class="icon-btn edit" onclick="openSale(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
          ${userCanDelete("sales") ? `<button class="icon-btn delete" onclick="delItem('sales', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
          <span style="display:none">${escapeHtml(searchText)}</span>
        </td>
      </tr>`;
    })
    .join("");

  // staff
  const staffList = db.staff
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => inDateRange(s.createdAt || s.date, "staffFrom", "staffTo"))
    .slice()
    .sort((a, b) => String(a.s.createdAt || a.s.date || "").localeCompare(String(b.s.createdAt || b.s.date || "")) * -1);
  byId("tblStaff").innerHTML = staffList
    .map(
      ({ s, idx }, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${s.uid}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.role || "-")}</td>
      <td>${escapeHtml(s.phone || "-")}</td>
      <td>${money(s.baseSalary || 0)} AZN</td>
      <td>${money(s.commPct || 0)}%</td>
      <td class="tbl-actions">
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openStaff(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete("staff") ? `<button class="icon-btn delete" onclick="delItem('staff', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // debts (debitor) grouped by customer + date filter + pagination
  const debtsStatus = byId("debtsStatus")?.value || "";
  const debtsAllRaw = db.sales
    .filter((s) => !s.returnedAt)
    .filter((s) => String(s.saleType || "").toLowerCase() !== "kredit")
    .filter((s) => debtsStatus ? inDateRange(s.date, "debtsFrom", "debtsTo") : false)
    .map((s, saleIdx) => {
      const total = n(s.amount);
      const rem = saleRemaining(s);
      const st = debtStatus(total, rem);
      return { s, saleIdx, total, rem, st };
    });

  const debtsAll = debtsAllRaw.filter((x) => (debtsStatus === "all" ? true : debtsStatus ? x.st === debtsStatus : false));

  const groupMap = new Map();
  for (const x of debtsAll) {
    const key = String(x.s.customerId);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(x);
  }
  const groups = Array.from(groupMap.entries()).map(([customerId, items]) => {
    const total = items.reduce((a, t) => a + t.total, 0);
    const rem = items.reduce((a, t) => a + t.rem, 0);
    const paid = total - rem;
    const st = debtStatus(total, rem);
    return { customerId, customerName: items[0]?.s.customerName || customerId, total, paid, rem, st, items };
  });

  const groupsFiltered = groups;
  groupsFiltered.sort((a, b) => (a.rem < b.rem ? 1 : -1));

  window.__debtorGroups = groupsFiltered;
  const debtsPageSize = getPageSize("debtsPageSize", 50);
  const groupsPage = paginate(groupsFiltered, "debts", debtsPageSize, "debtsPageInfo");
  const debtsTotal = groupsFiltered.reduce((a, g) => a + n(g.total), 0);
  const debtsPaid = groupsFiltered.reduce((a, g) => a + n(g.paid), 0);
  const debtsRem = groupsFiltered.reduce((a, g) => a + n(g.rem), 0);

  byId("tblDebts").innerHTML = groupsPage
    .map((g, i) => {
      const payDisabled = g.rem <= 0.000001 ? "disabled" : "";
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(g.customerName)}</td>
        <td>${money(g.total)} AZN</td>
        <td>${money(g.paid)} AZN</td>
        <td>${money(g.rem)} AZN</td>
        <td><span class="pill ${g.st}">${debtLabel(g.st)}</span></td>
        <td class="tbl-actions">
          <button class="icon-btn info" onclick="openDebtorInfo('${escapeAttr(g.customerId)}')" title="Info"><i class="fas fa-circle-info"></i></button>
          <button class="btn-mini-pay" type="button" onclick="openDebtorPayment('${escapeAttr(g.customerId)}')" ${payDisabled}>Ödəniş et</button>
        </td>
      </tr>`;
    })
    .join("")
    + (groupsFiltered.length
      ? `<tr class="total-row">
          <td colspan="2"><strong>Cəmi</strong></td>
          <td><strong>${money(debtsTotal)} AZN</strong></td>
          <td><strong>${money(debtsPaid)} AZN</strong></td>
          <td><strong>${money(debtsRem)} AZN</strong></td>
          <td></td>
          <td></td>
        </tr>`
      : "");
  filterDebts();

  // overdue credits (monthly installments)
  const overdueBody = byId("tblOverdue");
  if (overdueBody) {
    const view = byId("overdueView")?.value || "";
    const daysFrom = Math.max(0, Math.floor(n(byId("overdueDaysFrom")?.value || 0)));
    const daysToRaw = byId("overdueDaysTo")?.value;
    const daysTo = daysToRaw === "" ? null : Math.max(0, Math.floor(n(daysToRaw)));
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const dayMs = 24 * 60 * 60 * 1000;
    const toDayStart = (iso) => {
      const [y, m, d] = String(iso || "").slice(0, 10).split("-").map(Number);
      if (!y || !m || !d) return null;
      return new Date(y, m - 1, d).getTime();
    };
    const todayT = toDayStart(todayISO);

    const saleRowsMap = new Map();
    (db.sales || [])
      .filter((s) => !s.returnedAt && String(s.saleType || "").toLowerCase() === "kredit")
      .forEach((s, idx) => {
        const sched = buildCreditSchedule(s);
        const inv = s.invNo || invFallback("sales", s.uid);
        const cust = (db.cust || []).find((c) => String(c.uid) === String(s.customerId)) || null;
        const guarantor = cust?.zam ? (db.cust || []).find((g) => String(g.uid) === String(cust.zam)) : null;
        const custFull = cust ? `${cust.sur || ""} ${cust.name || ""} ${cust.father || ""}`.trim() : (s.customerName || "-");
        const custPhone = String(cust?.ph1 || cust?.ph2 || cust?.ph3 || "-");
        const zam = guarantor ? `${guarantor.sur || ""} ${guarantor.name || ""} ${guarantor.father || ""}`.trim() : "-";
        const saleKey = String(s.uid);
        const invoiceRemaining = Math.max(0, saleRemaining(s));
        if (invoiceRemaining <= 0.000001) return;

        let overdueSum = 0;
        let maxDaysLate = 0;
        let repAll = null; // earliest unpaid installment
        let repOverdue = null; // most delayed unpaid installment

        for (const r of sched.rows) {
          if (r.remaining <= 0.000001) continue;
          const dueT = toDayStart(r.due);
          if (dueT == null || todayT == null) continue;
          const daysLateRaw = Math.floor((todayT - dueT) / dayMs);
          const daysLate = Math.max(0, daysLateRaw);
          const isOverdue = daysLateRaw >= 1;
          if (isOverdue) {
            overdueSum += Math.max(0, n(r.remaining));
            if (daysLate > maxDaysLate) maxDaysLate = daysLate;
          }
          if (!repAll || String(r.due || "") < String(repAll.due || "")) repAll = r;
          if (
            isOverdue &&
            (!repOverdue ||
              daysLate > Math.max(0, n(repOverdue.__daysLate || 0)) ||
              (daysLate === Math.max(0, n(repOverdue.__daysLate || 0)) && String(r.due || "") < String(repOverdue.due || "")))
          ) {
            repOverdue = { ...r, __daysLate: daysLate };
          }
        }

        const includeByView =
          view === "overdue" ? overdueSum > 0.000001 :
          view === "today" ? false :
          view === "all"; // all
        if (!includeByView) return;

        const rep = view === "overdue" ? (repOverdue || repAll) : repAll;
        if (!rep) return;

        const daysForFilter = view === "overdue" ? maxDaysLate : Math.max(0, maxDaysLate);
        if (daysForFilter < daysFrom) return;
        if (daysTo != null && daysForFilter > daysTo) return;

        saleRowsMap.set(saleKey, {
          saleUid: s.uid,
          customer: custFull || s.customerName || "-",
          phone: custPhone,
          inv,
          dueFullAmount: Math.max(0, n(rep.amount)),
          duePaidAmount: Math.max(0, n(rep.paid)),
          dueDate: rep.due,
          rowRemaining: Math.max(0, n(rep.remaining)),
          dueAmount: Math.max(0, overdueSum),
          invoiceRemaining,
          daysLate: view === "overdue" ? Math.max(0, n(rep.__daysLate || maxDaysLate)) : Math.max(0, maxDaysLate),
          zam,
        });
      });

    const rows = Array.from(saleRowsMap.values());
    for (const x of rows) {
      if (view === "all" && x.daysLate < 1) x.dueAmount = 0;
    }

    rows.sort((a, b) => (b.daysLate - a.daysLate) || String(a.dueDate).localeCompare(String(b.dueDate)));
    const overdueTotal = rows.reduce((a, x) => a + n(x.dueAmount), 0);
    overdueBody.innerHTML =
      rows
        .map((x, i) => {
          const lateCellClass =
            x.daysLate >= 91 ? "late-cell-91p" :
            x.daysLate >= 61 ? "late-cell-61-90" :
            x.daysLate >= 31 ? "late-cell-31-60" :
            x.daysLate >= 1 ? "late-cell-1-30" : "";
          return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(x.customer)}</td>
            <td>${escapeHtml(x.phone || "-")}</td>
            <td>${escapeHtml(x.inv || "-")}</td>
            <td class="overdue-num-cell">${money(x.dueFullAmount)} AZN</td>
            <td class="overdue-num-cell">${money(x.duePaidAmount)} AZN</td>
            <td class="overdue-num-cell">${money(x.dueAmount)} AZN</td>
            <td class="overdue-num-cell">${money(x.invoiceRemaining)} AZN</td>
            <td>${escapeHtml(x.dueDate || "-")}</td>
            <td class="${lateCellClass} overdue-days-cell">${x.daysLate}</td>
            <td>${escapeHtml(x.zam || "-")}</td>
            <td class="tbl-actions overdue-actions-cell">
              <button class="icon-btn info overdue-info-btn" type="button" onclick="openOverdueInfo('${escapeAttr(x.saleUid)}')" title="Info"><i class="fas fa-circle-info"></i></button>
            </td>
          </tr>`;
        })
        .join("")
      || emptyRow(12);
    if (rows.length) {
      const overdueFullTotal = rows.reduce((a, x) => a + n(x.dueFullAmount), 0);
      const overduePaidTotal = rows.reduce((a, x) => a + n(x.duePaidAmount), 0);
      const overdueInvoiceRemTotal = rows.reduce((a, x) => a + n(x.invoiceRemaining), 0);
      overdueBody.innerHTML += `
        <tr class="total-row">
          <td colspan="4"><strong>Cəmi</strong></td>
          <td class="overdue-num-cell"><strong>${money(overdueFullTotal)} AZN</strong></td>
          <td class="overdue-num-cell"><strong>${money(overduePaidTotal)} AZN</strong></td>
          <td class="overdue-num-cell"><strong>${money(overdueTotal)} AZN</strong></td>
          <td class="overdue-num-cell"><strong>${money(overdueInvoiceRemTotal)} AZN</strong></td>
          <td colspan="4"></td>
        </tr>
      `;
    }
  }

  // creditor (suppliers) + date filter + pagination
  const credStatus = byId("credStatus")?.value || "";
  const groupsMap = new Map();
  for (const p of db.purch.filter((p) => !p.returnedAt).filter((p) => inDateRange(p.date, "credFrom", "credTo"))) {
    const supp = p.supp || "(Seçilməyib)";
    if (!groupsMap.has(supp)) groupsMap.set(supp, []);
    groupsMap.get(supp).push(p);
  }

  const credGroups = Array.from(groupsMap.entries()).map(([supp, purchases]) => {
    const actives = purchases.filter((x) => !x.returnedAt);
    const total = actives.reduce((a, x) => a + n(x.amount), 0);
    const paid = actives.reduce((a, x) => a + n(x.paidTotal), 0);
    const rem = actives.reduce((a, x) => a + purchRemaining(x), 0);
    const st = debtStatus(total, rem);
    return { supp, purchases, total, paid, rem, st };
  });

  // expose groups for info modal
  window.__credGroups = credGroups;

  const filteredGroupsAll = credGroups.filter((g) => {
    if (!credStatus) return false;
    if (credStatus === "all") return true;
    if (credStatus === "open") return g.st !== "paid";
    return g.st === credStatus;
  });
  const credTotal = filteredGroupsAll.reduce((a, g) => a + n(g.total), 0);
  const credPaid = filteredGroupsAll.reduce((a, g) => a + n(g.paid), 0);
  const credRem = filteredGroupsAll.reduce((a, g) => a + n(g.rem), 0);

  const credPageSize = getPageSize("credPageSize", 50);
  const filteredGroups = paginate(filteredGroupsAll, "cred", credPageSize, "credPageInfo");

  byId("tblCreditor").innerHTML = filteredGroups
    .map(
      (g, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(g.supp)}</td>
      <td>${money(g.total)} AZN</td>
      <td>${money(g.paid)} AZN</td>
      <td>${money(g.rem)} AZN</td>
      <td><span class="pill ${g.st}">${debtLabel(g.st)}</span></td>
      <td class="tbl-actions">
        <button class="icon-btn info" onclick="openCreditorInfo(${credGroups.indexOf(g)})" title="Info"><i class="fas fa-circle-info"></i></button>
      </td>
    </tr>`
    )
    .join("")
    + (filteredGroupsAll.length
      ? `<tr class="total-row">
          <td colspan="2"><strong>Cəmi</strong></td>
          <td><strong>${money(credTotal)} AZN</strong></td>
          <td><strong>${money(credPaid)} AZN</strong></td>
          <td><strong>${money(credRem)} AZN</strong></td>
          <td></td>
          <td></td>
        </tr>`
      : "");
  filterCreditor();

  // cash list + filters + pagination
  fillCashAccountSelect();
  const cashType = byId("cashType")?.value || "all";
  const cashAccId = getSelectedCashAccountId();
  const cashRowsAll = db.cash
    .filter((c) => (cashType === "all" ? true : c.type === cashType))
    .filter((c) => (cashAccId ? Number(c.accountId || 1) === Number(cashAccId) : true))
    .filter((c) => inDateRange(c.date, "cashFrom", "cashTo"))
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1));

  const cashPageSize = getPageSize("cashPageSize", 50);
  const cashRows = paginate(cashRowsAll, "cash", cashPageSize, "cashPageInfo");

  byId("tblCash").innerHTML = cashRows
    .map((c, i) => {
      const kind = c.link?.kind || "";
      const accountName = (db.accounts || []).find((a) => Number(a.uid) === Number(c.accountId || 1))?.name || `#${Number(c.accountId || 1)}`;
      let invNo = "-";
      let customer = "-";
      // Always show the person who PERFORMED the cash operation
      const employee = c.actor || "-";
      let payType = "-";

      if (kind === "sale" || kind === "sale_payment" || kind === "return_refund") {
        const s = db.sales.find((x) => Number(x.uid) === Number(c.link?.saleUid));
        if (s) {
          invNo = s.invNo || invFallback("sales", s.uid);
          customer = s.customerName || "-";
        }
        const pk = c.meta?.payKind || "";
        payType =
          kind === "return_refund" ? "Qaytarma" :
          pk === "down" ? "İlkin" :
          pk === "monthly" ? "Aylıq" :
          "Satış";
      } else if (kind === "debtor_payment") {
        const allocs = c.meta?.allocations || [];
        const firstSaleUid = allocs[0]?.saleUid ?? allocs[0]?.salesUid ?? null;
        const s = firstSaleUid ? db.sales.find((x) => Number(x.uid) === Number(firstSaleUid)) : null;
        if (s) {
          invNo = s.invNo || invFallback("sales", s.uid);
          customer = s.customerName || "-";
        } else {
          customer = c.source || "-";
        }
        const pk = c.meta?.payKind || "";
        payType = pk === "down" ? "İlkin" : pk === "monthly" ? "Aylıq" : "Debitor";
      } else if (kind === "creditor_invoice_payment" || kind === "purch_payment" || kind === "purch_payment_adj") {
        const p = db.purch.find((x) => Number(x.uid) === Number(c.link?.purchUid));
        if (p) {
          invNo = p.invNo || invFallback("purch", p.uid);
          customer = p.supp || "-";
        }
        payType = "Alış";
      } else if (kind === "creditor_payment") {
        const allocs = c.meta?.allocations || [];
        const firstPurchUid = allocs[0]?.purchUid ?? null;
        const p = firstPurchUid ? db.purch.find((x) => Number(x.uid) === Number(firstPurchUid)) : null;
        if (p) {
          invNo = p.invNo || invFallback("purch", p.uid);
        }
        customer = c.link?.supp || c.source || "-";
        payType = "Alış";
      } else if (kind === "staff_salary") {
        customer = c.link?.staffName || "-";
        payType = c.link?.payType ? String(c.link.payType).charAt(0).toUpperCase() + String(c.link.payType).slice(1) : "Əməkhaqqı";
      } else if (kind === "transfer") {
        customer = "Hesablar arası";
        payType = "Transfer";
      } else if (kind === "expense" || kind === "income") {
        customer = c.source || "-";
        payType = kind === "expense" ? "Xərc" : "Mədaxil";
      } else {
        customer = c.source || "-";
        const fallback = kind || (c.type === "in" ? "Mədaxil" : "Məxaric");
        payType = String(fallback).charAt(0).toUpperCase() + String(fallback).slice(1);
      }

      return `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(invNo)}</td>
      <td>${escapeHtml(customer)}</td>
      <td>${c.type === "in" ? "Gəlir" : "Xərc"}</td>
      <td class="${c.type === "in" ? "amt-in" : "amt-out"}">${money(c.amount)} AZN</td>
      <td>${escapeHtml(accountName)}</td>
      <td>${escapeHtml(employee)}</td>
      <td>${fmtDT(c.date)}</td>
      <td>${escapeHtml(payType)}</td>
      <td class="tbl-actions">
        <button class="icon-btn info" onclick="openCashInfo(${c.uid})" title="Info"><i class="fas fa-circle-info"></i></button>
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openEditCashOp(${c.uid})" title="Redaktə"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete("cash") ? `<button class="icon-btn delete" onclick="delCashOp(${c.uid})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`;
    })
    .join("");

  const incomeF = cashRowsAll.filter((c) => c.type === "in").reduce((a, b) => a + n(b.amount), 0);
  const expenseF = cashRowsAll.filter((c) => c.type === "out").reduce((a, b) => a + n(b.amount), 0);
  byId("cashIn").innerText = money(incomeF);
  byId("cashOut").innerText = money(expenseF);
  byId("cashBal").innerText = money(incomeF - expenseF);
  const advEl = byId("cashAdv");
  if (advEl) advEl.innerText = money(totalReturnedSalesCreditLeft());

  // accounts
  ensureAccounts();
  const cashAccountsBtn = byId("cashAccountsBtn");
  if (cashAccountsBtn) cashAccountsBtn.style.display = userCanSection("accounts") ? "" : "none";
  const tblAccounts = byId("tblAccounts");
  if (tblAccounts) tblAccounts.innerHTML = db.accounts
    .map((a, i) => {
      const bal = accountBalance(a.uid);
      const delDisabled = a.uid === 1 ? "disabled" : "";
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.type)}</td>
        <td>${money(bal)} AZN</td>
        <td class="tbl-actions">
          ${userCanEdit() ? `<button class="icon-btn edit" onclick="openAccount(${i})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
          ${userCanDelete("accounts") ? `<button class="icon-btn delete" onclick="delAccount(${i})" title="Sil" ${delDisabled}><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  // companies (developer only)
  const compBody = byId("tblCompanies");
  if (compBody) {
    const curCid = meta?.session?.companyId;
    compBody.innerHTML = meta.companies
      .map((c, i) => {
        const active = c.id === curCid;
        return `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.id)}</td>
          <td>${active ? '<span class="pill paid">AKTİV</span>' : "-"}</td>
          <td class="tbl-actions">
            <button class="btn-mini-pay" type="button" onclick="useCompany('${escapeAttr(c.id)}')" ${active ? "disabled" : ""}>Seç</button>
            ${isDeveloper() ? `<button class="icon-btn edit" onclick="openCompany(${i})" title="Edit"><i class="fas fa-pen"></i></button><button class="icon-btn delete" onclick="delCompany(${i})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  // users (cari şirkətin istifadəçiləri)
  const userBody = byId("tblUsers");
  if (userBody) {
    const companyUsers = usersForCurrentCompany()
      .slice()
      .sort((a, b) => String(a.username).localeCompare(String(b.username)));
    userBody.innerHTML = companyUsers
      .map((u, i) => {
        const me = Number(u.uid) === Number(meta?.session?.userUid);
        const staffUid = u.staffUid != null && u.staffUid !== "" ? String(u.staffUid) : null;
        const staffName = staffUid && db.staff ? (db.staff.find((s) => String(s.uid) === staffUid)?.name || "-") : "-";
        const uidAttr = escapeAttr(String(u.uid));
        return `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(u.fullName || "-")}</td>
          <td>${escapeHtml(u.username)}${me ? " (siz)" : ""}</td>
          <td>${escapeHtml(staffName)}</td>
          <td>${escapeHtml(u.role || "user")}</td>
          <td>${u.active ? "Aktiv" : "Deaktiv"}</td>
          <td class="tbl-actions">
            ${(isDeveloper() || isAdmin()) ? `<button class="icon-btn edit" onclick="openUser('${uidAttr}')" title="Edit"><i class="fas fa-pen"></i></button><button class="icon-btn delete" onclick="delUser('${uidAttr}')" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  // audit
  ensureAuditTrash();
  const auditBody = byId("tblAudit");
  if (auditBody) {
    const list = db.audit
      .filter((a) => inDateRange(a.ts, "auditFrom", "auditTo"))
      .slice()
      .sort((a, b) => (a.ts > b.ts ? -1 : 1));
    auditBody.innerHTML = list
      .map((a, i) => {
        return `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtDT(a.ts)}</td>
          <td>${escapeHtml(a.user || "-")}</td>
          <td>${escapeHtml(auditExplain(a))}</td>
          <td>${escapeHtml(a.target || "-")}</td>
          <td><button class="btn-mini-pay" type="button" onclick="openAuditDetails(${a.uid})">Bax</button></td>
        </tr>`;
      })
      .join("");
  }

  // trash
  const trashBody = byId("tblTrash");
  if (trashBody) {
    const list = (db.trash || []).slice().sort((a, b) => (a.deletedAt > b.deletedAt ? -1 : 1));
    trashBody.innerHTML = list
      .map((t, i) => {
        const name =
          t.type === "cust"
            ? `${t.item?.sur || ""} ${t.item?.name || ""}`
            : t.type === "supp"
              ? t.item?.co || "-"
              : t.type === "prod"
                ? t.item?.name || "-"
                : t.type === "purch"
                  ? (t.item?.invNo || invFallback("purch", t.item?.uid)) + " • " + (t.item?.name || "-")
                  : t.type === "sales"
                    ? (t.item?.invNo || invFallback("sales", t.item?.uid)) + " • " + (t.item?.customerName || "-")
                    : t.type === "cash"
                      ? `Cash #${t.item?.uid}`
                      : "-";
        return `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtDT(t.deletedAt)}</td>
          <td>${escapeHtml(t.type)}</td>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(t.deletedBy || "-")}</td>
          <td class="tbl-actions">
            ${userCanEdit() ? `<button class="btn-mini-pay" type="button" onclick="restoreTrash(${t.uid})">Bərpa</button>` : ""}
            ${userCanDelete("trash") ? `<button class="icon-btn delete" onclick="deleteTrash(${t.uid})" title="Tam sil"><i class="fas fa-trash"></i></button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  // profile
  renderProfile();

  // reports (P&L)
  const repSalesEl = byId("repSales");
  if (repSalesEl) {
    const repMonth = byId("repMonth")?.value || "";
    const repView = byId("repView")?.value || "summary";
    const useMonth = !!repMonth;

    const salesInRange = db.sales
      .filter((s) => (useMonth ? inMonth(s.date, repMonth) : inDateRange(s.date, "repFrom", "repTo")))
      .filter((s) => !s.returnedAt);
    const salesTotal = salesInRange.reduce((a, s) => a + n(s.amount), 0);
    const salesPaidInRange = (db.cash || [])
      .filter((c) => (useMonth ? inMonth(c.date, repMonth) : inDateRange(c.date, "repFrom", "repTo")))
      .filter((c) => {
        const k = String(c.link?.kind || "");
        return k === "sale" || k === "sale_payment" || k === "debtor_payment" || k === "debtor_invoice_payment";
      })
      .reduce((a, c) => a + Math.max(0, n(c.amount)), 0)
      - (db.cash || [])
        .filter((c) => (useMonth ? inMonth(c.date, repMonth) : inDateRange(c.date, "repFrom", "repTo")))
        .filter((c) => String(c.link?.kind || "") === "return_refund")
        .reduce((a, c) => a + Math.max(0, n(c.amount)), 0);
    const cogs = salesInRange.reduce((a, s) => {
      if (s.bulkPurchUid) {
        const p = db.purch.find((x) => String(x.uid) === String(s.bulkPurchUid));
        const unit = p ? n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1))) : 0;
        return a + unit * Math.max(1, Math.floor(n(s.qty || 1)));
      }
      const p = db.purch.find((x) => itemKeyFromPurch(x) === s.itemKey);
      return a + (p ? n(p.amount) : 0);
    }, 0);
    const exp = db.cash
      .filter((c) => c.type === "out")
      .filter((c) => c.link && c.link.kind === "expense")
      .filter((c) => (useMonth ? inMonth(c.date, repMonth) : inDateRange(c.date, "repFrom", "repTo")))
      .reduce((a, c) => a + n(c.amount), 0);
    const hasPeriod = useMonth || (byId("repFrom")?.value || "").trim() || (byId("repTo")?.value || "").trim();
    const byEmpForPayroll = new Map();
    for (const s of salesInRange) {
      const empId = String(s.employeeId || "");
      if (!empId) continue;
      byEmpForPayroll.set(empId, (byEmpForPayroll.get(empId) || 0) + n(s.amount));
    }
    let payrollTotalPeriod = 0;
    if (hasPeriod) {
      for (const st of db.staff || []) {
        const salesEmp = byEmpForPayroll.get(String(st.uid)) || 0;
        const pct = Math.max(0, n(st.commPct || 0));
        const base = Math.max(0, n(st.baseSalary || 0));
        payrollTotalPeriod += base + salesEmp * (pct / 100);
      }
    }
    const pl = salesTotal - cogs - exp;
    const plCash = salesPaidInRange - cogs - exp;
    byId("repSales").innerText = money(salesTotal);
    const repSalesPaidEl = byId("repSalesPaid");
    if (repSalesPaidEl) repSalesPaidEl.innerText = money(Math.max(0, salesPaidInRange));
    byId("repCogs").innerText = money(cogs);
    byId("repExp").innerText = money(exp);
    const repPayrollEl = byId("repPayroll");
    if (repPayrollEl) repPayrollEl.innerText = money(payrollTotalPeriod);
    byId("repPL").innerText = money(pl);
    const repPLCashEl = byId("repPLCash");
    if (repPLCashEl) repPLCashEl.innerText = money(plCash);

    // month detailed list
    const head = byId("repListHead");
    const body = byId("tblRepList");
    if (head && body) {
      if (repView === "sales") {
        head.innerHTML = `<tr><th>#</th><th>Tarix</th><th>Qaimə</th><th>Müştəri</th><th>Məhsul</th><th>Məbləğ</th><th>Info</th></tr>`;
        const rows = salesInRange
          .slice()
          .sort((a, b) => (a.date > b.date ? -1 : 1))
          .map((s, i) => {
            const idx = db.sales.findIndex((x) => x.uid === s.uid);
            const inv = s.invNo || invFallback("sales", s.uid);
            return `
            <tr>
              <td>${i + 1}</td>
              <td>${fmtDT(s.date)}</td>
              <td>${escapeHtml(inv)}</td>
              <td>${escapeHtml(s.customerName)}</td>
              <td>${escapeHtml(s.productName)}</td>
              <td>${money(s.amount)} AZN</td>
              <td class="tbl-actions"><button class="icon-btn info" onclick="openSaleInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button></td>
            </tr>`;
          })
          .join("");
        body.innerHTML = rows || emptyRow(7);
      } else if (repView === "purch") {
        const purchInRange = db.purch
          .filter((p) => (useMonth ? inMonth(p.date, repMonth) : inDateRange(p.date, "repFrom", "repTo")))
          .slice()
          .sort((a, b) => (a.date > b.date ? -1 : 1));
        head.innerHTML = `<tr><th>#</th><th>Tarix</th><th>Qaimə</th><th>Təchizatçı</th><th>Məhsul</th><th>Məbləğ</th></tr>`;
        body.innerHTML =
          purchInRange
            .map((p, i) => {
              const inv = p.invNo || invFallback("purch", p.uid);
              return `
              <tr>
                <td>${i + 1}</td>
                <td>${fmtDT(p.date)}</td>
                <td>${escapeHtml(inv)}</td>
                <td>${escapeHtml(p.supp)}</td>
                <td>${escapeHtml(p.name)}</td>
                <td>${money(p.amount)} AZN</td>
              </tr>`;
            })
            .join("") || emptyRow(6);
      } else if (repView === "expense") {
        const expRows = db.cash
          .filter((c) => c.type === "out")
          .filter((c) => c.link && c.link.kind === "expense")
          .filter((c) => (useMonth ? inMonth(c.date, repMonth) : inDateRange(c.date, "repFrom", "repTo")))
          .slice()
          .sort((a, b) => (a.date > b.date ? -1 : 1));
        head.innerHTML = `<tr><th>#</th><th>Tarix</th><th>Mənbə</th><th>Məbləğ</th><th>Qeyd</th></tr>`;
        body.innerHTML =
          expRows
            .map(
              (c, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${fmtDT(c.date)}</td>
              <td>${escapeHtml(c.source)}</td>
              <td class="amt-out">-${money(c.amount)} AZN</td>
              <td>${escapeHtml(c.note || "")}</td>
            </tr>`
            )
            .join("") || emptyRow(5);
      } else if (repView === "monthly") {
        const monthsList = [];
        if (repMonth) {
          monthsList.push(repMonth);
        } else {
          const fromMs = parseDateOnly(byId("repFrom")?.value);
          const toMs = parseDateOnly(byId("repTo")?.value);
          if (fromMs && toMs) {
            const from = new Date(fromMs);
            const to = new Date(toMs);
            let y = from.getFullYear();
            let m = from.getMonth() + 1;
            const endY = to.getFullYear();
            const endM = to.getMonth() + 1;
            while (y < endY || (y === endY && m <= endM)) {
              monthsList.push(`${y}-${String(m).padStart(2, "0")}`);
              m++;
              if (m > 12) {
                m = 1;
                y++;
              }
            }
          }
        }
        head.innerHTML = `<tr><th>#</th><th>Ay</th><th>Satış</th><th>Alış</th><th>Xərc</th><th>Əməkhaqqı</th><th>Mənfəət/Zərər</th></tr>`;
        if (monthsList.length === 0) {
          body.innerHTML = `<tr><td colspan="7">Ay (repMonth) və ya tarix aralığı (repFrom–repTo) seçin</td></tr>`;
        } else {
          body.innerHTML = monthsList
            .map((monthKey, i) => {
              const salesInMonth = db.sales
                .filter((s) => !s.returnedAt)
                .filter((s) => inMonth(s.date, monthKey));
              const salesSum = salesInMonth.reduce((a, s) => a + n(s.amount), 0);
              const cogsM = salesInMonth.reduce((a, s) => {
                if (s.bulkPurchUid) {
                  const p = db.purch.find((x) => String(x.uid) === String(s.bulkPurchUid));
                  const unit = p ? n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1))) : 0;
                  return a + unit * Math.max(1, Math.floor(n(s.qty || 1)));
                }
                const p = db.purch.find((x) => itemKeyFromPurch(x) === s.itemKey);
                return a + (p ? n(p.amount) : 0);
              }, 0);
              const expM = db.cash
                .filter((c) => c.type === "out")
                .filter((c) => c.link && c.link.kind === "expense")
                .filter((c) => inMonth(c.date, monthKey))
                .reduce((a, c) => a + n(c.amount), 0);
              const byEmpM = new Map();
              for (const s of salesInMonth) {
                const empId = String(s.employeeId || "");
                if (!empId) continue;
                byEmpM.set(empId, (byEmpM.get(empId) || 0) + n(s.amount));
              }
              let payrollM = 0;
              for (const st of db.staff || []) {
                const salesEmp = byEmpM.get(String(st.uid)) || 0;
                const pct = Math.max(0, n(st.commPct || 0));
                const base = Math.max(0, n(st.baseSalary || 0));
                payrollM += base + salesEmp * (pct / 100);
              }
              const plM = salesSum - cogsM - expM - payrollM;
              const [y, m] = monthKey.split("-");
              const ayLabel = `${y}‑${m}`;
              return `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(ayLabel)}</td>
                <td>${money(salesSum)} AZN</td>
                <td>${money(cogsM)} AZN</td>
                <td>${money(expM)} AZN</td>
                <td>${money(payrollM)} AZN</td>
                <td>${money(plM)} AZN</td>
              </tr>`;
            })
            .join("");
        }
      } else if (repView === "staff") {
        const byEmp = new Map();
        for (const s of salesInRange) {
          const empId = String(s.employeeId || "");
          if (!empId) continue;
          if (!byEmp.has(empId)) byEmp.set(empId, { count: 0, sum: 0 });
          const o = byEmp.get(empId);
          o.count += 1;
          o.sum += n(s.amount);
        }
        const staffSorted = db.staff
          .slice()
          .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        head.innerHTML = `<tr><th>#</th><th>Əməkdaş</th><th>Satış sayı</th><th>Satış cəmi</th><th>Faiz</th><th>Komissiya</th><th>Baza maaş</th><th>Yekun</th><th>Əməliyyat</th></tr>`;
        body.innerHTML =
          staffSorted
            .map((st, i) => {
              const empId = String(st.uid);
              const o = byEmp.get(empId) || { count: 0, sum: 0 };
              const pct = Math.max(0, n(st.commPct || 0));
              const base = Math.max(0, n(st.baseSalary || 0));
              const comm = o.sum * (pct / 100);
              const total = base + comm;
              return `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(st.name)}</td>
                <td>${o.count}</td>
                <td>${money(o.sum)} AZN</td>
                <td>${money(pct)}%</td>
                <td>${money(comm)} AZN</td>
                <td>${money(base)} AZN</td>
                <td>${money(total)} AZN</td>
                <td class="tbl-actions"><button class="btn-mini" type="button" onclick="openStaffReportSales('${escapeAttr(empId)}')" title="Satış siyahısı"><i class="fas fa-list"></i> Bax</button></td>
              </tr>`;
            })
            .join("") || emptyRow(9);
      } else {
        head.innerHTML = `<tr><th>Göstəriş</th><th>Dəyər</th></tr>`;
        body.innerHTML = `
          <tr><td>Satış</td><td>${money(salesTotal)} AZN</td></tr>
          <tr><td>Satış (ödənilən)</td><td>${money(Math.max(0, salesPaidInRange))} AZN</td></tr>
          <tr><td>Alış</td><td>${money(cogs)} AZN</td></tr>
          <tr><td>Xərc</td><td>${money(exp)} AZN</td></tr>
          <tr><td>Əməkhaqqı (bütün əməkdaşlar, ay üzrə)</td><td>${money(payrollTotalPeriod)} AZN</td></tr>
          <tr><td>Mənfəət/Zərər</td><td>${money(pl)} AZN</td></tr>
          <tr><td>Nağdlaşan mənfəət</td><td>${money(plCash)} AZN</td></tr>
        `;
      }
    }

    // payroll (commission from employee's own sales total) + sale count + Bax
    const payBody = byId("tblPayroll");
    if (payBody) {
      const byEmpPay = new Map();
      for (const s of salesInRange) {
        const empId = String(s.employeeId || "");
        if (!empId) continue;
        if (!byEmpPay.has(empId)) byEmpPay.set(empId, { count: 0, sum: 0 });
        const o = byEmpPay.get(empId);
        o.count += 1;
        o.sum += n(s.amount);
      }
      const rows = db.staff
        .slice()
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
        .map((st, i) => {
          const o = byEmpPay.get(String(st.uid)) || { count: 0, sum: 0 };
          const salesSum = o.sum;
          const pct = Math.max(0, n(st.commPct || 0));
          const base = Math.max(0, n(st.baseSalary || 0));
          const comm = salesSum * (pct / 100);
          const total = base + comm;
          return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(st.name)}</td>
            <td>${o.count}</td>
            <td>${money(salesSum)} AZN</td>
            <td>${money(pct)}%</td>
            <td>${money(comm)} AZN</td>
            <td>${money(base)} AZN</td>
            <td>${money(total)} AZN</td>
            <td class="tbl-actions"><button class="btn-mini" type="button" onclick="openStaffReportSales('${escapeAttr(String(st.uid))}')" title="Satış siyahısı"><i class="fas fa-list"></i> Bax</button></td>
          </tr>`;
        })
        .join("");
      payBody.innerHTML = rows || emptyRow(9);
    }
  }

  const totalsAll = cashTotals();
  // dashboard stats
  const stockCount = db.purch.reduce((a, p) => a + purchRemainingQty(p), 0);
  const debtorSum = db.sales.reduce((a, s) => a + saleRemaining(s), 0);
  const creditorSum = db.purch.reduce((a, p) => a + purchRemaining(p), 0);

  byId("st-cust").innerText = String(db.cust.length);
  byId("st-stock").innerText = String(stockCount);
  byId("st-debts").innerText = money(debtorSum);
  byId("st-creditor").innerText = money(creditorSum);
  byId("st-cash").innerText = money(totalAccountsBalance());

  // Dashboard charts: son 6 ay satış
  const monthNamesAz = ["Yan", "Fev", "Mar", "Apr", "May", "İyn", "İyl", "Avq", "Sen", "Okt", "Noy", "Dek"];
  const now = new Date();
  const last6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    last6.push({ key: `${y}-${m}`, label: `${monthNamesAz[d.getMonth()]} ${y}` });
  }
  const salesByMonth = last6.map(({ key }) => {
    const sum = (db.sales || [])
      .filter((s) => !s.returnedAt && inMonth(s.date, key))
      .reduce((a, s) => a + n(s.amount), 0);
    return sum;
  });
  const maxSales = Math.max(1, ...salesByMonth);
  // Qısa ay adları
  const shortMonths = ["Yan","Fev","Mar","Apr","May","İyn","İyl","Avq","Sen","Okt","Noy","Dek"];
  function fmtChartVal(v) {
    if (v >= 1000000) return (v/1000000).toFixed(1).replace(/\.0$/,"") + "M";
    if (v >= 1000) return (v/1000).toFixed(1).replace(/\.0$/,"") + "k";
    return money(v);
  }
  function buildVBarHtml(dataArr, labelsArr, barClass) {
    const maxV = Math.max(1, ...dataArr);
    const cols = dataArr.map((val, i) => {
      const pct = maxV ? (val / maxV) * 100 : 0;
      const lbl = labelsArr[i];
      return `<div class="dash-vbar-col">
        <div class="dash-vbar-inner">
          <span class="dash-vbar-val${barClass ? " "+barClass : ""}">${fmtChartVal(val)}</span>
          <div class="dash-vbar-bar${barClass ? " "+barClass : ""}" style="height:${Math.max(2,pct)}%"></div>
        </div>
        <span class="dash-vbar-lbl">${escapeHtml(lbl)}</span>
      </div>`;
    }).join("");
    return `<div class="dash-vbar-wrap">${cols}<div class="dash-vbar-baseline"></div></div>`;
  }

  const salesChartEl = byId("dashChartSales");
  if (salesChartEl) {
    const shortLabels = last6.map(({key}) => { const [,m] = key.split("-"); return shortMonths[+m-1]||m; });
    salesChartEl.innerHTML = buildVBarHtml(salesByMonth, shortLabels, "");
  }

  // Alış vs Satış (bu ay)
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const purchThisMonth = (db.purch || []).filter((p) => inMonth(p.date, currentMonthKey)).reduce((a, p) => a + n(p.amount), 0);
  const salesThisMonth = (db.sales || []).filter((s) => !s.returnedAt && inMonth(s.date, currentMonthKey)).reduce((a, s) => a + n(s.amount), 0);
  const maxPVS = Math.max(1, purchThisMonth, salesThisMonth);
  const pvsEl = byId("dashChartPurchVsSales");
  if (pvsEl) {
    pvsEl.innerHTML = `<div class="dash-hbar-wrap">
      <div class="dash-bar-row"><span class="dash-bar-label">Alış</span><div class="dash-bar-track"><div class="dash-bar-fill purch" style="width:${(purchThisMonth/maxPVS*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(purchThisMonth)} AZN</span></div>
      <div class="dash-bar-row"><span class="dash-bar-label">Satış</span><div class="dash-bar-track"><div class="dash-bar-fill sales" style="width:${(salesThisMonth/maxPVS*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(salesThisMonth)} AZN</span></div>
    </div>`;
  }

  // Son 6 ay alış (AZN)
  const purchByMonth = last6.map(({ key }) => (db.purch || []).filter((p) => inMonth(p.date, key)).reduce((a, p) => a + n(p.amount), 0));
  const purchChartEl = byId("dashChartPurch");
  if (purchChartEl) {
    const shortLabels2 = last6.map(({key}) => { const [,m] = key.split("-"); return shortMonths[+m-1]||m; });
    purchChartEl.innerHTML = buildVBarHtml(purchByMonth, shortLabels2, "purch");
  }

  // Debitor vs Kreditor borclar
  const maxDebt = Math.max(1, debtorSum, creditorSum);
  const debtCredEl = byId("dashChartDebtVsCredit");
  if (debtCredEl) {
    debtCredEl.innerHTML = `<div class="dash-hbar-wrap">
      <div class="dash-bar-row"><span class="dash-bar-label">Debitor</span><div class="dash-bar-track"><div class="dash-bar-fill debt" style="width:${(debtorSum/maxDebt*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(debtorSum)} AZN</span></div>
      <div class="dash-bar-row"><span class="dash-bar-label">Kreditor</span><div class="dash-bar-track"><div class="dash-bar-fill credit" style="width:${(creditorSum/maxDebt*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(creditorSum)} AZN</span></div>
    </div>`;
  }

  // Aşağı statistik sətiri: bu il cəmi, anbar sayı
  const yearStart = `${now.getFullYear()}-01-01`;
  const salesYear = (db.sales || []).filter((s) => !s.returnedAt && String((s.date || "").slice(0, 10)) >= yearStart).reduce((a, s) => a + n(s.amount), 0);
  const purchYear = (db.purch || []).filter((p) => String((p.date || "").slice(0, 10)) >= yearStart).reduce((a, p) => a + n(p.amount), 0);
  const salesYearEl = byId("dashStatSalesYear");
  if (salesYearEl) salesYearEl.textContent = money(salesYear);
  const purchYearEl = byId("dashStatPurchYear");
  if (purchYearEl) purchYearEl.textContent = money(purchYear);
  const stockCountEl = byId("dashStatStockCount");
  if (stockCountEl) stockCountEl.textContent = String(stockCount);
  updateDebtSectionVisibility();

  // Re-apply active text searches so results do not reset after auto refresh/render.
  reapplyActiveSearchFilters();
}

function delItem(type, i) {
  const sec = type === "cust" ? "cust"
    : type === "supp" ? "supp"
    : type === "prod" ? "prod"
    : type === "purch" ? "purch"
    : type === "sales" ? "sales"
    : type === "staff" ? "staff"
    : "*";
  if (!userCanDelete(sec)) return alert("Sil icazəsi yoxdur.");
  appConfirm("Silinsin?").then((ok) => {
    if (!ok) return;
  ensureAuditTrash();
  const u = currentUser();
  const deletedBy = u ? u.username : "-";
  const deletedAt = nowISODateTimeLocal();

  if (type === "purch") {
    const p = db.purch[i];
    if (!p) return;
    if (n(p.paidTotal) > 0.000001) {
      return alert("Bu alışın ödənişi var. Kassa balansı pozulmasın deyə silmək olmaz. Lazımdırsa, əks ödəniş (geri qaytarma) əməliyyatı edin.");
    }
    if (!canDeletePurchase(p)) return alert("Bu alış satılıb (və ya say ilə satış edilib). Əvvəl satışı silin.");
    db.trash.push({ uid: genId(db.trash, 1), type: "purch", item: p, deletedAt, deletedBy });
    logEvent("delete", "purch", { uid: p.uid });
    db.purch.splice(i, 1);
    saveDB();
    return;
  }

  if (type === "sales") {
    const s = db.sales[i];
    if (!s) return;
    if (n(s.paidTotal) > 0.000001 || (s.payments && Array.isArray(s.payments) && s.payments.length)) {
      return alert("Bu satışın ödənişi var. Kassa balansı pozulmasın deyə silmək olmaz. Məhsul qaytarılırsa 'Qaytarma' edin (refund varsa kassadan çıxış yazılsın).");
    }
    db.trash.push({ uid: genId(db.trash, 1), type: "sales", item: s, deletedAt, deletedBy });
    logEvent("delete", "sales", { uid: s.uid });
    db.sales.splice(i, 1);
    saveDB();
    return;
  }

  if (type === "cust") {
    const c = db.cust[i];
    if (!c) return;
    db.trash.push({ uid: genId(db.trash, 1), type: "cust", item: c, deletedAt, deletedBy });
    logEvent("delete", "cust", { uid: c.uid });
    db.cust.splice(i, 1);
    saveDB();
    return;
  }
  if (type === "supp") {
    const s = db.supp[i];
    if (!s) return;
    db.trash.push({ uid: genId(db.trash, 1), type: "supp", item: s, deletedAt, deletedBy });
    logEvent("delete", "supp", { uid: s.uid });
    db.supp.splice(i, 1);
    saveDB();
    return;
  }
  if (type === "prod") {
    const p = db.prod[i];
    if (!p) return;
    const nm = String(p.name || "").trim();
    if (nm) {
      const usedInPurch = (db.purch || []).some((x) => String(x.name || "").trim() === nm);
      const usedInSales = (db.sales || []).some((x) => String(x.productName || "").trim() === nm);
      if (usedInPurch || usedInSales) return alert("Bu məhsul adı alış/satışda istifadə olunub. Silmək olmaz.");
    }
    db.trash.push({ uid: genId(db.trash, 1), type: "prod", item: p, deletedAt, deletedBy });
    logEvent("delete", "prod", { uid: p.uid });
    db.prod.splice(i, 1);
    saveDB();
    return;
  }
  if (type === "staff") {
    const s = db.staff[i];
    if (!s) return;
    db.trash.push({ uid: genId(db.trash, 1), type: "staff", item: s, deletedAt, deletedBy });
    logEvent("delete", "staff", { uid: s.uid });
    db.staff.splice(i, 1);
    saveDB();
    return;
  }
  });
  return;
}

// Utilities
function byId(id) {
  return document.getElementById(id);
}
function val(id) {
  return (byId(id)?.value ?? "").toString();
}

function emptyRow(colspan, icon = "fa-inbox", msg = "Məlumat yoxdur") {
  return `<tr><td colspan="${colspan}" style="padding:0;border:none;">
    <div class="empty-state">
      <div class="empty-state-icon"><i class="fas ${icon}"></i></div>
      <div class="empty-state-title">${msg}</div>
      <div class="empty-state-sub">Hələ ki məlumat əlavə edilməyib</div>
    </div>
  </td></tr>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("\n", " ");
}

// expose functions globally for onclick handlers
Object.assign(window, {
  showSec,
  pagePrev,
  pageNext,
  filterTable,
  closeMdl,
  modalBack,
  login,
  logout,
  openCust,
  saveCust,
  openCustInfo,
  openSupp,
  saveSupp,
  openSuppInfo,
  openProd,
  saveProd,
  openPurch,
  savePurch,
  openSale,
  saveSale,
  openSaleInfo,
  openSalePayment,
  saveSalePayment,
  openPaymentHistory,
  openStaff,
  saveStaff,
  openCashOp,
  openCashInfo,
  saveCashOp,
  openEditCashOp,
  saveEditCashOp,
  delCashOp,
  openCashReconcile,
  saveCashReconcile,
  openCashDiffAnalysis,
  openOverdueInfo,
  openOverduePayment,
  saveOverdueNote,
  onStockCatChange,
  setDebtsStatus,
  setOverdueView,
  showDebtSub,
  onDebtTypeChange,
  seedDevTestData,
  toggleCashKind,
  toggleIncomeSourceBox,
  refreshSubcats,
  refreshCustomerInvoices,
  refreshSupplierInvoices,
  addExpenseCategory,
  addExpenseSubcategory,
  filterDebts,
  filterCreditOnly,
  filterCreditor,
  openCreditorInfo,
  openCreditorPayment,
  saveCreditorPayment,
  openCreditorInvoicePayment,
  saveCreditorInvoicePayment,
  openSupplierPaymentHistory,
  openDebtorInfo,
  openDebtorPayment,
  saveDebtorPayment,
  refreshFromCloud,
  delItem,
  toggleCreditBox,
  recalcCredit,
  togglePurchBulk,
  toggleSaleQty,
  openAccountsManager,
  openAccount,
  saveAccount,
  delAccount,
  openCompany,
  saveCompany,
  delCompany,
  useCompany,
  resetCompanyData,
  openUser,
  saveUser,
  delUser,
  openChangePassword,
  changePassword,
  openProfile,
  triggerProfilePhotoUpload,
  onProfilePhotoSelected,
  renderSidebarBrand,
  openSettings,
  saveSettings,
  openSkins,
  setSkin,
  openLoginModal,
  closeLoginModal,
  toggleLoginPassword,
  toggleLpMenu,
  closeLpMenu,
  toggleSidebar,
  openAuditDetails,
  openGlobalSearch,
  runGlobalSearch,
  openSpotlight,
  closeSpotlight,
  closeSpotlightIfOutside,
  runSpotlight,
  spotlightRunIdx,
  toggleMobileSidebar,
  closeMobileSidebar,
  setLang,
  exportCompany,
  importCompany,
  exportCsvCurrent,
  recalcAll,
  openReturnedSalesCreditReport,
  openReturnAdvancePay,
  saveReturnAdvancePay,
  openQrTool,
  genQr,
  clearAudit,
  emptyTrash,
  restoreTrash,
  deleteTrash,
  openReturnSale,
  saveReturnSale,
  openReturnPurch,
  saveReturnPurch,
  printSale,
  toggleDevMenu,
});

/* ── Profil foto helpers ── */
function getProfilePhoto(uid) {
  try { return localStorage.getItem("profilePhoto_" + uid) || ""; } catch { return ""; }
}
function setProfilePhoto(uid, dataUrl) {
  try { localStorage.setItem("profilePhoto_" + uid, dataUrl); } catch {}
}
function removeProfilePhoto(uid) {
  try { localStorage.removeItem("profilePhoto_" + uid); } catch {}
}
function triggerProfilePhotoUpload() {
  const inp = byId("profilePhotoFileInput");
  if (inp) inp.click();
}
function onProfilePhotoSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return alert("Yalnız şəkil faylı seçin.");
  if (file.size > 2 * 1024 * 1024) return alert("Şəkil 2MB-dan böyük olmamalıdır.");
  const reader = new FileReader();
  reader.onload = (ev) => {
    const u = currentUser();
    if (!u) return;
    setProfilePhoto(u.uid, ev.target.result);
    renderSidebarUser();
  };
  reader.readAsDataURL(file);
}

function renderSidebarUser() {
  const el = byId("sidebarUserInfo");
  if (!el) return;
  if (!meta?.session) { el.innerHTML = ""; return; }
  const u = meta.users?.find((x) => x.uid === meta.session.userUid);
  const name = u ? userDisplay(u) : "İstifadəçi";
  const role = u?.role === "developer" ? "Developer" : u?.role === "admin" ? "Admin" : u?.role === "owner" ? "Sahibkar" : "İstifadəçi";
  const initials = name.split(" ").map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "U";
  const email = u?.email || "";
  const photo = u ? getProfilePhoto(u.uid) : "";
  const avatarInner = photo
    ? `<img src="${escapeAttr(photo)}" class="sidebar-user-avatar-img" alt="${escapeAttr(initials)}">`
    : escapeHtml(initials);
  el.innerHTML = `
    <div class="sidebar-user-avatar" title="Şəkil yüklə" onclick="triggerProfilePhotoUpload()">${avatarInner}<span class="sidebar-avatar-cam"><i class="fas fa-camera"></i></span></div>
    <input type="file" id="profilePhotoFileInput" accept="image/*" style="display:none" onchange="onProfilePhotoSelected(event)">
    <div class="sidebar-user-name">${escapeHtml(name)}</div>
    <div class="sidebar-user-role">${escapeHtml(email || role)}</div>`;
  el.onclick = (ev) => {
    if (ev.target.closest(".sidebar-user-avatar")) return;
    toggleProfileMenu({ currentTarget: byId("profileMenuBtn") });
  };
}

function renderSidebarBrand() {
  const nameEl = byId("sidebarBrandName");
  const logoEl = byId("sidebarBrandLogo");
  if (!nameEl) return;
  const compId = meta?.session?.companyId || "";
  const comp = meta?.companies?.find((c) => c.id === compId);
  nameEl.textContent = "rbsoft.az";
  if (logoEl) {
    const logo = comp?.logo || "";
    if (logo) {
      logoEl.innerHTML = `<img src="${escapeAttr(logo)}" alt="${escapeAttr(compName)}" style="max-height:32px;max-width:100%;object-fit:contain;">`;
      logoEl.style.display = "";
    } else {
      logoEl.innerHTML = "";
      logoEl.style.display = "none";
    }
  }
}

function updateHeaderWelcome() {
  const titleEl = byId("appHeaderTitle");
  if (!titleEl) return;
  if (!meta?.session) return;
  const u = meta.users?.find((x) => x.uid === meta.session.userUid);
  const firstName = u ? (userDisplay(u).split(" ")[0] || "") : "";
  if (firstName) titleEl.textContent = "Xoş gəldiniz, " + firstName + "!";
}

function initApp() {
  applyAccessUI();
  applySidebarState();
  setupNavTooltips();
  initHeaderCompactSearch();
  initLang();
  renderSidebarUser();
  renderSidebarBrand();
  updateHeaderWelcome();
  setupLandingPage();
  if (!meta.session) {
    showLoginOverlay(true);
    return;
  }
  showLoginOverlay(false);
  var secToShow = null;
  var navToUse = null;
  const lastSection = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("bakfon_lastSection")) || null;
  if (lastSection && userCanSection(lastSection)) {
    const navLink = Array.from(document.querySelectorAll(".nav-link")).find(
      (el) => el.getAttribute("onclick")?.includes("showSec('" + lastSection + "'") && el.style.display !== "none"
    );
    if (navLink) {
      secToShow = lastSection;
      navToUse = navLink;
    }
  }
  if (!secToShow) {
    const firstVisible = Array.from(document.querySelectorAll(".nav-link")).find(
      (el) => el.style.display !== "none" && !el.classList.contains("dev-toggle")
    );
    const firstSecId = firstVisible?.getAttribute("onclick")?.match(/showSec\('([^']+)'/)?.[1];
    if (firstVisible && firstSecId && userCanSection(firstSecId)) {
      secToShow = firstSecId;
      navToUse = firstVisible;
    }
  }
  runMigrations();
  ensureOverdueTestPack();
  if (secToShow && navToUse) showSec(secToShow, navToUse);
  renderAll();
}

function hideLoading() {
  const loadingEl = byId("loadingOverlay");
  if (loadingEl) loadingEl.classList.add("hidden");
}

function getLoginCompanyFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("company");
    if (fromQuery) return String(fromQuery).trim();
    const hash = (window.location.hash || "").replace(/^#/, "");
    const fromHash = new URLSearchParams(hash).get("company");
    if (fromHash) return String(fromHash).trim();
  } catch (e) {}
  return null;
}

async function init() {
  applyTheme();
  // Offline mode is NOT allowed (avoid local-only operations / desync).
  if (!isOnline()) {
    showOfflineBlock(true);
    window.addEventListener("online", () => location.reload());
    return;
  }
  window.addEventListener("offline", () => showOfflineBlock(true));
  window.addEventListener("online", () => location.reload());
  window.__loginCompanyFromUrl = getLoginCompanyFromUrl();
  const loadingEl = byId("loadingOverlay");
  if (loadingEl) loadingEl.classList.remove("hidden");
  byId("loadingText").textContent = useFirestore() ? "Firestore bağlanır..." : "Yüklənir...";

  var loadingHidden = false;
  var timeoutId = setTimeout(function () {
    if (loadingHidden) return;
    loadingHidden = true;
    hideLoading();
    toast("Yüklənmə vaxtı keçdi. Yeniləyin və ya interneti yoxlayın.", "err", 5000);
    console.warn("Bakfon ERP: init timeout");
  }, 12000);

  try {
    initFirestore();
    if (useFirestore()) await ensureFirestoreAuth();
    meta = await loadMetaAsync();
    ensureMetaDefaults();
    if (useFirestore()) saveMeta();

    if (meta.session) {
      if (byId("loadingText")) byId("loadingText").textContent = "Məlumat yüklənir...";
      db = await loadCompanyDBAsync();
    } else {
      db = defaultDB();
    }
    subscribeRealtime();
    startRealtimeAutoRefresh();
    if (!loadingHidden) {
      loadingHidden = true;
      clearTimeout(timeoutId);
      hideLoading();
      initApp();
    }
  } catch (e) {
    if (!loadingHidden) {
      loadingHidden = true;
      clearTimeout(timeoutId);
      hideLoading();
      toast("Başlatma xətası: " + (e && e.message ? e.message : "Yeniləyin."), "err", 5000);
      console.error("Bakfon ERP init xətası:", e);
      // If something fails (including network), do not fall back to offline usage.
      showOfflineBlock(true);
    }
  }
}

window.addEventListener("load", () => {
  if (typeof FIREBASE_CONFIG === "undefined") window.FIREBASE_CONFIG = null;
  init();
});

var headerClockInterval = null;
function startHeaderClock() {
  if (headerClockInterval) return;
  updateHeaderDateTime();
  headerClockInterval = setInterval(updateHeaderDateTime, 1000);
}

var realtimeAutoRefreshTimer = null;
function startRealtimeAutoRefresh() {
  if (realtimeAutoRefreshTimer) clearInterval(realtimeAutoRefreshTimer);
  realtimeAutoRefreshTimer = null;
  if (!useFirestore() || !meta?.session?.companyId) return;
  realtimeAutoRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshFromCloud(true);
  }, 15000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!useFirestore() || !meta?.session?.companyId) return;
  setTimeout(() => refreshFromCloud(true), 300);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openGlobalSearch();
  }
});

// ===================== #17 Bildiriş mərkəzi =====================
function openNotifications() {
  if (!meta?.session) return showLoginOverlay(true);
  const list = getNotifications();
  const iconMap = { neg: "fa-circle-exclamation", overdue: "fa-clock", stock: "fa-box", info: "fa-circle-info" };
  const rows = list.map((x) => {
    const icon = iconMap[x.kind] || "fa-circle-info";
    const secMap = { neg: "cash", overdue: "overdue", stock: "stock" };
    const secId = secMap[x.kind];
    const actionBtn = secId
      ? `<div class="notif-action"><button onclick="closeMdl();showSec('${secId}',null)">Bölməyə keç →</button></div>`
      : "";
    return `<div class="notif-item">
      <div class="notif-icon ${x.kind}"><i class="fas ${icon}"></i></div>
      <div class="notif-body">
        <div class="notif-title">${escapeHtml(x.title)}</div>
        <div class="notif-text">${escapeHtml(x.text || "")}</div>
        ${actionBtn}
      </div>
    </div>`;
  }).join("");

  openModal(`
    <div class="notif-header-bar">
      <h3>${t("notifications")}</h3>
      ${list.length ? `<span class="notif-count-badge">${list.length}</span>` : ""}
    </div>
    <div class="notif-panel">
      ${rows || `<div class="notif-empty"><i class="fas fa-check-circle" style="color:var(--accent);font-size:1.5rem;margin-bottom:8px;display:block;"></i>${t("no_notifications")}</div>`}
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">${t("close")}</button>
    </div>
  `);
}

// ===================== #18 Mobil uyğunluq =====================
function toggleMobileSidebar() {
  const aside = document.querySelector("aside");
  const overlay = byId("mobileSidebarOverlay");
  if (!aside || !overlay) return;
  aside.classList.toggle("mobile-open");
  overlay.classList.toggle("open");
}
function closeMobileSidebar() {
  const aside = document.querySelector("aside");
  const overlay = byId("mobileSidebarOverlay");
  if (!aside || !overlay) return;
  aside.classList.remove("mobile-open");
  overlay.classList.remove("open");
}
// close mobile sidebar when nav link is clicked
document.addEventListener("click", (e) => {
  if (window.innerWidth <= 768 && e.target.closest(".nav-link")) {
    closeMobileSidebar();
  }
});

// ===================== #19 Spotlight / Command palette =====================
let _spotlightIdx = -1;

function openSpotlight() {
  if (!meta?.session) return showLoginOverlay(true);
  const overlay = byId("spotlightOverlay");
  if (!overlay) return;
  overlay.classList.add("open");
  const input = byId("spotlightInput");
  if (input) { input.value = ""; input.focus(); }
  _spotlightIdx = -1;
  runSpotlight();
}
function closeSpotlight() {
  byId("spotlightOverlay")?.classList.remove("open");
  _spotlightIdx = -1;
}
function closeSpotlightIfOutside(e) {
  if (e.target === byId("spotlightOverlay")) closeSpotlight();
}

function runSpotlight() {
  const q = (byId("spotlightInput")?.value || "").trim().toLowerCase();
  const el = byId("spotlightResults");
  if (!el) return;
  _spotlightIdx = -1;

  const sections = [
    { id: "dash",      label: t("nav_dash"),      icon: "fa-gauge" },
    { id: "cust",      label: t("nav_cust"),      icon: "fa-users" },
    { id: "supp",      label: t("nav_supp"),      icon: "fa-truck" },
    { id: "prod",      label: t("nav_prod"),      icon: "fa-box-open" },
    { id: "purch",     label: t("nav_purch"),     icon: "fa-cart-flatbed" },
    { id: "stock",     label: t("nav_stock"),     icon: "fa-warehouse" },
    { id: "sales",     label: t("nav_sales"),     icon: "fa-cash-register" },
    { id: "staff",     label: t("nav_staff"),     icon: "fa-id-badge" },
    { id: "debts",     label: t("nav_debts"),     icon: "fa-file-invoice-dollar" },
    { id: "creditor",  label: t("nav_creditor"),  icon: "fa-hand-holding-dollar" },
    { id: "cash",      label: t("nav_cash"),      icon: "fa-coins" },
    { id: "reports",   label: t("nav_reports"),   icon: "fa-chart-bar" },
    { id: "audit",     label: t("nav_audit"),     icon: "fa-shield-halved" },
  ];

  const groups = [];

  // Quick section navigation
  const secMatches = !q ? sections.slice(0, 5) : sections.filter((s) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  if (secMatches.length) {
    groups.push({
      label: t("sections"),
      items: secMatches.slice(0, 6).map((s) => ({
        icon: s.icon, name: s.label, sub: "", tag: t("section"),
        action: () => { closeSpotlight(); showSec(s.id, null); }
      }))
    });
  }

  if (q.length >= 2) {
    // Customers
    const custs = (db.cust || []).filter((c) => `${c.sur} ${c.name} ${c.phone || ""} ${c.uid}`.toLowerCase().includes(q)).slice(0, 5);
    if (custs.length) groups.push({
      label: t("nav_cust"),
      items: custs.map((c, i) => ({
        icon: "fa-user", name: `${c.sur} ${c.name}`, sub: c.phone || "",  tag: t("customer"),
        action: () => { closeSpotlight(); showSec("cust", null); }
      }))
    });

    // Products
    const prods = (db.prod || []).filter((p) => `${p.name} ${p.code || ""} ${p.uid}`.toLowerCase().includes(q)).slice(0, 5);
    if (prods.length) groups.push({
      label: t("nav_prod"),
      items: prods.map((p) => ({
        icon: "fa-box-open", name: p.name, sub: `${t("code")}: ${p.code || "-"} • ${money(p.price)} AZN`, tag: t("product"),
        action: () => { closeSpotlight(); showSec("prod", null); }
      }))
    });

    // Sales invoices
    const sales = (db.sales || []).filter((s) => `${s.invNo || ""} ${s.customerName || ""} ${s.uid}`.toLowerCase().includes(q)).slice(0, 4);
    if (sales.length) groups.push({
      label: t("nav_sales"),
      items: sales.map((s, i) => {
        const idx = db.sales.indexOf(s);
        return {
          icon: "fa-receipt", name: `#${s.invNo || s.uid} — ${s.customerName || ""}`,
          sub: `${money(s.amount)} AZN • ${fmtDT(s.date)}`, tag: t("sale"),
          action: () => { closeSpotlight(); showSec("sales", null); setTimeout(() => openSaleInfo && openSaleInfo(idx >= 0 ? idx : 0), 150); }
        };
      })
    });

    // Suppliers
    const supps = (db.supp || []).filter((s) => `${s.co} ${s.contact || ""}`.toLowerCase().includes(q)).slice(0, 4);
    if (supps.length) groups.push({
      label: t("nav_supp"),
      items: supps.map((s) => ({
        icon: "fa-truck", name: s.co, sub: s.contact || "", tag: t("supplier"),
        action: () => { closeSpotlight(); showSec("supp", null); }
      }))
    });
  }

  if (!groups.length) {
    el.innerHTML = `<div class="spotlight-empty"><i class="fas fa-magnifying-glass" style="font-size:1.4rem;margin-bottom:8px;display:block;"></i>${q ? t("no_results") : t("spotlight_hint")}</div>`;
    return;
  }

  el.innerHTML = groups.map((g) => `
    <div class="spotlight-group">
      <div class="spotlight-group-label">${escapeHtml(g.label)}</div>
      ${g.items.map((it, i) => `
        <div class="spotlight-item" data-action-idx="${_buildSpotlightActions(it.action)}" onclick="spotlightRunIdx(this)">
          <i class="fas ${it.icon}"></i>
          <div class="spotlight-item-main">
            <div class="spotlight-item-name">${escapeHtml(it.name)}</div>
            ${it.sub ? `<div class="spotlight-item-sub">${escapeHtml(it.sub)}</div>` : ""}
          </div>
          <span class="spotlight-item-tag">${escapeHtml(it.tag)}</span>
        </div>`).join("")}
    </div>`).join("");
}

const _spotlightActionStore = [];
function _buildSpotlightActions(fn) {
  _spotlightActionStore.push(fn);
  return _spotlightActionStore.length - 1;
}
function spotlightRunIdx(el) {
  const idx = Number(el.getAttribute("data-action-idx"));
  if (_spotlightActionStore[idx]) _spotlightActionStore[idx]();
}
function spotlightMove(dir) {
  const items = byId("spotlightResults")?.querySelectorAll(".spotlight-item") || [];
  if (!items.length) return;
  items[_spotlightIdx]?.classList.remove("active");
  _spotlightIdx = Math.max(0, Math.min(items.length - 1, _spotlightIdx + dir));
  items[_spotlightIdx]?.classList.add("active");
  items[_spotlightIdx]?.scrollIntoView({ block: "nearest" });
}
function spotlightConfirm() {
  const items = byId("spotlightResults")?.querySelectorAll(".spotlight-item") || [];
  if (_spotlightIdx >= 0 && items[_spotlightIdx]) spotlightRunIdx(items[_spotlightIdx]);
}

// ===================== #20 Çoxdilli dəstək =====================
const LANGS = {
  az: {
    notifications: "Bildirişlər", no_notifications: "Bildiriş yoxdur", close: "Bağla",
    sections: "Bölmələr", section: "Bölmə", customer: "Müştəri", product: "Məhsul",
    sale: "Satış", supplier: "Təchizatçı", no_results: "Nəticə tapılmadı",
    spotlight_hint: "Axtar: müştəri, məhsul, qaimə, bölmə...", code: "Kod",
    nav_dash: "Xülasə", nav_cust: "Müştərilər", nav_supp: "Təchizatçılar",
    nav_prod: "Məhsullar", nav_purch: "Alışlar", nav_stock: "Anbar",
    nav_sales: "Satışlar", nav_staff: "Əməkdaşlar", nav_debts: "Debitor borclar",
    nav_creditor: "Kreditor borclar", nav_cash: "Kassa", nav_reports: "Hesabatlar",
    nav_audit: "Audit log",
  },
  ru: {
    notifications: "Уведомления", no_notifications: "Нет уведомлений", close: "Закрыть",
    sections: "Разделы", section: "Раздел", customer: "Клиент", product: "Товар",
    sale: "Продажа", supplier: "Поставщик", no_results: "Не найдено",
    spotlight_hint: "Поиск: клиент, товар, накладная, раздел...", code: "Код",
    nav_dash: "Главная", nav_cust: "Клиенты", nav_supp: "Поставщики",
    nav_prod: "Товары", nav_purch: "Закупки", nav_stock: "Склад",
    nav_sales: "Продажи", nav_staff: "Сотрудники", nav_debts: "Дебиторы",
    nav_creditor: "Кредиторы", nav_cash: "Касса", nav_reports: "Отчёты",
    nav_audit: "Журнал аудита",
  },
  en: {
    notifications: "Notifications", no_notifications: "No notifications", close: "Close",
    sections: "Sections", section: "Section", customer: "Customer", product: "Product",
    sale: "Sale", supplier: "Supplier", no_results: "No results found",
    spotlight_hint: "Search: customer, product, invoice, section...", code: "Code",
    nav_dash: "Dashboard", nav_cust: "Customers", nav_supp: "Suppliers",
    nav_prod: "Products", nav_purch: "Purchases", nav_stock: "Warehouse",
    nav_sales: "Sales", nav_staff: "Staff", nav_debts: "Receivables",
    nav_creditor: "Payables", nav_cash: "Cash", nav_reports: "Reports",
    nav_audit: "Audit log",
  },
};

let _currentLang = localStorage.getItem("erp_lang") || "az";
function t(key) {
  return (LANGS[_currentLang] || LANGS.az)[key] || (LANGS.az[key] || key);
}
function setLang(lang) {
  if (!LANGS[lang]) return;
  _currentLang = lang;
  localStorage.setItem("erp_lang", lang);
  document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-lang") === lang));
  applyLangToNav();
  toast(`${lang.toUpperCase()} dili seçildi`);
}
function applyLangToNav() {
  const map = {
    "showSec('dash'":   t("nav_dash"),
    "showSec('cust'":   t("nav_cust"),
    "showSec('supp'":   t("nav_supp"),
    "showSec('prod'":   t("nav_prod"),
    "showSec('purch'":  t("nav_purch"),
    "showSec('stock'":  t("nav_stock"),
    "showSec('sales'":  t("nav_sales"),
    "showSec('staff'":  t("nav_staff"),
    "showSec('debts'":  t("nav_debts"),
    "showSec('overdue'":t("nav_debts") + " (vaxtı keçmiş)",
    "showSec('creditor'":t("nav_creditor"),
    "showSec('cash'":   t("nav_cash"),
    "showSec('reports'":t("nav_reports"),
    "showSec('audit'":  t("nav_audit"),
  };
  document.querySelectorAll(".nav-link[onclick]").forEach((el) => {
    const oc = el.getAttribute("onclick") || "";
    for (const [key, label] of Object.entries(map)) {
      if (oc.includes(key)) {
        const icon = el.querySelector("i");
        if (icon) {
          el.childNodes.forEach((n) => { if (n.nodeType === 3) n.textContent = " " + label; });
        }
        break;
      }
    }
  });
  // Update content-header h1 for active section
  const activeH1 = document.querySelector(".section.active .content-header h1");
  if (activeH1) {
    const activeId = document.querySelector(".section.active")?.id;
    const secKey = `nav_${activeId}`;
    if (t(secKey) !== secKey) activeH1.textContent = t(secKey);
  }
}
function initLang() {
  const saved = localStorage.getItem("erp_lang") || "az";
  _currentLang = saved;
  document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-lang") === saved));
}

