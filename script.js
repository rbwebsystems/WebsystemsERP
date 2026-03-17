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
  closeMdl();
}

function delAccount(idx) {
  if (!userCanDelete()) return alert("Sil icazəsi yoxdur.");
  ensureAccounts();
  const a = db.accounts[idx];
  if (!a) return;
  if (a.uid === 1) return alert("Əsas Kassa silinə bilməz.");
  const used = db.cash.some((c) => Number(c.accountId) === Number(a.uid));
  if (used) return alert("Bu hesabda əməliyyat var, silmək olmaz.");
  if (!confirm("Hesab silinsin?")) return;
  db.accounts.splice(idx, 1);
  saveDB();
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
  return cid === "test";
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

function userCanEdit() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canEdit;
}

function userCanDelete() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canDelete;
}

function userCanPay() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canPay;
}

function userCanRefund() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canRefund;
}

function userCanExport() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canExport;
}

function userCanImport() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
  return !!u.perms?.canImport;
}

function userCanReset() {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (u.role === "developer" || u.role === "admin") return true;
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
    if (el.id === "devMenu") el.style.display = dev ? (el.style.display || "none") : "none";
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
  menu.style.display = open ? "none" : "block";
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
    debts: "Debitor borclar",
    overdue: "Vaxtı keçmiş kreditlər",
    creditor: "Kreditor borclar",
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
  if (!ov) return;
  ov.style.display = show ? "flex" : "none";
  document.body.classList.toggle("login-open", !!show);
  if (show) {
    const sel = byId("loginCompany");
    if (sel) {
      sel.innerHTML = meta.companies.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.id)})</option>`).join("");
      const fromUrl = window.__loginCompanyFromUrl;
      if (fromUrl && meta.companies.some((c) => c.id === fromUrl)) sel.value = fromUrl;
    }
    byId("loginHint").innerText = window.__loginCompanyFromUrl ? "Link ünvanı ilə giriş." : "Keçid ünvanında ?company=ŞİRKƏT_ID olmalıdır.";
    setTimeout(() => byId("loginUser")?.focus(), 0);
  }
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
  const u = meta.users.find((x) => x.username === username);
  if (!u || !u.active) return alert("İstifadəçi tapılmadı (və ya deaktivdir).");
  if (u.pass !== pass) return alert("Şifrə yanlışdır.");
  window.__pendingLogin = { u, pass };
  if (u.role === "developer") {
    const list = (meta.companies || [])
      .map((c) => `<button type="button" class="btn-main" style="width:100%;margin-bottom:8px;text-align:left;padding:12px 16px;" onclick="closeMdl();window.__developerCompanyCallback('${escapeAttr(c.id)}');">${escapeHtml(c.name)} <small class="muted">(${escapeHtml(c.id)})</small></button>`)
      .join("");
    const html = `<div class="modal-body"><h3 style="margin-bottom:16px;">Şirkət seçin</h3><div style="display:flex;flex-direction:column;max-height:60vh;overflow-y:auto;">${list || "<p class=\"muted\">Şirkət yoxdur.</p>"}</div></div>`;
    window.__developerCompanyCallback = (companyId) => {
      doLoginWithCompany(companyId);
    };
    openModal(html);
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
  let timePart = timePartRaw || "00:00";
  timePart = timePart.slice(0, 5);
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

const SKINS = [
  { id: "teal", name: "Teal (default)", accent: "#0D9488", accentHover: "#0b7a6f", accentLight: "#ccfbf1", sidebarLight: "#0D9488", sidebarDark: "#111827" },
  { id: "blue", name: "Ocean Blue", accent: "#2563eb", accentHover: "#1d4ed8", accentLight: "#dbeafe", sidebarLight: "#1e40af", sidebarDark: "#0b1220" },
  { id: "violet", name: "Violet", accent: "#7c3aed", accentHover: "#6d28d9", accentLight: "#ede9fe", sidebarLight: "#5b21b6", sidebarDark: "#14102a" },
  { id: "slate", name: "Slate", accent: "#0f172a", accentHover: "#111827", accentLight: "#e2e8f0", sidebarLight: "#0f172a", sidebarDark: "#0b1220" },
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
  if (titleEl) titleEl.textContent = getCurrentCompanyName();
  updateHeaderDateTime();
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
    // trigger enter animation every time
    sec.classList.remove("anim-enter");
    void sec.offsetWidth; // reflow
    sec.classList.add("anim-enter");
    setTimeout(() => sec.classList.remove("anim-enter"), 500);
  }
  if (el) el.classList.add("active");
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
function openModal(html) {
  document.getElementById("modalContent").innerHTML = html;
  modal.style.display = "flex";
}
function closeMdl() {
  modal.style.display = "none";
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
    .filter((s) => String(s.bulkPurchUid || "") === String(purchUid))
    .reduce((a, b) => a + Math.max(0, n(b.qty || 0)), 0);
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
  const [y, m, d] = (dateISO || "").split("-").map(Number);
  if (!y || !m || !d) return dateISO || "";
  const dt = new Date(y, m - 1 + addMonths, d);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildCreditSchedule(sale) {
  const term = Number(sale.credit?.termMonths) || 0;
  const total = n(sale.amount);
  const down = n(sale.credit?.downPayment);
  const remAfterDown = Math.max(0, total - down);
  const monthly = term > 0 ? remAfterDown / term : 0;

  // payments after down:
  const paid = n(sale.paidTotal);
  const paidAfterDown = Math.max(0, paid - down);
  let paidLeft = paidAfterDown;
  const rows = [];
  for (let i = 1; i <= term; i++) {
    const due = addMonthsISO(sale.date, i);
    const amt = monthly;
    const paidThis = Math.min(amt, paidLeft);
    paidLeft -= paidThis;
    const st = debtStatus(amt, Math.max(0, amt - paidThis));
    rows.push({ idx: i, due, amount: amt, paid: paidThis, remaining: Math.max(0, amt - paidThis), status: st });
  }
  return { term, down, remAfterDown, monthly, rows };
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
  const data = {
    uid: idx !== null ? db.supp[idx].uid : genId(db.supp, 1000),
    createdAt: idx !== null ? (db.supp[idx].createdAt || db.supp[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    co: val("f_co"),
    per: val("f_per"),
    mob: val("f_mob"),
    voen: val("f_voen"),
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
  const invVal = idx !== null ? (p.invNo || invFallback("purch", p.uid)) : nextInvNo("purch");
  const existingInvs = Array.from(new Set((db.purch || []).map((x) => String(x.invNo || "").trim()).filter(Boolean))).slice(0, 2000);
  const invOptions =
    `<option value="">— Mövcud qaimə seç (istəyə bağlı) —</option>` +
    existingInvs
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((x) => `<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`)
      .join("");

  const isBulk = purchIsBulk(p);
  const prefUnit = isBulk ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1)))) : n(p.amount);
  openModal(`
    <h2>${idx !== null ? "Alış Redaktə" : "Yeni Alış"}</h2>
    <form onsubmit="savePurch(event, ${idx})">
      <div class="grid-3">
        <div class="span-3">
          <div class="grid-3">
            <input id="f_p_inv" class="span-2" value="${escapeAttr(invVal)}" placeholder="Qaimə № (məs: AL-001)" ${idx !== null ? "readonly" : ""} required>
            <select id="f_p_inv_pick" onchange="byId('f_p_inv').value=this.value||byId('f_p_inv').value;" title="Mövcud qaiməni seçib eyni qaiməyə yeni məhsul əlavə edin">
              ${invOptions}
            </select>
          </div>
        </div>
        <input type="datetime-local" id="f_p_date" value="${escapeAttr(p.date)}" required>
        <select id="f_p_supp" class="span-2" required>
          <option value="">Təchizatçı seç</option>
          ${suppOptions}
        </select>
        <select id="f_p_staff" class="span-3">${staffOptions}</select>

        <select id="f_p_prod" class="span-3" required>
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

        <input type="number" step="0.01" id="f_p_amount" value="${escapeAttr(isBulk ? String(prefUnit) : String(p.amount))}" placeholder="${isBulk ? "1 ədəd qiymət (AZN)" : "Məbləğ (AZN)"}" class="span-2" required>
        <select id="f_p_payType">
          <option value="nagd" ${p.payType === "nagd" ? "selected" : ""}>nagd</option>
          <option value="kocurme" ${p.payType === "kocurme" ? "selected" : ""}>kocurme</option>
          <option value="kredit" ${p.payType === "kredit" ? "selected" : ""}>kredit</option>
        </select>
        <input type="number" step="0.01" id="f_p_paid" value="${escapeAttr(p.paidTotal || "0")}" placeholder="Ödənilən (AZN)">
        <select id="f_p_pay_acc" class="span-3">${payAccOptions}</select>
        <div id="pTotalHint" class="span-3 muted small" style="display:${isBulk ? "" : "none"}">Cəmi: —</div>
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
}

function savePurch(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isNew = idx === null;
  const prevPaid = idx !== null ? n(db.purch[idx]?.paidTotal) : 0;
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
    return confirm(msg);
  };

  if (!isBulk) {
    const imei1 = val("f_p_i1").trim();
    const imei2 = val("f_p_i2").trim();
    const seria = val("f_p_ser").trim();
    const findMatch = (pred) => (db.purch || []).find((p, pi) => !(idx !== null && pi === idx) && pred(p));
    const m1 = imei1 ? findMatch((p) => String(p.imei1 || "").trim() === imei1) : null;
    if (m1 && !warnExisting(m1, "IMEI 1", imei1)) return;
    const m2 = !m1 && imei2 ? findMatch((p) => String(p.imei2 || "").trim() === imei2) : null;
    if (m2 && !warnExisting(m2, "IMEI 2", imei2)) return;
    const m3 = !m1 && !m2 && seria ? findMatch((p) => String(p.seria || "").trim() === seria) : null;
    if (m3 && !warnExisting(m3, "Seriya", seria)) return;
  } else {
    const codeNorm = String(code || "").trim();
    if (codeNorm) {
      const m = (db.purch || []).find((p, pi) => !(idx !== null && pi === idx) && String(p.code || "").trim() === codeNorm);
      if (m && !warnExisting(m, "Kod", codeNorm)) return;
    }
  }
  const employeeId = (val("f_p_staff") || "").trim() || undefined;
  const invNoVal = (val("f_p_inv") || "").trim();
  const unitPrice = isBulk ? Math.max(0, n(val("f_p_amount"))) : null;
  const totalAmount = isBulk ? unitPrice * qty : Math.max(0, n(val("f_p_amount")));
  const data = {
    uid: idx !== null ? db.purch[idx].uid : genId(db.purch, 1),
    invNo: idx !== null ? (db.purch[idx].invNo || invFallback("purch", db.purch[idx].uid)) : (invNoVal || nextInvNo("purch")),
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
  const isBulk = String(sel).startsWith("bulk:");
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
      <button class="btn-cancel" type="button" onclick="openSupplierPaymentHistory(${idx})">Ödəniş tarixçəsi</button>
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
  const data = {
    uid: idx !== null ? db.staff[idx].uid : genId(db.staff, 1),
    createdAt: idx !== null ? (db.staff[idx].createdAt || db.staff[idx].date || nowISODateTimeLocal()) : nowISODateTimeLocal(),
    name: val("f_st_name"),
    role: val("f_st_role"),
    phone: val("f_st_phone"),
    baseSalary: String(Math.max(0, n(val("f_st_salary")))),
    commPct: String(Math.max(0, n(val("f_st_comm")))),
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
        if (x.type === "serial" && current.itemKey === x.key) return true;
      }
      return x.rem > 0;
    });

  const custOptions =
    `<option value="">Müştəri seç</option>` +
    db.cust.map((c) => `<option value="${c.uid}">${escapeHtml(c.sur)} ${escapeHtml(c.name)} (${c.uid})</option>`).join("");
  const staffOptions =
    `<option value="">Əməkdaş seç</option>` +
    db.staff.map((s) => `<option value="${s.uid}">${escapeHtml(s.name)}${s.role ? " - " + escapeHtml(s.role) : ""}</option>`).join("");

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

        <select id="f_s_item" class="span-3" ${stockItems.length ? "" : "disabled"} onchange="toggleSaleQty()" required>${itemOptions}</select>

        <div id="saleQtyBox" class="grid-3 span-3" style="display:none;">
          <input type="number" step="1" min="1" id="f_s_qty" class="span-3" placeholder="Say">
        </div>

        <input type="number" step="0.01" id="f_s_amount" class="span-2" placeholder="Ümumi məbləğ (AZN)" required oninput="recalcCredit()">
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
        </div>
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
    if (current.bulkPurchUid) {
      const q = Math.max(1, Math.floor(n(current.qty || 1)));
      const unit = current.unitPrice != null && current.unitPrice !== "" ? n(current.unitPrice) : (n(current.amount) / q);
      byId("f_s_amount").value = String(unit);
    } else {
      byId("f_s_amount").value = String(current.amount || "");
    }

    if (current.bulkPurchUid) {
      byId("f_s_item").value = `bulk:${current.bulkPurchUid}`;
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

function togglePayNow(noRender) {
  const box = byId("payNowBox");
  const chk = byId("f_pay_now");
  if (!box || !chk) return;
  box.style.display = chk.checked ? "" : "none";
  if (!chk.checked) {
    byId("f_s_paid").value = "0";
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

function saveSale(e, idx) {
  e.preventDefault();
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  const isEdit = idx !== null;
  const isNew = !isEdit;

  const customerId = val("f_s_customer");
  const employeeId = val("f_s_staff");
  const sel = val("f_s_item");
  const [kind, purchUid] = String(sel || "").split(":");
  const purch = db.purch.find((p) => String(p.uid) === String(purchUid));
  if (!customerId || !employeeId || !purch) return;

  const key = itemKeyFromPurch(purch);
  const sold = soldKeySet();
  let qty = 1;
  let bulkPurchUid = null;
  if (kind === "bulk") {
    bulkPurchUid = purch.uid;
    qty = Math.max(1, Math.floor(n(val("f_s_qty"))));
    let avail = purchRemainingQty(purch);
    if (isEdit && db.sales[idx] && String(db.sales[idx].bulkPurchUid || "") === String(bulkPurchUid)) {
      avail += Math.max(0, Math.floor(n(db.sales[idx].qty || 0)));
    }
    if (qty > avail) return alert("Anbarda kifayət qədər say yoxdur.");
  } else {
    if (!isEdit && sold.has(key)) return alert("Bu mal artıq satılıb.");
    if (isEdit && db.sales[idx] && db.sales[idx].itemKey !== key && sold.has(key)) return alert("Bu mal artıq satılıb.");
  }

  const saleType = val("f_s_type");
  const unitOrTotal = Math.max(0, n(val("f_s_amount")));
  const amount = kind === "bulk" ? (unitOrTotal * qty) : unitOrTotal;
  const payNow = !!byId("f_pay_now")?.checked;
  const payAccountId = payNow ? Number(val("f_pay_acc") || 1) : null;
  let paid = payNow ? Math.max(0, n(val("f_s_paid"))) : 0;
  if (paid > amount) paid = amount;

  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  const staff = db.staff.find((s) => String(s.uid) === String(employeeId));
  if (!cust || !staff) return;

  // credit limit check (only for kredit)
  if (val("f_s_type") === "kredit") {
    const lim = Math.max(0, n(cust.creditLimit || 0));
    if (lim > 0.000001) {
      const existing = db.sales
        .filter((s) => String(s.customerId) === String(cust.uid))
        .filter((s) => String(s.saleType) === "kredit")
        .filter((s) => !s.returnedAt)
        .reduce((a, s) => a + saleRemaining(s), 0);
      const qtyNow = kind === "bulk" ? Math.max(1, Math.floor(n(val("f_s_qty")))) : 1;
      const formTotal = kind === "bulk" ? (Math.max(0, n(val("f_s_amount"))) * qtyNow) : Math.max(0, n(val("f_s_amount")));
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
    productName: purch.name,
    code: purch.code || "",
    qty,
    bulkPurchUid,
    imei1: purch.imei1 || "",
    imei2: purch.imei2 || "",
    seria: purch.seria || "",
    amount: String(amount),
    unitPrice: kind === "bulk" ? String(unitOrTotal) : (isEdit ? db.sales[idx]?.unitPrice ?? "" : ""),
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
      addSalePaymentInternal(base, diff, base.date, "sales_form");
    }
  } else {
    // create initial payment if paid > 0
    if (paid > 0.000001) {
      addSalePaymentInternal(base, paid, base.date, "sales_form");
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
        note: purchIsBulk(purch)
          ? `${base.productName} (KOD:${base.code || "-"} • SAY:${base.qty})`
          : `${base.productName} (${base.imei1 || base.imei2 || base.seria || "-"})`,
        link: { kind: "sale_payment", saleUid: base.uid },
        meta: { customerId: base.customerId },
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

function addSalePaymentInternal(sale, amount, date, source) {
  const a = Math.max(0, n(amount));
  if (a <= 0) return;
  const rem = Math.max(0, n(sale.amount) - sumPayments(sale.payments));
  const applied = Math.min(rem, a);
  if (applied <= 0) return;

  sale.payments.push({
    uid: genId(sale.payments, 1),
    date: date || nowISODate(),
    amount: applied,
    source: source || "manual",
  });
  sale.paidTotal = String(sumPayments(sale.payments));
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
      <div class="info-row"><div class="info-label">Satış tarixi</div><div class="info-value">${escapeHtml(s.date)}</div></div>
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)} (${s.customerId})</div></div>
      <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${guarantor ? escapeHtml(`${guarantor.sur} ${guarantor.name} (${guarantor.uid})`) : "-"}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(s.productName)}</div></div>
      <div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(s.code || "-")}</div></div>
      <div class="info-row"><div class="info-label">Say</div><div class="info-value">${String(Math.max(1, Math.floor(n(s.qty || 1))))}</div></div>
      <div class="info-row"><div class="info-label">IMEI 1</div><div class="info-value">${escapeHtml(s.imei1 || "-")}</div></div>
      <div class="info-row"><div class="info-label">IMEI 2</div><div class="info-value">${escapeHtml(s.imei2 || "-")}</div></div>
      <div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(s.seria || "-")}</div></div>
      <div class="info-row"><div class="info-label">Satış növü</div><div class="info-value">${escapeHtml(String(s.saleType).toUpperCase())}</div></div>
      <div class="info-row"><div class="info-label">Əməkdaş</div><div class="info-value">${escapeHtml(s.employeeName || "-")}</div></div>
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
        <td>${escapeHtml(p.source || "")}</td>
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
        <input type="number" step="0.01" id="pay_amount" placeholder="Məbləğ (AZN)" class="span-2" required>
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
  const date = val("pay_date");
  const amount = Math.max(0, n(val("pay_amount")));
  const accId = Number(val("pay_acc") || 1);
  const payKind = val("pay_kind") || "regular";
  if (amount <= 0) return;

  addSalePaymentInternal(s, amount, date, payKind === "down" ? "down" : payKind === "monthly" ? "monthly" : "sale_info");

  // Cash operation: payment into cash only if this is cash payment (assume nagd) or user pays cash from cash module.
  // Here we treat it as cash-in (kassa) by default.
  addCashOp({
    type: "in",
    date,
    source: `Debitor ödəniş (${s.customerName})`,
    amount: Math.min(amount, amount), // recorded amount input (even if part applied is less, adjust below)
    note: val("pay_note") || `Satış #${s.uid}`,
    link: { kind: "sale", saleUid: s.uid },
    meta: { customerId: s.customerId, payKind },
    accountId: accId,
  }, { clampToApplied: true, applied: Math.min(amount, amountAppliedToSaleLast(s)) });
  logEvent("create", "cash", { type: "in", kind: "sale", amount: Math.min(amount, amountAppliedToSaleLast(s)), saleUid: s.uid });

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

function saveEditCashOp(e, uid) {
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
    if (!confirm(msg)) return;
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
  if (!userCanDelete()) return alert("Sil icazəsi yoxdur.");
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  if (!confirm("Kassa əməliyyatı silinsin?")) return;
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
            <select id="cash_customer_invoice" class="span-3">
              <option value="">Qaimə seç (istəyə bağlı)</option>
            </select>
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
      return `<option value="${s.uid}">Qaimə #${escapeHtml(invNo)} • ${escapeHtml(s.date)} • Qalıq ${money(saleRemaining(s))}</option>`;
    })
    .join("");
  sel.innerHTML = `<option value="">Qaimə seç (istəyə bağlı)</option>` + inv;
}

function refreshSupplierInvoices() {
  const supp = byId("cash_supplier")?.value || "";
  const sel = byId("cash_supplier_invoice");
  if (!sel) return;
  const inv = db.purch
    .filter((p) => String(p.supp) === String(supp))
    .filter((p) => purchRemaining(p) > 0.000001)
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .map((p) => `<option value="${p.uid}">Qaimə #${p.uid} • ${escapeHtml(p.date)} • ${escapeHtml(p.name)} • Qalıq ${money(purchRemaining(p))}</option>`)
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
    addSalePaymentInternal(s, a, date, "cash_module_invoice");

    addCashOp({
      type: "in",
      date,
      source: `Müştəri ödənişi (${cust.sur} ${cust.name})`,
      amount: a,
      note: note || `Qaimə #${s.invNo || invFallback("sales", s.uid)}`,
      link: { kind: "debtor_payment", customerId },
      meta: { allocations: [{ saleUid: s.uid, amount: a }] },
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

  addCashOp({
    type: "in",
    date,
    source: `Müştəri ödənişi (${cust.sur} ${cust.name})`,
    amount: applied.applied,
    note: note || `Debitor ödəniş`,
    link: { kind: "debtor_payment", customerId },
    meta: { allocations: applied.allocations },
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
  if (!confirm("Şirkət silinsin? (məlumatlar LocalStorage-da qalacaq)")) return;
  meta.companies.splice(idx, 1);
  if (meta.companies.length === 0) meta.companies.push({ id: "bakfon", name: "Bakfon" });
  if (meta.session && !meta.companies.some((x) => x.id === meta.session.companyId)) {
    meta.session.companyId = meta.companies[0].id;
    if (useFirestore()) loadCompanyDBAsync().then((data) => { db = data; subscribeRealtime(); });
    else db = loadCompanyDB();
  }
  saveMeta();
  renderAll();
}

function resetCompanyData() {
  if (!userCanReset()) return alert("Reset icazəsi yoxdur.");
  const cid = meta?.session?.companyId;
  if (!cid) return;
  if (!confirm("Bu şirkətin bütün datası sıfırlansın?")) return;
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
    meta.users.push({ uid: genId(meta.users, 1), fullName, username, staffUid: staffUid || undefined, pass, role, active, companyId: cid || null, perms: { sections, canEdit, canDelete, canPay, canRefund, canExport, canImport, canReset }, createdAt: nowISODateTimeLocal() });
  } else {
    const idx = meta.users.findIndex((x) => String(x.uid) === String(uidVal));
    if (idx === -1) return;
    const keep = meta.users[idx];
    if (!isDeveloper() && cid && !userBelongsToCompany(keep, cid)) return alert("Bu istifadəçi başqa şirkətə aiddir.");
    meta.users[idx] = { ...keep, fullName, staffUid: staffUid || undefined, pass, role, active, companyId: keep.companyId || prefix || cid, perms: { sections, canEdit, canDelete, canPay, canRefund, canExport, canImport, canReset } };
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
  if (!confirm("İstifadəçi silinsin?")) return;
  meta.users.splice(idx, 1);
  saveMeta();
  renderAll();
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

    const purchStaffName = getStaffName(p.employeeId);
    const purchStatusText = p.returnedAt ? "QAYTARILIB" : "AKTİV";

    let saleHtml = "";
    if (purchIsBulk(p)) {
      const sales = (db.sales || []).filter((s) => !s.returnedAt && String(s.bulkPurchUid || "") === String(p.uid));
      saleHtml = sales.length
        ? sales.map((s) => {
            const saleStaffName = s.employeeName || getStaffName(s.employeeId);
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
      const saleStaffName = s ? (s.employeeName || getStaffName(s.employeeId)) : "-";
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
    const purchStaffName = p ? getStaffName(p.employeeId) : "-";
    const saleStaffName = s.employeeName || getStaffName(s.employeeId);
    const rem = saleRemaining(s);
    const st = debtStatus(n(s.amount), rem);

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

function exportCompany() {
  if (!userCanExport()) return alert("Export icazəsi yoxdur.");
  const cid = meta?.session?.companyId;
  if (!cid) return;
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
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
      db = { ...defaultDB(), ...parsed };
      saveDB();
      logEvent("import", "company", { companyId: meta?.session?.companyId || "-" });
      alert("Import olundu.");
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

function openOverdueInfo(customerId) {
  ensureAuditTrash();
  const cid = String(customerId || "");
  const custName = (db.sales || []).find((s) => String(s.customerId) === cid)?.customerName || cid;
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
  (db.sales || [])
    .filter((s) => !s.returnedAt && String(s.saleType || "").toLowerCase() === "kredit" && String(s.customerId) === cid)
    .forEach((s) => {
      const inv = s.invNo || invFallback("sales", s.uid);
      const sched = buildCreditSchedule(s);
      for (const r of sched.rows) {
        if (r.remaining <= 0.000001) continue;
        const dueT = toDayStart(r.due);
        if (dueT == null || todayT == null) continue;
        const daysLate = Math.floor((todayT - dueT) / dayMs);
        if (daysLate < 1) continue;
        items.push({ inv, due: r.due, monthly: r.amount, remaining: r.remaining, daysLate, saleUid: s.uid });
      }
    });

  items.sort((a, b) => (b.daysLate - a.daysLate) || String(a.due).localeCompare(String(b.due)));
  const rowsHtml = items
    .map(
      (x, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(x.inv)}</td>
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

  openModal(`
    <h2>Gecikmə detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custName)}</div></div>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Gecikən aylıqlar</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Ödəniş günü</th><th>Aylıq</th><th>Qalıq</th><th>Gecikmə (gün)</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="6">Gecikən aylıq yoxdur.</td></tr>`}</tbody>
      </table>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Qeyd əlavə et</h3>
    <form onsubmit="saveOverdueNote(event, '${escapeAttr(cid)}')">
      <div class="grid-3">
        <input id="ov_note" class="span-3" placeholder="Qeyd..." required>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Qeydlər</h3>
    ${notesHtml || `<p class="muted">Qeyd yoxdur.</p>`}
  `);
}

function saveOverdueNote(e, customerId) {
  e.preventDefault();
  ensureAuditTrash();
  const cid = String(customerId || "");
  const text = (byId("ov_note")?.value || "").trim();
  if (!text) return;
  const u = currentUser();
  db.overdueNotes.push({ uid: genId(db.overdueNotes, 1), customerId: cid, text, ts: nowISODateTimeLocal(), user: u ? u.username : "-" });
  logEvent("create", "overdue_note", { customerId: cid });
  saveDB();
  openOverdueInfo(cid);
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
        <thead><tr><th>#</th><th>Qaimə</th><th>Qaytarma tarixi</th><th>Müştəri</th><th>Ödənən</th><th>Refund</th><th>Kassada qalan</th></tr></thead>
        <tbody>
          ${body || `<tr><td colspan="7">Qaytarma avansı yoxdur.</td></tr>`}
          ${body ? `<tr class="total-row"><td colspan="6"><strong>Cəmi</strong></td><td><strong>${money(totalLeft)} AZN</strong></td></tr>` : ""}
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
  if (!confirm("Audit təmizlənsin?")) return;
  db.audit = [];
  saveDB();
}

function emptyTrash() {
  if (!userCanReset()) return alert("İcazə yoxdur.");
  if (!confirm("Səbət tam boşaldılsın?")) return;
  db.trash = [];
  saveDB();
}

function restoreTrash(uid) {
  if (!userCanEdit()) return alert("İcazə yoxdur.");
  const i = db.trash.findIndex((t) => Number(t.uid) === Number(uid));
  if (i < 0) return;
  const t = db.trash[i];
  const it = t.item;
  if (t.type === "cust") db.cust.push(it);
  else if (t.type === "supp") db.supp.push(it);
  else if (t.type === "prod") db.prod.push(it);
  else if (t.type === "staff") db.staff.push(it);
  else if (t.type === "purch") db.purch.push(it);
  else if (t.type === "sales") db.sales.push(it);
  else if (t.type === "cash") db.cash.push(it);
  db.trash.splice(i, 1);
  logEvent("restore", "trash", { type: t.type });
  saveDB();
}

function deleteTrash(uid) {
  if (!userCanDelete()) return alert("Sil icazəsi yoxdur.");
  const i = db.trash.findIndex((t) => Number(t.uid) === Number(uid));
  if (i < 0) return;
  if (!confirm("Səbətdən tam silinsin?")) return;
  db.trash.splice(i, 1);
  logEvent("delete", "trash", { uid });
  saveDB();
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
      const canD = userCanDelete();
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
        ${userCanDelete() ? `<button class="icon-btn delete" onclick="delItem('supp', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
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
        ${userCanDelete() ? `<button class="icon-btn delete" onclick="delItem('prod', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // purchases (latest first) + date filter + pagination
  const purchStatus = byId("purchStatus")?.value || "active";
  const purchListAll = db.purch
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => (purchStatus === "all" ? true : purchStatus === "returned" ? !!p.returnedAt : !p.returnedAt))
    .filter(({ p }) => inDateRange(p.date, "purchFrom", "purchTo"))
    .sort((a, b) => String(a.p.date).localeCompare(String(b.p.date)) * -1);

  const purchPageSize = getPageSize("purchPageSize", 50);
  const purchList = paginate(purchListAll, "purch", purchPageSize, "purchPageInfo");

  byId("tblPurch").innerHTML = purchList
    .map(({ p, idx }, i) => {
      const rem = purchRemaining(p);
      const actions = `
        <button class="icon-btn info" onclick="openPurchInfo(${idx})" title="Məlumat"><i class="fas fa-circle-info"></i></button>
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openPurch(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete() ? `<button class="icon-btn delete" onclick="delItem('purch', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      `;
      const invNo = p.invNo || invFallback("purch", p.uid);
      const searchText = [
        p.uid,
        invNo,
        p.date,
        p.supp,
        p.name,
        p.code,
        p.qty,
        p.imei1,
        p.imei2,
        p.seria,
        p.amount,
        p.paidTotal,
        p.payType,
      ]
        .filter((x) => x != null && String(x).trim() !== "")
        .join(" ");
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(invNo)}</td>
        <td>${fmtDT(p.date)}</td>
        <td>${escapeHtml(p.supp)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${purchIsBulk(p) ? String(Math.max(1, Math.floor(n(p.qty || 1)))) : ""}</td>
        <td>${money(p.amount)} AZN</td>
        <td>${money(p.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions">${actions}<span style="display:none">${escapeHtml(searchText)}</span></td>
      </tr>`;
    })
    .join("");

  // stock (do NOT depend on purch date/status filters; show all inventory)
  const stockListAll = (db.purch || [])
    .slice(0, 5000) /* safety */
    .map((p) => ({ p }));

  byId("tblStock").innerHTML = stockListAll
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
        s.employeeName,
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
        <td>${escapeHtml(s.employeeName || "")}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions">
          <button class="icon-btn info" onclick="openSaleInfo(${idx})" title="Info"><i class="fas fa-circle-info"></i></button>
          ${userCanEdit() ? `<button class="icon-btn edit" onclick="openSale(${idx})" title="Edit"><i class="fas fa-pen"></i></button>` : ""}
          ${userCanDelete() ? `<button class="icon-btn delete" onclick="delItem('sales', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
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
        ${userCanDelete() ? `<button class="icon-btn delete" onclick="delItem('staff', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // debts (debitor) grouped by customer + date filter + pagination
  const debtsStatus = byId("debtsStatus")?.value || "all";
  const debtsAll = db.sales
    .filter((s) => inDateRange(s.date, "debtsFrom", "debtsTo"))
    .map((s, saleIdx) => {
      const total = n(s.amount);
      const rem = saleRemaining(s);
      const st = debtStatus(total, rem);
      return { s, saleIdx, total, rem, st };
    });

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

  const groupsFiltered = groups.filter((g) => (debtsStatus === "all" ? true : g.st === debtsStatus));
  groupsFiltered.sort((a, b) => (a.rem < b.rem ? 1 : -1));

  window.__debtorGroups = groupsFiltered;
  const debtsPageSize = getPageSize("debtsPageSize", 50);
  const groupsPage = paginate(groupsFiltered, "debts", debtsPageSize, "debtsPageInfo");

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
    .join("");
  filterDebts();
  const creditQ = byId("srcCreditOnly")?.value || "";
  if (creditQ) filterCreditOnly();

  // overdue credits (monthly installments)
  const overdueBody = byId("tblOverdue");
  if (overdueBody) {
    const view = byId("overdueView")?.value || "overdue";
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
          const isOverdue = daysLate >= 1;
          const isToday = daysLate === 0;
          if (view === "overdue" && !isOverdue) continue;
          if (view === "today" && !isToday) continue;
          const inv = s.invNo || invFallback("sales", s.uid);
          const cid = String(s.customerId || "");
          if (!byCust.has(cid)) {
            byCust.set(cid, { customerId: cid, customer: s.customerName || "-", maxLate: 0, dueCount: 0, dueTotal: 0, nextDue: null, nextDueT: null });
          }
          const g = byCust.get(cid);
          g.maxLate = Math.max(g.maxLate, Math.max(0, daysLate));
          g.dueCount += 1;
          g.dueTotal += Math.max(0, n(r.remaining));
          if (g.nextDueT == null || dueT < g.nextDueT) {
            g.nextDueT = dueT;
            g.nextDue = r.due;
          }
          // keep a few sample invoices for display
          if (!g.invs) g.invs = [];
          if (g.invs.length < 3 && !g.invs.includes(inv)) g.invs.push(inv);
        }
      });

    const rows = Array.from(byCust.values());
    rows.sort((a, b) => (b.maxLate - a.maxLate) || (b.dueTotal - a.dueTotal));
    overdueBody.innerHTML =
      rows
        .map((x, i) => {
          const invText = (x.invs || []).join(", ");
          return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(x.customer)}</td>
            <td>${escapeHtml(invText || "-")}</td>
            <td>${escapeHtml(x.nextDue || "-")}</td>
            <td>${x.dueCount}</td>
            <td>${money(x.dueTotal)} AZN</td>
            <td>${x.maxLate}</td>
            <td class="tbl-actions">
              <button class="btn-mini" type="button" onclick="openOverdueInfo('${escapeAttr(x.customerId)}')"><i class="fas fa-circle-info"></i> Info</button>
            </td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="8">Məlumat yoxdur</td></tr>`;
  }

  // creditor (suppliers) + date filter + pagination
  const credStatus = byId("credStatus")?.value || "open";
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
    if (credStatus === "all") return true;
    if (credStatus === "open") return g.st !== "paid";
    return g.st === credStatus;
  });

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
    .join("");
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
      const payKind = c.meta?.payKind || "";
      const payBadge =
        c.link?.kind === "sale" && payKind
          ? `<small class="muted" style="margin-left:8px;">(${payKind === "down" ? "ilkin" : payKind === "monthly" ? "aylıq" : payKind})</small>`
          : "";
      const invInfo = (() => {
        const kind = c.link?.kind || "";
        if (kind === "sale" || kind === "sale_payment") {
          const s = db.sales.find((x) => Number(x.uid) === Number(c.link?.saleUid));
          if (!s) return "";
          const inv = s.invNo || invFallback("sales", s.uid);
          return `Qaimə: ${inv}`;
        }
        if (kind === "debtor_payment") {
          const allocs = c.meta?.allocations || [];
          const invs = Array.from(
            new Set(
              allocs
                .map((a) => {
                  const saleUid = a.saleUid ?? a.salesUid ?? null;
                  const s = saleUid ? db.sales.find((x) => Number(x.uid) === Number(saleUid)) : null;
                  return s ? (s.invNo || invFallback("sales", s.uid)) : null;
                })
                .filter(Boolean)
            )
          );
          return invs.length ? `Qaimə: ${invs.join(", ")}` : "";
        }
        if (kind === "creditor_invoice_payment") {
          const p = db.purch.find((x) => Number(x.uid) === Number(c.link?.purchUid));
          if (!p) return "";
          const inv = p.invNo || invFallback("purch", p.uid);
          return `Qaimə: ${inv}`;
        }
        if (kind === "creditor_payment") {
          const allocs = c.meta?.allocations || [];
          const invs = Array.from(
            new Set(
              allocs
                .map((a) => {
                  const p = db.purch.find((x) => Number(x.uid) === Number(a.purchUid));
                  return p ? (p.invNo || invFallback("purch", p.uid)) : null;
                })
                .filter(Boolean)
            )
          );
          return invs.length ? `Qaimə: ${invs.join(", ")}` : "";
        }
        return "";
      })();
      const noteHtml = invInfo
        ? `${escapeHtml(c.note || "")}<div class="muted" style="font-size:.85em;margin-top:2px;">${escapeHtml(invInfo)}</div>`
        : escapeHtml(c.note || "");
      return `
    <tr>
      <td>${i + 1}</td>
      <td>${c.type === "in" ? "Gəlir" : "Xərc"}</td>
      <td>${fmtDT(c.date)}</td>
      <td>${escapeHtml(c.source)}${payBadge}</td>
      <td class="${c.type === "in" ? "amt-in" : "amt-out"}">${c.type === "in" ? "+" : "-"}${money(c.amount)} AZN</td>
      <td>${noteHtml}</td>
      <td class="tbl-actions">
        ${userCanEdit() ? `<button class="icon-btn edit" onclick="openEditCashOp(${c.uid})" title="Redaktə"><i class="fas fa-pen"></i></button>` : ""}
        ${userCanDelete() ? `<button class="icon-btn delete" onclick="delCashOp(${c.uid})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
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
  byId("tblAccounts").innerHTML = db.accounts
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
          ${userCanDelete() ? `<button class="icon-btn delete" onclick="delAccount(${i})" title="Sil" ${delDisabled}><i class="fas fa-trash"></i></button>` : ""}
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
          <td>${escapeHtml(a.action || "-")}</td>
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
            ${userCanDelete() ? `<button class="icon-btn delete" onclick="deleteTrash(${t.uid})" title="Tam sil"><i class="fas fa-trash"></i></button>` : ""}
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
    byId("repSales").innerText = money(salesTotal);
    byId("repCogs").innerText = money(cogs);
    byId("repExp").innerText = money(exp);
    const repPayrollEl = byId("repPayroll");
    if (repPayrollEl) repPayrollEl.innerText = money(payrollTotalPeriod);
    byId("repPL").innerText = money(pl);

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
        body.innerHTML = rows || `<tr><td colspan="7">Məlumat yoxdur</td></tr>`;
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
            .join("") || `<tr><td colspan="6">Məlumat yoxdur</td></tr>`;
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
            .join("") || `<tr><td colspan="5">Məlumat yoxdur</td></tr>`;
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
            .join("") || `<tr><td colspan="9">Məlumat yoxdur</td></tr>`;
      } else {
        head.innerHTML = `<tr><th>Göstəriş</th><th>Dəyər</th></tr>`;
        body.innerHTML = `
          <tr><td>Satış</td><td>${money(salesTotal)} AZN</td></tr>
          <tr><td>Alış</td><td>${money(cogs)} AZN</td></tr>
          <tr><td>Xərc</td><td>${money(exp)} AZN</td></tr>
          <tr><td>Əməkhaqqı (bütün əməkdaşlar, ay üzrə)</td><td>${money(payrollTotalPeriod)} AZN</td></tr>
          <tr><td>Mənfəət/Zərər</td><td>${money(pl)} AZN</td></tr>
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
      payBody.innerHTML = rows || `<tr><td colspan="9">Məlumat yoxdur</td></tr>`;
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
  const salesChartEl = byId("dashChartSales");
  if (salesChartEl) {
    salesChartEl.innerHTML = last6
      .map(({ label }, i) => {
        const val = salesByMonth[i];
        const pct = maxSales ? (val / maxSales) * 100 : 0;
        return `<div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(label)}</span><div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%"></div><span class="dash-bar-value">${money(val)}</span></div></div>`;
      })
      .join("");
  }

  // Alış vs Satış (bu ay)
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const purchThisMonth = (db.purch || []).filter((p) => inMonth(p.date, currentMonthKey)).reduce((a, p) => a + n(p.amount), 0);
  const salesThisMonth = (db.sales || []).filter((s) => !s.returnedAt && inMonth(s.date, currentMonthKey)).reduce((a, s) => a + n(s.amount), 0);
  const maxPVS = Math.max(1, purchThisMonth, salesThisMonth);
  const pctPurch = (purchThisMonth / maxPVS) * 100;
  const pctSales = (salesThisMonth / maxPVS) * 100;
  const pvsEl = byId("dashChartPurchVsSales");
  if (pvsEl) {
    pvsEl.innerHTML = `
      <div class="dash-bar-row"><span class="dash-bar-label">Alış</span><div class="dash-bar-track"><div class="dash-bar-fill dash-bar-fill-purch" style="width:${pctPurch}%"></div><span class="dash-bar-value">${money(purchThisMonth)} AZN</span></div></div>
      <div class="dash-bar-row"><span class="dash-bar-label">Satış</span><div class="dash-bar-track"><div class="dash-bar-fill dash-bar-fill-sales" style="width:${pctSales}%"></div><span class="dash-bar-value">${money(salesThisMonth)} AZN</span></div></div>
    `;
  }

  // Son 6 ay alış (AZN)
  const purchByMonth = last6.map(({ key }) => (db.purch || []).filter((p) => inMonth(p.date, key)).reduce((a, p) => a + n(p.amount), 0));
  const maxPurch = Math.max(1, ...purchByMonth);
  const purchChartEl = byId("dashChartPurch");
  if (purchChartEl) {
    purchChartEl.innerHTML = last6
      .map(({ label }, i) => {
        const val = purchByMonth[i];
        const pct = maxPurch ? (val / maxPurch) * 100 : 0;
        return `<div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(label)}</span><div class="dash-bar-track"><div class="dash-bar-fill dash-bar-fill-purch" style="width:${pct}%"></div><span class="dash-bar-value">${money(val)}</span></div></div>`;
      })
      .join("");
  }

  // Debitor vs Kreditor borclar
  const maxDebt = Math.max(1, debtorSum, creditorSum);
  const pctDebt = (debtorSum / maxDebt) * 100;
  const pctCred = (creditorSum / maxDebt) * 100;
  const debtCredEl = byId("dashChartDebtVsCredit");
  if (debtCredEl) {
    debtCredEl.innerHTML = `
      <div class="dash-bar-row"><span class="dash-bar-label">Debitor</span><div class="dash-bar-track"><div class="dash-bar-fill dash-bar-fill-debt" style="width:${pctDebt}%"></div><span class="dash-bar-value">${money(debtorSum)} AZN</span></div></div>
      <div class="dash-bar-row"><span class="dash-bar-label">Kreditor</span><div class="dash-bar-track"><div class="dash-bar-fill dash-bar-fill-credit" style="width:${pctCred}%"></div><span class="dash-bar-value">${money(creditorSum)} AZN</span></div></div>
    `;
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
}

function delItem(type, i) {
  if (!confirm("Silinsin?")) return;
  if (!userCanDelete()) return alert("Sil icazəsi yoxdur.");
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
}

// Utilities
function byId(id) {
  return document.getElementById(id);
}
function val(id) {
  return (byId(id)?.value ?? "").toString();
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
  saveCashOp,
  openEditCashOp,
  saveEditCashOp,
  delCashOp,
  openCashReconcile,
  saveCashReconcile,
  openCashDiffAnalysis,
  openOverdueInfo,
  saveOverdueNote,
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
  openSettings,
  saveSettings,
  openSkins,
  setSkin,
  openAuditDetails,
  openGlobalSearch,
  runGlobalSearch,
  exportCompany,
  importCompany,
  exportCsvCurrent,
  recalcAll,
  openReturnedSalesCreditReport,
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

function initApp() {
  applyAccessUI();
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

