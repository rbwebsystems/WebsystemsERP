// Bakfon ERP - LocalStorage və ya Firestore (realtime)
document.title = "RBSoft ERP";

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
  founders: [],
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

// ── Premium Preloader ──────────────────────────────
const _pl = {
  _done: false,
  _bar(pct) {
    const b = byId("preloaderBar");
    if (b) b.style.width = pct + "%";
  },
  _text(t) {
    const el = byId("preloaderText");
    if (el) el.textContent = t;
  },
  step(name) {
    const map = { auth: [25,"Autentifikasiya"], meta: [55,"Konfiqurasiya"], data: [80,"Məlumatlar"], ready: [100,"Hazır"] };
    const [pct, label] = map[name] || [0,""];
    this._bar(pct);
    this._text(label);
  },
  hide() {
    if (this._done) return;
    this._done = true;
    this._bar(100);
    const el = byId("appPreloader");
    if (!el) return;
    setTimeout(() => el.classList.add("app-preloader--out"), 250);
  },
};

function setLoading(text) {
  const el = byId("loadingText");
  const ov = byId("loadingOverlay");
  if (el) el.textContent = text || "Yüklənir...";
  if (ov) ov.classList.toggle("hidden", !text);
}

let _softOpDepth = 0;
let _softOpTimer = null;

/** Yumşaq yükləmə: səhifə mərkəzində kart; immediate=true dərhal; false ≈260ms (tez Firestore əməliyyatlarında parıltı az olsun). */
function softLoadingBegin(immediate) {
  _softOpDepth++;
  if (_softOpDepth > 1) {
    if (immediate && _softOpTimer) {
      clearTimeout(_softOpTimer);
      _softOpTimer = null;
      byId("softLoadingCenter")?.classList.remove("hidden");
    }
    return;
  }
  const center = byId("softLoadingCenter");
  const show = () => {
    _softOpTimer = null;
    if (_softOpDepth > 0) center?.classList.remove("hidden");
  };
  if (immediate) show();
  else _softOpTimer = setTimeout(show, 260);
}

function softLoadingEnd() {
  _softOpDepth = Math.max(0, _softOpDepth - 1);
  if (_softOpDepth > 0) return;
  if (_softOpTimer) {
    clearTimeout(_softOpTimer);
    _softOpTimer = null;
  }
  byId("softLoadingCenter")?.classList.add("hidden");
}

/** Bölmə keçidi + renderAll: zolaq dərhal görünsün; çox sürətli işlərdə ən azı ~minMs görünür. */
const SECTION_LOAD_MIN_MS = 300;
const MODAL_SLIDEOVER_LOAD_MIN_MS = 240;
function withSectionLoading(runSync) {
  if (!meta?.session) {
    runSync();
    return;
  }
  const t0 = Date.now();
  softLoadingBegin(true);
  try {
    runSync();
  } finally {
    const finish = () => {
      const wait = Math.max(0, SECTION_LOAD_MIN_MS - (Date.now() - t0));
      setTimeout(() => softLoadingEnd(), wait);
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }
}

/** Sidebar / spotlight / bildiriş: bölmə + cədvəllərin yenilənməsi bir yerdə yükləmə ilə. */
function goSecWithLoad(id, el, opts) {
  closeMdl();
  withSectionLoading(() => {
    showSec(id, el, opts);
    renderAll();
  });
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

async function loadCompanyDBAsync(opts) {
  const useSoft = !!(opts && opts.soft);
  if (useSoft) softLoadingBegin(true);
  try {
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
  } finally {
    if (useSoft) softLoadingEnd();
  }
}

function subscribeRealtime() {
  if (!useFirestore()) return;
  unsubscribeRealtime();
  const metaRef = getMetaRef();
  if (metaRef) {
    firestoreUnsubMeta = metaRef.onSnapshot(
      (snap) => {
        if (snap.exists) {
          const next = snap.data() || {};
          if (Array.isArray(next.companies)) meta.companies = next.companies;
          if (Array.isArray(next.users)) meta.users = next.users;
          applyAccessUI();
          if (meta.session) {
            renderSidebarUser();
            refreshHeaderBar();
          }
          renderAll();
          checkSubscriptionStatus();
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
  if (!silent) softLoadingBegin(true);
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
    // Refresh meta subscription status from Firestore
    const metaRef = getMetaRef();
    if (metaRef) {
      metaRef.get().then(msnap => {
        if (msnap.exists) {
          const mdata = msnap.data();
          if (mdata.companies) meta.companies = mdata.companies;
        }
        checkSubscriptionStatus();
      }).catch(() => checkSubscriptionStatus());
    } else {
      checkSubscriptionStatus();
    }
  } catch (e) {
    console.warn("Buluddan yeniləmə xətası:", e);
    const msg = (e && e.message) ? String(e.message) : "Yeniləmə xətası";
    toast(msg, "err", 4000);
  } finally {
    if (!silent) softLoadingEnd();
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
    .map((a) => `<option value="${a.uid}" ${String(a.uid) === String(selectedId) ? "selected" : ""}>${escapeHtml(a.name)}</option>`)
    .join("");
}

function fillCashAccountSelect() {
  const sel = byId("cashAccount");
  if (!sel) return;
  ensureAccounts();
  const cur = sel.value || "all";
  sel.innerHTML =
    `<option value="all">Bütün hesablar</option>` +
    db.accounts.map((a) => `<option value="${a.uid}">${escapeHtml(a.name)}</option>`).join("");
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Hesab</div>
          <div class="grid-2">
            <div class="f-group"><label>Hesab adı *</label><input id="acc_name" placeholder="məs: Əsas Kassa" value="${escapeHtml(a.name || "")}" required></div>
            <div class="f-group"><label>Hesab növü</label><select id="acc_type">
          <option value="cash" ${a.type === "cash" ? "selected" : ""}>kassa</option>
          <option value="bank" ${a.type === "bank" ? "selected" : ""}>bank</option>
          <option value="card" ${a.type === "card" ? "selected" : ""}>kart</option>
        </select></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Yarat"}</button>
        <button class="btn-cancel" type="button" onclick="accountFormDismiss()">Bağla</button>
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
          ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("cash", "accountEdit", i)}" onclick="openAccount(${i});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
          ${userCanDelete("accounts") ? `<button class="icon-btn delete" onclick="delAccount(${i})" title="Sil" ${delDisabled}><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
}

/** Hesab formundan çıxış: modal tarixçəsi varsa Geri ilə siyahıya qayıt, yoxsa bağla. */
function accountFormDismiss() {
  const h = window.__modalHistory || [];
  if (h.length) modalBack();
  else closeMdl();
}

function openAccountsManager() {
  if (!userCanSection("accounts")) return alert("Hesablar bölməsinə giriş icazəniz yoxdur.");
  openModal(`
    <h2>Hesablar</h2>
    <div class="modal-toolbar-row">
      <div class="muted">Hesab yarat, redaktə et, sil və qalıqlara bax.</div>
      ${userCanEdit() ? `<button class="btn-main" type="button" onclick="openAccount()"><i class="fas fa-plus"></i> Yeni hesab</button>` : ""}
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
  const h = window.__modalHistory || [];
  if (h.length > 0) modalBack();
  else {
    renderAccountsManagerTable();
    closeMdl();
  }
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

/** onDone: Firestore .set bitdikdən sonra (və ya LS yazıldıqdan dərhal sonra) çağırılır — UI “saxlanıldı” əvvəl yükləmə, sonra gəlsin. */
function saveCompanyDB(onDone) {
  const cid = meta?.session?.companyId || meta?.companies?.[0]?.id || "default";
  const finish = () => {
    if (typeof onDone === "function") onDone();
  };
  if (useFirestore()) {
    lastFirestoreWriteAt = Date.now();
    const ref = getCompanyRef(cid);
    if (ref) {
      const data = JSON.parse(JSON.stringify(db));
      softLoadingBegin(true);
      ref
        .set(data)
        .catch((e) => console.warn("Firestore company yazma xətası:", e))
        .finally(() => {
          softLoadingEnd();
          finish();
        });
      return;
    }
  }
  localStorage.setItem(companyDBKey(cid), JSON.stringify(db));
  finish();
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
  saveCompanyDB(() => {
    updateLastSavedEl();
    renderAll();
  });
}

// ===================== Telegram Bildirişləri =====================
async function sendTelegram(text) {
  const s = db.settings || {};
  if (s.telegramEnabled === false) return;
  const token = (s.telegramToken || "").trim();
  const chatId = (s.telegramChatId || "").trim();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (_) {}
}

function tgCompanyName() {
  return (db.settings?.companyName || "ERP") ;
}
function tgUserName() {
  const u = currentUser();
  return (u?.fullName || "").trim() || userDisplay(u) || "-";
}
function tgAccName(accId) {
  return (db.accounts || []).find((a) => a.uid === Number(accId || 1))?.name || "Kassa";
}
function tgPayKindLabel(kind) {
  const M = {
    monthly: "Aylıq ödəniş", down: "İlkin ödəniş", regular: "Nağd ödəniş",
    credit_pay: "Kredit ödənişi", cash_pay: "Nağd ödəniş",
    debtor_payment: "Müştəri ödənişi", debtor_invoice_payment: "Qaimə ödənişi",
    expense: "Xərc", supp_pay: "Təchizatçı ödənişi",
    creditor_payment: "Kreditor ödənişi", creditor_invoice_payment: "Kreditor qaimə ödənişi",
    owner_income: "Təsisçidən mədaxil", owner_expense: "Təsisçiyə məxaric",
    transfer: "Transfer",
  };
  return M[kind] || kind || "-";
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
  tgLogEvent(action, target, details, (u?.fullName || "").trim() || userDisplay(u));
}

function tgLogEvent(action, target, details, user) {
  const ICONS = { create:"➕", update:"✏️", delete:"🗑️", return:"↩️", pay:"💳", login:"🔐", logout:"🚪" };
  const TARGETS = { sales:"Satış", purch:"Alış", cash:"Kassa", cust:"Müştəri", supp:"Təchizatçı",
    prod:"Məhsul", staff:"Əməkdaş", settings:"Ayarlar", founders:"Təsisçi", trash:"Zibil",
    sales_locked_override:"Satış (bağlı dövr)" };
  // skip noisy/low-value events
  const SKIP = new Set(["settings","trash","login","logout"]);
  if (SKIP.has(target)) return;
  // skip update on sales/purch that were already notified directly (create/update handled by saveSale/savePurch)
  if ((target === "sales" || target === "purch") && (action === "create" || action === "update")) return;
  // skip individual cash creates (expense/payment already notified in saveCashOp)
  if (target === "cash" && action === "create") {
    const kind = String(details.kind || "");
    const ALREADY_NOTIFIED = new Set(["expense","debtor_payment","debtor_invoice_payment"]);
    if (ALREADY_NOTIFIED.has(kind)) return;
  }

  const icon = ICONS[action] || "🔔";
  const tgt = TARGETS[target] || target;
  const inv = details.invNo ? `\nQaimə: <b>${details.invNo}</b>` : "";
  const amt = details.amount ? `\nMəbləğ: <b>${money(details.amount)} AZN</b>` : "";
  const kind = details.kind ? `\nNöv: ${details.kind}` : "";
  const usr = user ? `\nƏməkdaş: <b>${user}</b>` : "";

  sendTelegram(
    `${icon} ${tgt} — <b>${tgCompanyName()}</b>${inv}${amt}${kind}${usr}`
  );
}

async function sendDailyOverdueReport() {
  const today = new Date();
  const yy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayISO = `${yy}-${mm}-${dd}`;
  const todayLabel = `${dd}.${mm}.${yy}`;

  const PAY_TYPE_LABEL = {
    down: "İlkin ödəniş",
    monthly: "Aylıq ödəniş",
    credit_pay: "Aylıq ödəniş",
  };

  const dueList = [];
  for (const sale of (db.sales || [])) {
    if (sale.returnedAt) continue;
    if (String(sale.saleType || "").toLowerCase() !== "kredit") continue;
    const sched = buildCreditSchedule(sale);
    const custName = sale.customerName || "-";
    const invNo = sale.invNo || invFallback("sales", sale.uid);
    const accName = (db.accounts || []).find((a) => a.uid === Number(sale.paymentAccountId || 1))?.name || "Kassa";
    // down payment — check if due today (same day as sale date)
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
    // monthly installments
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

  const s = db.settings || {};
  if (!(s.telegramToken || "").trim() || !(s.telegramChatId || "").trim()) return;

  if (dueList.length === 0) {
    await sendTelegram(
      `📅 <b>Gündəlik Kredit Bildirişi — ${todayLabel}</b>\n` +
      `Şirkət: <b>${tgCompanyName()}</b>\n\n` +
      `✅ Bu gün ödənilməli kredit öhdəliyi yoxdur.`
    );
    return;
  }

  const lines = dueList.map((d, i) =>
    `${i + 1}. 👤 <b>${d.customer}</b>  |  📄 ${d.invNo}\n` +
    `   🏷 Növ: ${d.payType}\n` +
    `   💰 Məbləğ: <b>${money(d.amount)} AZN</b>  (Qalıq: ${money(d.remaining)} AZN)\n` +
    `   🏦 Hesab: ${d.account}`
  ).join("\n\n");

  await sendTelegram(
    `📅 <b>Gündəlik Kredit Ödənişləri — ${todayLabel}</b>\n` +
    `Şirkət: <b>${tgCompanyName()}</b>\n` +
    `Cəmi: <b>${dueList.length}</b> ödəniş bu gün\n\n` +
    lines
  );
}

function startDailyReportScheduler() {
  const HOUR = 10;
  const MIN = 0;
  const KEY = "__dailyCreditReportSent";

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function checkAndSend() {
    const now = new Date();
    const today = todayKey();
    const pastTime = now.getHours() > HOUR || (now.getHours() === HOUR && now.getMinutes() >= MIN);
    const sent = localStorage.getItem(KEY) === today;
    if (pastTime && !sent) {
      localStorage.setItem(KEY, today);
      sendDailyOverdueReport();
    }
  }

  checkAndSend();
  setInterval(checkAndSend, 60 * 1000);
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

function showDebtSub(sectionId, debtType) {
  if (!sectionId) {
    window.__debtsSaleType = "";
    updateDebtSubSelectVisibility("");
    updateDebtSubEnabled();
    updateDebtSectionVisibility();
    return;
  }
  // nagd/topdan/korporativ → #debts section, set sale type filter
  const salesTypes = ["nagd", "topdan", "korporativ"];
  const isDebtsSec = sectionId === "debts" || salesTypes.includes(sectionId);
  const realSection = isDebtsSec ? "debts" : sectionId;
  const typeVal = debtType !== undefined ? debtType : sectionId;
  if (salesTypes.includes(typeVal)) {
    window.__debtsSaleType = typeVal;
  } else {
    window.__debtsSaleType = "";
  }
  const debtNav = findNavLinkForSection("debts");
  withSectionLoading(() => {
    showSec(realSection, debtNav || null);
    document.querySelectorAll(".debt-type-select").forEach((s) => {
      s.value = typeVal;
    });
    updateDebtSubSelectVisibility(realSection);
    updateDebtSubEnabled();
    updateDebtSectionVisibility();
    // Update section title
    const h1 = byId(realSection)?.querySelector("h1");
    if (h1) {
      const titles = { nagd: "Borclar - Nağd satış", topdan: "Borclar - Topdan satış", korporativ: "Borclar - Korporativ satış", debts: "Borclar", creditor: "Borclar - Kreditor", overdue: "Borclar - Kreditlər" };
      h1.textContent = titles[typeVal] || titles[realSection] || h1.textContent;
    }
    renderAll();
  });
}

function updateDebtSubSelectVisibility(sectionId) {
  document.querySelectorAll(".debt-sub-select").forEach((el) => {
    el.style.display = "";
  });
}

function updateDebtSubEnabled() {
  const activeType = document.querySelector(".debt-type-select")?.value || "";
  const isDebtsType = activeType === "nagd" || activeType === "topdan" || activeType === "korporativ";
  document.querySelectorAll(".debt-sub-select").forEach((el) => {
    const forSec = el.getAttribute("data-debt-sub-for") || "";
    let enabled = false;
    if (forSec === "debts") enabled = isDebtsType;
    else if (forSec === "creditor") enabled = activeType === "creditor";
    else if (forSec === "overdue") enabled = activeType === "overdue";
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
  const isDebtsType = activeType === "nagd" || activeType === "topdan" || activeType === "korporativ";
  const showDebts = activeSec === "debts" && isDebtsType && !!(byId("debtsStatus")?.value || "");
  const showCred = activeSec === "creditor" && activeType === "creditor" && !!(byId("credStatus")?.value || "");
  const showOver = activeSec === "overdue" && activeType === "overdue" && !!(byId("overdueView")?.value || "");
  const d = byId("debtsContent"); if (d) d.style.display = showDebts ? "" : "none";
  const c = byId("creditorContent"); if (c) c.style.display = showCred ? "" : "none";
  const o = byId("overdueContent"); if (o) o.style.display = showOver ? "" : "none";
}

function onDebtTypeChange(sel) {
  const value = String(sel?.value || "");
  if (byId("debtsStatus")) byId("debtsStatus").value = "";
  if (byId("credStatus")) byId("credStatus").value = "";
  if (byId("overdueView")) byId("overdueView").value = "";
  const sectionId = (value === "nagd" || value === "topdan" || value === "korporativ") ? "debts" : value;
  showDebtSub(sectionId, value);
}

// ========= Reports: tab navigation & rendering =========
const REP_VIEWS = ["sales","purch","staff","expense","stock","pl","cash",
  "customer","saletype","product","aging","credits","creditor","accounts","daily","returns","staffperf","payments","founders"];
const REP_TITLES = {
  sales: "Satış hesabatı", purch: "Alış hesabatı", staff: "Əmək haqqı hesabatı",
  expense: "Xərc hesabatı", stock: "Anbar hesabatı", pl: "Mənfəət/Zərər hesabatı",
  cash: "Kassa hesabatı", customer: "Müştəri hesabatı", saletype: "Satış növü üzrə",
  product: "Məhsul satış hesabatı", aging: "Debitor yaşlanma", credits: "Kredit portfeli",
  creditor: "Kreditor (Təchizatçı) hesabatı", accounts: "Hesab hərəkəti", daily: "Günlük hesabat",
  returns: "Geri qaytarma hesabatı", staffperf: "Əməkdaş fəaliyyəti", payments: "Ödəniş hesabatı",
  founders: "Təsisçi bölməsi",
};

function setRepView(view) {
  const menu = byId("repMenu");
  const content = byId("repContent");
  if (!view) {
    if (menu) menu.style.display = "";
    if (content) content.style.display = "none";
    REP_VIEWS.forEach((v) => { const s = byId(`repSec-${v}`); if (s) s.style.display = "none"; });
    window.__repView = "";
    return;
  }
  window.__repView = view;
  if (menu) menu.style.display = "none";
  if (content) content.style.display = "";
  const titleEl = byId("repContentTitle");
  if (titleEl) titleEl.textContent = REP_TITLES[view] || view;
  REP_VIEWS.forEach((v) => { const s = byId(`repSec-${v}`); if (s) s.style.display = v === view ? "" : "none"; });
  withSectionLoading(() => {
    renderReports();
    if (window.innerWidth <= 768) requestAnimationFrame(wrapMobileTables);
  });
}

function syncRepFilters() {
  const m = byId("repMonthVis")?.value || "";
  const f = byId("repFromVis")?.value || "";
  const t = byId("repToVis")?.value || "";
  if (byId("repMonth")) byId("repMonth").value = m;
  if (byId("repFrom")) byId("repFrom").value = f;
  if (byId("repTo")) byId("repTo").value = t;
  withSectionLoading(() => renderReports());
}

function renderReports() {
  const view = window.__repView || "";
  if (!view) return;
  const repMonth = byId("repMonthVis")?.value || byId("repMonth")?.value || "";
  const useMonth = !!repMonth;
  const inRange = (d) => useMonth ? inMonth(d, repMonth) : inDateRange(d, "repFromVis", "repToVis");
  const hasPeriod = useMonth || (byId("repFromVis")?.value || "").trim() || (byId("repToVis")?.value || "").trim();
    const saleTypeMap = { nagd: "Nağd", post: "Post", post_taksit: "Post Taksit", topdan: "Topdan", korporativ: "Korporativ", kredit: "Kredit", kocurme: "Köçürmə" };

  if (view === "sales") {
    const rows = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date))
      .slice().sort((a, b) => (a.date > b.date ? -1 : 1));
    const salesTotal = rows.reduce((a, s) => a + n(s.amount), 0);
    const salesPaid = rows.reduce((a, s) => a + n(s.paidTotal || 0), 0);
    const salesRem = rows.reduce((a, s) => a + saleRemaining(s), 0);
    const cogs = rows.reduce((a, s) => {
      if (s.bulkPurchUid) {
        const p = (db.purch || []).find((x) => String(x.uid) === String(s.bulkPurchUid));
        const unit = p ? n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1))) : 0;
        return a + unit * Math.max(1, Math.floor(n(s.qty || 1)));
      }
      const p = (db.purch || []).find((x) => itemKeyFromPurch(x) === s.itemKey);
      return a + (p ? n(p.amount) : 0);
    }, 0);
    setText("rv-salesTotal", money(salesTotal) + " AZN");
    setText("rv-salesPaid", money(salesPaid) + " AZN");
    setText("rv-salesCogs", money(cogs) + " AZN");
    setText("rv-salesPL", money(salesTotal - cogs) + " AZN");
    setText("rv-salesCount", String(rows.length));
    const body = byId("tblRepSales");
    if (body) {
      body.innerHTML = rows.map((s, i) => {
        const idx = (db.sales || []).findIndex((x) => x.uid === s.uid);
        const inv = s.invNo || invFallback("sales", s.uid);
        const rem = saleRemaining(s);
        const typeLabel = saleTypeMap[String(s.saleType || "").toLowerCase()] || String(s.saleType || "").toUpperCase();
        return `<tr>
          <td>${i + 1}</td><td>${fmtDT(s.date)}</td>
          <td>${escapeHtml(inv)}</td><td>${escapeHtml(s.customerName)}</td>
          <td>${escapeHtml(s.productName)}</td><td>${escapeHtml(typeLabel)}</td>
          <td>${money(s.amount)} AZN</td><td>${money(n(s.paidTotal || 0))} AZN</td>
          <td>${money(rem)} AZN</td>
          <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales","saleInfo",idx)}" onclick="openSaleInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a></td>
        </tr>`;
      }).join("") + (rows.length ? `<tr class="total-row">
        <td colspan="6"><strong>Cəmi (${rows.length} satış)</strong></td>
        <td><strong>${money(salesTotal)} AZN</strong></td>
        <td><strong>${money(salesPaid)} AZN</strong></td>
        <td><strong>${money(salesRem)} AZN</strong></td>
        <td></td></tr>` : emptyRow(10));
    }

  } else if (view === "purch") {
    const rows = (db.purch || []).filter((p) => !p.returnedAt).filter((p) => !hasPeriod || inRange(p.date))
      .slice().sort((a, b) => (a.date > b.date ? -1 : 1));
    const purchTotal = rows.reduce((a, p) => a + n(p.amount), 0);
    const purchPaid = rows.reduce((a, p) => a + n(p.paidTotal || 0), 0);
    const purchRem = rows.reduce((a, p) => a + purchRemaining(p), 0);
    setText("rv-purchTotal", money(purchTotal) + " AZN");
    setText("rv-purchPaid", money(purchPaid) + " AZN");
    setText("rv-purchRem", money(purchRem) + " AZN");
    setText("rv-purchCount", String(rows.length));
    const body = byId("tblRepPurch");
    if (body) {
      body.innerHTML = rows.map((p, i) => {
        const inv = p.invNo || invFallback("purch", p.uid);
        const rem = purchRemaining(p);
        const purchIdx = (db.purch || []).findIndex((x) => x.uid === p.uid);
        return `<tr>
          <td>${i + 1}</td><td>${fmtDT(p.date)}</td>
          <td>${escapeHtml(inv)}</td><td>${escapeHtml(p.supp || "-")}</td>
          <td>${escapeHtml(p.name)}</td><td>${n(p.qty || 1)}</td>
          <td>${money(p.amount)} AZN</td><td>${money(n(p.paidTotal || 0))} AZN</td>
          <td>${money(rem)} AZN</td>
          <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("purch","purchInfo",purchIdx)}" onclick="openPurchInfo(${purchIdx});return false;" title="Info"><i class="fas fa-circle-info"></i></a></td>
        </tr>`;
      }).join("") + (rows.length ? `<tr class="total-row">
        <td colspan="6"><strong>Cəmi (${rows.length} alış)</strong></td>
        <td><strong>${money(purchTotal)} AZN</strong></td>
        <td><strong>${money(purchPaid)} AZN</strong></td>
        <td><strong>${money(purchRem)} AZN</strong></td>
        <td></td></tr>` : emptyRow(10));
    }

  } else if (view === "staff") {
    const salesInRange = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date));
    const byEmp = new Map();
    for (const s of salesInRange) {
      const empId = String(s.employeeId || ""); if (!empId) continue;
      if (!byEmp.has(empId)) byEmp.set(empId, { count: 0, sum: 0 });
      byEmp.get(empId).count++;
      byEmp.get(empId).sum += n(s.amount);
    }
    let totalBase = 0, totalComm = 0, totalSales = 0, totalPayroll = 0;
    const staffSorted = (db.staff || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const body = byId("tblRepStaff");
    if (body) {
      const staffRows = staffSorted.map((st, i) => {
        const o = byEmp.get(String(st.uid)) || { count: 0, sum: 0 };
        const pct = Math.max(0, n(st.commPct || 0));
        const base = Math.max(0, n(st.baseSalary || 0));
        const comm = o.sum * (pct / 100);
        const total = base + comm;
        totalBase += base; totalComm += comm; totalSales += o.sum; totalPayroll += total;
        return `<tr>
          <td>${i + 1}</td><td>${escapeHtml(st.name)}</td>
          <td>${o.count}</td><td>${money(o.sum)} AZN</td>
          <td>${money(pct)}%</td><td>${money(comm)} AZN</td>
          <td>${money(base)} AZN</td><td><strong>${money(total)} AZN</strong></td>
          <td class="tbl-actions"><button class="btn-mini" type="button" onclick="openStaffReportSales('${escapeAttr(String(st.uid))}')" title="Satış siyahısı"><i class="fas fa-list"></i> Bax</button></td>
        </tr>`;
      });
      body.innerHTML = staffRows.join("") + (staffSorted.length ? `<tr class="total-row">
        <td colspan="3"><strong>Cəmi</strong></td>
        <td><strong>${money(totalSales)} AZN</strong></td>
        <td></td>
        <td><strong>${money(totalComm)} AZN</strong></td>
        <td><strong>${money(totalBase)} AZN</strong></td>
        <td><strong>${money(totalPayroll)} AZN</strong></td>
        <td></td></tr>` : emptyRow(9));
    }
    setText("rv-staffTotal", money(totalPayroll) + " AZN");
    setText("rv-staffBase", money(totalBase) + " AZN");
    setText("rv-staffComm", money(totalComm) + " AZN");
    setText("rv-staffSales", money(totalSales) + " AZN");

  } else if (view === "expense") {
    const rows = (db.cash || [])
      .filter((c) => c.type === "out" && c.link?.kind === "expense")
      .filter((c) => !hasPeriod || inRange(c.date))
      .slice().sort((a, b) => (a.date > b.date ? -1 : 1));
    const expTotal = rows.reduce((a, c) => a + n(c.amount), 0);
    setText("rv-expTotal", money(expTotal) + " AZN");
    setText("rv-expCount", String(rows.length));
    const body = byId("tblRepExp");
    if (body) {
      body.innerHTML = rows.map((c, i) => {
        const accName = (db.accounts || []).find((a) => a.uid === Number(c.accountId || 1))?.name || "Kassa";
        return `<tr>
          <td>${i + 1}</td><td>${fmtDT(c.date)}</td>
          <td>${escapeHtml(c.source || "-")}</td>
          <td class="amt-out">-${money(c.amount)} AZN</td>
          <td>${escapeHtml(accName)}</td>
          <td>${escapeHtml(c.note || "")}</td>
        </tr>`;
      }).join("") + (rows.length ? `<tr class="total-row">
        <td colspan="3"><strong>Cəmi (${rows.length} əməliyyat)</strong></td>
        <td><strong>-${money(expTotal)} AZN</strong></td>
        <td colspan="2"></td></tr>` : emptyRow(6));
    }

  } else if (view === "stock") {
    // Anbardakı bütün məhsullar (remaining qty > 0)
    const stockItems = (db.purch || [])
      .filter((p) => purchRemainingQty(p) > 0)
      .slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    let totalQty = 0, totalVal = 0;
    const body = byId("tblRepStock");
    if (body) {
      body.innerHTML = stockItems.map((p, i) => {
        const qty = purchRemainingQty(p);
        const unitPrice = n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1)));
        const val = unitPrice * qty;
        totalQty += qty; totalVal += val;
        const imeiParts = [p.imei1, p.imei2].filter(Boolean);
        const key = (imeiParts.length ? imeiParts.join("/") : (p.seria || p.code || "")).trim();
        const isSerial = !purchIsBulk(p);
        return `<tr>
          <td>${i + 1}</td><td>${escapeHtml(p.name)}</td>
          <td>${isSerial ? "Seriyalı" : "Ədədi"}</td>
          <td>${escapeHtml(key || "-")}</td>
          <td>${qty}</td>
          <td>${money(unitPrice)} AZN</td>
          <td>${money(val)} AZN</td>
          <td>${fmtDT(p.date)}</td>
        </tr>`;
      }).join("") + (stockItems.length ? `<tr class="total-row">
        <td colspan="4"><strong>Cəmi (${stockItems.length} məhsul növü)</strong></td>
        <td><strong>${totalQty}</strong></td>
        <td></td>
        <td><strong>${money(totalVal)} AZN</strong></td>
        <td></td></tr>` : emptyRow(8));
    }
    setText("rv-stockQty", String(totalQty));
    setText("rv-stockVal", money(totalVal) + " AZN");
    setText("rv-stockItems", String(stockItems.length));

  } else if (view === "pl") {
    // Mənfəət/Zərər — aylara görə siyahı (əgər tarix verilsə) və ya ümumi
    const calcCogs = (salesList) => salesList.reduce((a, s) => {
      if (s.bulkPurchUid) {
        const p = (db.purch || []).find((x) => String(x.uid) === String(s.bulkPurchUid));
        const unit = p ? n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1))) : 0;
        return a + unit * Math.max(1, Math.floor(n(s.qty || 1)));
      }
      const p = (db.purch || []).find((x) => itemKeyFromPurch(x) === s.itemKey);
      return a + (p ? n(p.amount) : 0);
    }, 0);
    const calcPayroll = (salesList) => {
      const byEmpM = new Map();
      for (const s of salesList) {
        const empId = String(s.employeeId || ""); if (!empId) continue;
        byEmpM.set(empId, (byEmpM.get(empId) || 0) + n(s.amount));
      }
      return (db.staff || []).reduce((a, st) => {
        const salesEmp = byEmpM.get(String(st.uid)) || 0;
        return a + Math.max(0, n(st.baseSalary || 0)) + salesEmp * (Math.max(0, n(st.commPct || 0)) / 100);
      }, 0);
    };
    // Build month list
    const monthsList = [];
    if (repMonth) {
      monthsList.push(repMonth);
    } else {
      const fromMs = parseDateOnly(byId("repFromVis")?.value);
      const toMs = parseDateOnly(byId("repToVis")?.value);
      if (fromMs && toMs) {
        const from = new Date(fromMs); const to = new Date(toMs);
        let y = from.getFullYear(); let m = from.getMonth() + 1;
        while (y < to.getFullYear() || (y === to.getFullYear() && m <= to.getMonth() + 1)) {
          monthsList.push(`${y}-${String(m).padStart(2, "0")}`);
          m++; if (m > 12) { m = 1; y++; }
        }
      }
    }
    let totSales = 0, totCogs = 0, totExp = 0, totPay = 0;
    const body = byId("tblRepPL");
    if (body) {
      if (!monthsList.length) {
        body.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center">Ay və ya tarix aralığı seçin</td></tr>`;
      } else {
        body.innerHTML = monthsList.map((mk, i) => {
          const salesM = (db.sales || []).filter((s) => !s.returnedAt && inMonth(s.date, mk));
          const purchM = (db.purch || []).filter((p) => inMonth(p.date, mk));
          const expM = (db.cash || []).filter((c) => c.type === "out" && c.link?.kind === "expense" && inMonth(c.date, mk)).reduce((a, c) => a + n(c.amount), 0);
          const salesSum = salesM.reduce((a, s) => a + n(s.amount), 0);
          const cogsM = calcCogs(salesM);
          const payM = calcPayroll(salesM);
          const pl = salesSum - cogsM - expM - payM;
          totSales += salesSum; totCogs += cogsM; totExp += expM; totPay += payM;
          const [y, m] = mk.split("-");
          return `<tr>
            <td>${i + 1}</td><td>${y}-${m}</td>
            <td>${money(salesSum)} AZN</td><td>${money(cogsM)} AZN</td>
            <td>${money(expM)} AZN</td><td>${money(payM)} AZN</td>
            <td class="${pl >= 0 ? "amt-in" : "amt-out"}"><strong>${money(pl)} AZN</strong></td>
          </tr>`;
        }).join("") + `<tr class="total-row">
          <td colspan="2"><strong>Cəmi</strong></td>
          <td><strong>${money(totSales)} AZN</strong></td>
          <td><strong>${money(totCogs)} AZN</strong></td>
          <td><strong>${money(totExp)} AZN</strong></td>
          <td><strong>${money(totPay)} AZN</strong></td>
          <td class="${(totSales-totCogs-totExp-totPay)>=0?"amt-in":"amt-out"}"><strong>${money(totSales-totCogs-totExp-totPay)} AZN</strong></td>
        </tr>`;
      }
    }
    setText("rv-plSales", money(totSales) + " AZN");
    setText("rv-plCogs", money(totCogs) + " AZN");
    setText("rv-plExp", money(totExp) + " AZN");
    setText("rv-plPayroll", money(totPay) + " AZN");
    setText("rv-plNet", money(totSales - totCogs - totExp - totPay) + " AZN");

  } else if (view === "cash") {
    const rows = (db.cash || [])
      .filter((c) => !hasPeriod || inRange(c.date))
      .slice().sort((a, b) => (a.date > b.date ? -1 : 1));
    const cashIn = rows.filter((c) => c.type === "in").reduce((a, c) => a + n(c.amount), 0);
    const cashOut = rows.filter((c) => c.type === "out").reduce((a, c) => a + n(c.amount), 0);
    setText("rv-cashIn", money(cashIn) + " AZN");
    setText("rv-cashOut", money(cashOut) + " AZN");
    setText("rv-cashNet", money(cashIn - cashOut) + " AZN");
    setText("rv-cashCount", String(rows.length));
    const body = byId("tblRepCash");
    if (body) {
      body.innerHTML = rows.map((c, i) => {
        const accName = (db.accounts || []).find((a) => a.uid === Number(c.accountId || 1))?.name || "Kassa";
        const isIn = c.type === "in";
        return `<tr>
          <td>${i + 1}</td><td>${fmtDT(c.date)}</td>
          <td><span class="pill ${isIn ? "paid" : "overdue"}">${isIn ? "Giriş" : "Çıxış"}</span></td>
          <td>${escapeHtml(c.source || "-")}</td>
          <td class="${isIn ? "amt-in" : "amt-out"}">${isIn ? "+" : "-"}${money(c.amount)} AZN</td>
          <td>${escapeHtml(accName)}</td>
          <td>${escapeHtml(c.note || "")}</td>
        </tr>`;
      }).join("") + (rows.length ? `<tr class="total-row">
        <td colspan="4"><strong>Cəmi (${rows.length} əməliyyat)</strong></td>
        <td><strong class="${(cashIn-cashOut)>=0?"amt-in":"amt-out"}">${money(cashIn-cashOut)} AZN</strong></td>
        <td colspan="2"></td></tr>` : emptyRow(7));
    }

  } else if (view === "customer") {
    const sales = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date));
    const map = new Map();
    for (const s of sales) {
      const k = String(s.customerId || s.customerName || "");
      if (!map.has(k)) map.set(k, { name: s.customerName || k, customerId: s.customerId, count: 0, total: 0, paid: 0, rem: 0, lastDate: "" });
      const o = map.get(k);
      o.count++; o.total += n(s.amount); o.paid += n(s.paidTotal || 0); o.rem += saleRemaining(s);
      if (!o.lastDate || s.date > o.lastDate) o.lastDate = s.date;
    }
    const rows = Array.from(map.values()).sort((a, b) => b.total - a.total);
    const totSales = rows.reduce((a, r) => a + r.total, 0);
    const totPaid = rows.reduce((a, r) => a + r.paid, 0);
    const totRem = rows.reduce((a, r) => a + r.rem, 0);
    setText("rv-custCount", String(rows.length));
    setText("rv-custSales", money(totSales) + " AZN");
    setText("rv-custPaid", money(totPaid) + " AZN");
    setText("rv-custRem", money(totRem) + " AZN");
    const body = byId("tblRepCustomer");
    if (body) {
      body.innerHTML = rows.map((r, i) => {
        const cust = (db.cust || []).find((c) => (r.customerId && c.uid === r.customerId) || String(c.sur + " " + c.name).trim() === String(r.name).trim());
        const idx = cust ? (db.cust || []).indexOf(cust) : -1;
        const infoBtn = idx >= 0 ? `<a class="icon-btn info" href="${erpOpHref("cust","custInfo",idx)}" onclick="openCustInfo(${idx});return false;"><i class="fas fa-circle-info"></i></a>` : "-";
        return `<tr><td>${i+1}</td><td>${escapeHtml(r.name)}</td><td>${r.count}</td>
          <td>${money(r.total)} AZN</td><td>${money(r.paid)} AZN</td><td>${money(r.rem)} AZN</td>
          <td>${fmtDT(r.lastDate)}</td><td class="tbl-actions">${infoBtn}</td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="3"><strong>Cəmi</strong></td>
        <td><strong>${money(totSales)} AZN</strong></td><td><strong>${money(totPaid)} AZN</strong></td>
        <td><strong>${money(totRem)} AZN</strong></td><td colspan="2"></td></tr>` : emptyRow(8));
    }

  } else if (view === "saletype") {
    const sales = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date));
    const typeMap = { nagd: "Nağd", post: "Post", post_taksit: "Post Taksit", topdan: "Topdan", korporativ: "Korporativ", kredit: "Kredit", kocurme: "Köçürmə" };
    const map = new Map();
    for (const s of sales) {
      const k = String(s.saleType || "nagd").toLowerCase();
      if (!map.has(k)) map.set(k, { count: 0, total: 0, paid: 0, rem: 0 });
      const o = map.get(k); o.count++; o.total += n(s.amount); o.paid += n(s.paidTotal||0); o.rem += saleRemaining(s);
    }
    const totAmt = Array.from(map.values()).reduce((a, r) => a + r.total, 0);
    setText("rv-stTotal", money(totAmt) + " AZN");
    setText("rv-stCount", String(sales.length));
    const rows = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
    const body = byId("tblRepSaletype");
    if (body) {
      body.innerHTML = rows.map(([k, r], i) => `<tr><td>${i+1}</td><td>${escapeHtml(typeMap[k]||k)}</td>
        <td>${r.count}</td><td>${money(r.total)} AZN</td><td>${money(r.paid)} AZN</td>
        <td>${money(r.rem)} AZN</td><td>${totAmt > 0 ? (r.total/totAmt*100).toFixed(1) : 0}%</td></tr>`
      ).join("") + (rows.length ? `<tr class="total-row"><td colspan="2"><strong>Cəmi</strong></td>
        <td><strong>${sales.length}</strong></td><td><strong>${money(totAmt)} AZN</strong></td>
        <td><strong>${money(Array.from(map.values()).reduce((a,r)=>a+r.paid,0))} AZN</strong></td>
        <td><strong>${money(Array.from(map.values()).reduce((a,r)=>a+r.rem,0))} AZN</strong></td>
        <td>100%</td></tr>` : emptyRow(7));
    }

  } else if (view === "product") {
    const sales = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date));
    const map = new Map();
    for (const s of sales) {
      const k = String(s.productName || "-");
      if (!map.has(k)) map.set(k, { count: 0, total: 0, cogs: 0 });
      const o = map.get(k); o.count++; o.total += n(s.amount);
      if (s.bulkPurchUid) {
        const p = (db.purch||[]).find((x) => String(x.uid) === String(s.bulkPurchUid));
        o.cogs += p ? (n(p.amount)/Math.max(1,Math.floor(n(p.qty||1))))*Math.max(1,Math.floor(n(s.qty||1))) : 0;
      } else {
        const p = (db.purch||[]).find((x) => itemKeyFromPurch(x) === s.itemKey);
        o.cogs += p ? n(p.amount) : 0;
      }
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
    const totSales = rows.reduce((a, [,r]) => a + r.total, 0);
    const totCogs = rows.reduce((a, [,r]) => a + r.cogs, 0);
    setText("rv-prodCount", String(rows.length));
    setText("rv-prodSales", money(totSales) + " AZN");
    setText("rv-prodCogs", money(totCogs) + " AZN");
    setText("rv-prodPL", money(totSales - totCogs) + " AZN");
    const body = byId("tblRepProduct");
    if (body) {
      body.innerHTML = rows.map(([k, r], i) => {
        const pl = r.total - r.cogs;
        const plPct = r.total > 0 ? (pl/r.total*100).toFixed(1) : 0;
        return `<tr><td>${i+1}</td><td>${escapeHtml(k)}</td><td>${r.count}</td>
          <td>${money(r.total)} AZN</td><td>${money(r.cogs)} AZN</td>
          <td class="${pl>=0?"amt-in":"amt-out"}">${money(pl)} AZN</td><td>${plPct}%</td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="3"><strong>Cəmi</strong></td>
        <td><strong>${money(totSales)} AZN</strong></td><td><strong>${money(totCogs)} AZN</strong></td>
        <td><strong class="${(totSales-totCogs)>=0?"amt-in":"amt-out"}">${money(totSales-totCogs)} AZN</strong></td><td></td></tr>` : emptyRow(7));
    }

  } else if (view === "aging") {
    const today = Date.now();
    const debts = (db.sales || [])
      .filter((s) => !s.returnedAt && String(s.saleType||"").toLowerCase() !== "kredit" && saleRemaining(s) > 0.001)
      .map((s) => {
        const idx = (db.sales || []).indexOf(s);
        const rem = saleRemaining(s);
        const days = Math.floor((today - (parseDateOnly(s.date) || today)) / 86400000);
        const cat = days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
        return { s, idx, rem, days, cat };
      }).sort((a, b) => b.days - a.days);
    const total = debts.reduce((a, r) => a + r.rem, 0);
    const b30 = debts.filter((r) => r.cat==="0-30").reduce((a,r)=>a+r.rem,0);
    const b60 = debts.filter((r) => r.cat==="31-60").reduce((a,r)=>a+r.rem,0);
    const b90 = debts.filter((r) => r.cat==="61-90").reduce((a,r)=>a+r.rem,0);
    const b90p = debts.filter((r) => r.cat==="90+").reduce((a,r)=>a+r.rem,0);
    setText("rv-agingTotal", money(total) + " AZN");
    setText("rv-aging30", money(b30) + " AZN");
    setText("rv-aging60", money(b60) + " AZN");
    setText("rv-aging90", money(b90) + " AZN");
    setText("rv-aging90p", money(b90p) + " AZN");
    const catPill = { "0-30":"partial","31-60":"partial","61-90":"overdue","90+":"overdue" };
    const body = byId("tblRepAging");
    if (body) {
      body.innerHTML = debts.map((r, i) => {
        const inv = r.s.invNo || invFallback("sales", r.s.uid);
        return `<tr><td>${i+1}</td><td>${escapeHtml(r.s.customerName)}</td>
          <td>${escapeHtml(inv)}</td><td>${fmtDT(r.s.date)}</td>
          <td>${money(r.rem)} AZN</td><td>${r.days}</td>
          <td><span class="pill ${catPill[r.cat]||"unpaid"}">${r.cat} gün</span></td>
          <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales","saleInfo",r.idx)}" onclick="openSaleInfo(${r.idx});return false;"><i class="fas fa-circle-info"></i></a></td></tr>`;
      }).join("") + (debts.length ? `<tr class="total-row"><td colspan="4"><strong>Cəmi (${debts.length})</strong></td>
        <td><strong>${money(total)} AZN</strong></td><td colspan="3"></td></tr>` : emptyRow(8));
    }

  } else if (view === "credits") {
    const today = Date.now();
    const credits = (db.sales || [])
      .filter((s) => !s.returnedAt && String(s.saleType||"").toLowerCase() === "kredit" && saleRemaining(s) > 0.001)
      .map((s, _, arr) => { const idx = (db.sales||[]).indexOf(s); return { s, idx }; })
      .sort((a, b) => (a.s.date > b.s.date ? -1 : 1));
    const totAmt = credits.reduce((a,{s})=>a+n(s.amount),0);
    const totPaid = credits.reduce((a,{s})=>a+n(s.paidTotal||0),0);
    const totRem = credits.reduce((a,{s})=>a+saleRemaining(s),0);
    let overdueRem = 0;
    const body = byId("tblRepCredits");
    if (body) {
      body.innerHTML = credits.map(({s, idx}, i) => {
        const inv = s.invNo || invFallback("sales", s.uid);
        const rem = saleRemaining(s);
        const sched = buildCreditSchedule(s);
        const nextDueRow = sched.rows.find((r) => r.remaining > 0.001);
        const nextDueMs = nextDueRow ? parseDateOnly(nextDueRow.due) : null;
        const overdueDays = nextDueMs && nextDueMs < today ? Math.floor((today - nextDueMs)/86400000) : 0;
        if (overdueDays > 0) overdueRem += rem;
        return `<tr><td>${i+1}</td><td>${escapeHtml(s.customerName)}</td>
          <td>${escapeHtml(s.productName)}</td><td>${escapeHtml(inv)}</td>
          <td>${money(n(s.amount))} AZN</td><td>${money(n(s.paidTotal||0))} AZN</td>
          <td>${money(rem)} AZN</td>
          <td>${nextDueRow ? fmtDT(nextDueRow.due) : "-"}</td>
          <td>${overdueDays > 0 ? `<span class="pill unpaid">${overdueDays} gün</span>` : `<span class="pill paid">OK</span>`}</td>
          <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales","saleInfo",idx)}" onclick="openSaleInfo(${idx});return false;"><i class="fas fa-circle-info"></i></a></td></tr>`;
      }).join("") + (credits.length ? `<tr class="total-row"><td colspan="4"><strong>Cəmi (${credits.length})</strong></td>
        <td><strong>${money(totAmt)} AZN</strong></td><td><strong>${money(totPaid)} AZN</strong></td>
        <td><strong>${money(totRem)} AZN</strong></td><td colspan="3"></td></tr>` : emptyRow(10));
    }
    setText("rv-crCount", String(credits.length));
    setText("rv-crTotal", money(totAmt) + " AZN");
    setText("rv-crPaid", money(totPaid) + " AZN");
    setText("rv-crRem", money(totRem) + " AZN");
    setText("rv-crOverdue", money(overdueRem) + " AZN");

  } else if (view === "creditor") {
    const purches = (db.purch || []).filter((p) => !p.returnedAt).filter((p) => !hasPeriod || inRange(p.date));
    const map = new Map();
    for (const p of purches) {
      const k = String(p.supp || "-");
      if (!map.has(k)) map.set(k, { count: 0, total: 0, paid: 0, rem: 0 });
      const o = map.get(k); o.count++; o.total += n(p.amount); o.paid += n(p.paidTotal||0); o.rem += purchRemaining(p);
    }
    const rows = Array.from(map.entries()).sort((a,b) => b[1].rem - a[1].rem);
    const totT = rows.reduce((a,[,r])=>a+r.total,0), totP = rows.reduce((a,[,r])=>a+r.paid,0), totR = rows.reduce((a,[,r])=>a+r.rem,0);
    setText("rv-credCount", String(rows.length));
    setText("rv-credTotal", money(totT) + " AZN");
    setText("rv-credPaid", money(totP) + " AZN");
    setText("rv-credRem", money(totR) + " AZN");
    const body = byId("tblRepCreditor");
    if (body) {
      body.innerHTML = rows.map(([k, r], i) => {
        const st = debtStatus(r.total, r.rem);
        return `<tr><td>${i+1}</td><td>${escapeHtml(k)}</td><td>${r.count}</td>
          <td>${money(r.total)} AZN</td><td>${money(r.paid)} AZN</td><td>${money(r.rem)} AZN</td>
          <td><span class="pill ${st}">${debtLabel(st)}</span></td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="3"><strong>Cəmi</strong></td>
        <td><strong>${money(totT)} AZN</strong></td><td><strong>${money(totP)} AZN</strong></td>
        <td><strong>${money(totR)} AZN</strong></td><td></td></tr>` : emptyRow(7));
    }

  } else if (view === "accounts") {
    // Populate account selector
    const accSel = byId("rv-accountSel");
    if (accSel && accSel.options.length <= 1) {
      (db.accounts || [{ uid: 1, name: "Kassa" }]).forEach((a) => {
        const o = document.createElement("option"); o.value = String(a.uid); o.textContent = a.name;
        accSel.appendChild(o);
      });
    }
    const selAccId = accSel?.value ? Number(accSel.value) : null;
    const rows = (db.cash || [])
      .filter((c) => !hasPeriod || inRange(c.date))
      .filter((c) => selAccId === null || Number(c.accountId || 1) === selAccId)
      .slice().sort((a, b) => (a.date > b.date ? 1 : -1));
    let running = 0;
    const cashInAcc = rows.filter(c=>c.type==="in").reduce((a,c)=>a+n(c.amount),0);
    const cashOutAcc = rows.filter(c=>c.type==="out").reduce((a,c)=>a+n(c.amount),0);
    setText("rv-accIn", money(cashInAcc) + " AZN");
    setText("rv-accOut", money(cashOutAcc) + " AZN");
    setText("rv-accNet", money(cashInAcc - cashOutAcc) + " AZN");
    const body = byId("tblRepAccounts");
    if (body) {
      body.innerHTML = rows.map((c, i) => {
        const isIn = c.type === "in";
        running += isIn ? n(c.amount) : -n(c.amount);
        const accName = (db.accounts||[]).find((a) => a.uid === Number(c.accountId||1))?.name || "Kassa";
        return `<tr><td>${i+1}</td><td>${fmtDT(c.date)}</td>
          <td><span class="pill ${isIn?"paid":"overdue"}">${isIn?"Giriş":"Çıxış"}</span></td>
          <td>${escapeHtml(c.source||"-")}</td>
          <td class="${isIn?"amt-in":"amt-out"}">${isIn?"+":"-"}${money(c.amount)} AZN</td>
          <td><strong>${money(running)} AZN</strong></td>
          <td>${escapeHtml(c.note||"")}</td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="4"><strong>Cəmi</strong></td>
        <td><strong class="${(cashInAcc-cashOutAcc)>=0?"amt-in":"amt-out"}">${money(cashInAcc-cashOutAcc)} AZN</strong></td>
        <td colspan="2"></td></tr>` : emptyRow(7));
    }

  } else if (view === "daily") {
    const cashOps = (db.cash || []).filter((c) => !hasPeriod || inRange(c.date));
    const salesAll = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date));
    const dayMap = new Map();
    const getDay = (d) => String(d || "").slice(0, 10);
    for (const s of salesAll) {
      const d = getDay(s.date); if (!d) continue;
      if (!dayMap.has(d)) dayMap.set(d, { salesCount: 0, salesAmt: 0, cashIn: 0, cashExp: 0 });
      dayMap.get(d).salesCount++; dayMap.get(d).salesAmt += n(s.amount);
    }
    for (const c of cashOps) {
      const d = getDay(c.date); if (!d) continue;
      if (!dayMap.has(d)) dayMap.set(d, { salesCount: 0, salesAmt: 0, cashIn: 0, cashExp: 0 });
      if (c.type === "in") dayMap.get(d).cashIn += n(c.amount);
      if (c.type === "out" && c.link?.kind === "expense") dayMap.get(d).cashExp += n(c.amount);
    }
    const rows = Array.from(dayMap.entries()).sort((a, b) => (a[0] > b[0] ? -1 : 1));
    const totSalesAmt = rows.reduce((a,[,r])=>a+r.salesAmt,0);
    const totCashIn = rows.reduce((a,[,r])=>a+r.cashIn,0);
    const totExp = rows.reduce((a,[,r])=>a+r.cashExp,0);
    setText("rv-dailySales", money(totSalesAmt) + " AZN");
    setText("rv-dailyIn", money(totCashIn) + " AZN");
    setText("rv-dailyExp", money(totExp) + " AZN");
    setText("rv-dailyDays", String(rows.length));
    const body = byId("tblRepDaily");
    if (body) {
      body.innerHTML = rows.map(([d, r], i) => {
        const net = r.cashIn - r.cashExp;
        return `<tr><td>${i+1}</td><td>${fmtDT(d)}</td><td>${r.salesCount}</td>
          <td>${money(r.salesAmt)} AZN</td><td>${money(r.cashIn)} AZN</td>
          <td>${money(r.cashExp)} AZN</td>
          <td class="${net>=0?"amt-in":"amt-out"}">${money(net)} AZN</td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="2"><strong>Cəmi (${rows.length} gün)</strong></td>
        <td><strong>${rows.reduce((a,[,r])=>a+r.salesCount,0)}</strong></td>
        <td><strong>${money(totSalesAmt)} AZN</strong></td>
        <td><strong>${money(totCashIn)} AZN</strong></td>
        <td><strong>${money(totExp)} AZN</strong></td>
        <td><strong class="${(totCashIn-totExp)>=0?"amt-in":"amt-out"}">${money(totCashIn-totExp)} AZN</strong></td></tr>` : emptyRow(7));
    }

  } else if (view === "returns") {
    const rows = (db.sales || [])
      .filter((s) => s.returnedAt && (!hasPeriod || inRange(s.returnedAt)))
      .slice().sort((a, b) => (a.returnedAt > b.returnedAt ? -1 : 1));
    const totAmt = rows.reduce((a, s) => a + n(s.amount), 0);
    setText("rv-retCount", String(rows.length));
    setText("rv-retTotal", money(totAmt) + " AZN");
    const body = byId("tblRepReturns");
    if (body) {
      body.innerHTML = rows.map((s, i) => {
        const idx = (db.sales||[]).indexOf(s);
        const inv = s.invNo || invFallback("sales", s.uid);
        return `<tr><td>${i+1}</td><td>${fmtDT(s.returnedAt)}</td><td>${fmtDT(s.date)}</td>
          <td>${escapeHtml(inv)}</td><td>${escapeHtml(s.customerName)}</td>
          <td>${escapeHtml(s.productName)}</td><td>${money(n(s.amount))} AZN</td>
          <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales","saleInfo",idx)}" onclick="openSaleInfo(${idx});return false;"><i class="fas fa-circle-info"></i></a></td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="6"><strong>Cəmi (${rows.length})</strong></td>
        <td><strong>${money(totAmt)} AZN</strong></td><td></td></tr>` : emptyRow(8));
    }

  } else if (view === "staffperf") {
    // Populate staff selector
    const staffSel = byId("rv-staffSel");
    if (staffSel && staffSel.options.length <= 1) {
      (db.staff || []).forEach((st) => {
        const o = document.createElement("option"); o.value = String(st.uid); o.textContent = st.name;
        staffSel.appendChild(o);
      });
    }
    const selStaff = staffSel?.value || "";
    const salesAll = (db.sales || []).filter((s) => !s.returnedAt).filter((s) => !hasPeriod || inRange(s.date))
      .filter((s) => !selStaff || String(s.employeeId||"") === selStaff);
    const staffList = selStaff ? (db.staff||[]).filter((st) => String(st.uid) === selStaff) : (db.staff||[]);
    const monthSalesMap = new Map();
    for (const s of salesAll) {
      const mk = String(s.date||"").slice(0,7);
      const empId = String(s.employeeId||"");
      const key = mk + "|" + empId;
      if (!monthSalesMap.has(key)) monthSalesMap.set(key, { month: mk, empId, count: 0, sum: 0 });
      const o = monthSalesMap.get(key); o.count++; o.sum += n(s.amount);
    }
    const rows = Array.from(monthSalesMap.values()).sort((a,b)=>a.month>b.month?-1:1);
    let totSales = 0, totCommOnly = 0, totYekun = 0;
    const body = byId("tblRepStaffperf");
    if (body) {
      body.innerHTML = rows.map((r, i) => {
        const st = (db.staff||[]).find((x) => String(x.uid) === r.empId);
        const pct = Math.max(0, n(st?.commPct||0));
        const base = Math.max(0, n(st?.baseSalary||0));
        const comm = r.sum * (pct/100);
        const yekun = base + comm;
        totSales += r.sum; totCommOnly += comm; totYekun += yekun;
        return `<tr><td>${i+1}</td><td>${r.month}</td><td>${escapeHtml(st?.name||r.empId||"-")}</td>
          <td>${r.count}</td><td>${money(r.sum)} AZN</td><td>${money(comm)} AZN</td>
          <td>${money(base)} AZN</td><td><strong>${money(yekun)} AZN</strong></td></tr>`;
      }).join("") + (rows.length ? `<tr class="total-row"><td colspan="4"><strong>Cəmi</strong></td>
        <td><strong>${money(totSales)} AZN</strong></td>
        <td><strong>${money(totCommOnly)} AZN</strong></td>
        <td></td><td><strong>${money(totYekun)} AZN</strong></td></tr>` : emptyRow(8));
    }
    setText("rv-spSales", money(totSales) + " AZN");
    setText("rv-spCount", String(salesAll.length));
    setText("rv-spComm", money(totCommOnly) + " AZN");

  } else if (view === "payments") {
    const SALE_PAY_KINDS = new Set(["sale","sale_info","debts_module","sale_payment","debtor_payment",
      "debtor_invoice_payment","monthly","down","sale_down","sale_monthly"]);
    const PURCH_PAY_KINDS = new Set(["purch_payment","purch_payment_adj","creditor_payment","creditor_invoice_payment"]);
    const allCash = (db.cash || []).filter((c) => !hasPeriod || inRange(c.date));
    const incoming = allCash.filter((c) => c.type === "in" && SALE_PAY_KINDS.has(String(c.link?.kind||"")));
    const outgoing = allCash.filter((c) => c.type === "out" && PURCH_PAY_KINDS.has(String(c.link?.kind||"")));
    const combined = [
      ...incoming.map((c) => ({ ...c, _dir: "in" })),
      ...outgoing.map((c) => ({ ...c, _dir: "out" }))
    ].sort((a, b) => (a.date > b.date ? -1 : 1));
    const totIn = incoming.reduce((a,c)=>a+n(c.amount),0);
    const totOut = outgoing.reduce((a,c)=>a+n(c.amount),0);
    setText("rv-payIn", money(totIn) + " AZN");
    setText("rv-payOut", money(totOut) + " AZN");
    setText("rv-payNet", money(totIn - totOut) + " AZN");
    setText("rv-payCount", String(combined.length));
    const body = byId("tblRepPayments");
    if (body) {
      body.innerHTML = combined.map((c, i) => {
        const isIn = c._dir === "in";
        const accName = (db.accounts||[]).find((a)=>a.uid===Number(c.accountId||1))?.name||"Kassa";
        // Try to find customer/supplier name from link
        let party = c.source || "-";
        const kind = String(c.link?.kind||"");
        let qaimə = "-";
        if (SALE_PAY_KINDS.has(kind) && c.link?.saleUid) {
          const s = (db.sales||[]).find((x)=>String(x.uid)===String(c.link.saleUid));
          if (s) { party = s.customerName; qaimə = s.invNo || invFallback("sales",s.uid); }
        } else if (PURCH_PAY_KINDS.has(kind) && c.link?.purchUid) {
          const p = (db.purch||[]).find((x)=>String(x.uid)===String(c.link.purchUid));
          if (p) { party = p.supp || "-"; qaimə = p.invNo || invFallback("purch",p.uid); }
        }
        const dirLabel = isIn ? "Satış ödənişi" : "Alış ödənişi";
        return `<tr><td>${i+1}</td><td>${fmtDT(c.date)}</td>
          <td><span class="pill ${isIn?"paid":"unpaid"}">${dirLabel}</span></td>
          <td>${escapeHtml(party)}</td><td>${escapeHtml(qaimə)}</td>
          <td class="${isIn?"amt-in":"amt-out"}">${isIn?"+":"-"}${money(c.amount)} AZN</td>
          <td>${escapeHtml(accName)}</td><td>${escapeHtml(c.note||"")}</td></tr>`;
      }).join("") + (combined.length ? `<tr class="total-row"><td colspan="5"><strong>Cəmi (${combined.length})</strong></td>
        <td><strong class="${(totIn-totOut)>=0?"amt-in":"amt-out"}">${money(totIn-totOut)} AZN</strong></td>
        <td colspan="2"></td></tr>` : emptyRow(8));
    }
  } else if (view === "founders") {
    if (!db.founders) db.founders = [];
    const allOps = (db.cash || []).filter((c) => ["owner_income","owner_expense","founder_income","founder_expense"].includes(String(c.link?.kind||"")));
    const periodOps = allOps.filter((c) => !hasPeriod || inRange(c.date));
    const totalShares = db.founders.reduce((a,f) => a + n(f.share||0), 0);

    const periodExpenses = (db.cash||[]).filter((c) => c.type === "out" && c.link?.kind === "expense" && (!hasPeriod || inRange(c.date))).reduce((a,c) => a+n(c.amount), 0);
    const periodPayroll = (db.cash||[]).filter((c) => c.type === "out" && ["salary","payroll"].includes(String(c.link?.kind||"")) && (!hasPeriod || inRange(c.date))).reduce((a,c) => a+n(c.amount), 0);
    const numFounders = db.founders.length || 1;
    const equalExpShare = (periodExpenses + periodPayroll) / numFounders;

    // === TAHAKKUq METODU ===
    const periodSales = (db.sales||[]).filter((s) => !s.returnedAt && (!hasPeriod || inRange(s.date)));
    const accrualSaleRev = periodSales.reduce((a,s) => a + n(s.amount), 0);
    const accrualCogs = periodSales.reduce((a,s) => {
      if (s.bulkPurchUid || (Array.isArray(s.bulkAllocations) && s.bulkAllocations.length)) {
        const purch = s.bulkAllocations?.length
          ? db.purch.find((x) => String(x.uid) === String(s.bulkAllocations[0].purchUid))
          : db.purch.find((x) => String(x.uid) === String(s.bulkPurchUid));
        const unit = purch ? n(purch.amount) / Math.max(1, Math.floor(n(purch.qty||1))) : 0;
        return a + unit * Math.max(1, Math.floor(n(s.qty||1)));
      }
      const p = db.purch.find((x) => itemKeyFromPurch(x) === s.itemKey);
      return a + (p ? n(p.amount) : 0);
    }, 0);
    const grossProfitAccrual = accrualSaleRev - accrualCogs;

    // === KASSA METODU ===
    const SALE_PAY_KINDS_FND = new Set(["sale","sale_info","debts_module","sale_payment","debtor_payment","debtor_invoice_payment","monthly","down","sale_down","sale_monthly"]);
    const cashSaleRev = (db.cash||[]).filter((c) => c.type === "in" && SALE_PAY_KINDS_FND.has(String(c.link?.kind||"")) && (!hasPeriod || inRange(c.date))).reduce((a,c) => a+n(c.amount), 0);
    const cashCogsRatio = accrualSaleRev > 0 ? (cashSaleRev / accrualSaleRev) : 0;
    const cashCogs = accrualCogs * cashCogsRatio;
    const grossProfitCash = cashSaleRev - cashCogs;

    function buildFounderRows(grossProfit, showActions) {
      let totCap = 0, totWit = 0, totPS = 0, totExp = 0, totNet = 0;
      const rows = db.founders.map((f, fi) => {
        const capital = periodOps.filter((c) => c.type === "in" && String(c.link?.founderId) === String(f.uid)).reduce((a,c) => a+n(c.amount), 0);
        const withdrawn = periodOps.filter((c) => c.type === "out" && String(c.link?.founderId) === String(f.uid)).reduce((a,c) => a+n(c.amount), 0);
        const share = n(f.share || 0);
        const profitShare = totalShares > 0 ? (grossProfit * share / totalShares) : 0;
        const expShare = equalExpShare;
        const net = profitShare - expShare;
        const remaining = net - withdrawn;
        totCap += capital; totWit += withdrawn; totPS += profitShare; totExp += expShare; totNet += net;
        const actions = showActions ? `<button class="btn-mini" onclick="openFounderForm(${fi})" title="Redaktə"><i class="fas fa-pen"></i></button>
          <button class="btn-mini" onclick="openFounderPayHistory(${fi})" title="Tarixçə"><i class="fas fa-clock-rotate-left"></i></button>
          <button class="btn-mini" onclick="openFounderCashOp(${fi},'in')" title="Sermayə qoy"><i class="fas fa-plus"></i></button>
          <button class="btn-mini" onclick="openFounderCashOp(${fi},'out')" title="Çəkmə"><i class="fas fa-minus"></i></button>` : "";
        return `<tr>
          <td>${fi+1}</td><td>${escapeHtml(f.name)}</td><td>${money(share)}%</td>
          <td>${money(capital)} AZN</td>
          <td class="${profitShare>=0?"amt-in":"amt-out"}">${money(profitShare)} AZN</td>
          <td class="amt-out">${money(expShare)} AZN</td>
          <td class="${net>=0?"amt-in":"amt-out"}"><strong>${money(net)} AZN</strong></td>
          <td class="amt-out">${money(withdrawn)} AZN</td>
          <td class="${remaining>=0?"amt-in":"amt-out"}"><strong>${money(remaining)} AZN</strong></td>
          ${showActions ? `<td class="tbl-actions">${actions}</td>` : ""}
        </tr>`;
      }).join("");
      const totRemaining = totNet - totWit;
      const cols = showActions ? 10 : 9;
      const totalRow = db.founders.length
        ? `<tr class="total-row"><td colspan="3"><strong>Cəmi</strong></td>
            <td><strong>${money(totCap)} AZN</strong></td>
            <td><strong class="${totPS>=0?"amt-in":"amt-out"}">${money(totPS)} AZN</strong></td>
            <td><strong class="amt-out">${money(totExp)} AZN</strong></td>
            <td><strong class="${totNet>=0?"amt-in":"amt-out"}">${money(totNet)} AZN</strong></td>
            <td><strong class="amt-out">${money(totWit)} AZN</strong></td>
            <td><strong class="${totRemaining>=0?"amt-in":"amt-out"}">${money(totRemaining)} AZN</strong></td>
            ${showActions ? "<td></td>" : ""}
           </tr>`
        : `<tr><td colspan="${cols}">Təsisçi yoxdur.</td></tr>`;
      return { html: rows + totalRow, totCap, totWit, totPS, totNet };
    }

    const cashResult = buildFounderRows(grossProfitCash, true);
    const accrualResult = buildFounderRows(grossProfitAccrual, false);

    setText("rv-fndIn", money(grossProfitCash) + " AZN");
    setText("rv-fndIn2", money(grossProfitAccrual) + " AZN");
    setText("rv-fndOut", money(cashResult.totWit) + " AZN");
    setText("rv-fndExpShare", money(cashResult.totCap) + " AZN");
    setText("rv-fndNet", money(cashResult.totNet) + " AZN");
    setText("rv-fndCount", String(db.founders.length));
    const fBody = byId("tblRepFounders");
    if (fBody) fBody.innerHTML = cashResult.html;
    const fBody2 = byId("tblRepFoundersAccrual");
    if (fBody2) fBody2.innerHTML = accrualResult.html;

    // ops table
    const opsBody = byId("tblRepFounderOps");
    if (opsBody) {
      opsBody.innerHTML = periodOps.slice().sort((a,b) => (a.date>b.date?-1:1)).map((c,i) => {
        const f = db.founders.find((x) => String(x.uid) === String(c.link?.founderId));
        return `<tr><td>${i+1}</td><td>${fmtDT(c.date)}</td>
          <td><span class="pill ${c.type==="in"?"partial":"unpaid"}">${c.type==="in"?"Qoyulan sermayə":"Çəkilən"}</span></td>
          <td>${escapeHtml(f?.name||c.source||"-")}</td>
          <td class="${c.type==="in"?"":"amt-out"}">${c.type==="in"?"+":"-"}${money(c.amount)} AZN</td>
          <td>${escapeHtml(c.note||"")}</td></tr>`;
      }).join("") || `<tr><td colspan="6">Bu dövr üçün əməliyyat yoxdur</td></tr>`;
    }
  }
}

function setText(id, val) {
  const el = byId(id); if (el) el.innerText = val;
}

function ensureFounders() { if (!db.founders) db.founders = []; }

function openFounderForm(idx = null) {
  if (!userCanEdit()) return alert("Redaktə icazəsi yoxdur.");
  ensureFounders();
  const f = idx !== null ? db.founders[idx] : { name: "", share: "", note: "" };
  openModal(`
    <h2>${idx !== null ? "Təsisçi redaktə" : "Yeni Təsisçi"}</h2>
    <form onsubmit="saveFounder(event, ${idx})">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Məlumat</div>
          <div class="grid-2">
            <div class="f-group"><label>Ad Soyad *</label><input id="fnd_name" value="${escapeHtml(f.name||"")}" required placeholder="Ad Soyad"></div>
            <div class="f-group"><label>Faiz payı (%)</label><input type="number" step="0.01" min="0" max="100" id="fnd_share" value="${escapeHtml(String(f.share||""))}" placeholder="məs: 50"></div>
            <div class="f-group grid-span-2"><label>Qeyd</label><input id="fnd_note" value="${escapeHtml(f.note||"")}" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Əlavə et"}</button>
        ${idx !== null && userCanDelete("founders") ? `<button class="btn-cancel" type="button" onclick="deleteFounder(${idx})">Sil</button>` : ""}
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveFounder(e, idx) {
  e.preventDefault();
  ensureFounders();
  const name = val("fnd_name").trim();
  if (!name) return;
  const share = Math.max(0, n(val("fnd_share")));
  const note = val("fnd_note").trim();
  if (idx !== null) {
    db.founders[idx] = { ...db.founders[idx], name, share, note };
  } else {
    db.founders.push({ uid: genId(db.founders, 1), name, share, note, createdAt: nowISODateTimeLocal() });
  }
  logEvent(idx !== null ? "update" : "create", "founders", { name });
  saveDB(); closeMdl(); setRepView("founders");
}

function deleteFounder(idx) {
  if (!userCanDelete("founders")) return;
  appConfirm("Bu təsisçi silinsin?").then((ok) => { if (!ok) return; db.founders.splice(idx, 1); saveDB(); closeMdl(); setRepView("founders"); });
}

function openFounderCashOp(founderIdx, direction) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  ensureFounders();
  const f = db.founders[founderIdx];
  if (!f) return;
  const accOptions = accountOptionsHtml(1);
  openModal(`
    <h2>Təsisçi ${direction === "in" ? "Sermayə qoyuluşu" : "Məxaric (çəkmə)"} — ${escapeHtml(f.name)}</h2>
    <form onsubmit="saveFounderCashOp(event, ${founderIdx}, '${direction}')">
      <div class="form-stack">
        <div class="form-card">
          <div class="grid-2">
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="fnd_op_amount" placeholder="0.00" required></div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="fnd_op_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Hesab</label><select id="fnd_op_acc">${accOptions}</select></div>
            <div class="f-group"><label>Qeyd</label><input id="fnd_op_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveFounderCashOp(e, founderIdx, direction) {
  e.preventDefault();
  ensureFounders();
  const f = db.founders[founderIdx];
  if (!f) return;
  const amount = Math.max(0, n(val("fnd_op_amount")));
  if (!amount) return;
  const date = val("fnd_op_date");
  const note = val("fnd_op_note");
  const accId = Number(val("fnd_op_acc") || 1);
  if (direction === "out") {
    const bal = accountBalance(accId);
    if (bal + 0.000001 < amount) return alert("Balans kifayət etmir.");
  }
  addCashOp({
    type: direction,
    date,
    source: `Təsisçi ${direction === "in" ? "mədaxil" : "məxaric"} — ${f.name}`,
    amount,
    note,
    link: { kind: direction === "in" ? "founder_income" : "founder_expense", founderId: f.uid },
    accountId: accId,
  });
  logEvent("create", "cash", { kind: direction === "in" ? "founder_income" : "founder_expense", founderId: f.uid, amount });
  saveDB(); closeMdl(); setRepView("founders");
}

function openFounderPayHistory(founderIdx) {
  ensureFounders();
  const f = db.founders[founderIdx];
  if (!f) return;
  const ops = (db.cash || []).filter((c) => String(c.link?.founderId) === String(f.uid))
    .slice().sort((a,b) => (a.date>b.date?-1:1));
  const rows = ops.map((c,i) => `<tr>
    <td>${i+1}</td><td>${fmtDT(c.date)}</td>
    <td><span class="pill ${c.type==="in"?"partial":"unpaid"}">${c.type==="in"?"Qoyulan sermayə":"Çəkilən"}</span></td>
    <td class="${c.type==="in"?"":"amt-out"}">${c.type==="in"?"+":"-"}${money(c.amount)} AZN</td>
    <td>${escapeHtml((db.accounts||[]).find((a)=>a.uid===Number(c.accountId||1))?.name||"Kassa")}</td>
    <td>${escapeHtml(c.note||"")}</td></tr>`).join("");
  openModal(`
    <h2>Ödəniş tarixçəsi — ${escapeHtml(f.name)}</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Faiz payı</div><div class="info-value">${money(n(f.share))}%</div></div>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>#</th><th>Tarix</th><th>Növ</th><th>Məbləğ</th><th>Hesab</th><th>Qeyd</th></tr></thead>
      <tbody>${rows||`<tr><td colspan="6">Tarixçə boşdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer"><button class="btn-cancel" onclick="closeMdl()">Bağla</button></div>
  `);
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
      softLoadingBegin(true);
      ref
        .set(data)
        .catch((e) => console.warn("Firestore meta yazma xətası:", e))
        .finally(() => {
          softLoadingEnd();
          updateLastSavedEl();
        });
    }
    localStorage.setItem(META_KEY, JSON.stringify(meta));
    if (ref) return;
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
  const comp = (meta?.companies || []).find((c) => c.id === (meta?.session?.companyId || ""));
  const company = String(db.settings?.companyName || comp?.name || "").trim();
  return company && un ? `${company}_${un}` : un || "-";
}

function currentActorName() {
  return userDisplay(currentUser()) || "-";
}

function currentUserStaffId() {
  const user = currentUser();
  if (!user) return "";
  const staffUid = user.staffUid;
  if (staffUid != null && staffUid !== "") {
    const staff = (db.staff || []).find((s) => String(s.uid) === String(staffUid));
    if (staff) return String(staff.uid);
  }
  // staffUid bağlı deyilsə, tam adla eşləşdirməyə cəhd et
  const fullName = String(user.fullName || "").trim().toLowerCase();
  if (fullName) {
    const byName = (db.staff || []).find((s) => String(s.name || "").trim().toLowerCase() === fullName);
    if (byName) return String(byName.uid);
  }
  return "";
}

function canChangeSaleStaff() {
  return isAdmin() || isDeveloper();
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
  // Şirkətlər və Dev alətləri yalnız developer üçün (admin və user görməz).
  if (sectionId === "companies" || sectionId === "tools") return isDeveloper();
  // Ayarlar bölməsi admin və developer üçün
  if (sectionId === "settings") return isAdmin() || isDeveloper();
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
  const d2 = a.details && typeof a.details === "object" ? a.details : {};
  const auditTargetLabelM = { sales: "Satış", purch: "Alış", cash: "Kassa", cust: "Müştəri", supp: "Təchizatçı", prod: "Məhsul", staff: "Əməkdaş", accounts: "Hesab", users: "İstifadəçi", company: "Şirkət", settings: "Ayarlar", trash: "Səbət" };
  const detailFields = Object.entries(d2).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `<div class="info-row"><div class="info-label" style="text-transform:capitalize">${escapeHtml(k)}</div><div class="info-value">${escapeHtml(String(v))}</div></div>`).join("");
  openModal(`
    <h2>Audit detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Tarix</div><div class="info-value">${fmtDT(a.ts)}</div></div>
      <div class="info-row"><div class="info-label">İstifadəçi</div><div class="info-value">${escapeHtml(a.user || "-")}</div></div>
      <div class="info-row"><div class="info-label">Əməliyyat</div><div class="info-value">${escapeHtml(a.action || "-")}</div></div>
      <div class="info-row"><div class="info-label">Hədəf</div><div class="info-value">${escapeHtml(auditTargetLabelM[a.target] || a.target || "-")}</div></div>
      <div class="info-row"><div class="info-label">Açıqlama</div><div class="info-value">${escapeHtml(explain)}</div></div>
    </div>
    ${detailFields ? `<div class="info-block"><div class="info-row"><div class="info-label" style="font-weight:600">Məlumatlar</div><div class="info-value"></div></div>${detailFields}</div>` : ""}
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
  document.querySelectorAll(".admin-not-dev").forEach((el) => {
    el.style.display = admin && !dev ? "flex" : "none";
  });

  // Hide sections the user can't access (nav links)
  document.querySelectorAll(".nav-link[data-sec]").forEach((el) => {
    const secId = el.getAttribute("data-sec");
    if (!secId) return;
    if (el.classList.contains("dev-only") || el.classList.contains("admin-only") || el.classList.contains("dev-sub")) return;
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
  const keyMap = {
    debts: "page_debts_deb",
    overdue: "page_debts_loans",
    creditor: "page_debts_cred",
    companies: "nav_companies",
    tools: "nav_tools",
    users: "nav_users",
    trash: "nav_trash",
    accounts: "nav_accounts",
    profile: "nav_profile",
  };
  const k = keyMap[id] || `nav_${id}`;
  const tr = t(k);
  if (tr !== k) return tr;
  return id;
}

function showLoginOverlay(show) {
  const ov = byId("loginOverlay");
  const landing = byId("publicLanding");
  if (!ov) return;
  if (show) {
    forceCloseModal();
    try {
      closeSpotlight();
    } catch (e) {}
    closeProfileMenu();
    closeMobileSidebar();
    document.body.classList.remove("landing-login-open");
  }
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
    loadCompanyDBAsync({ soft: true }).then((data) => {
      db = data;
      unsubscribeRealtime();
      subscribeRealtime();
      startRealtimeAutoRefresh();
      showLoginOverlay(false);
      applyAccessUI();
      logEvent("login", "auth", { companyId: c.id });
      renderSidebarUser();
      refreshHeaderBar();
      renderAll();
      showDashboardAfterLogin();
      checkSubscriptionStatus();
    });
  } else {
    db = loadCompanyDB();
    showLoginOverlay(false);
    applyAccessUI();
    logEvent("login", "auth", { companyId: c.id });
    renderSidebarUser();
    refreshHeaderBar();
    renderAll();
    showDashboardAfterLogin();
    checkSubscriptionStatus();
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

function logoutFromDisabled() {
  ["compDisabledOverlay","subSuspendOverlay","subWarningPopup"].forEach(id => {
    const e = byId(id); if (e) e.remove();
  });
  logout();
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
  try {
    if (location.hash && /^#\/[a-z0-9_]+$/i.test(location.hash)) {
      history.replaceState(null, "", location.pathname + (location.search || ""));
    }
  } catch (e) {}
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

function saleInvPrefix(saleType) {
  const map = { nagd: "NS", post: "PS", post_taksit: "TKS", topdan: "TS", korporativ: "KPS", kredit: "KS", kocurme: "NS" };
  return map[String(saleType || "").toLowerCase()] || "NS";
}

function nextInvNo(kind, saleType) {
  ensureCounters();
  if (kind === "purch") {
    const n0 = db.counters.purchInv++;
    return "AL-" + String(n0).padStart(3, "0");
  }
  const prefix = saleInvPrefix(saleType);
  const n0 = db.counters.salesInv++;
  return prefix + "-" + String(n0).padStart(3, "0");
}
function previewInvNo(kind, saleType) {
  ensureCounters();
  if (kind === "purch") return "AL-" + String(db.counters.purchInv || 1).padStart(3, "0");
  const prefix = saleInvPrefix(saleType);
  return prefix + "-" + String(db.counters.salesInv || 1).padStart(3, "0");
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
  const needsPurch = (db.purch || []).some((p) => !/^[A-Z]+-\d+$/.test(String(p.invNo || "").trim()));
  const needsSales = (db.sales || []).some((s) => !/^[A-Z]+-\d+$/.test(String(s.invNo || "").trim()));
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
  requestAnimationFrame(() => syncSlideoverContentPad());
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
  if (ov) {
    ov.classList.toggle("hidden", !show);
    ov.classList.toggle("loading-overlay--soft", !show);
  }
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
      const comp = (meta?.companies || []).find((c) => c.id === (meta?.session?.companyId || ""));
      const compName = String(db.settings?.companyName || comp?.name || "").trim();
      titleEl.textContent = compName;
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
      action: () => goSecWithLoad("overdue", null),
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
      action: () => goSecWithLoad("stock", findNavLinkForSection("stock")),
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

/** URL: #/dash, #/sales, … — sorğu sətri (dərin keçid) ayrıca emal olunur. */
function parseAppSectionFromHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  const pathOnly = raw.split("?")[0] || "";
  const m = pathOnly.match(/^\/([a-z][a-z0-9_]*)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Məs: #/cust?o=custInfo&v=3 */
function parseHashRouteQuery() {
  const raw = String(location.hash || "").replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  const pathPart = (qIdx >= 0 ? raw.slice(0, qIdx) : raw) || "";
  const m = pathPart.match(/^\/([a-z][a-z0-9_]*)$/i);
  if (!m) return null;
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
  let params;
  try {
    params = new URLSearchParams(queryPart);
  } catch {
    return { sec: m[1].toLowerCase(), op: null, v: null };
  }
  return {
    sec: m[1].toLowerCase(),
    op: params.get("o"),
    v: params.get("v"),
  };
}

function erpOpHref(sec, op, v) {
  const s = String(sec || "").toLowerCase();
  const o = String(op || "");
  return "#/" + s + "?o=" + encodeURIComponent(o) + "&v=" + encodeURIComponent(v == null ? "" : String(v));
}

function stripDeepLinkFromHash(sec) {
  const s = String(sec || "").toLowerCase();
  try {
    history.replaceState(null, "", location.pathname + (location.search || "") + "#/" + s);
  } catch (e) {
    try {
      location.hash = "#/" + s;
    } catch (e2) {}
  }
}

function consumeHashDeepLink() {
  if (!meta?.session) return;
  const parsed = parseHashRouteQuery();
  if (!parsed || !parsed.op || parsed.v == null || parsed.v === "") return;
  const { sec, op, v } = parsed;
  const run = () => {
    try {
      switch (op) {
        case "custInfo":
          openCustInfo(Number(v));
          break;
        case "custEdit":
          openCust(Number(v));
          break;
        case "suppInfo":
          openSuppInfo(Number(v));
          break;
        case "suppEdit":
          openSupp(Number(v));
          break;
        case "prodEdit":
          openProd(Number(v));
          break;
        case "saleInfo":
          openSaleInfo(Number(v));
          break;
        case "saleEdit":
          openSale(Number(v));
          break;
        case "staffEdit":
          openStaff(Number(v));
          break;
        case "purchEdit":
          openPurch(Number(v));
          break;
        case "purchInfoInv":
          openPurchInfoByInv(v);
          break;
        case "purchInvEdit":
          openPurchInvoiceEdit(v);
          break;
        case "cashInfo":
          openCashInfo(Number(v));
          break;
        case "cashEdit":
          openEditCashOp(Number(v));
          break;
        case "accountEdit":
          openAccount(Number(v));
          break;
        case "companyEdit":
          openCompany(Number(v));
          break;
        case "userEdit":
          openUser(v);
          break;
        case "debtorInfo":
          openDebtorInfo(v);
          break;
        case "overdueInfo":
          openOverdueInfo(v);
          break;
        case "creditorInfo":
          openCreditorInfo(Number(v));
          break;
        case "auditView":
          openAuditDetails(Number(v));
          break;
        case "repView":
          setRepView(v);
          break;
        default:
          return;
      }
      stripDeepLinkFromHash(sec);
    } catch (e) {
      console.warn("Dərin keçid:", e);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function bindSidebarNavClicks() {
  if (window.__sidebarNavClicksBound) return;
  window.__sidebarNavClicksBound = true;
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("aside nav .nav-link[data-sec]");
      if (!btn || btn.tagName !== "BUTTON") return;
      e.preventDefault();
      const id = btn.getAttribute("data-sec");
      if (!id) return;
      if (!meta?.session) {
        showLoginOverlay(true);
        return;
      }
      if (!userCanSection(id)) {
        alert("Bu bölməyə icazə yoxdur.");
        return;
      }
      goSecWithLoad(id, btn);
    },
    true
  );
}

function isValidAppSection(id) {
  const el = typeof id === "string" && id ? document.getElementById(id) : null;
  return !!(el && el.classList && el.classList.contains("section"));
}

function findNavLinkForSection(id) {
  if (!id || !/^[a-z][a-z0-9_]*$/i.test(id)) return null;
  try {
    return document.querySelector(`aside nav .nav-link[data-sec="${id}"]`);
  } catch {
    return null;
  }
}

function syncAppSectionHash(id) {
  if (!meta?.session || !id) return;
  const want = "#/" + id;
  if (location.hash === want) return;
  try {
    history.replaceState(null, "", location.pathname + (location.search || "") + want);
  } catch (e) {
    try {
      location.hash = want;
    } catch (e2) {}
  }
}

function onErpHashChange() {
  if (!meta?.session) return;
  const id = parseAppSectionFromHash();
  if (!id || !isValidAppSection(id)) return;
  if (!userCanSection(id)) {
    alert("Bu bölməyə icazə yoxdur.");
    const dn = findNavLinkForSection("dash");
    withSectionLoading(() => {
      showSec("dash", dn || null, { skipHash: true });
      syncAppSectionHash("dash");
      renderAll();
    });
    return;
  }
  const nav = findNavLinkForSection(id);
  withSectionLoading(() => {
    showSec(id, nav || null, { skipHash: true });
    renderAll();
    consumeHashDeepLink();
  });
}

function showSec(id, el, opts) {
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
  // Sync mobile tab bar active state
  document.querySelectorAll(".mob-tab").forEach((t) => {
    t.classList.toggle("active", t.getAttribute("data-sec") === id);
  });
  if (id === "debts") {
    document.querySelectorAll(".debt-type-select").forEach((s) => {
      s.value = "";
    });
    updateDebtSubSelectVisibility("");
    updateDebtSubEnabled();
    updateDebtSectionVisibility();
  }
  if (id === "settings") renderSettingsPage();
  if (id === "cash") setCashDateToToday();
  refreshHeaderBar();
  if (meta?.session) try { sessionStorage.setItem("bakfon_lastSection", id); } catch (e) {}
  if (meta?.session && !(opts && opts.skipHash)) syncAppSectionHash(id);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function setCashDateToToday() {
  const today = todayISO();
  const fromEl = byId("cashFrom");
  const toEl   = byId("cashTo");
  if (fromEl && !fromEl.value) fromEl.value = today;
  if (toEl   && !toEl.value)   toEl.value   = today;
}

// Gecə yarısı kassa tarixini yeni günə keçir
(function scheduleCashMidnightReset() {
  function msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 1);
    return midnight - now;
  }
  function resetAndReschedule() {
    const today = todayISO();
    const fromEl = byId("cashFrom");
    const toEl   = byId("cashTo");
    if (fromEl) { fromEl.value = today; }
    if (toEl)   { toEl.value   = today; }
    renderAll();
    setTimeout(resetAndReschedule, msUntilMidnight());
  }
  setTimeout(resetAndReschedule, msUntilMidnight());
})();

function showDashboardAfterLogin() {
  if (!meta?.session) return;
  bindSidebarNavClicks();
  const fromHash = parseAppSectionFromHash();
  if (fromHash && isValidAppSection(fromHash) && userCanSection(fromHash)) {
    const nav = findNavLinkForSection(fromHash);
    showSec(fromHash, nav || null, { skipHash: true });
    try {
      sessionStorage.setItem("bakfon_lastSection", fromHash);
    } catch (e) {}
    requestAnimationFrame(() => consumeHashDeepLink());
    return;
  }
  try {
    sessionStorage.setItem("bakfon_lastSection", "dash");
  } catch (e) {}
  const dashNav = findNavLinkForSection("dash");
  showSec("dash", dashNav || null, { skipHash: true });
  syncAppSectionHash("dash");
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
  return 9999;
}

function parseDateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  // dd.mm.yyyy
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) {
    const [d, m, y] = s.split(".").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  // yyyy-mm-dd
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function formatDateInput(el) {
  let v = el.value.replace(/[^\d]/g, "").slice(0, 8);
  if (v.length >= 5) v = v.slice(0, 2) + "." + v.slice(2, 4) + "." + v.slice(4);
  else if (v.length >= 3) v = v.slice(0, 2) + "." + v.slice(2);
  el.value = v;
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
    ? `<div class="modal-nav-top"><button class="btn-back" type="button" onclick="modalBack()"><i class="fas fa-chevron-left"></i></button></div>`
    : "";
  return `${nav}${rawHtml}`;
}
/** Məzmunu scroll olunan qatda saxlayır, footer həmişə panelin altında, mətnin üstünə çıxmır */
function layoutModalScrollShell(root) {
  if (!root || root.querySelector(":scope > .modal-body-inner")) return;
  const directFooter = root.querySelector(":scope > .modal-footer");
  const form = root.querySelector(":scope > form");
  const formFooter = form && form.querySelector(":scope > .modal-footer");
  const footer = directFooter || formFooter;
  const host = directFooter ? root : form;
  if (!footer || !host) return;
  const inner = document.createElement("div");
  inner.className = "modal-body-inner";
  let n = host.firstChild;
  while (n && n !== footer) {
    const next = n.nextSibling;
    const leaveNavTop =
      host === root &&
      n.nodeType === 1 &&
      n.classList &&
      n.classList.contains("modal-nav-top");
    if (!leaveNavTop) inner.appendChild(n);
    n = next;
  }
  if (inner.childNodes.length) host.insertBefore(inner, footer);
}

/** Köhnə sessiyalar üçün --slideover-pad-left təmizlənir (padding indi yalnız CSS --so-pad-x). */
function syncSlideoverContentPad() {
  document.getElementById("modalContent")?.style.removeProperty("--slideover-pad-left");
}

function openModal(html, opts = {}) {
  const body = document.getElementById("modalContent");
  if (!body) return;
  const slideover = !opts.popup;
  const slideLoadT0 = slideover ? Date.now() : 0;
  if (slideover) softLoadingBegin(true);
  try {
    const now = Date.now();
    const alreadyOpen = modal.style.display === "flex";
    const justClosed = window.__modalJustClosedAt && now - window.__modalJustClosedAt < 350;
    const curRaw = window.__currentModalRaw || "";
    if ((alreadyOpen || justClosed) && curRaw) {
      window.__modalHistory = window.__modalHistory || [];
      window.__modalHistory.push(curRaw);
      window.__modalClassHistory = window.__modalClassHistory || [];
      window.__modalClassHistory.push(modal.classList.contains("modal--slideover") ? "slideover" : "popup");
    } else if (!alreadyOpen) {
      window.__modalHistory = [];
      window.__modalClassHistory = [];
    }
    window.__currentModalRaw = html;
    body.innerHTML = renderModalWithNav(html);
    layoutModalScrollShell(body);
    // popup (xəbərdarlıq) vs slide-over
    if (opts.popup) {
      modal.classList.add("modal--popup");
      modal.classList.remove("modal--slideover");
      body.style.removeProperty("--slideover-pad-left");
    } else {
      modal.classList.add("modal--slideover");
      modal.classList.remove("modal--popup");
    }
    modal.style.display = "flex";
    // slide-in animasiya trigger + başlıq xətti (main-area / header ilə sinxron)
    requestAnimationFrame(() => {
      modal.classList.add("modal--open");
      if (!opts.popup) syncSlideoverContentPad();
    });
    window.__modalJustClosedAt = 0;
  } finally {
    if (slideover) {
      const finish = () => {
        const wait = Math.max(0, MODAL_SLIDEOVER_LOAD_MIN_MS - (Date.now() - slideLoadT0));
        setTimeout(() => softLoadingEnd(), wait);
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
    }
  }
}
function modalBack() {
  const body = document.getElementById("modalContent");
  const hist = window.__modalHistory || [];
  if (!body || !hist.length) return;
  const prevRaw = hist.pop();
  const prevClass = (window.__modalClassHistory || []).pop() || "slideover";
  const prevIsSlideover = prevClass === "slideover";
  const slideBackT0 = prevIsSlideover ? Date.now() : 0;
  if (prevIsSlideover) softLoadingBegin(true);
  try {
    window.__currentModalRaw = prevRaw;
    body.innerHTML = renderModalWithNav(prevRaw);
    layoutModalScrollShell(body);
    // əvvəlki modal-ın class-ını bərpa et
    if (prevIsSlideover) {
      modal.classList.add("modal--slideover");
      modal.classList.remove("modal--popup");
    } else {
      modal.classList.add("modal--popup");
      modal.classList.remove("modal--slideover");
    }
    modal.style.display = "flex";
    modal.classList.add("modal--open");
  } finally {
    if (prevIsSlideover) {
      requestAnimationFrame(() => {
        syncSlideoverContentPad();
        requestAnimationFrame(() => {
          const wait = Math.max(0, MODAL_SLIDEOVER_LOAD_MIN_MS - (Date.now() - slideBackT0));
          setTimeout(() => softLoadingEnd(), wait);
        });
      });
    }
  }
  if (byId("mdlAccountsTbl")) {
    requestAnimationFrame(() => renderAccountsManagerTable());
  }
}
function closeMdl() {
  modal.classList.remove("modal--open");
  window.__modalJustClosedAt = Date.now();
  setTimeout(() => {
    const stillClosed = !modal.classList.contains("modal--open");
    if (stillClosed) {
      modal.style.display = "none";
      modal.classList.remove("modal--slideover", "modal--popup");
      document.getElementById("modalContent")?.style.removeProperty("--slideover-pad-left");
    }
    if (stillClosed && window.__modalJustClosedAt && Date.now() - window.__modalJustClosedAt >= 320) {
      window.__modalHistory = [];
      window.__modalClassHistory = [];
      window.__currentModalRaw = "";
    }
  }, 300);
}

/** Modal #appShell-dən kənarda olduğu üçün çıxış/giriş ekranında da qala bilər — dərhal təmizlə. */
function forceCloseModal() {
  const m = document.getElementById("mdlMain");
  if (!m) return;
  m.classList.remove("modal--open", "modal--slideover", "modal--popup");
  m.style.display = "none";
  document.getElementById("modalContent")?.style.removeProperty("--slideover-pad-left");
  window.__modalHistory = [];
  window.__modalClassHistory = [];
  window.__currentModalRaw = "";
  window.__modalJustClosedAt = Date.now();
}

function popupDismiss() {
  if ((window.__modalHistory || []).length) modalBack();
  else closeMdl();
}

function appAlert(msg, title = "Bildiriş") {
  const text = msg == null ? "" : String(msg);
  return new Promise((resolve) => {
    const dismiss = () => { el.remove(); resolve(); };
    const el = document.createElement("div");
    el.className = "ios-dialog-overlay";
    el.innerHTML = `
      <div class="ios-dialog">
        <div class="ios-dialog-title">${escapeHtml(title)}</div>
        ${text ? `<div class="ios-dialog-msg">${escapeHtml(text)}</div>` : ""}
        <div class="ios-dialog-btns">
          <button class="ios-btn-ok">Tamam</button>
        </div>
      </div>`;
    el.querySelector(".ios-btn-ok").onclick = dismiss;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") dismiss(); });
    document.body.appendChild(el);
    el.querySelector("button").focus();
  });
}

function appConfirm(msg, title = "Təsdiq") {
  const text = msg == null ? "" : String(msg);
  return new Promise((resolve) => {
    const close = (v) => { el.remove(); resolve(v); };
    const el = document.createElement("div");
    el.className = "ios-dialog-overlay";
    el.innerHTML = `
      <div class="ios-dialog">
        <div class="ios-dialog-title">${escapeHtml(title)}</div>
        ${text ? `<div class="ios-dialog-msg">${escapeHtml(text)}</div>` : ""}
        <div class="ios-dialog-btns">
          <button class="ios-btn-confirm">Bəli</button>
          <button class="ios-btn-cancel">Ləğv et</button>
        </div>
      </div>`;
    el.querySelector(".ios-btn-cancel").onclick = () => close(false);
    el.querySelector(".ios-btn-confirm").onclick = () => close(true);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    });
    document.body.appendChild(el);
    el.querySelector(".ios-btn-cancel").focus();
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Qeyd mətni</div>
          <div class="grid-2">
            <div class="f-group f-group--note"><label>Qeyd *</label><textarea id="appRequireNoteInput" placeholder="Qeyd yazın…" style="min-height:110px;"></textarea></div>
          </div>
        </div>
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
  const TARGET_SCHEMA_VERSION = 3;
  let ver = Math.max(0, Math.floor(n(db.settings.__schemaVersion || 0)));
  let changed = false;

  // v1: normalize all existing credit sales for cent-accurate schedule behavior
  if (ver < 1) {
    const did = runCreditRoundingMigration();
    if (did) {
      logEvent("update", "tools", { kind: "credit_round_migration_v2" });
      changed = true;
    }
    db.settings.__creditRoundV2 = true;
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

  // v3: backfill missing default fields from recent features
  if (ver < 3) {
    // telegramEnabled default: true (existing companies that had Telegram set up keep working)
    if (db.settings.telegramEnabled === undefined) {
      db.settings.telegramEnabled = !!(db.settings.telegramToken && db.settings.telegramChatId);
      changed = true;
    }
    // paymentAccountId default on sales missing it
    for (const s of (db.sales || [])) {
      if (s.paymentAccountId == null) { s.paymentAccountId = 1; changed = true; }
    }
    // paymentAccountId default on purchases missing it
    for (const p of (db.purch || [])) {
      if (p.paymentAccountId == null) { p.paymentAccountId = 1; changed = true; }
    }
    // cash ops: ensure accountId exists
    for (const c of (db.cash || [])) {
      if (c.accountId == null) { c.accountId = 1; changed = true; }
    }
    if (changed) logEvent("update", "tools", { kind: "defaults_backfill_v3" });
    ver = 3;
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şəxsi məlumat</div>
          <div class="grid-2">
            <div class="f-group"><label>Soyad *</label><input id="f_sur" value="${escapeHtml(c.sur)}" placeholder="Soyad" required></div>
            <div class="f-group"><label>Ad *</label><input id="f_name" value="${escapeHtml(c.name)}" placeholder="Ad" required></div>
            <div class="f-group"><label>Ata adı</label><input id="f_father" value="${escapeHtml(c.father)}" placeholder="Ata adı"></div>
            <div class="f-group"><label>FİN *</label><input id="f_fin" value="${escapeHtml(c.fin)}" placeholder="FİN" maxlength="7" required></div>
            <div class="f-group"><label>Şəxsiyyət seriya №</label><input id="f_ser" value="${escapeHtml(c.seriaNum)}" placeholder="AA1234567"></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Əlaqə</div>
          <div class="grid-2">
            <div class="f-group"><label>Mobil 1 *</label><input id="f_ph1" value="${escapeHtml(c.ph1)}" placeholder="+994 xx xxx xx xx" required></div>
            <div class="f-group"><label>Mobil 2</label><input id="f_ph2" value="${escapeHtml(c.ph2 || "")}" placeholder="+994 xx xxx xx xx"></div>
            <div class="f-group"><label>Mobil 3</label><input id="f_ph3" value="${escapeHtml(c.ph3 || "")}" placeholder="+994 xx xxx xx xx"></div>
            <div class="f-group"><label>İş yeri</label><input id="f_work" value="${escapeHtml(c.work || "")}" placeholder="Şirkət / müəssisə"></div>
            <div class="f-group"><label>Ünvan</label><textarea id="f_addr" rows="3" placeholder="Yaşayış ünvanı">${escapeHtml(c.addr || "")}</textarea></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Digər</div>
          <div class="grid-2">
            <div class="f-group"><label>Zamin</label><select id="f_zam">${guarantorOptions}</select></div>
            <div class="f-group"><label>Kredit limit (AZN)</label><input type="number" step="0.01" id="f_climit" value="${escapeAttr(String(c.creditLimit ?? "0"))}" placeholder="0 = limitsiz"></div>
          </div>
        </div>
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
      softLoadingBegin(true);
      try {
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
      } finally {
        softLoadingEnd();
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şirkət məlumatları</div>
          <div class="grid-2">
            <div class="f-group"><label>Şirkət adı *</label><input id="f_co" value="${escapeHtml(s.co)}" placeholder="Şirkət / Fərdi sahibkar" required></div>
            <div class="f-group"><label>Məsul şəxs</label><input id="f_per" value="${escapeHtml(s.per)}" placeholder="Ad Soyad"></div>
            <div class="f-group"><label>Mobil</label><input id="f_mob" value="${escapeHtml(s.mob)}" placeholder="+994 xx xxx xx xx"></div>
            <div class="f-group"><label>VÖEN</label><input id="f_voen" value="${escapeHtml(s.voen)}" placeholder="1234567890"></div>
          </div>
        </div>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Məhsul</div>
          <div class="grid-2">
            <div class="f-group"><label>Məhsul adı *</label><input id="f_p_name" value="${escapeHtml(p.name)}" placeholder="Məhsul Adı" required></div>
            <div class="f-group"><label>Kateqoriya</label><input id="f_p_cat" value="${escapeHtml(p.cat || "")}" placeholder="məs: Telefon, Aksessuar"></div>
            <div class="f-group"><label>Alt kateqoriya</label><input id="f_p_subcat" value="${escapeHtml(p.subCat || "")}" placeholder="məs: iPhone, Samsung"></div>
          </div>
        </div>
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
  const staffName = staff ? staff.name : (p.employeeName || "");
  const actorLabel = operationActorName(p, staffName) || "-";
  const payTypeLabel = { nagd: "Nağd", kocurme: "Köçürmə", kredit: "Kredit" }[String(p.payType || "").toLowerCase()] || (p.payType || "-");
  const paymentTypeLabel = { resmi: "Rəsmi", qeyri_resmi: "Qeyri-Rəsmi" }[p.paymentType || ""] || "-";
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
      <div class="info-row"><div class="info-label">Rəsmilik</div><div class="info-value">${escapeHtml(paymentTypeLabel)}</div></div>
      <div class="info-row"><div class="info-label">Ödənilən (AZN)</div><div class="info-value">${money(p.paidTotal)}</div></div>
      <div class="info-row"><div class="info-label">Qalıq (AZN)</div><div class="info-value">${money(purchRemaining(p))}</div></div>
      <div class="info-row"><div class="info-label">Alış edən əməkdaş</div><div class="info-value">${escapeHtml(actorLabel)}</div></div>
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
  const staffName = operationActorName(head, staff ? staff.name : (head.employeeName || "")) || "-";
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
          <a class="icon-btn edit" href="${erpOpHref("purch", "purchEdit", idx)}" onclick="closeMdl();openPurch(${idx});return false;" title="Redaktə"><i class="fas fa-pen"></i></a>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Qaytarma</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="pret_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Geri qaytarılan məbləğ (AZN)</label><input type="number" step="0.01" id="pret_refund" placeholder="0.00 — sıfır ola bilər"></div>
            <div class="f-group"><label>Hesab *</label><select id="pret_acc" required>${accountOptionsHtml(1)}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="pret_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
  const defaultPurchStaffId = String(idx !== null ? (p.employeeId || "") : currentUserStaffId());
  const staffOptions = `<option value="">— Əməkdaş seçin —</option>` + (db.staff || []).map((s) => `<option value="${s.uid}" ${defaultPurchStaffId === String(s.uid) ? "selected" : ""}>${escapeHtml(s.name)}${s.role ? " – " + escapeHtml(s.role) : ""}</option>`).join("");
  ensureAccounts();
  const payAccOptions = accountOptionsHtml(Number(p.paymentAccountId || 1));
  const invVal = idx !== null ? (p.invNo || invFallback("purch", p.uid)) : previewInvNo("purch");
  window.__purchDraftItems = [];

  const isBulk = purchIsBulk(p);
  const prefUnit = isBulk ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : n(p.amount) / Math.max(1, Math.floor(n(p.qty || 1)))) : n(p.amount);
  openModal(`
    <h2>${idx !== null ? "Alış Redaktə" : "Yeni Alış"}</h2>
    <form onsubmit="savePurch(event, ${idx})">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Əsas məlumat</div>
          <div class="grid-2">
            <div class="f-group"><label>Qaimə №</label><input id="f_p_inv" value="${escapeAttr(invVal)}" placeholder="Auto" readonly required></div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="f_p_date" value="${escapeAttr(p.date)}" required></div>
            <div class="f-group"><label>Əməkdaş${canChangeSaleStaff() ? "" : " *"}</label><select id="f_p_staff" ${canChangeSaleStaff() ? "" : "disabled"} ${canChangeSaleStaff() ? "" : "required"}>${staffOptions}</select></div>
            <div class="f-group"><label>Təchizatçı *</label><select id="f_p_supp" required>
          <option value="">Seçin…</option>
          ${suppOptions}
        </select></div>
            <div class="f-group"><label>Məhsul</label><select id="f_p_prod" ${idx !== null ? "required" : ""}>
          <option value="">Seçin…</option>
          ${prodOptions}
        </select></div>
            <div class="paybox paybox--row">
          <label class="chk">
            <input type="checkbox" id="f_p_bulk" onchange="togglePurchBulk()" ${purchIsBulk(p) ? "checked" : ""}>
            <span>Say ilə alış (IMEI/Seriyasız)</span>
          </label>
        </div>
          </div>
        </div>

        <div id="pBulkBox" class="form-card" style="display:none;">
          <div class="form-card-title">Kod və say</div>
          <div class="grid-2">
            <div class="f-group"><label>Məhsul kodu</label><input id="f_p_code" value="${escapeHtml(p.code || "")}" placeholder="məs: IP16PM-256"></div>
            <div class="f-group"><label>Say</label><input type="number" step="1" min="1" id="f_p_qty" value="${escapeAttr(String(p.qty || 1))}" placeholder="Ədəd"></div>
          </div>
        </div>

        <div id="pSerialBox" class="form-card" style="display:none;">
          <div class="form-card-title">IMEI / Seriya</div>
          <div class="grid-2">
            <div class="f-group"><label>IMEI 1</label><input id="f_p_i1" value="${escapeHtml(p.imei1 || "")}" placeholder="IMEI 1"></div>
            <div class="f-group"><label>IMEI 2</label><input id="f_p_i2" value="${escapeHtml(p.imei2 || "")}" placeholder="IMEI 2"></div>
            <div class="f-group"><label>Seriya №</label><input id="f_p_ser" value="${escapeHtml(p.seria || "")}" placeholder="Seriya №"></div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group"><label>${isBulk ? "1 ədəd qiymət (AZN)" : "Məbləğ (AZN)"}</label><input type="number" step="0.01" id="f_p_amount" value="${escapeAttr(isBulk ? String(prefUnit) : String(p.amount))}" placeholder="0.00" ${idx !== null ? "required" : ""}></div>
            <div class="f-group"><label>Ödəniş növü</label><select id="f_p_payType">
          <option value="nagd" ${p.payType === "nagd" ? "selected" : ""}>Nağd</option>
          <option value="kocurme" ${p.payType === "kocurme" ? "selected" : ""}>Köçürmə</option>
          <option value="kredit" ${p.payType === "kredit" ? "selected" : ""}>Kredit</option>
        </select></div>
            <div class="f-group"><label>Rəsmilik</label><select id="f_p_paymentType">
          <option value="" ${!p.paymentType ? "selected" : ""}>Seçilməyib</option>
          <option value="resmi" ${p.paymentType === "resmi" ? "selected" : ""}>Rəsmi</option>
          <option value="qeyri_resmi" ${p.paymentType === "qeyri_resmi" ? "selected" : ""}>Qeyri-Rəsmi</option>
        </select></div>
            <div class="f-group"><label>Ödəniş hesabı</label><select id="f_p_pay_acc">${payAccOptions}</select></div>
            <div class="f-group"><label>Ödənilən (AZN)</label><input type="number" step="0.01" id="f_p_paid" value="${escapeAttr(p.paidTotal || "0")}" placeholder="0.00"></div>
            <div id="pTotalHint" class="hint-line grid-span-2 muted small" style="display:${isBulk ? "" : "none"}">Cəmi: —</div>
          </div>
        </div>
        ${idx === null ? `<div class="form-card">
          <div class="form-card-title">Alış siyahısı</div>
          <p style="margin:0 0 12px;"><button class="btn-secondary" type="button" onclick="addPurchDraftItem()"><i class="fas fa-plus"></i> Siyahıya əlavə et</button></p>
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
    const employeeId = (canChangeSaleStaff() ? (val("f_p_staff") || "").trim() : currentUserStaffId()) || undefined;
    const actorName = currentActorName();
    const payType = val("f_p_payType");
    const paymentType = val("f_p_paymentType") || "";
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
        paymentType,
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
  const employeeId = (canChangeSaleStaff() ? (val("f_p_staff") || "").trim() : currentUserStaffId()) || undefined;
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
    paymentType: val("f_p_paymentType") || (idx !== null ? (db.purch[idx]?.paymentType || "") : ""),
    paidTotal: String(Math.max(0, n(val("f_p_paid")))),
    employeeId,
    actorName,
    paymentAccountId: Number(val("f_p_pay_acc") || (idx !== null ? db.purch[idx]?.paymentAccountId : 1) || 1),
  };
  if (idx !== null) db.purch[idx] = data;
  else db.purch.push(data);
  logEvent(isNew ? "create" : "update", "purch", { uid: data.uid, invNo: data.invNo });

  sendTelegram(
    `${isNew ? "📦 Yeni alış" : "✏️ Alış yeniləndi"} — <b>${tgCompanyName()}</b>\n` +
    `Qaimə: <b>${data.invNo || invFallback("purch", data.uid)}</b>\n` +
    `Təchizatçı: ${data.supp || "-"}\n` +
    `Məbləğ: <b>${money(data.amount)} AZN</b>\n` +
    `Ödəniş hesabı: ${tgAccName(data.paymentAccountId)}\n` +
    `Tarix: ${fmtDT(data.date)}\n` +
    `Əməkdaş: <b>${tgUserName()}</b>`
  );

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

function saleItemUnitPriceFromPurch(p) {
  if (!p) return 0;
  if (!purchIsBulk(p)) return Math.max(0, n(p.amount));
  const explicit = Math.max(0, n(p.unitPrice || 0));
  if (explicit > 0.000001) return explicit;
  const qty = Math.max(1, Math.floor(n(p.qty || 1)));
  return Math.max(0, n(p.amount)) / qty;
}

function getSaleItemCatalog() {
  return Array.isArray(window.__saleItemCatalog) ? window.__saleItemCatalog : [];
}

function renderSaleItemOptions(filterText = "", preferredValue = "") {
  const sel = byId("f_s_item");
  if (!sel) return;
  const q = String(filterText || "").trim().toLowerCase();
  const items = getSaleItemCatalog().filter((item) => !q || item.searchText.includes(q));
  const fifoOptions = items
    .filter((item) => item.group === "fifo")
    .map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.optionLabel)}</option>`)
    .join("");
  const stockOptions = items
    .filter((item) => item.group === "stock")
    .map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.optionLabel)}</option>`)
    .join("");
  sel.innerHTML =
    `<option value="">Mal seçin</option>` +
    (fifoOptions ? `<optgroup label="AUTO FIFO">${fifoOptions}</optgroup>` : "") +
    (stockOptions ? `<optgroup label="Anbar">${stockOptions}</optgroup>` : "");
  sel.disabled = items.length === 0;
  const nextValue = preferredValue && items.some((item) => item.value === preferredValue) ? preferredValue : "";
  sel.value = nextValue;
}

function fillSaleAmountFromSelectedItem() {
  const amtEl = byId("f_s_amount");
  if (!amtEl) return;
  amtEl.value = "";
  amtEl.setAttribute("data-autofill", "0");
}

function clearSalePickerFields() {
  const searchEl = byId("f_s_lookup");
  if (searchEl) searchEl.value = "";
  renderSaleItemOptions("", "");
  const amountEl = byId("f_s_amount");
  if (amountEl) {
    amountEl.value = "";
    amountEl.setAttribute("data-autofill", "0");
  }
  if (byId("f_s_qty")) byId("f_s_qty").value = "1";
  toggleSaleQty();
}

function handleSaleItemChange() {
  fillSaleAmountFromSelectedItem();
  toggleSaleQty();
  if (typeof window.__saleUpdateHint === "function") window.__saleUpdateHint();
  recalcCredit();
}

function searchSaleItem() {
  const input = byId("f_s_lookup");
  const q = String(input?.value || "").trim();
  const normalized = q.toLowerCase();
  const currentValue = byId("f_s_item")?.value || "";
  renderSaleItemOptions(q, currentValue);
  if (!window.__saleAutoAddEnabled || !normalized) return;
  const catalog = getSaleItemCatalog();
  const exactMatches = catalog.filter((item) => Array.isArray(item.autoTokens) && item.autoTokens.includes(normalized));
  if (!exactMatches.length) return;
  // Saynan (FIFO/bulk) məhsulda kod uyğunluğu prioritetdir
  const fifoMatch = exactMatches.filter((item) => item.group === "fifo");
  const winner = fifoMatch.length === 1 ? fifoMatch[0] : exactMatches.length === 1 ? exactMatches[0] : null;
  if (!winner) return;
  renderSaleItemOptions(q, winner.value);
  handleSaleItemChange();
}

function syncSalePaymentInputState() {
  const payNow = !!byId("f_pay_now")?.checked;
  const isCredit = String(byId("f_s_type")?.value || "") === "kredit";
  const isInitial = !!byId("f_pay_initial")?.checked;
  const paidEl = byId("f_s_paid");
  if (!paidEl) return;
  if (!payNow) {
    paidEl.disabled = true;
    return;
  }
  if (isCredit && isInitial) {
    paidEl.disabled = true;
    const down = Math.max(0, n(byId("f_cr_down")?.value || 0));
    paidEl.value = money(down);
    paidEl.setAttribute("data-autofill", String(down));
    return;
  }
  paidEl.disabled = false;
}

function toggleSaleInitialPayment() {
  syncSalePaymentInputState();
  recalcCredit();
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
  const fromMs = parseDateOnly((byId("custFrom")?.value || "").trim());
  const toMs = parseDateOnly((byId("custTo")?.value || "").trim());

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
    const ms = datePartMs(d);
    if (ms === null) return true;
    if (fromMs && ms < fromMs) return false;
    if (toMs && ms > toMs) return false;
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
      <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openSuppStatement(idx) {
  const s = db.supp[idx];
  if (!s) return;
  const suppName = String(s.co || "");
  const fromMs = parseDateOnly((byId("repFrom")?.value || "").trim());
  const toMs = parseDateOnly((byId("repTo")?.value || "").trim());

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
    const ms = datePartMs(d);
    if (ms === null) return true;
    if (fromMs && ms < fromMs) return false;
    if (toMs && ms > toMs) return false;
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
      <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
      <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şəxsi məlumat</div>
          <div class="grid-2">
            <div class="f-group"><label>Ad Soyad *</label><input id="f_st_name" value="${escapeHtml(s.name)}" placeholder="Ad Soyad" required></div>
            <div class="f-group"><label>Telefon</label><input id="f_st_phone" value="${escapeHtml(s.phone || "")}" placeholder="+994 xx xxx xx xx"></div>
            <div class="f-group"><label>Vəzifə</label><input id="f_st_role" value="${escapeHtml(s.role || "")}" placeholder="Satıcı / Mühasib…"></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Maaş</div>
          <div class="grid-2">
            <div class="f-group"><label>Standart maaş (AZN)</label><input type="number" step="0.01" id="f_st_salary" value="${escapeAttr(String(s.baseSalary ?? "0"))}" placeholder="0.00"></div>
            <div class="f-group"><label>Satışdan faiz (%)</label><input type="number" step="0.01" id="f_st_comm" value="${escapeAttr(String(s.commPct ?? "0"))}" placeholder="0"></div>
          </div>
        </div>
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
    <div class="form-stack" style="margin-bottom:14px;">
      <div class="form-card">
        <div class="form-card-title">Filtr</div>
        <div class="grid-2">
          <div class="f-group"><label>Ay</label><input type="month" id="payrollCalcMonth" value="${currentMonth}" onchange="updateStaffPayrollTable()" class="select-small"></div>
        </div>
      </div>
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
    <div class="form-stack" style="margin-bottom:14px;">
      <div class="form-card">
        <div class="form-card-title">Filtr</div>
        <div class="grid-2">
          <div class="f-group"><label>Ay</label><input type="month" id="staffPayMonth" value="${currentMonth}" onchange="renderStaffPayList()" class="select-small"></div>
        </div>
      </div>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group"><label>Hesab *</label><select id="staff_pay_acc" required>${accOptions}</select></div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="staff_pay_date" value="${dateVal}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" min="0" id="staff_pay_amount" value="${amt}" required></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input type="text" id="staff_pay_note" placeholder="məs: 2024-01 əməkhaqqı"></div>
          </div>
        </div>
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
      if (!fifoGroups.has(key)) fifoGroups.set(key, { key, code, name, rem: 0, unitPrice: saleItemUnitPriceFromPurch(x.p) });
      const g = fifoGroups.get(key);
      g.rem += Math.max(0, n(x.rem));
    });

  const custOptions =
    `<option value="">Müştəri seç</option>` +
    db.cust.map((c) => `<option value="${c.uid}">${escapeHtml(c.sur)} ${escapeHtml(c.name)} (${c.uid})</option>`).join("");
  const defaultStaffId = String(isEdit ? (current?.employeeId || "") : currentUserStaffId());
  const staffEditable = canChangeSaleStaff();
  const staffOptions =
    `<option value="">Əməkdaş seç</option>` +
    db.staff.map((s) => `<option value="${s.uid}" ${String(defaultStaffId) === String(s.uid) ? "selected" : ""}>${escapeHtml(s.name)}${s.role ? " - " + escapeHtml(s.role) : ""}</option>`).join("");

  const itemCatalog = [
    ...Array.from(fifoGroups.values())
      .filter((g) => g.rem > 0)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((g) => {
        const autoTokens = [g.name, g.code]
          .map((v) => String(v || "").trim().toLowerCase())
          .filter(Boolean);
        return {
          group: "fifo",
          value: `fifo:${g.key}`,
          label: `${g.name || "-"}${g.code ? ` | KOD:${g.code}` : ""}`,
          optionLabel: `AUTO FIFO | ${g.name || "-"} | KOD:${g.code || "-"} | QALIQ:${Math.floor(g.rem)}`,
          defaultAmount: Math.max(0, n(g.unitPrice)),
          searchText: `${g.name || ""} ${g.code || ""}`.toLowerCase(),
          autoTokens,
        };
      }),
    ...stockItems.map((x) => {
      const price = saleItemUnitPriceFromPurch(x.p);
      const base = `${x.p.name} | ${x.p.supp} | ${x.p.date}`;
      const extra =
        x.type === "bulk"
          ? ` | KOD:${x.p.code || "-"} | QALIQ:${x.rem}`
          : ` | IMEI1:${x.p.imei1 || "-"} IMEI2:${x.p.imei2 || "-"} SER:${x.p.seria || "-"}`;
      const autoTokens = [x.p.name, x.p.code, x.p.imei1, x.p.imei2, x.p.seria]
        .map((v) => String(v || "").trim().toLowerCase())
        .filter(Boolean);
      return {
        group: "stock",
        value: `${x.type}:${x.p.uid}`,
        label: x.type === "bulk"
          ? `${x.p.name || "-"}${x.p.code ? ` | KOD:${x.p.code}` : ""}`
          : `${x.p.name || "-"}${x.p.imei1 ? ` | IMEI:${x.p.imei1}` : x.p.seria ? ` | SER:${x.p.seria}` : ""}`,
        optionLabel: `${base}${extra}`,
        defaultAmount: Math.max(0, n(price)),
        searchText: `${x.p.name || ""} ${x.p.code || ""} ${x.p.imei1 || ""} ${x.p.imei2 || ""} ${x.p.seria || ""}`.toLowerCase(),
        autoTokens,
      };
    }),
  ];

  ensureAccounts();
  const accOptions = accountOptionsHtml(current?.paymentAccountId || 1);

  openModal(`
    <h2>${isEdit ? "Satış Redaktə" : "Yeni Satış"}</h2>
    <form onsubmit="saveSale(event, ${idx})">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Əsas məlumat</div>
          <div class="grid-2">
            <div class="f-group"><label>Müştəri *</label><select id="f_s_customer" required>${custOptions}</select></div>
            <div class="f-group"><label>Əməkdaş${staffEditable ? "" : " *"}</label><select id="f_s_staff" ${staffEditable ? "" : "disabled"} ${staffEditable ? "" : "required"}>${staffOptions}</select></div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="f_s_date" value="${escapeAttr(current?.date || nowISODateTimeLocal())}" required></div>
            <div class="f-group"><label>Satış növü *</label><select id="f_s_type" onchange="toggleCreditBox();togglePostTaksit()" required>
          <option value="nagd">Nağd</option>
          <option value="post">Post</option>
          <option value="topdan">Topdan</option>
          <option value="korporativ">Korporativ</option>
          <option value="kredit">Kredit</option>
        </select></div>
            <div id="postTaksitBox" class="f-group" style="display:none">
              <label class="chk" style="margin-top:24px"><input type="checkbox" id="f_s_taksit" onchange="togglePostTaksit()"><span>Taksit (bank)</span></label>
            </div>
            <div id="postTaksitTermBox" class="f-group" style="display:none">
              <label>Taksit müddəti (ay)</label>
              <input type="number" step="1" min="1" id="f_s_taksit_term" placeholder="məs: 12">
            </div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Məhsul</div>
          <div class="grid-2">
            <div class="f-group"><label>Axtarış</label><input type="text" id="f_s_lookup" placeholder="Ad, IMEI, seriya və ya kod yazın" oninput="searchSaleItem()"></div>
            <div class="f-group"><label>Mal seçin</label><select id="f_s_item" ${itemCatalog.length ? "" : "disabled"} onchange="handleSaleItemChange()" ${isEdit ? "required" : ""}>
          <option value="">Mal seçin</option>
        </select></div>
            <div id="saleQtyBox" style="display:none;">
              <div class="f-group"><label>Say</label><input type="number" step="1" min="1" id="f_s_qty" placeholder="Ədəd sayı"></div>
            </div>
            <div class="f-group"><label>Qiymət (AZN)</label><div style="display:flex;gap:6px;align-items:center"><input type="number" step="0.01" id="f_s_amount" placeholder="0.00" style="flex:1" ${isEdit ? "required" : ""} oninput="if(window.__saleUpdateHint)window.__saleUpdateHint();recalcCredit()"><button type="button" class="btn-main" onclick="addSaleDraftItem()" style="white-space:nowrap;padding:8px 14px">+ Əlavə et</button></div></div>
            <div id="sTotalHint" class="hint-line grid-span-2 muted small" style="display:none">Cəmi: —</div>
          </div>
        </div>
        ${!isEdit ? `<div class="form-card">
          <div class="form-card-title">Satış siyahısı</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Məhsul</th><th>Qiymət</th><th>Növ</th><th>Say</th><th>Məbləğ</th><th></th></tr></thead>
              <tbody id="saleDraftList"><tr><td colspan="7">Məhsul əlavə edilməyib</td></tr></tbody>
              <tfoot><tr class="total-row"><td colspan="5">Qaimə cəmi</td><td id="saleDraftTotal">0.00 AZN</td><td></td></tr></tfoot>
            </table>
          </div>
        </div>` : ""}
        <div id="creditBox" class="form-card" style="display:none;">
          <div class="form-card-title">Kredit şərtləri</div>
          <div class="grid-2">
            <div class="f-group"><label>Kredit müddəti (ay)</label><input type="number" step="1" min="1" id="f_cr_term" placeholder="məs: 12" oninput="recalcCredit()"></div>
            <div class="f-group"><label>İlkin ödəniş (AZN)</label><input type="number" step="0.01" min="0" id="f_cr_down" placeholder="0.00" oninput="recalcCredit()"></div>
            <div class="f-group"><label>Aylıq ödəniş (auto)</label><input id="f_cr_monthly" placeholder="Hesablanır…" readonly></div>
            <div class="f-group"><label>Qalıq (ilkindən sonra)</label><input id="f_cr_rem" placeholder="Hesablanır…" readonly></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="paybox paybox--row">
          <label class="chk">
            <input type="checkbox" id="f_pay_now" onchange="togglePayNow()">
            <span>Ödəniş qəbul et</span>
          </label>
        </div>
            <div id="payNowBox" class="grid-span-2" style="display:none;">
              <div class="grid-2">
                <div class="f-group"><label>Ödəniş məbləği (AZN)</label><input type="number" step="0.01" id="f_s_paid" placeholder="0.00" value="${escapeAttr(current?.lastPayAmount || "")}"></div>
                <div class="f-group"><label>Ödəniş hesabı</label><select id="f_pay_acc">${accOptions}</select></div>
                <label class="chk grid-span-2">
                  <input type="checkbox" id="f_pay_initial" onchange="toggleSaleInitialPayment()">
                  <span>İlkin ödənişdir</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-main" type="submit">${isEdit ? "Yenilə" : "Satışı yadda saxla"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);

  window.__saleItemCatalog = itemCatalog;
  window.__saleAutoAddEnabled = !isEdit;
  renderSaleItemOptions();

  // Prefill select values
  if (current) {
    byId("f_s_type").value = current.saleType === "kocurme" ? "korporativ" : (current.saleType || "nagd");
    byId("f_s_customer").value = String(current.customerId || "");
    byId("f_s_staff").value = String(current.employeeId || defaultStaffId || "");
    // if bulk, show unit price in input; else show total
    if (current.bulkPurchUid || (Array.isArray(current.bulkAllocations) && current.bulkAllocations.length)) {
      const q = Math.max(1, Math.floor(n(current.qty || 1)));
      const unit = current.unitPrice != null && current.unitPrice !== "" ? n(current.unitPrice) : (n(current.amount) / q);
      byId("f_s_amount").value = String(unit);
      byId("f_s_amount").setAttribute("data-autofill", String(unit));
    } else {
      byId("f_s_amount").value = String(current.amount || "");
      byId("f_s_amount").setAttribute("data-autofill", String(current.amount || ""));
    }

    let currentItemValue = "";
    if (current.bulkPurchUid) {
      currentItemValue = `bulk:${current.bulkPurchUid}`;
      if (byId("f_s_qty")) byId("f_s_qty").value = String(current.qty || 1);
    } else if (Array.isArray(current.bulkAllocations) && current.bulkAllocations.length) {
      const token = String(current.code || current.productName || "-").trim().replace(/:/g, "_");
      currentItemValue = `fifo:${token}`;
      if (byId("f_s_qty")) byId("f_s_qty").value = String(current.qty || 1);
    } else {
      const purch = db.purch.find((p) => itemKeyFromPurch(p) === current.itemKey);
      if (purch) currentItemValue = `serial:${purch.uid}`;
    }
    renderSaleItemOptions("", currentItemValue);
    if (currentItemValue) byId("f_s_item").value = currentItemValue;

    if (current.saleType === "kredit") {
      toggleCreditBox(true);
      byId("f_cr_term").value = String(current.credit?.termMonths || "");
      byId("f_cr_down").value = String(current.credit?.downPayment || "");
      recalcCredit();
    } else {
      toggleCreditBox(false);
    }
    if (current.saleType === "post_taksit") {
      byId("f_s_type").value = "post";
      togglePostTaksit();
      if (byId("f_s_taksit")) { byId("f_s_taksit").checked = true; togglePostTaksit(); }
      if (byId("f_s_taksit_term")) byId("f_s_taksit_term").value = String(current.taksitTerm || "");
    }
    // pay now
    const paidTotal = n(current.paidTotal);
    byId("f_pay_now").checked = paidTotal > 0.000001;
    togglePayNow(true);
    byId("f_s_paid").value = money(current.lastPayAmount ?? paidTotal);
    if (current.saleType === "kredit") {
      const downPayment = Math.max(0, n(current.credit?.downPayment || 0));
      const lastPaid = Math.max(0, n(current.lastPayAmount ?? paidTotal));
      if (Math.abs(lastPaid - downPayment) < 0.01 && lastPaid > 0) {
        byId("f_pay_initial").checked = true;
      }
    }
  } else {
    byId("f_s_type").value = "nagd";
    byId("f_s_staff").value = defaultStaffId;
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
    const isFifo = String(sel).startsWith("fifo:");
    const hint = byId("sTotalHint");
    if (!hint) return;
    if (!isBulk && !isFifo) {
      hint.style.display = "none";
      return;
    }
    hint.style.display = "";
    const qty = Math.max(1, Math.floor(n(val("f_s_qty") || 1)));
    const unit = Math.max(0, n(val("f_s_amount") || 0));
    hint.textContent = `Cəmi: ${money(unit * qty)} AZN`;
  };
  window.__saleUpdateHint = upd;
  const qtyEl = byId("f_s_qty");
  const amtEl = byId("f_s_amount");
  qtyEl && (qtyEl.oninput = () => { upd(); recalcCredit(); });
  amtEl && (amtEl.oninput = () => { upd(); recalcCredit(); });
  byId("f_s_item") && (byId("f_s_item").onchange = () => handleSaleItemChange());
  upd();
  syncSalePaymentInputState();
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
  const catalogItem = getSaleItemCatalog().find((x) => x.value === sel);
  const opt = byId("f_s_item")?.selectedOptions?.[0];
  const label = (catalogItem?.label || opt?.textContent || "").trim();
  return { item: { kind, purchUid, qty, unitOrTotal, amount, label, price: unitOrTotal } };
}

function renderSaleDraftItems() {
  const tb = byId("saleDraftList");
  const totalEl = byId("saleDraftTotal");
  if (!tb || !totalEl) return;
  const arr = window.__saleDraftItems || [];
  if (!arr.length) {
    tb.innerHTML = `<tr><td colspan="7">Məhsul əlavə edilməyib</td></tr>`;
    totalEl.textContent = "0.00 AZN";
    return;
  }
  const total = arr.reduce((a, x) => a + n(x.amount), 0);
  tb.innerHTML = arr
    .map((x, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(x.label || x.purchUid)}</td>
      <td>${money(x.price != null ? x.price : x.unitOrTotal)} AZN</td>
      <td>${x.kind === "bulk" ? "Sayla" : (x.kind === "fifo" ? "FIFO" : "Seriyalı")}</td>
      <td>${x.qty}</td>
      <td>${money(x.amount)} AZN</td>
      <td><button type="button" class="icon-btn delete" onclick="removeSaleDraftItem(${i})"><i class="fas fa-trash"></i></button></td>
    </tr>`)
    .join("");
  totalEl.textContent = `${money(total)} AZN`;
  recalcCredit();
}

function addSaleDraftItem(skipAlert) {
  const r = readSaleDraftFromForm();
  if (r.error) {
    if (!skipAlert) alert(r.error);
    return false;
  }
  const arr = window.__saleDraftItems || [];
  const item = r.item;

  if (item.kind !== "bulk" && item.kind !== "fifo") {
    const dup = arr.some((x) => x.purchUid === item.purchUid && x.kind === item.kind);
    if (dup) {
      if (!skipAlert) alert("Bu məhsul artıq siyahıya əlavə edilib.");
      return false;
    }
  } else {
    const catalogItem = getSaleItemCatalog().find((x) => x.value === `${item.kind}:${item.purchUid}`);
    if (catalogItem) {
      const alreadyQty = arr.filter((x) => x.purchUid === item.purchUid && x.kind === item.kind).reduce((s, x) => s + (x.qty || 0), 0);
      const maxRem = item.kind === "fifo"
        ? Math.floor(n((catalogItem.optionLabel || "").match(/QALIQ:(\d+)/)?.[1]))
        : Math.floor(n((catalogItem.optionLabel || "").match(/QALIQ:(\d+)/)?.[1]));
      if (maxRem > 0 && alreadyQty + item.qty > maxRem) {
        if (!skipAlert) alert(`Anbarda yalnız ${maxRem} ədəd qalıb. Siyahıda artıq ${alreadyQty} ədəd var.`);
        return false;
      }
    }
  }

  arr.push(item);
  window.__saleDraftItems = arr;
  renderSaleDraftItems();
  clearSalePickerFields();
  return true;
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
    byId("f_s_paid").value = "";
    if (byId("f_pay_initial")) byId("f_pay_initial").checked = false;
  } else {
    // if credit, default to down payment
    if (byId("f_s_type")?.value === "kredit") {
      recalcCredit();
    }
  }
  syncSalePaymentInputState();
  if (!noRender) return;
}

function togglePostTaksit() {
  const type = byId("f_s_type")?.value;
  const isPost = type === "post";
  const taksitBox = byId("postTaksitBox");
  const termBox = byId("postTaksitTermBox");
  if (taksitBox) taksitBox.style.display = isPost ? "" : "none";
  if (!isPost) { if (byId("f_s_taksit")) byId("f_s_taksit").checked = false; }
  const isTaksit = isPost && !!byId("f_s_taksit")?.checked;
  if (termBox) termBox.style.display = isTaksit ? "" : "none";
}

function toggleCreditBox(force) {
  const type = byId("f_s_type")?.value;
  const show = typeof force === "boolean" ? force : type === "kredit";
  const box = byId("creditBox");
  if (!box) return;
  box.style.display = show ? "" : "none";
  if (!show && byId("f_pay_initial")) byId("f_pay_initial").checked = false;
  recalcCredit();
  syncSalePaymentInputState();
}

function recalcCredit() {
  const type = byId("f_s_type")?.value;
  if (type !== "kredit") {
    syncSalePaymentInputState();
    return;
  }
  const draftTotal = (window.__saleDraftItems || []).reduce((s, x) => s + n(x.amount), 0);
  const fallback = Math.max(0, n(byId("f_s_amount")?.value));
  const total = draftTotal > 0 ? draftTotal : fallback;
  const term = Math.max(1, Math.floor(n(byId("f_cr_term")?.value || 0)));
  let down = Math.max(0, n(byId("f_cr_down")?.value || 0));
  if (down > total) down = total;
  const rem = Math.max(0, total - down);
  const monthly = term > 0 ? rem / term : 0;
  byId("f_cr_monthly").value = monthly > 0 ? money(monthly) : "";
  byId("f_cr_rem").value = rem > 0 ? money(rem) : "";

  const paidEl = byId("f_s_paid");
  if (paidEl) {
    const shouldLockToDown = !!byId("f_pay_now")?.checked && !!byId("f_pay_initial")?.checked;
    const cur = n(paidEl.value);
    const auto = n(paidEl.getAttribute("data-autofill"));
    if (shouldLockToDown || cur === 0 || cur === auto) {
      paidEl.value = down > 0 ? money(down) : "";
      paidEl.setAttribute("data-autofill", String(down));
    }
  }
  syncSalePaymentInputState();
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
    const employeeId = canChangeSaleStaff() ? val("f_s_staff") : currentUserStaffId();
    const saleType = val("f_s_type");
    const date = val("f_s_date");
    const cust = db.cust.find((c) => String(c.uid) === String(customerId));
    const staff = employeeId ? db.staff.find((s) => String(s.uid) === String(employeeId)) : null;
    if (!cust) return alert("Müştəri seçin.");
    if (!staff && !canChangeSaleStaff()) return alert("Əməkdaş seçin.");

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
    const isTaksit = saleType === "post" && !!byId("f_s_taksit")?.checked;
    const taksitTerm = isTaksit ? Math.max(1, Math.floor(n(val("f_s_taksit_term") || 1))) : 0;
    const effectiveSaleType = isTaksit ? "post_taksit" : saleType;
    const invNo = nextInvNo("sales", effectiveSaleType);
    let paidLeft = paid;
    const totalDown = saleType === "kredit" ? Math.max(0, n(val("f_cr_down"))) : 0;
    const termMonths = saleType === "kredit" ? Math.max(1, Math.floor(n(val("f_cr_term") || 1))) : 0;
    if (saleType === "kredit" && payNow && isInitialPayment) {
      paid = Math.min(totalAmount, totalDown);
      paidLeft = paid;
    }

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
        saleType: effectiveSaleType,
        isTaksit: isTaksit || undefined,
        taksitTerm: isTaksit ? taksitTerm : undefined,
        customerId: cust.uid,
        customerName: `${cust.sur} ${cust.name} ${cust.father}`.trim(),
        employeeId: staff?.uid ?? "",
        employeeName: staff?.name ?? "",
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
  const employeeId = isEdit ? val("f_s_staff") : (canChangeSaleStaff() ? val("f_s_staff") : currentUserStaffId());
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
    if (payNow && isInitialPayment) paid = downPayment;
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

  sendTelegram(
    `${isNew ? "🧾 Yeni satış" : "✏️ Satış yeniləndi"} — <b>${tgCompanyName()}</b>\n` +
    `Qaimə: <b>${base.invNo || "-"}</b>\n` +
    `Müştəri: ${base.customerName || "-"}\n` +
    `Məbləğ: <b>${money(base.amount)} AZN</b>\n` +
    `Satış növü: ${base.saleType || "-"}\n` +
    `Ödəniş hesabı: ${tgAccName(base.paymentAccountId)}\n` +
    `Tarix: ${fmtDT(base.date)}\n` +
    `Əməkdaş: <b>${tgUserName()}</b>`
  );

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

function applyCustomerPaymentToDebts(customerId, amount, date, source, saleFilter) {
  let left = Math.max(0, n(amount));
  if (left <= 0) return { applied: 0, remaining: left, allocations: [] };

  const debts = db.sales
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => String(s.customerId) === String(customerId))
    .filter(({ s }) => saleRemaining(s) > 0.000001)
    .filter(({ s }) => typeof saleFilter === "function" ? saleFilter(s) : true)
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
        <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales", "saleInfo", idx)}" onclick="closeMdl(); openSaleInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a></td>
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
      <div class="form-card">
        <div class="form-card-title">Kredit şərtləri</div>
        <div class="grid-2">
          <div class="f-group"><label>Kredit müddəti (ay)</label><div class="f-static">${sch.term} ay</div></div>
          <div class="f-group"><label>İlkin ödəniş (AZN)</label><div class="f-static">${money(s.credit.downPayment)} AZN</div></div>
          <div class="f-group"><label>Aylıq ödəniş (AZN)</label><div class="f-static">${money(s.credit.monthlyPayment)} AZN</div></div>
          <div class="f-group"><label>Qalıq (ilkindən sonra)</label><div class="f-static">${money(sch.remAfterDown)} AZN</div></div>
        </div>
      </div>
    `;
    const rows = sch.rows
      .map(
        (r) => `
      <tr>
        <td>${r.idx}</td>
        <td>${fmtDT(r.due)}</td>
        <td>${money(r.amount)} AZN</td>
        <td>${money(r.paid)} AZN</td>
        <td>${money(r.remaining)} AZN</td>
        <td><span class="pill ${r.status}">${debtLabel(r.status)}</span></td>
      </tr>`
      )
      .join("");
    scheduleHtml = `
      <div class="form-card">
        <div class="form-card-title">Ödəniş cədvəli</div>
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
    <div class="form-stack">
      <div class="form-card">
        <div class="form-card-title">Əsas məlumat</div>
        <div class="grid-2">
          <div class="f-group"><label>Satış tarixi</label><div class="f-static">${fmtDT(s.date)}</div></div>
          <div class="f-group"><label>Satış növü</label><div class="f-static">${escapeHtml({ nagd: "Nağd", post: "Post", post_taksit: "Post Taksit", topdan: "Topdan", korporativ: "Korporativ", kredit: "Kredit", kocurme: "Köçürmə" }[String(s.saleType || "").toLowerCase()] || String(s.saleType || "").toUpperCase())}${s.taksitTerm ? ` (${s.taksitTerm} ay)` : ""}</div></div>
          <div class="f-group"><label>Müştəri</label><div class="f-static">${escapeHtml(s.customerName)} (${s.customerId})</div></div>
          <div class="f-group"><label>Əməkdaş</label><div class="f-static">${escapeHtml(operationActorName(s, s.employeeName || "-"))}</div></div>
          <div class="f-group grid-span-2"><label>Zamin</label><div class="f-static">${guarantor ? escapeHtml(`${guarantor.sur} ${guarantor.name} (${guarantor.uid})`) : "-"}</div></div>
        </div>
      </div>
      <div class="form-card">
        <div class="form-card-title">Məhsul</div>
        <div class="grid-2">
          <div class="f-group grid-span-2"><label>Məhsul</label><div class="f-static">${escapeHtml(s.productName)}</div></div>
          <div class="f-group"><label>Kod</label><div class="f-static">${escapeHtml(s.code || "-")}</div></div>
          <div class="f-group"><label>Say</label><div class="f-static">${String(Math.max(1, Math.floor(n(s.qty || 1))))}</div></div>
          <div class="f-group"><label>IMEI 1</label><div class="f-static">${escapeHtml(s.imei1 || "-")}</div></div>
          <div class="f-group"><label>IMEI 2</label><div class="f-static">${escapeHtml(s.imei2 || "-")}</div></div>
          <div class="f-group"><label>Seriya №</label><div class="f-static">${escapeHtml(s.seria || "-")}</div></div>
        </div>
      </div>
      <div class="form-card">
        <div class="form-card-title">Ödəniş</div>
        <div class="grid-2">
          <div class="f-group"><label>Məbləğ (AZN)</label><div class="f-static">${money(s.amount)} AZN</div></div>
          <div class="f-group"><label>Ödənilən (AZN)</label><div class="f-static">${money(s.paidTotal)} AZN</div></div>
          <div class="f-group"><label>Qalıq (AZN)</label><div class="f-static">${money(rem)} AZN</div></div>
          <div class="f-group"><label>Status</label><div class="f-static"><span class="pill ${st}">${debtLabel(st)}</span></div></div>
        </div>
      </div>
    </div>
    ${creditHtml}
    ${scheduleHtml}
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openSalePayment(${idx})">Ödəniş et</button>
      <button class="btn-cancel" type="button" onclick="openReturnSale(${idx})">Qaytar</button>
      <button class="btn-cancel" type="button" onclick="printSale(${idx})">Çap</button>
      ${s.saleType === "kredit" ? `<button class="btn-cancel" type="button" data-credit-doc-btn onclick="openCreditDocMenu(${idx},this)"><i class="fas fa-file-lines" style="margin-right:5px;"></i>Sənədlər</button>` : ""}
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
  const sInvNo = s.invNo || invFallback("sales", s.uid);
  openModal(`
    <h2>Ödəniş tarixçəsi</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Qaimə №</div><div class="info-value"><strong>${escapeHtml(sInvNo)}</strong></div></div>
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(s.customerName)}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(s.productName)}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ / Ödənilən / Qalıq</div><div class="info-value"><strong>${money(n(s.amount))} / ${money(n(s.paidTotal))} / ${money(saleRemaining(s))} AZN</strong></div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Məbləğ</th><th>Mənbə</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">Tarixçə boşdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openSalePayment(${idx})">Ödəniş et</button>
      <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="pay_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="pay_amount" placeholder="0.00" max="${escapeAttr(String(Math.max(0, rem)))}" required></div>
            <div class="f-group"><label>Hesab *</label><select id="pay_acc" required>${accountOptionsHtml(defAcc)}</select></div>
            ${isCredit ? `<div class="f-group"><label>Ödəniş növü *</label><select id="pay_kind" required>
          <option value="monthly" selected>Aylıq ödəniş</option>
          <option value="down">İlkin ödəniş</option>
        </select></div>` : `<input type="hidden" id="pay_kind" value="regular">`}
            <div class="f-group f-group--note"><label>Qeyd</label><input id="pay_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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

function openDebtorInfo(customerId, saleTypeFilter) {
  const cid = String(customerId);
  const stf = String(saleTypeFilter || window.__debtsSaleType || "").toLowerCase();
  // Qeyri-kredit satışlar; əgər saleTypeFilter verilib — yalnız həmin növ
  const items = (db.sales || [])
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => String(s.customerId) === cid)
    .filter(({ s }) => !s.returnedAt)
    .filter(({ s }) => String(s.saleType || "").toLowerCase() !== "kredit")
    .filter(({ s }) => !stf || String(s.saleType || "").toLowerCase() === stf)
    .sort((a, b) => String(a.s.date).localeCompare(String(b.s.date)) * -1);

  const custName = items[0]?.s.customerName || customerId;
  const totalRem = items.reduce((a, { s }) => a + saleRemaining(s), 0);
  const footPayDis = totalRem <= 0.000001 ? "disabled" : "";
  const saleTypeLabel = { nagd: "Nağd", post: "Post", post_taksit: "Post Taksit", topdan: "Topdan", korporativ: "Korporativ", kocurme: "Köçürmə" };
  const typeTitle = stf ? (saleTypeLabel[stf] || stf) + " satış" : "Debitor";

  const rows = items
    .map(({ s, idx }, i) => {
      const rem = saleRemaining(s);
      const st = debtStatus(n(s.amount), rem);
      const invNo = s.invNo || invFallback("sales", s.uid);
      const imeiParts = [s.imei1, s.imei2].filter(Boolean);
      const key = (imeiParts.length ? imeiParts.join("/") : (s.seria || s.code || "")).trim();
      const payDisabled = rem <= 0.000001 ? "disabled" : "";
      const typeLabel = saleTypeLabel[String(s.saleType || "").toLowerCase()] || String(s.saleType || "").toUpperCase();
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(invNo)}</td>
        <td>${fmtDT(s.date)}</td>
        <td>${escapeHtml(s.productName)}</td>
        <td>${escapeHtml(key || "-")}</td>
        <td>${escapeHtml(typeLabel)}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td><span class="pill ${st}">${debtLabel(st)}</span></td>
        <td class="tbl-actions">
          <a class="icon-btn info" href="${erpOpHref("sales", "saleInfo", idx)}" onclick="openSaleInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
          <button class="btn-mini-pay" type="button" onclick="openSalePayment(${idx})" ${payDisabled}>Ödəniş et</button>
        </td>
      </tr>`;
    })
    .join("");

  openModal(`
    <h2>${escapeHtml(typeTitle)} detalları</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custName)}</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq borc</div><div class="info-value"><strong>${money(totalRem)} AZN</strong></div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Tarix</th><th>Məhsul</th><th>IMEI/Seriya</th><th>Növ</th><th>Məbləğ</th><th>Ödənilən</th><th>Qalıq</th><th>Status</th><th>Əməliyyat</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="11">Borc yoxdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openDebtorPayment('${escapeAttr(cid)}','${escapeAttr(stf)}')" ${footPayDis}>Ödəniş et</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openDebtorPayment(customerId, saleTypeFilter) {
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const cid = String(customerId);
  const stf = String(saleTypeFilter || window.__debtsSaleType || "").toLowerCase();
  // Yalnız qeyri-kredit borclar, istəyə görə növ filtri
  const unpaidSales = db.sales
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => String(s.customerId) === cid)
    .filter(({ s }) => !s.returnedAt)
    .filter(({ s }) => String(s.saleType || "").toLowerCase() !== "kredit")
    .filter(({ s }) => !stf || String(s.saleType || "").toLowerCase() === stf)
    .filter(({ s }) => saleRemaining(s) > 0.000001)
    .sort((a, b) => (a.s.date > b.s.date ? 1 : -1));

  const totalRem = unpaidSales.reduce((a, { s }) => a + saleRemaining(s), 0);
  if (totalRem <= 0.000001) {
    alert("Borc yoxdur.");
    return;
  }
  const cust = db.cust.find((c) => String(c.uid) === cid);
  const custLabel = cust ? `${cust.sur} ${cust.name}` : customerId;

  const invOptions = unpaidSales.map(({ s }) => {
    const inv = s.invNo || invFallback("sales", s.uid);
    const rem = saleRemaining(s);
    return `<option value="${escapeAttr(String(s.uid))}" data-rem="${rem}">${escapeHtml(inv)} — ${escapeHtml(s.productName)} (qalıq: ${money(rem)} AZN)</option>`;
  }).join("");

  openModal(`
    <h2>Debitor ödəniş</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custLabel)}</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq</div><div class="info-value"><strong>${money(totalRem)} AZN</strong></div></div>
    </div>
    <form onsubmit="saveDebtorPayment(event, '${escapeAttr(cid)}', '${escapeAttr(stf)}')">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group" style="grid-column:1/-1"><label>Qaimə *</label>
              <select id="deb_pay_inv" required onchange="debPayInvChanged(this)">
                <option value="">— Seçin —</option>
                <option value="__all__" data-rem="${totalRem}">Bütün borclar (köhnəsi əvvəl) — ${money(totalRem)} AZN</option>
                ${invOptions}
              </select>
            </div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="deb_pay_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="deb_pay_amount" placeholder="0.00" required></div>
            <div class="f-group"><label>Hesab *</label><select id="deb_pay_acc" required>${accountOptionsHtml(1)}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="deb_pay_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function debPayInvChanged(sel) {
  const opt = sel.options[sel.selectedIndex];
  const rem = opt ? parseFloat(opt.getAttribute("data-rem") || "0") : 0;
  const amtEl = byId("deb_pay_amount");
  if (amtEl && rem > 0) amtEl.value = money(rem).replace(/[^\d.]/g, "");
}

function saveDebtorPayment(e, customerId, saleTypeFilter) {
  e.preventDefault();
  if (!userCanPay()) return alert("Ödəniş icazəsi yoxdur.");
  const stf = String(saleTypeFilter || "").toLowerCase();
  const date = val("deb_pay_date");
  const amount = Math.max(0, n(val("deb_pay_amount")));
  const accId = Number(val("deb_pay_acc") || 1);
  const invUid = val("deb_pay_inv") || "";
  if (!invUid) return alert("Qaimə seçin.");
  if (amount <= 0) return alert("Məbləğ daxil edin.");

  const cust = db.cust.find((c) => String(c.uid) === String(customerId));
  const custLabel = cust ? `${cust.sur} ${cust.name}` : customerId;

  let appliedAmount = 0;
  let allocations = [];
  let noteDefault = "Debitor ödəniş";

  if (invUid === "__all__") {
    // Filtrdə olan növün bütün borcları — köhnəsi əvvəl
    const result = applyCustomerPaymentToDebts(customerId, amount, date, "debts_module", (s) => {
      if (String(s.saleType || "").toLowerCase() === "kredit") return false;
      if (stf) return String(s.saleType || "").toLowerCase() === stf;
      return true;
    });
    if (result.applied <= 0.000001) return alert("Borc yoxdur.");
    appliedAmount = result.applied;
    allocations = result.allocations;
    noteDefault = "Debitor ödəniş (bütün borclar)";
  } else {
    // Konkret qaimə
    const saleIdx = db.sales.findIndex((s) => String(s.uid) === String(invUid));
    if (saleIdx < 0) return alert("Qaimə tapılmadı.");
    const sale = db.sales[saleIdx];
    const rem = saleRemaining(sale);
    if (rem <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
    if (amount - rem > 0.000001) return alert(`Məbləğ qalıq borcdan çox ola bilməz. Qalıq: ${money(rem)} AZN`);
    const paid = addSalePaymentInternal(sale, amount, date, "debts_module");
    if (paid <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
    appliedAmount = paid;
    allocations = [{ saleUid: sale.uid, amount: paid }];
    const inv = sale.invNo || invFallback("sales", sale.uid);
    noteDefault = `Ödəniş — ${inv}`;
  }

  addCashOp({
    type: "in",
    date,
    source: `Müştəri ödənişi (${custLabel})`,
    amount: appliedAmount,
    note: val("deb_pay_note") || noteDefault,
    link: { kind: "debtor_payment", customerId },
    meta: { allocations },
    accountId: accId,
  });

  logEvent("create", "cash", { type: "in", kind: "debtor_payment", amount: appliedAmount, customerId, allocations });
  saveDB();
  openDebtorInfo(customerId, stf);
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Əməliyyat</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="edit_cash_date" value="${(c.date || "").slice(0, 16)}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="edit_cash_amount" value="${n(c.amount)}" ${canEditAmount ? "" : "readonly"} required></div>
            ${!canEditAmount ? "<p class=\"hint-line grid-span-2 muted small\">Bu əməliyyat növündə məbləğ dəyişdirilə bilməz.</p>" : ""}
            <div class="f-group"><label>Mənbə / Açıqlama *</label><input type="text" id="edit_cash_source" value="${escapeHtml(c.source || "")}" required></div>
            <div class="f-group"><label>Hesab *</label><select id="edit_cash_acc" required>${accOptions}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input type="text" id="edit_cash_note" value="${escapeHtml(c.note || "")}" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

/* ─────────────────────────────────────────────
   Credit document printing
   types: muqavile | cedvel | zamanet | erizesi
   ───────────────────────────────────────────── */
function printCreditDoc(idx, type) {
  const s = db.sales[idx];
  if (!s || s.saleType !== "kredit") return;
  const cust = db.cust.find((c) => String(c.uid) === String(s.customerId)) || {};
  const guarantor = cust.zam ? (db.cust.find((c) => String(c.uid) === String(cust.zam)) || null) : null;
  const st = db.settings || {};
  const sch = buildCreditSchedule(s);

  const today = fmtDT(new Date().toISOString()).split(" ")[0];
  const saleDate = fmtDT(s.date).split(" ")[0];

  const co   = escapeHtml(st.companyName   || "Şirkət");
  const coAddr  = escapeHtml(st.companyAddress || "");
  const coPhone = escapeHtml(st.companyPhone   || "");
  const coVoen  = escapeHtml(st.companyVoen    || "");

  const custFull = escapeHtml(`${cust.sur || ""} ${cust.name || ""} ${cust.father || ""}`.trim());
  const custFin  = escapeHtml(cust.fin      || "-");
  const custSer  = escapeHtml(cust.seriaNum || "-");
  const custPh   = escapeHtml(cust.ph1      || "-");
  const custAddr = escapeHtml(cust.addr     || "-");

  const zamFull  = guarantor ? escapeHtml(`${guarantor.sur||""} ${guarantor.name||""} ${guarantor.father||""}`.trim()) : "-";
  const zamFin   = guarantor ? escapeHtml(guarantor.fin      || "-") : "-";
  const zamSer   = guarantor ? escapeHtml(guarantor.seriaNum || "-") : "-";
  const zamPh    = guarantor ? escapeHtml(guarantor.ph1      || "-") : "-";

  const prod     = escapeHtml(s.productName || "-");
  const imei1    = escapeHtml(s.imei1 || "-");
  const imei2    = escapeHtml(s.imei2 || "-");
  const seria    = escapeHtml(s.seria || "-");
  const docNo    = escapeHtml(String(s.invNo || s.uid));
  const total    = money(s.amount);
  const down     = money(s.credit?.downPayment  || 0);
  const monthly  = money(s.credit?.monthlyPayment || 0);
  const rem      = money(sch.remAfterDown);
  const term     = sch.term;
  const emekdas  = escapeHtml(s.employeeName || operationActorName(s, "-"));

  // shared page CSS
  const baseCSS = `
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Times New Roman',Times,serif;font-size:13px;color:#111;background:#f3f4f6;padding:20px;display:flex;justify-content:center;align-items:center;min-height:100vh;}
    .page{width:210mm;background:#fff;padding:18mm 16mm;border-radius:8px;}
    h1{font-size:15px;font-weight:700;text-align:center;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;}
    .subtitle{text-align:center;font-size:11px;color:#6b7280;margin-bottom:18px;}
    .section{margin-bottom:14px;}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:8px;}
    .row{display:flex;gap:8px;margin-bottom:5px;font-size:12px;}
    .lbl{color:#6b7280;min-width:160px;flex-shrink:0;}
    .val{font-weight:600;}
    p{font-size:13px;line-height:1.8;margin-bottom:8px;}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;}
    th{background:#f1f5f9;padding:5px 8px;text-align:left;border:1px solid #e2e8f0;font-weight:700;}
    td{padding:5px 8px;border:1px solid #e2e8f0;}
    .sign-row{display:flex;justify-content:space-between;gap:30px;margin-top:30px;}
    .sign-box{flex:1;}
    .sign-line{border-bottom:1px solid #374151;height:28px;margin-bottom:4px;}
    .sign-label{font-size:11px;color:#6b7280;}
    .stamp-box{width:80px;height:80px;border:1.5px dashed #d1d5db;border-radius:50%;margin:0 auto 4px;}
    .footer-note{text-align:center;font-size:10px;color:#9ca3af;margin-top:20px;border-top:1px dashed #d1d5db;padding-top:8px;}
    @media print{body{background:#fff;padding:0;display:block;min-height:unset;}.page{border-radius:0;padding:12mm 14mm;}@page{size:A4 portrait;margin:0;}}
  `;

  let title = "", body = "";

  if (type === "tehvil") {
    title = "Təhvil-Təslim Aktı";
    const qty = Math.max(1, Math.floor(n(s.qty || 1)));
    const imeiDisplay = [imei1, imei2, seria].filter(x => x && x !== "-").join(" / ") || "-";
    body = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:20px;font-size:12px;line-height:1.8;">
        <div style="text-align:right;">
          <div>Nisyə alqı-satqı müqaviləsi № ${docNo}</div>
          <div>2 saylı Əlavə</div>
        </div>
      </div>
      <p style="text-align:center;font-size:13px;line-height:1.9;margin-bottom:6px;">
        <strong>${docNo} saylı, ${saleDate} tarixli Nisyə alqı-satqı müqaviləsi dair</strong>
      </p>
      <p style="text-align:center;font-size:15px;font-weight:700;margin-bottom:20px;">Təhvil-Təslim Aktı</p>
      <p style="margin-bottom:4px;">Bakı şəhəri</p>
      <p style="margin-bottom:20px;">${saleDate.split(".")[2]}-cü il</p>
      <p style="font-size:13px;line-height:2;text-align:justify;margin-bottom:16px;">
        Hazırkı Təhvil-Təslim Aktı, bir tərəfdən (bundan sonra ayrılıqda Tərəf, birlikdə isə Tərəflər adlanacaq) <strong>"${co}"</strong> MMC, (bundan sonra "Satıcı" adlanacaq) və digər tərəfdən, şəxsiyyət vəsiqəsinin seriya nömrəsi <strong>${custSer}</strong>, <strong>${custFull}</strong> şəxsində (bundan sonra "Alıcı" adlanacaq) arasında aşağıdakılar barəsində imzalanmışdır:
      </p>
      <p style="font-size:13px;line-height:2;text-align:justify;margin-bottom:16px;">
        1. Tərəflər hazırkı Təhvil-Təslim Aktını tərtib edərək təsdiq edirlər ki, Tərəflər arasında imzalanmış <strong>${docNo}</strong> saylı, <strong>${saleDate}</strong> tarixli Nisyə alqı-satqı müqaviləsinə (bundan sonra – Müqavilə) əsasən, aşağıdakı cədvəldə göstərilən Mal(lar)ı Müqavilənin şərtlərinə uyğun şəkildə Alıcıya təhvil vermiş, Alıcı isə həmin Mal(lar)ı Satıcıdan tam və qüsursuz şəkildə təhvil almışdır:
      </p>
      <table style="margin-bottom:16px;">
        <thead>
          <tr>
            <th style="width:36px;">№</th>
            <th>Malların adları və təsviri (IMEI kodu)</th>
            <th style="width:60px;text-align:center;">Miqdar</th>
            <th style="width:80px;text-align:right;">Məbləğ AZN</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1.</td>
            <td>${prod}${imeiDisplay !== "-" ? ` (${imeiDisplay})` : ""}</td>
            <td style="text-align:center;">${qty}</td>
            <td style="text-align:right;">${total}</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:13px;line-height:2;text-align:justify;margin-bottom:16px;">
        2. Bu Aktın imzalandığı tarixdən etibarən Müqaviləyə uyğun olaraq Alıcı təsdiq və qəbul edir ki, Satıcı tərəfindən təhvil verilmiş Mallar işlək və qüsursuz vəziyyətdədir.
      </p>
      <p style="font-size:13px;line-height:2;margin-bottom:30px;">
        3. Hazırkı Aktın doğruluğunu aşağıda öz imzalarımızla təsdiq edirik:
      </p>
      <div style="display:flex;justify-content:space-between;margin-top:20px;font-size:13px;">
        <div>
          <p><strong>"SATICI"</strong></p>
          <p style="margin-top:8px;"><strong>"${co}"</strong> MMC</p>
          <div style="margin-top:30px;border-bottom:1px solid #374151;width:180px;"></div>
        </div>
        <div>
          <p><strong>"ALICI"</strong></p>
          <p style="margin-top:8px;">&nbsp;</p>
          <div style="margin-top:30px;border-bottom:1px solid #374151;width:180px;"></div>
        </div>
      </div>
    `;
  }

  else if (type === "cedvel") {
    title = "Ödəniş Cədvəli";
    const rows = sch.rows.map((r, i) => `
      <tr style="${i%2===0?"":"background:#f9fafb"}">
        <td>${r.idx}</td>
        <td>${fmtDT(r.due).split(" ")[0]}</td>
        <td style="text-align:right;">${money(r.amount)} AZN</td>
        <td style="text-align:right;">${money(r.paid)} AZN</td>
        <td style="text-align:right;">${money(r.remaining)} AZN</td>
      </tr>`).join("");
    body = `
      <div class="section">
        <div class="row"><span class="lbl">Müqavilə №:</span><span class="val">${docNo}</span></div>
        <div class="row"><span class="lbl">Alıcı:</span><span class="val">${custFull}</span></div>
        <div class="row"><span class="lbl">Məhsul:</span><span class="val">${prod}</span></div>
        <div class="row"><span class="lbl">Ümumi məbləğ:</span><span class="val">${total} AZN</span></div>
        <div class="row"><span class="lbl">İlkin ödəniş:</span><span class="val">${down} AZN</span></div>
        <div class="row"><span class="lbl">Kredit məbləği:</span><span class="val">${rem} AZN</span></div>
        <div class="row"><span class="lbl">Müddət / Aylıq:</span><span class="val">${term} ay / ${monthly} AZN</span></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Ödəniş tarixi</th><th>Aylıq məbləğ</th><th>Ödənilən</th><th>Qalıq</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="sign-row" style="margin-top:20px;">
        <div class="sign-box"><div class="sign-line"></div><div class="sign-label">Satıcı (${co})</div></div>
        <div class="sign-box"><div class="sign-line"></div><div class="sign-label">Alıcı (${custFull})</div></div>
      </div>
    `;
  }

  else if (type === "zamanet") {
    title = "Zəmanət Talonu";
    body = `
      <div class="section">
        <div class="row"><span class="lbl">Talonun №:</span><span class="val">${docNo}</span></div>
        <div class="row"><span class="lbl">Satış tarixi:</span><span class="val">${saleDate}</span></div>
        <div class="row"><span class="lbl">Alıcı:</span><span class="val">${custFull}</span></div>
        <div class="row"><span class="lbl">Telefon:</span><span class="val">${custPh}</span></div>
      </div>
      <div class="section">
        <div class="section-title">Məhsul məlumatı</div>
        <div class="row"><span class="lbl">Məhsul:</span><span class="val">${prod}</span></div>
        <div class="row"><span class="lbl">IMEI 1:</span><span class="val">${imei1}</span></div>
        <div class="row"><span class="lbl">IMEI 2:</span><span class="val">${imei2}</span></div>
        <div class="row"><span class="lbl">Seriya №:</span><span class="val">${seria}</span></div>
        <div class="row"><span class="lbl">Satıcı:</span><span class="val">${co}</span></div>
        ${coPhone ? `<div class="row"><span class="lbl">Əlaqə:</span><span class="val">${coPhone}</span></div>` : ""}
      </div>
      <div class="section">
        <div class="section-title">Zəmanət şərtləri</div>
        <p>• Zəmanət müddəti istehsalçı tərəfindən müəyyən edilir.</p>
        <p>• Zəmanət mexaniki zədələrə, su zədəsinə və istifadəçi xətalarına şamil edilmir.</p>
        <p>• Zəmanət xidmətindən yararlanmaq üçün bu talon mütləq təqdim edilməlidir.</p>
        <p>• Talon üzərindəki məlumatların dəyişdirilməsi zəmanəti etibarsız sayır.</p>
      </div>
      <div class="sign-row">
        <div class="sign-box"><div class="sign-line"></div><div class="sign-label">Satıcı (${emekdas})</div></div>
        <div class="sign-box"><div class="stamp-box"></div><div class="sign-label" style="text-align:center;font-size:10px;">Möhür</div></div>
        <div class="sign-box"><div class="sign-line"></div><div class="sign-label">Alıcı (${custFull})</div></div>
      </div>
    `;
  }

  else if (type === "erizesi") {
    title = "Razılıq Ərizəsi";
    const imeiStr = [imei1, imei2].filter(x => x && x !== "-").join(" / ") || "-";
    body = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:40px;margin-top:10px;">
        <div style="text-align:right;font-size:12px;line-height:1.8;">
          <div>Nisyə alqı-satqı müqaviləsi № ${docNo}</div>
          <div>1 saylı Əlavə</div>
        </div>
      </div>
      <div style="margin-top:30px;margin-bottom:50px;">
        <p style="font-size:14px;line-height:2.1;text-align:justify;text-indent:2em;">
          Mən <strong>${custFull}</strong>, seriya: <strong>${custSer}</strong>, FİN: <strong>${custFin}</strong> — <strong>"${co}"</strong> MMC-dən aldığım qarşılıqlı razılaşma əsasında dəyərini hissə-hissə ödəmək üçün nəzərdə tutulmuş <strong>"${prod}"</strong> markalı, İMEİ kodu: <strong>${imeiStr}</strong> mobil cihazın Müqavilə şərtlərini pozduğum halda İMEİ kodunun deaktiv edilməsi və vahid şəbəkədə riskli müştərilərin siyahısına salınmasına etirazım yoxdur.
        </p>
      </div>
      <div style="margin-top:50px;font-size:13px;line-height:3.2;">
        <div><strong>İmza:</strong></div>
        <div><strong>Satıcı:</strong></div>
        <div><strong>Alıcı:</strong></div>
        <div><strong>Tarix:</strong></div>
      </div>
    `;
  }

  const html = `<!DOCTYPE html><html lang="az"><head><meta charset="UTF-8"><title>${title}</title>
  <style>${baseCSS}</style></head><body>
  <div class="page">
    <div style="font-size:17px;font-weight:700;font-family:'Times New Roman',Times,serif;margin-bottom:${type==="erizesi"?"0":"12px"};">${co}</div>
    ${type !== "erizesi" ? `<h1 style="margin-top:6px;">${title}</h1><div class="subtitle">${coPhone ? coPhone : ""}${coAddr ? (coPhone?" • ":"")+coAddr : ""}</div>` : `<h1 style="display:none;">${title}</h1>`}
    ${body}
    <div class="footer-note">Çap edildi: ${fmtDT(new Date().toISOString())} • ${co}</div>
  </div>
  <script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};<\/script>
  </body></html>`;

  const w = window.open("", "_blank", "width=900,height=700,toolbar=0,menubar=0,scrollbars=1");
  if (w) { w.document.write(html); w.document.close(); }
}

function openCreditDocMenu(idx, triggerEl) {
  const docs = [
    { label: "Alqı-satqı müqaviləsi",  icon: "fa-handshake",      fn: () => printSaleContract(idx) },
    { label: "Təhvil-Təslim Aktı",     icon: "fa-file-contract",  fn: () => printCreditDoc(idx, "tehvil") },
    { label: "Ödəniş cədvəli",         icon: "fa-table",          fn: () => printCreditDoc(idx, "cedvel") },
    { label: "Zəmanət talonu",          icon: "fa-shield-halved",  fn: () => printCreditDoc(idx, "zamanet") },
    { label: "Razılıq ərizəsi",         icon: "fa-file-signature", fn: () => printCreditDoc(idx, "erizesi") },
  ];

  const existing = document.getElementById("creditDocDropdown");
  if (existing) { existing.remove(); return; }

  const menu = document.createElement("div");
  menu.id = "creditDocDropdown";
  menu.style.cssText = [
    "position:fixed",
    "z-index:99999",
    "background:#fff",
    "border:1px solid #e2e8f0",
    "border-radius:12px",
    "box-shadow:0 8px 32px rgba(0,0,0,.15)",
    "padding:6px",
    "min-width:220px",
  ].join(";");

  docs.forEach(d => {
    const item = document.createElement("button");
    item.type = "button";
    item.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:none;background:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;color:#1c1c1e;text-align:left;transition:background .12s;";
    item.innerHTML = `<i class="fas ${d.icon}" style="width:16px;color:#6b7280;flex-shrink:0;"></i>${d.label}`;
    item.onmouseenter = () => { item.style.background = "#f2f2f7"; };
    item.onmouseleave = () => { item.style.background = "none"; };
    item.onclick = (e) => { e.stopPropagation(); menu.remove(); d.fn(); };
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  // Position after appending so we know the menu height
  const btn = triggerEl || document.querySelector("[data-credit-doc-btn]");
  if (btn) {
    const r   = btn.getBoundingClientRect();
    const mh  = menu.offsetHeight || docs.length * 44;
    const top = r.top - mh - 8 > 0 ? r.top - mh - 8 : r.bottom + 8;
    menu.style.left = Math.max(8, r.left) + "px";
    menu.style.top  = top + "px";
  } else {
    menu.style.left = "50%";
    menu.style.top  = "50%";
    menu.style.transform = "translate(-50%,-50%)";
  }

  setTimeout(() => {
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };
    document.addEventListener("click", close);
  }, 10);
}

function printCashReceipt(uid) {
  const c = db.cash.find((x) => Number(x.uid) === Number(uid));
  if (!c) return;
  const s = db.settings || {};
  const accountName = (db.accounts || []).find((a) => Number(a.uid) === Number(c.accountId || 1))?.name || `#${Number(c.accountId || 1)}`;
  const actor = operationActorName(c, "-");
  const compName  = escapeHtml(s.companyName  || "ERP");
  const compAddr  = escapeHtml(s.companyAddress || "");
  const compPhone = escapeHtml(s.companyPhone   || "");
  const typeLabel = c.type === "in" ? "Gəlir (Mədaxil)" : "Xərc (Məxaric)";
  const color     = c.type === "in" ? "#16a34a" : "#dc2626";

  const html = `<!DOCTYPE html><html lang="az"><head><meta charset="UTF-8">
<title>Qəbz #${c.uid}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;display:flex;justify-content:center;padding:20px;}
  .receipt{width:210mm;min-height:148mm;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14mm 16mm;font-size:13px;}
  .receipt__head{text-align:center;margin-bottom:14px;border-bottom:1px dashed #d1d5db;padding-bottom:12px;}
  .receipt__company{font-size:17px;font-weight:700;margin-bottom:2px;}
  .receipt__sub{color:#6b7280;font-size:11px;}
  .receipt__title{margin:10px 0 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;}
  .receipt__amount{font-size:28px;font-weight:800;color:${color};margin:4px 0 14px;}
  .receipt__rows{border-top:1px dashed #d1d5db;padding-top:12px;}
  .receipt__row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:12px;}
  .receipt__row-label{color:#6b7280;flex-shrink:0;}
  .receipt__row-val{font-weight:500;text-align:right;}
  .receipt__sign{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-top:24px;padding-top:16px;border-top:1px dashed #d1d5db;}
  .receipt__sign-box{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;}
  .receipt__sign-line{width:100%;height:1px;background:#374151;}
  .receipt__sign-stamp{width:80px;height:80px;border:1.5px dashed #d1d5db;border-radius:50%;}
  .receipt__sign-label{font-size:10px;color:#6b7280;text-align:center;}
  .receipt__footer{margin-top:14px;border-top:1px dashed #d1d5db;padding-top:10px;text-align:center;color:#9ca3af;font-size:10px;}
  @media print{
    body{background:#fff;padding:0;display:block;}
    .receipt{width:210mm;min-height:148mm;border:none;border-radius:0;padding:10mm 14mm;}
    @page{size:A4 portrait;margin:0;}
  }
</style></head><body>
<div class="receipt">
  <div class="receipt__head">
    <div class="receipt__company">${compName}</div>
    ${compAddr  ? `<div class="receipt__sub">${compAddr}</div>`  : ""}
    ${compPhone ? `<div class="receipt__sub">Tel: ${compPhone}</div>` : ""}
  </div>
  <div style="text-align:center;">
    <div class="receipt__title">Məbləğ</div>
    <div class="receipt__amount">${money(c.amount)} AZN</div>
  </div>
  <div class="receipt__rows">
    <div class="receipt__row"><span class="receipt__row-label">Qəbz №</span><span class="receipt__row-val">#${c.uid}</span></div>
    <div class="receipt__row"><span class="receipt__row-label">Tarix</span><span class="receipt__row-val">${fmtDT(c.date)}</span></div>
    <div class="receipt__row"><span class="receipt__row-label">Növ</span><span class="receipt__row-val">${typeLabel}</span></div>
    <div class="receipt__row"><span class="receipt__row-label">Hesab</span><span class="receipt__row-val">${escapeHtml(accountName)}</span></div>
    ${c.source ? `<div class="receipt__row"><span class="receipt__row-label">Mənbə</span><span class="receipt__row-val">${escapeHtml(c.source)}</span></div>` : ""}
    ${actor !== "-" ? `<div class="receipt__row"><span class="receipt__row-label">Əməkdaş</span><span class="receipt__row-val">${escapeHtml(actor)}</span></div>` : ""}
    ${c.note ? `<div class="receipt__row"><span class="receipt__row-label">Qeyd</span><span class="receipt__row-val">${escapeHtml(c.note)}</span></div>` : ""}
  </div>
  <div class="receipt__sign">
    <div class="receipt__sign-box">
      <div class="receipt__sign-line"></div>
      <div class="receipt__sign-label">Qəbul edən (imza)</div>
    </div>
    <div class="receipt__sign-box">
      <div class="receipt__sign-stamp"></div>
      <div class="receipt__sign-label">Möhür</div>
    </div>
  </div>
  <div class="receipt__footer">Çap edildi: ${fmtDT(new Date().toISOString())}</div>
</div>
<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};}<\/script>
</body></html>`;

  const w = window.open("", "_blank", "width=400,height=600,toolbar=0,menubar=0,scrollbars=1");
  if (w) { w.document.write(html); w.document.close(); }
}

function openCashInfo(uid) {
  const i = db.cash.findIndex((c) => Number(c.uid) === Number(uid));
  if (i < 0) return;
  const c = db.cash[i];
  const accountName = (db.accounts || []).find((a) => Number(a.uid) === Number(c.accountId || 1))?.name || `#${Number(c.accountId || 1)}`;
  const kind = c.link?.kind || (c.type === "in" ? "income" : "expense");
  const actor = operationActorName(c, "-");
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
    <div class="modal-footer">
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      <button class="btn-cancel" type="button" onclick="printCashReceipt(${c.uid})"><i class="fas fa-print" style="margin-right:6px;"></i>Qəbz çap et</button>
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
  const catOptions = db.expenseCats.map((c) => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  const accOptions = accountOptionsHtml(1);

  openModal(`
    <h2>Yeni əməliyyat</h2>
    <form onsubmit="saveCashOp(event)">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Əməliyyat növü</div>
          <div class="grid-2">
            <div class="f-group"><label>Növ</label><select id="cash_kind" onchange="toggleCashKind()">
          <option value="" selected>Seçin</option>
          <option value="cash_pay">Nağd Ödəniş</option>
          <option value="credit_pay">Kredit Ödənişi</option>
          <option value="supp_pay">Kreditor Ödənişi</option>
          <option value="owner_income">Təsisçidən Mədaxil</option>
          <option value="owner_expense">Təsisçiyə Məxaric</option>
          <option value="transfer">Hesablar arası transfer</option>
          <option value="expense">Xərc</option>
        </select></div>
          </div>
        </div>

        <div id="cash_customer_box" class="form-card">
          <div class="form-card-title">Müştəri</div>
          <div class="grid-2">
            <div class="f-group"><label>Müştəri *</label><select id="cash_customer" onchange="refreshCustomerInvoices()" required><option value="">Müştəri seç</option></select></div>
            <div class="f-group"><label>Qaimə *</label><select id="cash_customer_invoice" onchange="refreshCashPayKind()">
              <option value="">Qaimə seçin</option>
            </select></div>
            <div id="cash_pay_kind_box" class="f-group" style="display:none;">
              <label>Ödəniş növü</label>
              <select id="cash_pay_kind">
                <option value="monthly" selected>Aylıq ödəniş</option>
                <option value="down">İlkin ödəniş</option>
              </select>
            </div>
          </div>
        </div>

        <div id="cash_supplier_box" class="form-card" style="display:none;">
          <div class="form-card-title">Təchizatçı</div>
          <div class="grid-2">
            <div class="f-group"><label>Təchizatçı</label><select id="cash_supplier" onchange="refreshSupplierInvoices()"><option value="">Təchizatçı seç</option></select></div>
            <div class="f-group"><label>Qaimə *</label><select id="cash_supplier_invoice">
              <option value="">Qaimə seçin</option>
            </select></div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Məbləğ və tarix</div>
          <div class="grid-2">
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="cash_amount" placeholder="0.00" required></div>
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="cash_date" value="${nowISODateTimeLocal()}" required></div>
            <div id="cash_acc_box">
              <div class="f-group"><label>Hesab *</label><select id="cash_acc" required>${accOptions}</select></div>
            </div>
          </div>
        </div>

        <div id="cash_income_box" class="form-card" style="display:none;">
          <div class="form-card-title">Mədaxil</div>
          <div class="grid-2">
            <div class="f-group"><label>Açıqlama</label><input id="cash_income_source" value="Təsisçidən mədaxil" placeholder="məs: Təsisçidən mədaxil"></div>
          </div>
        </div>

        <div id="cash_transfer_box" class="form-card" style="display:none;">
          <div class="form-card-title">Hesablar arası transfer</div>
          <div class="grid-2">
            <div class="f-group"><label>Hansı hesabdan *</label><select id="cash_transfer_from">${accountOptionsHtml(1)}</select></div>
            <div class="f-group"><label>Hansı hesaba *</label><select id="cash_transfer_to">${accountOptionsHtml(2)}</select></div>
          </div>
        </div>

        <div id="cash_expense_box" class="form-card" style="display:none;">
          <div class="form-card-title">Xərc</div>
          <div class="grid-2">
            <div class="f-group">
              <label>Kateqoriya</label>
              <div class="select-plus">
                <select id="exp_cat" onchange="refreshSubcats()">${catOptions}</select>
                <button class="mini-btn" type="button" title="Kateqoriya əlavə et" onclick="addExpenseCategory()"><i class="fas fa-plus"></i></button>
              </div>
            </div>
            <div class="f-group">
              <label>Alt kateqoriya</label>
              <div class="select-plus">
                <select id="exp_sub"></select>
                <button class="mini-btn" type="button" title="Alt kateqoriya əlavə et" onclick="addExpenseSubcategory()"><i class="fas fa-plus"></i></button>
              </div>
            </div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Qeyd</div>
          <div class="grid-2">
            <div class="f-group f-group--note"><label>Əlavə qeyd</label><input id="cash_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
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
  const accBox = byId("cash_acc_box");
  if (!custBox || !expBox) return;
  const xfrBox0 = byId("cash_transfer_box");
  if (kind === "cash_pay" || kind === "credit_pay") {
    custBox.style.display = "";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "none";
    if (xfrBox0) xfrBox0.style.display = "none";
    expBox.style.display = "none";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = true;
    byId("cash_acc").required = true;
    refreshCashCustomers();
    refreshCustomerInvoices();
  } else if (kind === "supp_pay") {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "";
    if (incBox) incBox.style.display = "none";
    if (xfrBox0) xfrBox0.style.display = "none";
    expBox.style.display = "none";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = false;
    byId("cash_acc").required = true;
    refreshCashSuppliers();
    refreshSupplierInvoices();
  } else if (kind === "owner_income" || kind === "owner_expense") {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "";
    if (xfrBox0) xfrBox0.style.display = "none";
    expBox.style.display = "none";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = false;
    byId("cash_acc").required = true;
    // Update income box label
    const incTitle = incBox?.querySelector(".form-card-title");
    if (incTitle) incTitle.textContent = kind === "owner_income" ? "Mədaxil" : "Məxaric";
    const incInput = byId("cash_income_source");
    if (incInput) incInput.value = kind === "owner_income" ? "Təsisçidən mədaxil" : "Təsisçiyə məxaric";
  } else if (kind === "transfer") {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "none";
    expBox.style.display = "none";
    if (accBox) accBox.style.display = "none";
    byId("cash_customer").required = false;
    const xfrBox = byId("cash_transfer_box");
    if (xfrBox) xfrBox.style.display = "";
  } else if (kind === "expense") {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "none";
    expBox.style.display = "";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = false;
    byId("cash_acc").required = true;
    const xfrBox2 = byId("cash_transfer_box");
    if (xfrBox2) xfrBox2.style.display = "none";
  } else {
    custBox.style.display = "none";
    if (suppBox) suppBox.style.display = "none";
    if (incBox) incBox.style.display = "none";
    expBox.style.display = "none";
    if (accBox) accBox.style.display = "";
    byId("cash_customer").required = false;
    byId("cash_acc").required = true;
  }
}

function cashCustomerSalesByKind(kind, customerId) {
  return db.sales
    .filter((s) => String(s.customerId) === String(customerId))
    .filter((s) => !s.returnedAt)
    .filter((s) => saleRemaining(s) > 0.000001)
    .filter((s) => kind === "credit_pay" ? String(s.saleType || "").toLowerCase() === "kredit" : String(s.saleType || "").toLowerCase() !== "kredit")
    .sort((a, b) => (a.date > b.date ? 1 : -1));
}

function refreshCashCustomers() {
  const sel = byId("cash_customer");
  const kind = byId("cash_kind")?.value || "";
  if (!sel) return;
  const customers = [];
  const seen = new Set();
  for (const s of db.sales) {
    if (s.returnedAt || saleRemaining(s) <= 0.000001) continue;
    const isCredit = String(s.saleType || "").toLowerCase() === "kredit";
    if (kind === "cash_pay" && isCredit) continue;
    if (kind === "credit_pay" && !isCredit) continue;
    const c = db.cust.find((x) => String(x.uid) === String(s.customerId));
    if (!c || seen.has(String(c.uid))) continue;
    seen.add(String(c.uid));
    customers.push(c);
  }
  const prev = sel.value || "";
  sel.innerHTML = `<option value="">Müştəri seç</option>` + customers
    .sort((a, b) => `${a.sur || ""} ${a.name || ""}`.localeCompare(`${b.sur || ""} ${b.name || ""}`, "az"))
    .map((c) => `<option value="${c.uid}">${escapeHtml(c.sur)} ${escapeHtml(c.name)}</option>`)
    .join("");
  if (prev && seen.has(String(prev))) sel.value = prev;
}

function refreshCashSuppliers() {
  const sel = byId("cash_supplier");
  if (!sel) return;
  const withDebt = new Set(db.purch.filter((p) => purchRemaining(p) > 0.000001).map((p) => String(p.supp)));
  const prev = sel.value || "";
  sel.innerHTML = `<option value="">Təchizatçı seç</option>` + db.supp
    .filter((s) => withDebt.has(String(s.co)))
    .sort((a, b) => String(a.co || "").localeCompare(String(b.co || ""), "az"))
    .map((s) => `<option value="${escapeAttr(s.co)}">${escapeHtml(s.co)}</option>`)
    .join("");
  if (prev && withDebt.has(String(prev))) sel.value = prev;
}

function refreshCustomerInvoices() {
  refreshCashPayKind();
  const customerId = byId("cash_customer")?.value || "";
  const kind = byId("cash_kind")?.value || "";
  const sel = byId("cash_customer_invoice");
  if (!sel) return;
  const inv = cashCustomerSalesByKind(kind, customerId)
    .map((s) => {
      const invNo = s.invNo || invFallback("sales", s.uid);
      return `<option value="${s.uid}">Qaimə #${escapeHtml(invNo)} • ${fmtDT(s.date)} • Qalıq ${money(saleRemaining(s))}</option>`;
    })
    .join("");
  sel.innerHTML = `<option value="">Qaimə seç (istəyə bağlı)</option>` + inv;
}

function refreshCashPayKind() {
  const kind = byId("cash_kind")?.value || "";
  const saleUid = byId("cash_customer_invoice")?.value;
  const box = byId("cash_pay_kind_box");
  if (!box) return;
  if (kind !== "credit_pay") {
    box.style.display = "none";
    return;
  }
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
  if (!kind) return alert("Əməliyyat növünü seçin.");

  if (kind === "transfer") {
    const fromAccId = Number(val("cash_transfer_from") || 0);
    const toAccId = Number(val("cash_transfer_to") || 0);
    if (!fromAccId || !toAccId) return alert("Hesabları seçin.");
    if (fromAccId === toAccId) return alert("Eyni hesabdan eyni hesaba transfer olmaz.");
    const fromBal = accountBalance(fromAccId);
    if (fromBal + 0.000001 < amount) return alert("Seçilmiş hesabda balans kifayət etmir.");
    const fromAcc = (db.accounts||[]).find((a) => a.uid === fromAccId);
    const toAcc = (db.accounts||[]).find((a) => a.uid === toAccId);
    addCashOp({ type: "out", date, source: `Transfer → ${toAcc?.name||"Hesab"}`, amount, note, link: { kind: "transfer", fromAccId, toAccId }, accountId: fromAccId });
    addCashOp({ type: "in",  date, source: `Transfer ← ${fromAcc?.name||"Hesab"}`, amount, note, link: { kind: "transfer", fromAccId, toAccId }, accountId: toAccId });
    logEvent("create", "cash", { type: "transfer", fromAccId, toAccId, amount });
    saveDB();
    closeMdl();
    return;
  }

  if (kind === "owner_income" || kind === "owner_expense") {
    if (!userCanOwnerIncome()) {
      alert("Təsisçi əməliyyatı yalnız admin və ya developer edə bilər.");
      return;
    }
    const src = (val("cash_income_source") || "").trim();
    if (kind === "owner_expense") {
      const bal = accountBalance(accId);
      if (bal + 0.000001 < amount) return alert("Balans kifayət etmir.");
    }
    addCashOp({
      type: kind === "owner_income" ? "in" : "out",
      date,
      source: src || (kind === "owner_income" ? "Təsisçidən mədaxil" : "Təsisçiyə məxaric"),
      amount,
      note,
      link: { kind: kind === "owner_income" ? "owner_income" : "owner_expense", from: "owner" },
      accountId: accId,
    });
    logEvent("create", "cash", { type: kind === "owner_income" ? "in" : "out", kind, amount });
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
    sendTelegram(
      `💸 Xərc — <b>${tgCompanyName()}</b>\n` +
      `Kateqoriya: ${val("exp_cat") || "-"} / ${val("exp_sub") || "-"}\n` +
      `Məbləğ: <b>${money(amount)} AZN</b>\n` +
      `Hesab: ${tgAccName(accId)}\n` +
      `Qeyd: ${note || "-"}\n` +
      `Tarix: ${fmtDT(date)}\n` +
      `Əməkdaş: <b>${tgUserName()}</b>`
    );
    return;
  }

  if (kind === "supp_pay") {
    const bal = accountBalance(accId);
    if (bal + 0.000001 < amount) {
      alert("Hesab balansı kifayət etmir. Mənfiyə düşəcək.");
      return;
    }
    const supp = val("cash_supplier");
    if (!supp) return alert("Təchizatçı seçin.");
    const invoiceUid = val("cash_supplier_invoice");
    if (!invoiceUid) return alert("Zəhmət olmasa qaimə seçin.");

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
  if (!cust) return alert("Müştəri seçin.");

  const saleUid = val("cash_customer_invoice");
  if (!saleUid) return alert("Zəhmət olmasa qaimə seçin.");
  if (saleUid) {
    const s = db.sales.find((x) => Number(x.uid) === Number(saleUid));
    if (!s) return;
    if (String(s.customerId) !== String(customerId)) return;
    if (s.returnedAt) return alert("Bu qaimə qaytarılıb.");
    const isCreditSale = String(s.saleType || "").toLowerCase() === "kredit";
    if (kind === "cash_pay" && isCreditSale) return alert("Bu bölmədə yalnız nağd qaimələr seçilə bilər.");
    if (kind === "credit_pay" && !isCreditSale) return alert("Bu bölmədə yalnız kredit qaimələri seçilə bilər.");
    s.payments = s.payments || [];
    const rem = saleRemaining(s);
    const a = Math.min(rem, amount);
    if (a <= 0.000001) return alert("Bu qaimənin borcu yoxdur.");
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
    sendTelegram(
      `💰 Müştəri ödənişi — <b>${tgCompanyName()}</b>\n` +
      `Müştəri: ${cust.sur} ${cust.name}\n` +
      `Qaimə: <b>${s.invNo || invFallback("sales", s.uid)}</b>\n` +
      `Ödəniş növü: ${tgPayKindLabel(cashPayKind)}\n` +
      `Məbləğ: <b>${money(a)} AZN</b>\n` +
      `Hesab: ${tgAccName(accId)}\n` +
      `Tarix: ${fmtDT(date)}\n` +
      `Əməkdaş: <b>${tgUserName()}</b>`
    );
    return;
  }

  const applied = applyCustomerPaymentToDebts(
    customerId,
    amount,
    date,
    kind === "credit_pay" ? "monthly" : "cash_module",
    kind === "credit_pay"
      ? (s) => String(s.saleType || "").toLowerCase() === "kredit"
      : (s) => String(s.saleType || "").toLowerCase() !== "kredit"
  );
  if (applied.applied <= 0.000001) {
    alert("Bu müştərinin borcu yoxdur (və ya borc artıq ödənilib).");
    return;
  }

  const generalPayKind = kind === "credit_pay" ? (val("cash_pay_kind") || "monthly") : "regular";
  addCashOp({
    type: "in",
    date,
    source: `Müştəri ödənişi (${cust.sur} ${cust.name})`,
    amount: applied.applied,
    note: note || (kind === "credit_pay" ? "Kredit ödənişi" : "Nağd ödəniş"),
    link: { kind: "debtor_payment", customerId },
    meta: { allocations: applied.allocations, payKind: generalPayKind },
    accountId: accId,
  });
  logEvent("create", "cash", { type: "in", kind: "debtor_payment", amount: applied.applied, customerId });

  saveDB();
  closeMdl();
  sendTelegram(
    `💰 Müştəri ödənişi — <b>${tgCompanyName()}</b>\n` +
    `Müştəri: ${cust.sur} ${cust.name}\n` +
    `Ödəniş növü: ${kind === "credit_pay" ? "Aylıq kredit ödənişi" : "Nağd ödəniş"}\n` +
    `Məbləğ: <b>${money(applied.applied)} AZN</b>\n` +
    `Hesab: ${tgAccName(accId)}\n` +
    `Tarix: ${fmtDT(date)}\n` +
    `Əməkdaş: <b>${tgUserName()}</b>`
  );
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="cred_pay_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="cred_pay_amount" placeholder="0.00" required></div>
            <div class="f-group"><label>Hesab *</label><select id="cred_pay_acc" required>${accountOptionsHtml(1)}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="cred_pay_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
  const today = Date.now();

  const rows = g.purchases
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .map((p) => {
      const pIdx = (db.purch || []).findIndex((x) => x.uid === p.uid);
      const invNo = p.invNo || invFallback("purch", p.uid);
      const total = n(p.amount);
      const paid = n(p.paidTotal);
      const rem = purchRemaining(p);
      const st = debtStatus(total, rem);
      const days = Math.floor((today - (parseDateOnly(p.date) || today)) / 86400000);
      const staff = p.employeeId && db.staff ? db.staff.find((s) => String(s.uid) === String(p.employeeId)) : null;
      const actor = operationActorName(p, staff ? staff.name : (p.employeeName || "-"));
      const payTypeLabel = p.paymentType === "qeyri_resmi" ? "Qeyri-Rəsmi" : (p.paymentType === "resmi" ? "Rəsmi" : "-");
      const identifiers = [p.imei1, p.imei2, p.seria, p.code].filter(Boolean).join(" · ");
      return `
      <tr>
        <td><a href="#" onclick="openPurchInfo(${pIdx});return false;" style="font-weight:600">${escapeHtml(invNo)}</a></td>
        <td>${fmtDT(p.date)}</td>
        <td>
          ${escapeHtml(p.name)}
          ${identifiers ? `<br><small style="color:var(--text-muted)">${escapeHtml(identifiers)}</small>` : ""}
        </td>
        <td>${escapeHtml(actor)}</td>
        <td>${escapeHtml(payTypeLabel)}</td>
        <td>${days} gün</td>
        <td>${money(total)} AZN</td>
        <td>${money(paid)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td><span class="pill ${st}">${debtLabel(st)}</span></td>
        <td class="tbl-actions">
          <button class="btn-mini-pay" type="button" onclick="openCreditorInvoicePayment(${p.uid})">Ödəniş et</button>
          <button class="btn-mini" type="button" onclick="openCreditorPurchPayHistory(${p.uid})"><i class="fas fa-clock-rotate-left"></i></button>
        </td>
      </tr>`;
    })
    .join("");

  openModal(`
    <h2>Kreditor detalları — ${escapeHtml(g.supp)}</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Cəmi məbləğ</div><div class="info-value">${money(g.total)} AZN</div></div>
      <div class="info-row"><div class="info-label">Cəmi ödənilən</div><div class="info-value">${money(g.paid)} AZN</div></div>
      <div class="info-row"><div class="info-label">Cəmi qalıq</div><div class="info-value"><strong>${money(g.rem)} AZN</strong></div></div>
    </div>
    <div class="table-wrap" style="overflow-x:auto">
      <table>
        <thead><tr><th>Qaimə №</th><th>Tarix</th><th>Məhsul / Tanımlayıcı</th><th>Əməkdaş</th><th>Ödəniş növü</th><th>Gün</th><th>Məbləğ</th><th>Ödənilən</th><th>Qalıq</th><th>Status</th><th>Əməliyyat</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="11">Bu təchizatçı üzrə alış yoxdur</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openCreditorPayment(${groupIdx})">Ümumi ödəniş</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function openCreditorPurchPayHistory(purchUid) {
  const p = (db.purch || []).find((x) => Number(x.uid) === Number(purchUid));
  if (!p) return;
  const invNo = p.invNo || invFallback("purch", p.uid);
  const ops = (db.cash || [])
    .filter((c) => c.link && (c.link.purchUid === p.uid || Number(c.link.purchUid) === Number(p.uid)))
    .slice().sort((a, b) => (a.date > b.date ? -1 : 1));
  const rows = ops.map((c, i) => `<tr>
    <td>${i+1}</td><td>${fmtDT(c.date)}</td>
    <td class="${c.type==="in"?"amt-in":"amt-out"}">${c.type==="in"?"+":"-"}${money(c.amount)} AZN</td>
    <td>${escapeHtml((db.accounts||[]).find((a)=>a.uid===Number(c.accountId||1))?.name||"Kassa")}</td>
    <td>${escapeHtml(c.note||"")}</td></tr>`).join("");
  openModal(`
    <h2>Ödəniş tarixçəsi — ${escapeHtml(invNo)}</h2>
    <div class="info-block">
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(p.name)}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ / Ödənilən / Qalıq</div><div class="info-value"><strong>${money(n(p.amount))} / ${money(n(p.paidTotal))} / ${money(purchRemaining(p))} AZN</strong></div></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>Məbləğ</th><th>Hesab</th><th>Qeyd</th></tr></thead>
        <tbody>${rows||`<tr><td colspan="5">Ödəniş tapılmadı</td></tr>`}</tbody>
      </table>
    </div>
    <div class="modal-footer"><button class="btn-cancel" onclick="closeMdl()">Bağla</button></div>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="inv_pay_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="inv_pay_amount" placeholder="0.00" required></div>
            <div class="f-group"><label>Hesab *</label><select id="inv_pay_acc" required>${accountOptionsHtml(1)}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="inv_pay_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
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
    "sales",
    "purch",
    "stock",
    "cust",
    "supp",
    "prod",
    "staff",
    "debts",
    "overdue",
    "creditor",
    "cash",
    "accounts",
    "reports",
    "users",
    "audit",
    "trash",
    "tools",
  ];
  const enabled = Array.isArray(c.sections) && c.sections.length > 0 ? c.sections : allSections;
  const secChecks = allSections
    .map((s) => {
      const on = enabled.includes(s);
      return `<label class="perm-row"><span class="perm-label">${escapeHtml(sectionLabelAz(s))}</span><input type="checkbox" class="coSec" value="${s}" ${on ? "checked" : ""}></label>`;
    })
    .join("");
  openModal(`
    <h2>${idx !== null ? "Şirkət redaktə" : "Yeni şirkət"}</h2>
    <form onsubmit="saveCompany(event, ${idx})">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şirkət</div>
          <div class="grid-2">
            <div class="f-group"><label>Şirkət adı *</label><input id="co_name" placeholder="Şirkət adı" value="${escapeHtml(c.name || "")}" required></div>
            <div class="f-group"><label>ID *</label><input id="co_id" placeholder="məs: bakfon" value="${escapeHtml(c.id || "")}" ${idx !== null ? 'disabled style="opacity:.6;font-family:monospace"' : 'required style="font-family:monospace"'}></div>
            <div class="f-group"><label>Direktor</label><input id="co_director" placeholder="Ad Soyad" value="${escapeHtml(c.director || "")}"></div>
            <div class="f-group"><label>VÖEN</label><input id="co_voen" placeholder="0000000000" value="${escapeHtml(c.voen || "")}"></div>
            <div class="f-group grid-span-2"><label>Ünvan</label><input id="co_address" placeholder="Şəhər, küçə, bina" value="${escapeHtml(c.address || "")}"></div>
            <div class="f-group grid-span-2"><label>Rekvizitlər</label><textarea id="co_requisites" rows="3" placeholder="Bank, hesab nömrəsi, SWIFT...">${escapeHtml(c.requisites || "")}</textarea></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">💳 Abunəlik</div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px">
            <input type="checkbox" id="co_sub_active" ${c.subscription?.active ? "checked" : ""} onchange="toggleSubFields(this.checked)">
            <span style="font-weight:600;font-size:.9rem">Ödənişli abunəlik</span>
          </label>
          <div id="co_sub_fields" style="${c.subscription?.active ? "" : "display:none"}">
            <div class="grid-2">
              <div class="f-group"><label>Aylıq məbləğ (AZN)</label><input type="number" id="co_sub_amount" min="1" step="0.01" value="${c.subscription?.monthlyAmount || ""}" placeholder="100"></div>
              <div class="f-group"><label>Ödəniş vaxtı</label>
                <div style="padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;font-size:.85rem;color:var(--text-muted)">📅 Hər ayın <b>1-5-i</b> arası (standart)</div>
              </div>
            </div>
            <div class="f-group" style="margin-top:4px">
              <label>Ödənilib (son ödəniş ayı)</label>
              <input type="month" id="co_sub_paid_until" value="${c.subscription?.paidUntil || ""}">
              <small style="color:var(--text-muted)">Boş = bu ay hələ ödənilməyib</small>
            </div>
          </div>
        </div>
      </div>
      <div class="perm-group">
        <div class="perm-group-title">Modullar</div>
        <div class="perm-list">
          ${secChecks}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${idx !== null ? "Yenilə" : "Yarat"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function genCompanyUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function toggleSubFields(on) {
  const el = byId("co_sub_fields");
  if (el) el.style.display = on ? "" : "none";
}

function saveCompany(e, idx) {
  e.preventDefault();
  if (!isDeveloper()) return;
  const name = val("co_name").trim();
  const sections = Array.from(document.querySelectorAll(".coSec"))
    .filter((x) => x.checked)
    .map((x) => x.value);
  if (!name) return;

  const subActive = byId("co_sub_active")?.checked || false;
  const subscription = subActive ? {
    active: true,
    monthlyAmount: Math.max(0, n(byId("co_sub_amount")?.value || 0)),
    paidUntil: (byId("co_sub_paid_until")?.value || "").trim(),
    payHistory: (meta.companies[idx]?.subscription?.payHistory || []),
  } : { active: false };

  const director   = val("co_director").trim();
  const voen       = val("co_voen").trim();
  const address    = val("co_address").trim();
  const requisites = (byId("co_requisites")?.value || "").trim();

  if (idx === null) {
    const id = val("co_id").trim().toLowerCase().replace(/\s+/g, "_");
    if (!id) return alert("Şirkət ID-sini daxil edin.");
    if (meta.companies.some(c => c.id === id)) return alert("Bu ID artıq mövcuddur. Başqa ID seçin.");
    meta.companies.push({ id, name, director, voen, address, requisites, sections, subscription });
  } else {
    meta.companies[idx] = { ...meta.companies[idx], name, director, voen, address, requisites, sections, subscription };
  }
  saveMeta();
  closeMdl();
  renderAll();
}

function markCompanyPaid(idx) {
  if (!isDeveloper()) return;
  const c = meta.companies[idx];
  if (!c?.subscription?.active) return;
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const sub = meta.companies[idx].subscription;
  sub.paidUntil = curMonth;
  if (!Array.isArray(sub.payHistory)) sub.payHistory = [];
  const alreadyRecorded = sub.payHistory.some(h => h.month === curMonth);
  if (!alreadyRecorded) {
    sub.payHistory.push({
      month: curMonth,
      paidAt: now.toISOString(),
      amount: sub.monthlyAmount || 0,
      by: tgUserName(),
      note: "Əl ilə qeyd edildi"
    });
  }
  saveMeta();
  renderAll();
  if (c.id === meta?.session?.companyId) hideSubscriptionBlock();
  toast(`${escapeHtml(c.name)} — ${curMonth} ödənişi qeyd edildi`, "ok");
}

function deleteCompanyPayment(idx, month) {
  if (!isDeveloper()) return;
  const c = meta.companies[idx];
  if (!c?.subscription) return;
  appConfirm(`"${month}" ödənişi silinsin?`).then(ok => {
    if (!ok) return;
    const sub = c.subscription;
    sub.payHistory = (sub.payHistory || []).filter(h => h.month !== month);
    // Recalculate paidUntil from remaining history
    const months = (sub.payHistory || []).map(h => h.month).sort();
    sub.paidUntil = months.length > 0 ? months[months.length - 1] : "";
    saveMeta();
    renderAll();
    // Update subscription UI for active company without page reload
    if (c.id === meta?.session?.companyId) checkSubscriptionStatus();
    openCompanyInfo(idx);
    toast(`${month} ödənişi silindi`, "warn");
  });
}

function openCompanyInfo(idx) {
  const c = meta.companies[idx];
  if (!c) return;
  const sub = c.subscription || {};
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const isPaid = (sub.paidUntil || "") >= curMonth;

  const tariffBlock = sub.active
    ? `<div class="info-row"><div class="info-label">Tarif</div><div class="info-value"><b>${money(sub.monthlyAmount)} AZN / ay</b></div></div>
       <div class="info-row"><div class="info-label">Ödəniş vaxtı</div><div class="info-value">Hər ayın 1–5-i arası</div></div>
       <div class="info-row"><div class="info-label">Bu ay</div><div class="info-value">${isPaid ? '<span class="pill paid">✅ Ödənilib</span>' : '<span class="pill overdue">⚠️ Ödənilməyib</span>'}</div></div>
       <div class="info-row"><div class="info-label">Son ödəniş</div><div class="info-value">${sub.paidUntil || "—"}</div></div>`
    : `<div class="info-row"><div class="info-label">Tarif</div><div class="info-value"><span class="pill" style="background:#f1f5f9;color:#64748b">Pulsuz</span></div></div>`;

  const hist = Array.isArray(sub.payHistory) && sub.payHistory.length > 0
    ? sub.payHistory.slice().reverse().map(p =>
        `<tr>
          <td>${p.month}</td>
          <td>${money(p.amount)} AZN</td>
          <td>${p.note || "—"}</td>
          <td>${p.by || "—"}</td>
          ${isDeveloper() ? `<td><button class="icon-btn delete" type="button" onclick="deleteCompanyPayment(${idx},'${escapeAttr(p.month)}')" title="Sil"><i class="fas fa-trash"></i></button></td>` : ""}
        </tr>`
      ).join("")
    : `<tr><td colspan="${isDeveloper() ? 5 : 4}" style="text-align:center;color:var(--text-muted)">Ödəniş tarixçəsi yoxdur</td></tr>`;

  const payBtn = (sub.active && !isPaid && isDeveloper())
    ? `<button class="btn-main" type="button" onclick="markCompanyPaid(${idx});openCompanyInfo(${idx})">✅ Bu ayı ödənilib qeyd et</button>`
    : "";

  const detailsBlock = `
    <div class="info-row"><div class="info-label">Şirkət adı</div><div class="info-value">${escapeHtml(c.name || "—")}</div></div>
    ${c.director  ? `<div class="info-row"><div class="info-label">Direktor</div><div class="info-value">${escapeHtml(c.director)}</div></div>` : ""}
    ${c.voen      ? `<div class="info-row"><div class="info-label">VÖEN</div><div class="info-value">${escapeHtml(c.voen)}</div></div>` : ""}
    ${c.address   ? `<div class="info-row"><div class="info-label">Ünvan</div><div class="info-value">${escapeHtml(c.address)}</div></div>` : ""}
    ${c.requisites? `<div class="info-row"><div class="info-label">Rekvizitlər</div><div class="info-value" style="white-space:pre-line">${escapeHtml(c.requisites)}</div></div>` : ""}
  `;

  openModal(`
    <h2>📋 ${escapeHtml(c.name)}</h2>
    <div class="form-stack">
      <div class="form-card">
        <div class="form-card-title">Şirkət məlumatları</div>
        <div class="info-block">${detailsBlock}</div>
      </div>
      <div class="form-card">
        <div class="form-card-title">Abunəlik məlumatı</div>
        <div class="info-block">${tariffBlock}</div>
      </div>
      <div class="form-card">
        <div class="form-card-title">Ödəniş tarixçəsi</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ay</th><th>Məbləğ</th><th>Qeyd</th><th>Qeyd edən</th>${isDeveloper() ? "<th></th>" : ""}</tr></thead>
            <tbody>${hist}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      ${payBtn}
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function restoreCompany(idx) {
  if (!isDeveloper()) return;
  const c = meta.companies[idx];
  if (!c) return;
  appConfirm(`"${c.name}" yenidən aktiv edilsin?`).then(ok => {
    if (!ok) return;
    meta.companies[idx].disabled = false;
    saveMeta();
    renderAll();
    toast(`${escapeHtml(c.name)} bərpa edildi`, "ok");
  });
}

function checkSubscriptionStatus() {
  if (isDeveloper()) { hideSubscriptionBlock(); return; }
  const cid = meta?.session?.companyId;
  if (!cid) return;
  const company = (meta.companies || []).find((c) => c.id === cid);
  if (!company) return;

  // Company disabled check
  if (company.disabled) {
    showCompanyDisabled(company.name);
    return;
  }
  const sub = company?.subscription;
  if (!sub?.active) return;

  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const day = now.getDate();
  const isPaid = (sub.paidUntil || "") >= curMonth;
  if (isPaid) { hideSubscriptionBlock(); return; }

  const amount = money(sub.monthlyAmount || 0);
  const monthLabel = now.toLocaleString("az-AZ", { month: "long", year: "numeric" });

  if (day <= 5) {
    showSubscriptionWarning(amount, monthLabel);
  } else {
    showSubscriptionSuspended(amount, monthLabel);
  }
}

function showCompanyDisabled(name) {
  ["subWarningPopup","subSuspendOverlay"].forEach(id => { const e = byId(id); if (e) e.remove(); });
  let el = byId("compDisabledOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "compDisabledOverlay";
    document.body.appendChild(el);
  }
  el.className = "ios-block-overlay";
  el.innerHTML = `
    <div class="ios-block-card">
      <div class="ios-block-icon">🚫</div>
      <div class="ios-block-title">Şirkət deaktiv edildi</div>
      <div class="ios-block-body"><b>${escapeHtml(name || "")}</b> şirkəti developer tərəfindən deaktiv edilib.</div>
      <div class="ios-block-body" style="margin-bottom:24px;font-size:.8rem">Əlavə məlumat üçün developer ilə əlaqə saxlayın.</div>
      <div class="ios-dialog-btns" style="margin:0 -28px">
        <button class="ios-btn-cancel" onclick="logoutFromDisabled()">Çıxış</button>
      </div>
    </div>
  `;
}

function showSubscriptionWarning(amount, monthLabel) {
  ["subWarningBar","subSuspendOverlay","compDisabledOverlay"].forEach(id => { const e = byId(id); if (e) e.remove(); });
  let el = byId("subWarningPopup");
  if (!el) {
    el = document.createElement("div");
    el.id = "subWarningPopup";
    document.body.appendChild(el);
  }
  el.className = "ios-block-overlay";
  el.innerHTML = `
    <div class="ios-block-card">
      <div class="ios-block-icon">⚠️</div>
      <div class="ios-block-title">Abunəlik ödənişi gözlənilir</div>
      <div class="ios-block-body"><b>${monthLabel}</b> üçün ödəniş hələ edilməyib.<br>Məbləğ: <b>${amount} AZN</b></div>
      <div class="ios-block-note">Son tarix: bu ayın <b>5-i</b>.<br>Ödəniş edilmədikdə xidmət dayandırılacaq.</div>
      <div class="ios-dialog-btns" style="margin:0 -28px">
        <button class="ios-btn-ok" onclick="document.getElementById('subWarningPopup').remove()">Anladım</button>
      </div>
    </div>
  `;
}

function showSubscriptionSuspended(amount, monthLabel) {
  ["subWarningPopup","compDisabledOverlay"].forEach(id => { const e = byId(id); if (e) e.remove(); });
  let el = byId("subSuspendOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "subSuspendOverlay";
    document.body.appendChild(el);
  }
  el.className = "ios-block-overlay";
  el.innerHTML = `
    <div class="ios-block-card">
      <div class="ios-block-icon">🔒</div>
      <div class="ios-block-title">Xidmət dayandırıldı</div>
      <div class="ios-block-body"><b>${monthLabel}</b> üçün abunəlik ödənişi edilməyib.<br>Məbləğ: <b>${amount} AZN</b></div>
      <div class="ios-block-body" style="margin-bottom:24px;font-size:.8rem">Xidmətdən istifadəni bərpa etmək üçün ödəniş edin və developer ilə əlaqə saxlayın.</div>
      <div class="ios-dialog-btns" style="margin:0 -28px">
        <button class="ios-btn-cancel" onclick="logout()">Çıxış</button>
      </div>
    </div>
  `;
  el.style.display = "flex";
}

function hideSubscriptionBlock() {
  ["subWarningBar","subWarningPopup","subSuspendOverlay","compDisabledOverlay"].forEach(id => {
    const el = byId(id);
    if (el) el.remove();
  });
}

function useCompany(companyId) {
  if (!isDeveloper()) return alert("İcazə yoxdur.");
  const c = meta.companies.find((x) => x.id === companyId);
  if (!c) return;
  meta.session.companyId = c.id;
  saveMeta();
  if (useFirestore()) {
    loadCompanyDBAsync({ soft: true }).then((data) => {
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
  if (!c.disabled) {
    // First action: deactivate
    appConfirm(`"${c.name}" deaktiv edilsin? (məlumatlar qalacaq, login bloklanacaq)`).then(ok => {
      if (!ok) return;
      meta.companies[idx].disabled = true;
      saveMeta();
      renderAll();
      toast(`${escapeHtml(c.name)} deaktiv edildi`, "warn");
    });
  } else {
    // Second action: permanent delete (only if already disabled)
    appConfirm(`"${c.name}" bütün məlumatları ilə BİRLİKDƏ TAM silinsin? Bu geri alına bilməz!`).then(ok => {
      if (!ok) return;
      meta.companies.splice(idx, 1);
      if (meta.companies.length === 0) meta.companies.push({ id: "default", name: "Default" });
      if (meta.session && !meta.companies.some((x) => x.id === meta.session.companyId)) {
        meta.session.companyId = meta.companies[0].id;
        if (useFirestore()) loadCompanyDBAsync({ soft: true }).then((data) => { db = data; subscribeRealtime(); });
        else db = loadCompanyDB();
      }
      saveMeta();
      renderAll();
      toast("Şirkət tamamilə silindi", "warn");
    });
  }
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
      if (ref) {
        softLoadingBegin(false);
        ref
          .set(empty)
          .then(() => {
            db = empty;
            logEvent("reset", "company", { companyId: cid });
            renderAll();
          })
          .catch((e) => console.warn("Firestore reset xətası:", e))
          .finally(() => softLoadingEnd());
      }
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

function normalizeUsernamePart(text) {
  const map = {
    ə: "e", Ə: "e",
    ı: "i", I: "i", İ: "i",
    ö: "o", Ö: "o",
    ü: "u", Ü: "u",
    ğ: "g", Ğ: "g",
    ş: "s", Ş: "s",
    ç: "c", Ç: "c",
    ñ: "n", Ñ: "n",
  };
  return String(text || "")
    .split("")
    .map((ch) => (Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch))
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAutoUsernameForUser(fullName, excludeUid) {
  const compId = meta?.session?.companyId || "";
  const comp = (meta?.companies || []).find((c) => c.id === compId);
  const compName = String(db.settings?.companyName || comp?.name || compId || "company").trim();
  const cleaned = normalizeUsernamePart(fullName);
  const parts = cleaned.split(" ").filter(Boolean);
  const first = parts[0] || "user";
  const surnameInitial = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  const suffix = `${first}${surnameInitial}` || "user";
  const base = `${compName}_${suffix}`;
  let candidate = base;
  let nIdx = 2;
  while (meta.users.some((u) => Number(u.uid) !== Number(excludeUid || 0) && String(u.username || "").trim().toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base}${nIdx}`;
    nIdx++;
  }
  return candidate;
}

function getAutoUserFullName() {
  const manual = !!byId("u_manual_mode")?.checked;
  if (manual) return val("u_full").trim();
  const staffUid = (val("u_staff") || "").trim();
  const staff = (db.staff || []).find((s) => String(s.uid) === String(staffUid));
  return String(staff?.name || "").trim();
}

function syncAutoUserIdentity() {
  const uidVal = (val("u_uid") || "").trim();
  const isNew = !uidVal;
  const manual = !!byId("u_manual_mode")?.checked;
  const fullEl = byId("u_full");
  const userEl = byId("u_name");
  const staffWrap = byId("u_staff_wrap");
  if (!fullEl || !userEl) return;
  if (staffWrap) staffWrap.style.display = manual ? "none" : "";
  const fullName = getAutoUserFullName();
  if (isNew && !manual) fullEl.value = fullName;
  // only auto-fill username if it's still empty (user hasn't typed manually)
  if (isNew && !userEl.value.trim()) userEl.value = fullName ? buildAutoUsernameForUser(fullName, 0) : "";
  else if (isNew && fullName) userEl.value = buildAutoUsernameForUser(fullName, 0);
}

function toggleUserManualMode() {
  syncAutoUserIdentity();
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
    "sales",
    "purch",
    "stock",
    "cust",
    "supp",
    "prod",
    "staff",
    "debts",
    "overdue",
    "creditor",
    "cash",
    "accounts",
    "reports",
    "users",
    "audit",
    "trash",
    "tools",
  ];
  const checks = sections
    .map((s) => {
      const on = (editingUser.perms?.sections || []).includes("*") || (editingUser.perms?.sections || []).includes(s);
      return `<label class="perm-row"><span class="perm-label">${escapeHtml(sectionLabelAz(s))}</span><input type="checkbox" class="permSec" value="${s}" ${on ? "checked" : ""}></label>`;
    })
    .join("");
  const isNew = uidOrNull == null || uidOrNull === "";
  const usedStaffUids = new Set(
    usersForCurrentCompany()
      .filter((x) => String(x.uid) !== String(editingUser.uid || ""))
      .map((x) => String(x.staffUid || "").trim())
      .filter(Boolean)
  );
  const staffOptions = [
    `<option value="">— Əməkdaş seçin —</option>`,
    ...(db.staff || [])
      .filter((s) => !isNew || !usedStaffUids.has(String(s.uid)))
      .map((s) => `<option value="${s.uid}" ${String(editingUser.staffUid || "") === String(s.uid) ? "selected" : ""}>${escapeHtml(s.name)}${s.role ? " - " + escapeHtml(s.role) : ""}</option>`),
  ].join("");
  const manualChecked = isNew ? false : !editingUser.staffUid;
  openModal(`
    <h2>${isNew ? "Yeni istifadəçi" : "İstifadəçi redaktə"}</h2>
    <form onsubmit="saveUser(event)">
      <input type="hidden" id="u_uid" value="${escapeAttr(isNew ? "" : String(editingUser.uid))}">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">İstifadəçi</div>
          <div class="grid-2">
            ${isNew ? `<label class="chk grid-span-2"><input type="checkbox" id="u_manual_mode" onchange="toggleUserManualMode()"><span>Əməkdaşsız manual istifadəçi yarat</span></label>` : ""}
            <div class="f-group" id="u_staff_wrap"><label>Əməkdaş ${isNew ? "*" : ""}</label><select id="u_staff" title="Əməkdaş" ${isNew ? 'onchange="syncAutoUserIdentity()"' : ""}>
          ${staffOptions}
        </select></div>
            <div class="f-group"><label>Ad Soyad *</label><input id="u_full" placeholder="Ad Soyad" value="${escapeHtml(editingUser.fullName || "")}" ${isNew ? 'oninput="syncAutoUserIdentity()"' : ""} required></div>
            <div class="f-group"><label>İstifadəçi adı *</label><input id="u_name" placeholder="${escapeAttr((cid || "sirket") + "_rustamb")}" value="${escapeHtml(editingUser.username || "")}" required></div>
            <div class="f-group"><label>Rol</label><select id="u_role">
          <option value="user" ${editingUser.role === "user" ? "selected" : ""}>İstifadəçi (user)</option>
          <option value="admin" ${editingUser.role === "admin" ? "selected" : ""}>Admin</option>
          <option value="developer" ${editingUser.role === "developer" ? "selected" : ""}>Developer</option>
        </select></div>
            <div class="f-group"><label>Vəzifə şablonu</label><select id="u_job_preset" onchange="applyJobPreset()">
          <option value="">— Şablon seç (icazələri tez doldurmaq üçün) —</option>
          <option value="satis_mute">Satış mütəxəssisi</option>
          <option value="kredit_mute">Kredit mütəxəssisi</option>
          <option value="anbar_mute">Anbar mütəxəssisi</option>
          <option value="kassir">Kassir</option>
          <option value="muhasib">Mühasib</option>
          <option value="mudur">Müdir (tam icazə)</option>
        </select></div>
            <div class="f-group"><label>Şifrə *</label><input id="u_pass" placeholder="Şifrə" type="password" value="${escapeHtml(editingUser.pass || "")}" required autocomplete="new-password"></div>
            <label class="chk grid-span-2"><input type="checkbox" id="u_active" ${editingUser.active ? "checked" : ""}><span>Aktiv</span></label>
          </div>
        </div>
        <div class="perm-group">
          <div class="perm-group-title">İcazələr</div>
          <div class="perm-list">
            <label class="perm-row perm-row--accent">
              <span class="perm-label">Hamısı (tam icazə)</span>
              <input type="checkbox" id="u_all_perms" onchange="toggleAllUserPerms(this)">
            </label>
            <label class="perm-row">
              <span class="perm-label">Redaktə edə bilsin</span>
              <input type="checkbox" id="u_can_edit" ${editingUser.perms.canEdit ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Silə bilsin</span>
              <input type="checkbox" id="u_can_delete" ${editingUser.perms.canDelete ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Ödəniş edə bilsin</span>
              <input type="checkbox" id="u_can_pay" ${editingUser.perms.canPay ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Qaytarma edə bilsin</span>
              <input type="checkbox" id="u_can_ref" ${editingUser.perms.canRefund ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Export edə bilsin</span>
              <input type="checkbox" id="u_can_exp" ${editingUser.perms.canExport ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Import edə bilsin</span>
              <input type="checkbox" id="u_can_imp" ${editingUser.perms.canImport ? "checked" : ""}>
            </label>
            <label class="perm-row">
              <span class="perm-label">Reset edə bilsin</span>
              <input type="checkbox" id="u_can_reset" ${editingUser.perms.canReset ? "checked" : ""}>
            </label>
          </div>
        </div>
        <div class="perm-group">
          <div class="perm-group-title">Detallı icazələr</div>
          <div class="perm-list perm-list--table">${actionMatrix}</div>
        </div>
        <div class="perm-group">
          <div class="perm-group-title">Bölmələr</div>
          <div class="perm-list">
            <label class="perm-row perm-row--accent">
              <span class="perm-label">Hamısı (bütün bölmələr)</span>
              <input type="checkbox" id="u_all_secs" onchange="toggleAllUserSecs(this)">
            </label>
            ${checks}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">${isNew ? "Yarat" : "Yenilə"}</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
  if (isNew) {
    if (byId("u_manual_mode")) byId("u_manual_mode").checked = false;
    syncAutoUserIdentity();
  } else if (byId("u_manual_mode")) {
    byId("u_manual_mode").checked = manualChecked;
    syncAutoUserIdentity();
  }
}

const JOB_PRESETS = {
  satis_mute: {
    sections: ["dash", "sales", "cust", "stock", "debts"],
    perms: { canEdit: true, canPay: true, canRefund: false, canDelete: false, canExport: false, canImport: false, canReset: false },
  },
  kredit_mute: {
    sections: ["dash", "sales", "cust", "debts", "overdue"],
    perms: { canEdit: true, canPay: true, canRefund: false, canDelete: false, canExport: true, canImport: false, canReset: false },
  },
  anbar_mute: {
    sections: ["dash", "stock", "purch", "prod", "supp"],
    perms: { canEdit: true, canPay: false, canRefund: true, canDelete: false, canExport: true, canImport: true, canReset: false },
  },
  kassir: {
    sections: ["dash", "cash", "sales", "debts", "creditor"],
    perms: { canEdit: false, canPay: true, canRefund: false, canDelete: false, canExport: false, canImport: false, canReset: false },
  },
  muhasib: {
    sections: ["dash", "cash", "accounts", "reports", "audit", "staff"],
    perms: { canEdit: true, canPay: true, canRefund: true, canDelete: false, canExport: true, canImport: false, canReset: false },
  },
  mudur: {
    sections: ["dash", "sales", "purch", "stock", "cust", "supp", "prod", "staff", "debts", "overdue", "creditor", "cash", "accounts", "reports", "audit"],
    perms: { canEdit: true, canPay: true, canRefund: true, canDelete: true, canExport: true, canImport: true, canReset: false },
  },
};

function applyJobPreset() {
  const preset = JOB_PRESETS[val("u_job_preset") || ""];
  if (!preset) return;
  // apply sections
  document.querySelectorAll(".permSec").forEach((el) => { el.checked = preset.sections.includes(el.value); });
  // apply perms
  const pmap = { canEdit: "u_can_edit", canDelete: "u_can_delete", canPay: "u_can_pay", canRefund: "u_can_ref", canExport: "u_can_exp", canImport: "u_can_imp", canReset: "u_can_reset" };
  for (const [k, id] of Object.entries(pmap)) {
    const el = byId(id); if (el) el.checked = !!(preset.perms[k]);
  }
}

function toggleAllUserPerms(cb) {
  const v = cb.checked;
  ["u_can_edit","u_can_delete","u_can_pay","u_can_ref","u_can_exp","u_can_imp","u_can_reset"].forEach((id) => {
    const el = byId(id); if (el) el.checked = v;
  });
  document.querySelectorAll(".permAct").forEach((el) => { el.checked = v; });
  if (v) {
    document.querySelectorAll(".permSec").forEach((el) => { el.checked = true; });
    const allSec = byId("u_all_secs"); if (allSec) allSec.checked = true;
  }
}

function toggleAllUserSecs(cb) {
  document.querySelectorAll(".permSec").forEach((el) => { el.checked = cb.checked; });
}

function saveUser(e) {
  e.preventDefault();
  if (!isDeveloper() && !isAdmin()) return;
  const uidVal = (val("u_uid") || "").trim();
  const isNew = uidVal === "";
  const manualMode = isNew && !!byId("u_manual_mode")?.checked;
  let fullName = val("u_full").trim();
  let staffUid = (val("u_staff") || "").trim();
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
  const cid = (meta?.session?.companyId || "").trim().toLowerCase();
  if (!pass) return;
  if (isNew) {
    if (!cid) return alert("Cari şirkət müəyyən deyil.");
    if (!manualMode && !staffUid) return alert("Əməkdaş seçin.");
    if (staffUid && usersForCurrentCompany().some((u) => String(u.staffUid || "") === String(staffUid))) {
      return alert("Bu əməkdaş üçün artıq istifadəçi var.");
    }
    if (!manualMode) {
      const staff = (db.staff || []).find((s) => String(s.uid) === String(staffUid));
      if (!staff) return alert("Əməkdaş tapılmadı.");
      fullName = String(staff.name || "").trim();
    } else {
      staffUid = "";
    }
  }
  const username = buildAutoUsernameForUser(fullName, uidVal || 0);
  const prefix = getCompanyIdFromUsername(username);
  if (!fullName || !username) return;
  if (isNew) {
    if (!prefix || prefix !== cid) return alert("İstifadəçi adı şirkət adı ilə başlamalıdır: " + (meta?.session?.companyId || cid) + "_ (məs: " + (meta?.session?.companyId || cid) + "_rustamb).");
    if (meta.users.some((u) => u.username === username)) return alert("Bu istifadəçi adı var.");
    meta.users.push({ uid: genId(meta.users, 1), fullName, username, staffUid: staffUid || undefined, pass, role, active, companyId: cid || null, perms: { sections, canEdit, canDelete, canPay, canRefund, canExport, canImport, canReset, actions }, createdAt: nowISODateTimeLocal() });
  } else {
    const idx = meta.users.findIndex((x) => String(x.uid) === String(uidVal));
    if (idx === -1) return;
    const keep = meta.users[idx];
    if (!isDeveloper() && cid && !userBelongsToCompany(keep, cid)) return alert("Bu istifadəçi başqa şirkətə aiddir.");
    if (staffUid && usersForCurrentCompany().some((u) => String(u.uid) !== String(uidVal) && String(u.staffUid || "") === String(staffUid))) {
      return alert("Bu əməkdaş üçün artıq istifadəçi var.");
    }
    const staff = staffUid ? (db.staff || []).find((s) => String(s.uid) === String(staffUid)) : null;
    if (staff) fullName = String(staff.name || "").trim() || fullName;
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Qaytarma</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="ret_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Geri qaytarılacaq məbləğ (AZN)</label><input type="number" step="0.01" id="ret_refund" placeholder="0 — istəyə bağlı" value="0"></div>
            <div class="f-group"><label>Hesab</label><select id="ret_acc">${accOptions}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="ret_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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

function printSaleContract(idx) {
  const s = db.sales[idx];
  if (!s) return;
  const cust = db.cust.find((c) => String(c.uid) === String(s.customerId)) || {};
  const guarantor = cust.zam ? (db.cust.find((c) => String(c.uid) === String(cust.zam)) || null) : null;
  const st = db.settings || {};

  const today = fmtDT(new Date().toISOString()).split(" ")[0];
  const saleDate = fmtDT(s.date).split(" ")[0];
  const docNo  = escapeHtml(String(s.invNo || s.uid));

  const co          = escapeHtml(st.companyName       || "Şirkət");
  const coLegal     = escapeHtml(st.companyLegalName  || st.companyName || "Şirkət");
  const coAddr      = escapeHtml(st.companyAddress    || "");
  const coPhone     = escapeHtml(st.companyPhone      || "");
  const coVoen      = escapeHtml(st.companyVoen       || "");
  const coDirector  = escapeHtml(st.companyDirector   || "______________________");
  const coBank      = escapeHtml(st.companyBank       || "");
  const coBankAcc   = escapeHtml(st.companyBankAcc    || "");
  const coSwift     = escapeHtml(st.companySwift      || "");
  const coCorrAcc   = escapeHtml(st.companyCorrAcc    || "");

  const custFull = escapeHtml(`${cust.sur||""} ${cust.name||""} ${cust.father||""}`.trim());
  const custFin  = escapeHtml(cust.fin      || "-");
  const custSer  = escapeHtml(cust.seriaNum || "-");
  const custPh   = escapeHtml(cust.ph1      || "-");
  const custAddr = escapeHtml(cust.addr     || "-");

  const zamFull  = guarantor ? escapeHtml(`${guarantor.sur||""} ${guarantor.name||""} ${guarantor.father||""}`.trim()) : null;
  const zamFin   = guarantor ? escapeHtml(guarantor.fin || "-") : null;
  const zamSer   = guarantor ? escapeHtml(guarantor.seriaNum || "-") : null;
  const zamPh    = guarantor ? escapeHtml(guarantor.ph1 || "-") : null;

  const prod  = escapeHtml(s.productName || "-");
  const imei1 = escapeHtml(s.imei1 || "-");
  const imei2 = escapeHtml(s.imei2 || "-");
  const seria = escapeHtml(s.seria || "-");
  const total = money(s.amount);
  const paid  = money(s.paidTotal);
  const saleTypeLabel = { nagd:"Nağd", post:"Post", post_taksit:"Post Taksit",
    topdan:"Topdan", korporativ:"Korporativ", kredit:"Kredit", kocurme:"Köçürmə" };
  const sType = escapeHtml(saleTypeLabel[String(s.saleType||"").toLowerCase()] || String(s.saleType||"").toUpperCase());

  const creditRows = s.saleType === "kredit" && s.credit ? (() => {
    const sch = buildCreditSchedule(s);
    return `
    <div class="section">
      <div class="section-title">Kredit şərtləri</div>
      <div class="row"><span class="lbl">İlkin ödəniş:</span><span class="val">${money(s.credit.downPayment)} AZN</span></div>
      <div class="row"><span class="lbl">Kredit məbləği:</span><span class="val">${money(sch.remAfterDown)} AZN</span></div>
      <div class="row"><span class="lbl">Müddət:</span><span class="val">${sch.term} ay</span></div>
      <div class="row"><span class="lbl">Aylıq ödəniş:</span><span class="val">${money(s.credit.monthlyPayment)} AZN</span></div>
    </div>`;
  })() : "";

  const sch = s.saleType === "kredit" && s.credit ? buildCreditSchedule(s) : null;
  const downAmt    = sch ? money(s.credit.downPayment)    : "—";
  const creditAmt  = sch ? money(sch.remAfterDown)        : "—";
  const termMonths = sch ? sch.term + " ay"               : "—";
  const monthlyAmt = sch ? money(s.credit.monthlyPayment) : "—";

  const bankBlock = (coBank || coBankAcc) ? `
    <p style="margin-top:6px;font-size:12px;">
      ${coBank ? `Bank: <strong>${coBank}</strong>` : ""}
      ${coBankAcc ? ` &nbsp;|&nbsp; Hesab: <strong>${coBankAcc}</strong>` : ""}
      ${coSwift ? ` &nbsp;|&nbsp; SWIFT: <strong>${coSwift}</strong>` : ""}
      ${coCorrAcc ? ` &nbsp;|&nbsp; Müxbir: <strong>${coCorrAcc}</strong>` : ""}
    </p>` : "";

  const html = `<!DOCTYPE html><html lang="az"><head><meta charset="UTF-8">
<title>Nisyə Alqı-Satqı Müqaviləsi №${docNo}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Times New Roman',Times,serif;font-size:13px;color:#111;background:#f3f4f6;padding:20px;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;}
  .page{width:210mm;background:#fff;padding:18mm 16mm;border-radius:8px;}
  p{font-size:13px;line-height:1.9;margin-bottom:10px;text-align:justify;}
  .sec-title{font-size:13px;font-weight:700;text-align:center;margin:20px 0 10px;}
  .field-row{display:flex;align-items:baseline;gap:4px;margin-bottom:6px;font-size:13px;}
  .field-label{font-weight:700;white-space:nowrap;}
  .field-line{flex:1;border-bottom:1px solid #111;min-width:80px;}
  .sign-block{display:flex;justify-content:space-between;margin-top:30px;gap:20px;}
  .sign-col{flex:1;}
  .sign-col p{text-align:left;margin-bottom:4px;}
  .sign-underline{border-bottom:1px solid #111;height:22px;margin-top:16px;}
  .footer-note{text-align:center;font-size:10px;color:#9ca3af;margin-top:20px;border-top:1px dashed #d1d5db;padding-top:8px;}
  @media print{body{background:#fff;padding:0;display:block;min-height:unset;}.page{border-radius:0;padding:12mm 14mm;}@page{size:A4 portrait;margin:0;}}
</style></head><body>
<div class="page">

  <div style="font-size:17px;font-weight:700;margin-bottom:16px;">${co}</div>

  <div style="text-align:right;font-size:13px;font-weight:700;margin-bottom:20px;">
    Nisyə alqı-satqı müqaviləsi № ${docNo}
  </div>

  <div style="display:flex;justify-content:space-between;margin-bottom:18px;font-size:13px;">
    <div><strong>Bakı şəhəri,</strong></div>
    <div><strong>${saleDate}</strong></div>
  </div>
  <div style="margin-bottom:18px;font-size:13px;">${saleDate.split(".")[2]}-cü il</div>

  <p>
    Bu müqaviləni (bundan sonra «Müqavilə» adlandırılacaq), bir tərəfdən Azərbaycan Respublikasının qanunvericiliyinə əsasən qeydə alınmış və Nizamnamə əsasında fəaliyyət göstərən <strong>"${coLegal}" Məhdud Məsuliyyətli Cəmiyyəti</strong>, Direktor <strong>${coDirector}${coVoen ? ` (VÖEN:${coVoen})` : ""}</strong> şəxsində, (bundan sonra "Satıcı" adlanacaq) və digər tərəfdən şəxsiyyət vəsiqəsinin seriya nömrəsi <strong>${custSer}</strong>, <strong>${custFull}</strong> şəxsində, (bundan sonra "Alıcı" adlanacaq (birlikdə "Tərəflər") aşağıdakı müqaviləni (bundan sonra "Müqavilə") bağladılar.
  </p>

  <div class="sec-title">1. Müqavilənin predmeti</div>
  <p>
    1.1. Müqaviləyə əsasən Satıcı Alıcıya Müqaviləyə əlavə olunan, Müqavilədə və onun ayrılmaz tərkib hissəsi hesab edilən "Əlavə 1"-də göstərilən Mal(lar)ı sənədlər əsasında (qaimə, vergi hesab-fakturası, və s.) nisyə satır, Alıcı isə həmin Mal(lar)ı qəbul edir və bu müqavilə ilə razılaşdırılmış qaydada Mal(lar)ın dəyərini Satıcıya ödəməyi öhdəsinə götürür.
  </p>

  <div style="margin:14px 0 6px;">
    <div class="field-row"><span class="field-label">Məhsulun adı:</span><span class="field-line">&nbsp;${prod}</span></div>
    <div class="field-row"><span class="field-label">İlkin ödəniş məbləği:</span><span class="field-line">&nbsp;${downAmt} AZN</span></div>
    <div class="field-row"><span class="field-label">Kredit məbləği:</span><span class="field-line">&nbsp;${creditAmt} AZN</span></div>
    <div class="field-row"><span class="field-label">Kredit müddəti:</span><span class="field-line">&nbsp;${termMonths}</span></div>
    <div class="field-row"><span class="field-label">Aylıq ödəniş məbləği:</span><span class="field-line">&nbsp;${monthlyAmt} AZN</span></div>
  </div>

  <div class="sec-title">2. Tərəflərin hüquq və vəzifələri</div>
  <p><strong>2.1. Satıcının hüquqları:</strong></p>
  <p>2.1.1. Müqavilə ilə üzərinə götürdüyü vəzifələri vaxtında və lazımınca icra etməyi və onların pozulmasına yol verməməyi Alıcıdan tələb edir;</p>
  <p>2.1.2. Alıcı bu müqavilənin şərtlərinin pozulmasına yol verdiyi halda isə müqavilənin vaxtından əvvəl ləğv edilməsinin və Alıcının müqavilə üzrə Satıcıya olan borcunun vaxtından əvvəl ödənilməsini tələb etmək.</p>
  <p><strong>2.2. Satıcının vəzifələri:</strong></p>
  <p>2.2.1. Alıcının nisyə aldığı Mala görə birdəfəlik haqqın hesablanmasının və tutulmasının düzgünlüyünə riayət etmək;</p>
  <p>2.2.2. Malı Alıcıya tam saz və qüsursuz vəziyyətdə təhvil vermək.</p>
  <p><strong>2.3. Alıcının hüquqları:</strong></p>
  <p>2.3.1. Satıcıdan Malın keyfiyyəti barədə tam məlumat almaq hüququna malikdir.</p>
  <p><strong>2.4. Alıcının vəzifələri:</strong></p>
  <p>2.4.1. Aylıq ödənişləri müqavilədə göstərilən müddətdə vaxtında ödəmək;</p>
  <p>2.4.2. Malı qəbul etdikdən sonra onun saxlanması və istifadəsi qaydalarına riayət etmək.</p>

  <div class="sec-title">3. Müqavilənin qüvvəsi və şərtləri</div>
  <p>3.1. Bu Müqavilə imzalandığı andan qüvvəyə minir və Tərəflər öhdəliklərini tam yerinə yetirənədək qüvvədə qalır.</p>
  <p>3.2. Müqavilə iki nüsxədə tərtib edilmişdir, hər bir nüsxə eyni hüquqi qüvvəyə malikdir.</p>

  <div class="sec-title">4. Tərəflərin rekvizitləri və imzaları</div>
  <div class="sign-block">
    <div class="sign-col">
      <p><strong>SATICI:</strong></p>
      <p><strong>"${coLegal || co}"</strong> MMC</p>
      ${coVoen    ? `<p>VÖEN: ${coVoen}</p>`       : ""}
      ${coAddr    ? `<p>Ünvan: ${coAddr}</p>`       : ""}
      ${coPhone   ? `<p>Tel: ${coPhone}</p>`         : ""}
      ${coDirector !== "______________________" ? `<p>Direktor: ${coDirector}</p>` : ""}
      ${bankBlock}
      <div class="sign-underline"></div>
      <p style="font-size:11px;margin-top:4px;">İmza / Möhür</p>
    </div>
    <div class="sign-col">
      <p><strong>ALICI:</strong></p>
      <p>${custFull}</p>
      <p>Şəx. vəs. ser.: ${custSer}</p>
      <p>FİN: ${custFin}</p>
      ${custPh !== "-" ? `<p>Tel: ${custPh}</p>` : ""}
      <div class="sign-underline"></div>
      <p style="font-size:11px;margin-top:4px;">İmza</p>
    </div>
  </div>

  <div class="footer-note">Müqavilə ${saleDate} tarixində tərtib edildi &nbsp;•&nbsp; ${co}</div>
</div>
<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};<\/script>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=700,toolbar=0,menubar=0,scrollbars=1");
  if (w) { w.document.write(html); w.document.close(); }
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
    <div class="form-stack">
      <div class="form-card">
        <div class="form-card-title">Axtarış</div>
        <div class="grid-2">
          <div class="f-group"><label>Axtarış sözü</label><input id="gs_q" placeholder="IMEI / Seriya / Kod / Qaimə / Ad …" oninput="runGlobalSearch()"></div>
        </div>
      </div>
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
    <div class="form-stack">
      <div class="form-card">
        <div class="form-card-title">Məzmun</div>
        <div class="grid-2">
          <div class="f-group"><label>Mətn</label><input id="qr_txt" placeholder="Mətn / Kod / IMEI / Seriya…"></div>
        </div>
      </div>
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

// ---- Settings page (sidebar section) ----
function renderSettingsPage() {
  const s = db.settings || {};
  const setVal = (id, v) => { const el = byId(id); if (el) el.value = v || ""; };
  setVal("pg_set_name",  s.companyName    || "");
  setVal("pg_set_addr",  s.companyAddress || "");
  setVal("pg_set_phone", s.companyPhone   || "");
  setVal("pg_set_curr",  s.currency       || "AZN");
  setVal("pg_set_sym",   s.currencySymbol || "₼");
  setVal("pg_tg_token",  s.telegramToken  || "");
  setVal("pg_tg_chat",   s.telegramChatId || "");
  const chk = byId("pg_tg_enabled");
  if (chk) chk.checked = s.telegramEnabled !== false;
}

function saveSettingsPage() {
  if (!isAdmin() && !isDeveloper()) return alert("İcazə yoxdur.");
  db.settings = db.settings || {};
  db.settings.companyName    = (byId("pg_set_name")?.value  || "").trim();
  db.settings.companyAddress = (byId("pg_set_addr")?.value  || "").trim();
  db.settings.companyPhone   = (byId("pg_set_phone")?.value || "").trim();
  db.settings.currency       = (byId("pg_set_curr")?.value  || "AZN").trim();
  db.settings.currencySymbol = (byId("pg_set_sym")?.value   || "₼").trim();
  db.settings.telegramToken  = (byId("pg_tg_token")?.value  || "").trim();
  db.settings.telegramChatId = (byId("pg_tg_chat")?.value   || "").trim();
  db.settings.telegramEnabled = byId("pg_tg_enabled")?.checked !== false;
  logEvent("update", "settings", {});
  saveDB();
  toast("Ayarlar yadda saxlandı", "ok");
}

async function testTelegramPage() {
  const token = (byId("pg_tg_token")?.value || "").trim();
  const chatId = (byId("pg_tg_chat")?.value || "").trim();
  if (!token || !chatId) return alert("Token və Chat ID daxil edin.");
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `✅ <b>${db.settings?.companyName || "ERP"}</b> — Telegram aktiv edildi!`, parse_mode: "HTML" }),
    });
    const j = await r.json();
    if (j.ok) alert("✅ Test mesajı göndərildi!");
    else alert("❌ Xəta: " + j.description);
  } catch (err) {
    alert("❌ Bağlantı xətası: " + err.message);
  }
}

function openTelegramSettings() {
  if (!isAdmin() && !isDeveloper()) return alert("İcazə yoxdur.");
  const s = db.settings || {};
  openModal(`
    <h2>📣 Telegram Ayarları</h2>
    <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:16px">Bu ayarlar yalnız bu şirkətə aiddir. Hər şirkətin öz botu ola bilər.</p>
    <form onsubmit="saveTelegramSettings(event)">
      <div class="form-card">
        <div class="grid-2">
          <div class="f-group"><label>Bot Token</label><input id="tg_token" placeholder="123456:AAFxxx..." value="${escapeHtml(s.telegramToken || "")}" autocomplete="off"></div>
          <div class="f-group"><label>Chat ID (qrup və ya şəxsi)</label><input id="tg_chat" placeholder="8358360181" value="${escapeHtml(s.telegramChatId || "")}"></div>
        </div>
        <button type="button" class="btn-cancel" onclick="testTelegramModal()" style="margin-top:8px"><i class="fas fa-paper-plane"></i> Test göndər</button>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Yadda saxla</button>
        <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
      </div>
    </form>
  `);
}

function saveTelegramSettings(e) {
  e.preventDefault();
  if (!isAdmin() && !isDeveloper()) return;
  db.settings = db.settings || {};
  db.settings.telegramToken = (byId("tg_token")?.value || "").trim();
  db.settings.telegramChatId = (byId("tg_chat")?.value || "").trim();
  saveDB();
  closeMdl();
  toast("Telegram ayarları yadda saxlandı", "ok");
}

async function testTelegramModal() {
  const token = (byId("tg_token")?.value || "").trim();
  const chatId = (byId("tg_chat")?.value || "").trim();
  if (!token || !chatId) return alert("Token və Chat ID daxil edin.");
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `✅ <b>${db.settings?.companyName || "ERP"}</b> — Telegram bildirişi aktiv edildi!`, parse_mode: "HTML" }),
    });
    const j = await r.json();
    if (j.ok) alert("✅ Test mesajı göndərildi!");
    else alert("❌ Xəta: " + j.description);
  } catch (err) {
    alert("❌ Bağlantı xətası: " + err.message);
  }
}

function openSettings() {
  if (!isAdmin() && !isDeveloper()) return alert("İcazə yoxdur.");
  ensureAuditTrash();
  const s = db.settings || defaultDB().settings;
  const dev = isDeveloper();
  openModal(`
    <h2>Ayarlar</h2>
    <form onsubmit="saveSettings(event)">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şirkət məlumatları</div>
          <div class="grid-2">
            <div class="f-group"><label>Şirkət adı *</label><input id="set_name" placeholder="Şirkət adı" value="${escapeHtml(s.companyName || "")}" required></div>
            <div class="f-group"><label>Hüquqi ad (tam)</label><input id="set_legal_name" placeholder="məs: Bakfon MMC" value="${escapeHtml(s.companyLegalName || "")}"></div>
            <div class="f-group"><label>Ünvan</label><input id="set_addr" placeholder="Ünvan" value="${escapeHtml(s.companyAddress || "")}"></div>
            <div class="f-group"><label>Telefon</label><input id="set_phone" placeholder="Telefon" value="${escapeHtml(s.companyPhone || "")}"></div>
            <div class="f-group"><label>Valyuta</label><input id="set_curr" placeholder="AZN" value="${escapeHtml(s.currency || "AZN")}"></div>
            <div class="f-group"><label>Valyuta simvolu</label><input id="set_sym" placeholder="₼" value="${escapeHtml(s.currencySymbol || "₼")}"></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Rekvizitlər</div>
          <div class="grid-2">
            <div class="f-group"><label>VÖEN</label><input id="set_voen" placeholder="1234567890" value="${escapeHtml(s.companyVoen || "")}"></div>
            <div class="f-group"><label>Direktor adı</label><input id="set_director" placeholder="Ad Soyad Ata adı" value="${escapeHtml(s.companyDirector || "")}"></div>
            <div class="f-group"><label>Bank adı</label><input id="set_bank" placeholder="ABB, Kapital Bank..." value="${escapeHtml(s.companyBank || "")}"></div>
            <div class="f-group"><label>Hesab №</label><input id="set_bank_acc" placeholder="AZ00XXXX0000000000" value="${escapeHtml(s.companyBankAcc || "")}"></div>
            <div class="f-group"><label>SWIFT/BİK</label><input id="set_swift" placeholder="AББАЗ2Х..." value="${escapeHtml(s.companySwift || "")}"></div>
            <div class="f-group"><label>Müxbir hesab</label><input id="set_corr_acc" placeholder="AZ00XXXX..." value="${escapeHtml(s.companyCorrAcc || "")}"></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">📣 Telegram Bildirişləri</div>
          <div class="grid-2">
            <div class="f-group"><label>Bot Token</label><input id="set_tg_token" placeholder="123456:AAFxxx..." value="${escapeHtml(s.telegramToken || "")}" autocomplete="off"></div>
            <div class="f-group"><label>Chat ID</label><input id="set_tg_chat" placeholder="8358360181" value="${escapeHtml(s.telegramChatId || "")}"></div>
          </div>
          <button type="button" class="btn-cancel" onclick="testTelegram()" style="margin-top:8px"><i class="fas fa-paper-plane"></i> Test göndər</button>
        </div>
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
  if (!isAdmin() && !isDeveloper()) return;
  ensureAuditTrash();
  db.settings = {
    companyName:      val("set_name").trim(),
    companyLegalName: val("set_legal_name").trim(),
    companyAddress:   val("set_addr").trim(),
    companyPhone:     val("set_phone").trim(),
    currency:         val("set_curr").trim() || "AZN",
    currencySymbol:   val("set_sym").trim() || "₼",
    companyVoen:      val("set_voen").trim(),
    companyDirector:  val("set_director").trim(),
    companyBank:      val("set_bank").trim(),
    companyBankAcc:   val("set_bank_acc").trim(),
    companySwift:     val("set_swift").trim(),
    companyCorrAcc:   val("set_corr_acc").trim(),
    telegramToken:    val("set_tg_token").trim(),
    telegramChatId:   val("set_tg_chat").trim(),
    ...(db.settings?.telegramEnabled !== undefined ? { telegramEnabled: db.settings.telegramEnabled } : {}),
  };
  logEvent("update", "settings", {});
  saveDB();
  closeMdl();
}

async function testTelegram() {
  const token = (byId("set_tg_token")?.value || "").trim();
  const chatId = (byId("set_tg_chat")?.value || "").trim();
  if (!token || !chatId) return alert("Token və Chat ID daxil edin.");
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "✅ ERP Telegram bildirişi aktiv edildi!", parse_mode: "HTML" }),
    });
    const j = await r.json();
    if (j.ok) alert("✅ Test mesajı göndərildi!");
    else alert("❌ Xəta: " + j.description);
  } catch (err) {
    alert("❌ Bağlantı xətası: " + err.message);
  }
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Ödəniş qaytarılması</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="ra_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Məbləğ (AZN) *</label><input type="number" step="0.01" id="ra_amount" value="${escapeAttr(String(left))}" placeholder="0.00" required></div>
            <div class="f-group"><label>Hesab *</label><select id="ra_acc" required>${accOptions}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="ra_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-main" type="submit">Qaytar</button>
        <button class="btn-back" type="button"><i class="fas fa-chevron-left"></i></button>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Sayım</div>
          <div class="grid-2">
            <div class="f-group"><label>Tarix *</label><input type="datetime-local" id="cc_date" value="${nowISODateTimeLocal()}" required></div>
            <div class="f-group"><label>Faktiki sayım (AZN) *</label><input type="number" step="0.01" id="cc_physical" placeholder="0.00" required></div>
            <div class="f-group"><label>Hesab *</label><select id="cc_acc" required>${accountOptionsHtml(Number(accId))}</select></div>
            <div class="f-group f-group--note"><label>Qeyd</label><input id="cc_note" placeholder="İstəyə bağlı"></div>
          </div>
        </div>
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
    <div class="form-stack">
      <div class="form-card">
        <div class="form-card-title">Gün sonu</div>
        <div class="grid-2">
          <div class="f-group"><label>Tarix / vaxt *</label><input type="datetime-local" id="dc_ts" value="${ts}" required></div>
          <div class="f-group f-group--note"><label>Qeyd</label><input id="dc_note" placeholder="İstəyə bağlı"></div>
        </div>
      </div>
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

function _renderDayCloseRows(closes) {
  if (!closes.length) return `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">Nəticə tapılmadı</td></tr>`;
  return closes.map((x, i) => {
    const accs = Array.isArray(x.accounts) ? x.accounts : [];
    const accRows = accs.map(a =>
      `<tr style="background:#f8fafc;">
        <td></td>
        <td style="padding-left:24px;color:var(--text-muted);font-size:.82rem;">${escapeHtml(a.name || "-")}</td>
        <td style="font-size:.82rem;color:var(--text-muted);">${escapeHtml(a.type || "-")}</td>
        <td colspan="2"></td>
        <td style="text-align:right;font-size:.85rem;font-weight:600;">${money(a.balance)} AZN</td>
      </tr>`
    ).join("");
    const sep = i > 0 ? `<tr><td colspan="6" style="padding:0;height:10px;background:transparent;border:none;"></td></tr>` : "";
    return `
      ${sep}
      <tr style="background:#f0f4f8;">
        <td class="muted" style="font-size:.8rem;border-top:2px solid var(--border-color);">${i + 1}</td>
        <td style="border-top:2px solid var(--border-color);">${fmtDT(x.ts)}</td>
        <td style="border-top:2px solid var(--border-color);">${escapeHtml(x.user || "-")}</td>
        <td style="border-top:2px solid var(--border-color);">${escapeHtml(x.note || "")}</td>
        <td colspan="2" style="text-align:right;padding-right:12px;border-top:2px solid var(--border-color);">
          <span style="font-size:1.15rem;font-weight:700;color:var(--text-main);">${money(x.totalBalance)}</span>
          <span style="font-size:.8rem;color:var(--text-muted);margin-left:3px;">AZN</span>
        </td>
      </tr>
      ${accRows}
    `;
  }).join("");
}

function filterDayCloseHistory() {
  const from = byId("dcFrom")?.value || "";
  const to   = byId("dcTo")?.value   || "";
  const all  = (db.dayCloses || []).slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const filtered = all.filter(x => {
    const d = (x.ts || "").slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
  const tbody = byId("dcHistTbody");
  if (tbody) tbody.innerHTML = _renderDayCloseRows(filtered);
}

function openDayCloseHistory() {
  ensureAuditTrash();
  const today = new Date().toISOString().slice(0, 10);
  const firstDate = (db.dayCloses || []).length
    ? (db.dayCloses || []).slice().sort((a,b) => String(a.ts).localeCompare(String(b.ts)))[0].ts.slice(0,10)
    : today;
  const all = (db.dayCloses || []).slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  openModal(`
    <h2>Gün sonu tarixçəsi</h2>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      <div class="f-group" style="margin:0;flex:1;min-width:130px;">
        <label style="font-size:.78rem;margin-bottom:4px;display:block;">Başlanğıc</label>
        <input type="date" id="dcFrom" value="${firstDate}" oninput="filterDayCloseHistory()">
      </div>
      <div class="f-group" style="margin:0;flex:1;min-width:130px;">
        <label style="font-size:.78rem;margin-bottom:4px;display:block;">Son</label>
        <input type="date" id="dcTo" value="${today}" oninput="filterDayCloseHistory()">
      </div>
      <button type="button" style="margin-top:18px;background:#fff;border:1px solid #d1d5db;border-radius:10px;height:34px;padding:0 14px;font-size:.85rem;font-weight:500;cursor:pointer;color:#374151;" onclick="byId('dcFrom').value='';byId('dcTo').value='';filterDayCloseHistory();">Sıfırla</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Tarix</th><th>İstifadəçi</th><th>Qeyd</th><th colspan="2" style="text-align:right;">Ümumi balans</th></tr></thead>
        <tbody id="dcHistTbody">${_renderDayCloseRows(all)}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn-back" type="button" onclick="openDayClose()"><i class="fas fa-chevron-left"></i></button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
  `);
}

function lateDaysChipClass(daysLate) {
  const d = Math.max(0, n(daysLate));
  if (d >= 91) return "late-chip-91p";
  if (d >= 61) return "late-chip-61-90";
  if (d >= 31) return "late-chip-31-60";
  if (d >= 16) return "late-chip-16-30";
  if (d >= 1) return "late-chip-1-15";
  return "late-chip-0";
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
      <td>${fmtDT(x.due)}</td>
      <td>${money(x.monthly)} AZN</td>
      <td>${money(x.remaining)} AZN</td>
      <td><span class="pill unpaid">GECİKİR</span></td>
      <td class="overdue-days-cell"><span class="late-chip ${lateDaysChipClass(x.daysLate)}">${x.daysLate}</span></td>
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
      <div class="info-row"><div class="info-label">Müştəri</div><div class="info-value">${escapeHtml(custName)}${cust && cust.fin ? ` <span style="color:var(--text-muted);font-size:.85em">(FIN: ${escapeHtml(cust.fin)})</span>` : ""}</div></div>
      ${cust && cust.ph1 ? `<div class="info-row"><div class="info-label">Əlaqə</div><div class="info-value">${escapeHtml(cust.ph1)}${cust.ph2?" / "+escapeHtml(cust.ph2):""}</div></div>` : ""}
      <div class="info-row"><div class="info-label">Zamin</div><div class="info-value">${escapeHtml(guarantor ? `${guarantor.sur || ""} ${guarantor.name || ""} ${guarantor.father || ""}`.trim() : "-")}</div></div>
      <div class="info-row"><div class="info-label">Qaimə</div><div class="info-value">${escapeHtml(inv)}</div></div>
      <div class="info-row"><div class="info-label">Məhsul</div><div class="info-value">${escapeHtml(sale.productName || "-")}</div></div>
      ${(sale.imei1 || sale.imei2) ? `<div class="info-row"><div class="info-label">IMEI</div><div class="info-value">${escapeHtml([sale.imei1, sale.imei2].filter(Boolean).join(" / "))}</div></div>` : ""}
      ${sale.seria ? `<div class="info-row"><div class="info-label">Seriya №</div><div class="info-value">${escapeHtml(sale.seria)}</div></div>` : ""}
      ${sale.code ? `<div class="info-row"><div class="info-label">Kod</div><div class="info-value">${escapeHtml(sale.code)}</div></div>` : ""}
      <div class="info-row"><div class="info-label">Satış tarixi</div><div class="info-value">${fmtDT(sale.date)}</div></div>
      <div class="info-row"><div class="info-label">İlk ödəniş günü</div><div class="info-value">${escapeHtml(dueStart)}</div></div>
      <div class="info-row"><div class="info-label">Müddət</div><div class="info-value">${credit.term} ay</div></div>
      <div class="info-row"><div class="info-label">Rəsmiləşdirən əməkdaş</div><div class="info-value">${escapeHtml(empName || "-")}</div></div>
      <div class="info-row"><div class="info-label">Məbləğ / Ödənilən / Qalıq</div><div class="info-value"><strong>${money(total)} / ${money(paid)} / ${money(rem)} AZN</strong></div></div>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Gecikən aylıqlar</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Qaimə</th><th>Ödəniş günü</th><th>Aylıq</th><th>Qalıq</th><th>Status</th><th>Gecikmə (gün)</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="7">Gecikən aylıq yoxdur.</td></tr>`}</tbody>
      </table>
    </div>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Ödəniş cədvəli</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Ödəniş günü</th><th>Məbləğ</th><th>Ödənilib</th><th>Qalıq</th><th>Status</th></tr></thead>
        <tbody>
          ${credit.rows.map((r) => `<tr><td>${r.idx}</td><td>${fmtDT(r.due)}</td><td>${money(r.amount)} AZN</td><td>${money(r.paid)} AZN</td><td>${money(r.remaining)} AZN</td><td><span class="pill ${r.status}">${escapeHtml(debtLabel(r.status))}</span></td></tr>`).join("") || `<tr><td colspan="6">Cədvəl yoxdur</td></tr>`}
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
    <form id="ovNoteForm" onsubmit="saveOverdueNote(event, '${escapeAttr(cid)}', '${escapeAttr(sale.uid)}')">
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Qeyd</div>
          <div class="grid-2">
            <div class="f-group f-group--note"><label>Mətn *</label><input id="ov_note" name="ov_note" placeholder="Qeyd yazın…" required></div>
          </div>
        </div>
      </div>
    </form>

    <h3 style="margin:16px 0 10px;font-size:1.05rem;">Qeydlər</h3>
    ${notesHtml || `<p class="muted">Qeyd yoxdur.</p>`}

    <div class="modal-footer">
      <button class="btn-main" type="button" onclick="openOverduePayment('${escapeAttr(sale.uid)}')">Ödəniş et</button>
      <button class="btn-main" type="submit" form="ovNoteForm">Yadda saxla</button>
      <button class="btn-cancel" type="button" onclick="closeMdl()">Bağla</button>
    </div>
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
      <div class="form-stack">
        <div class="form-card">
          <div class="form-card-title">Şifrə</div>
          <div class="grid-2">
            <div class="f-group"><label>Köhnə şifrə *</label><input id="pw_old" placeholder="••••••••" type="password" required autocomplete="current-password"></div>
            <div class="f-group"><label>Yeni şifrə *</label><input id="pw_new" placeholder="••••••••" type="password" required autocomplete="new-password"></div>
          </div>
        </div>
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
  renderSidebarUser();
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
          <a class="icon-btn info" href="${erpOpHref("cust", "custInfo", idx)}" onclick="openCustInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
          ${canE ? `<a class="icon-btn edit" href="${erpOpHref("cust", "custEdit", idx)}" onclick="openCust(${idx});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
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
        <a class="icon-btn info" href="${erpOpHref("supp", "suppInfo", idx)}" onclick="openSuppInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
        ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("supp", "suppEdit", idx)}" onclick="openSupp(${idx});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
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
        ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("prod", "prodEdit", idx)}" onclick="openProd(${idx});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
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
        <a class="icon-btn info" href="${erpOpHref("purch", "purchInfoInv", g.invNo)}" onclick="openPurchInfoByInv('${escapeAttr(g.invNo)}');return false;" title="Məlumat"><i class="fas fa-circle-info"></i></a>
        ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("purch", "purchInvEdit", g.invNo)}" onclick="openPurchInvoiceEdit('${escapeAttr(g.invNo)}');return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
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
  const stockSorted = stockFiltered.slice().sort((a, b) => String(b.p.date || "").localeCompare(String(a.p.date || "")));
  const stockPageSize = getPageSize("stockPageSize", 50);
  const stockListPaged = paginate(stockSorted, "stock", stockPageSize, "stockPageInfo");
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

  byId("tblStock").innerHTML = stockListPaged
    .map(({ p }, i) => {
      const remQty = purchRemainingQty(p);
      const isReturned = !!p.returnedAt;
      const isSold = !isReturned && remQty <= 0;
      const statusText = isReturned ? "QAYTARILIB" : isSold ? "SATILIB" : "ANBARDA";
      const badgeClass = isReturned ? "badge-returned" : isSold ? "badge-sold" : "badge-stock";
      const qtyAll = Math.max(1, Math.floor(n(p.qty || 1)));
      const unit = purchIsBulk(p) ? (p.unitPrice != null && p.unitPrice !== "" ? n(p.unitPrice) : (n(p.amount) / qtyAll)) : n(p.amount);
      const priceHtml = purchIsBulk(p)
        ? `${money(unit)} AZN <small class="muted">(cəmi ${money(p.amount)} AZN)</small>`
        : `${money(p.amount)} AZN`;
      return `
      <tr>
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
        <td>${escapeHtml({ nagd: "Nağd", post: "Post", post_taksit: "Post Taksit", topdan: "Topdan", korporativ: "Korporativ", kredit: "Kredit", kocurme: "Köçürmə" }[String(s.saleType || "").toLowerCase()] || String(s.saleType || "").toUpperCase())}${s.taksitTerm ? ` (${s.taksitTerm}ay)` : ""}</td>
        <td>${escapeHtml(operationActorName(s, s.employeeName || ""))}</td>
        <td>${money(s.amount)} AZN</td>
        <td>${money(s.paidTotal)} AZN</td>
        <td>${money(rem)} AZN</td>
        <td class="tbl-actions">
          <a class="icon-btn info" href="${erpOpHref("sales", "saleInfo", idx)}" onclick="openSaleInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
          ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("sales", "saleEdit", idx)}" onclick="openSale(${idx});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
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
        ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("staff", "staffEdit", idx)}" onclick="openStaff(${idx});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
        ${userCanDelete("staff") ? `<button class="icon-btn delete" onclick="delItem('staff', ${idx})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  // debts (debitor) grouped by customer + date filter + sale type filter + pagination
  const debtsStatus = byId("debtsStatus")?.value || "";
  const debtsSaleTypeFilter = window.__debtsSaleType || "";
  const debtsAllRaw = db.sales
    .filter((s) => !s.returnedAt)
    .filter((s) => String(s.saleType || "").toLowerCase() !== "kredit")
    .filter((s) => !debtsSaleTypeFilter || String(s.saleType || "").toLowerCase() === debtsSaleTypeFilter)
    .filter((s) => debtsStatus ? inDateRange(s.date, "debtsFrom", "debtsTo") : false)
    .map((s, saleIdx) => {
      const total = n(s.amount);
      const rem = saleRemaining(s);
      const st = debtStatus(total, rem);
      return { s, saleIdx, total, rem, st };
    });

  const debtsAll = debtsAllRaw.filter((x) => {
    if (!debtsStatus) return false;
    if (debtsStatus === "all") return true;
    if (debtsStatus === "open") return x.st === "partial" || x.st === "unpaid";
    return x.st === debtsStatus;
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
    const oldestDate = items.reduce((oldest, t) => (!oldest || t.s.date < oldest ? t.s.date : oldest), "");
    const days = oldestDate ? Math.floor((Date.now() - (parseDateOnly(oldestDate) || Date.now())) / 86400000) : 0;
    return { customerId, customerName: items[0]?.s.customerName || customerId, total, paid, rem, st, items, oldestDate, days };
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
      const stf = escapeAttr(debtsSaleTypeFilter);
      return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(g.customerName)}</td>
        <td>${money(g.total)} AZN</td>
        <td>${money(g.paid)} AZN</td>
        <td>${money(g.rem)} AZN</td>
        <td>${g.oldestDate ? fmtDT(g.oldestDate) : "-"}</td>
        <td>${g.days > 0 ? `<span class="pill ${g.days > 60 ? "unpaid" : g.days > 30 ? "partial" : "warn"}">${g.days} gün</span>` : "-"}</td>
        <td><span class="pill ${g.st}">${debtLabel(g.st)}</span></td>
        <td class="tbl-actions">
          <a class="icon-btn info" href="${erpOpHref("debts", "debtorInfo", g.customerId)}" onclick="openDebtorInfo('${escapeAttr(g.customerId)}','${stf}');return false;" title="Info"><i class="fas fa-circle-info"></i></a>
          <button class="btn-mini-pay" type="button" onclick="openDebtorPayment('${escapeAttr(g.customerId)}','${stf}')" ${payDisabled}>Ödəniş et</button>
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
          <td colspan="4"></td>
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
          const chipClass = lateDaysChipClass(x.daysLate);
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
            <td>${fmtDT(x.dueDate) || "-"}</td>
            <td class="overdue-days-cell"><span class="late-chip ${chipClass}">${x.daysLate}</span></td>
            <td>${escapeHtml(x.zam || "-")}</td>
            <td class="tbl-actions overdue-actions-cell">
              <a class="icon-btn info overdue-info-btn" href="${erpOpHref("debts", "overdueInfo", x.saleUid)}" onclick="openOverdueInfo('${escapeAttr(x.saleUid)}');return false;" title="Info"><i class="fas fa-circle-info"></i></a>
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
    const oldestDate = actives.reduce((oldest, x) => (!oldest || x.date < oldest ? x.date : oldest), "");
    const days = oldestDate ? Math.floor((Date.now() - (parseDateOnly(oldestDate) || Date.now())) / 86400000) : 0;
    return { supp, purchases, total, paid, rem, st, oldestDate, days };
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
    .map((g, i) => {
      const gIdx = credGroups.indexOf(g);
      return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(g.supp)}</td>
      <td>${money(g.total)} AZN</td>
      <td>${money(g.paid)} AZN</td>
      <td>${money(g.rem)} AZN</td>
      <td>${g.oldestDate ? fmtDT(g.oldestDate) : "-"}</td>
      <td>${g.days > 0 ? `<span class="pill ${g.days > 60 ? "unpaid" : g.days > 30 ? "partial" : "warn"}">${g.days} gün</span>` : "-"}</td>
      <td><span class="pill ${g.st}">${debtLabel(g.st)}</span></td>
      <td class="tbl-actions">
        <a class="icon-btn info" href="${erpOpHref("creditor", "creditorInfo", gIdx)}" onclick="openCreditorInfo(${gIdx});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
      </td>
    </tr>`;
    })
    .join("")
    + (filteredGroupsAll.length
      ? `<tr class="total-row">
          <td colspan="2"><strong>Cəmi</strong></td>
          <td><strong>${money(credTotal)} AZN</strong></td>
          <td><strong>${money(credPaid)} AZN</strong></td>
          <td><strong>${money(credRem)} AZN</strong></td>
          <td colspan="4"></td>
        </tr>`
      : "");
  filterCreditor();

  // cash list + filters + pagination
  // Tarix filteri boşdursa bu günün tarixini avtomatik qur
  setCashDateToToday();
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
        <a class="icon-btn info" href="${erpOpHref("cash", "cashInfo", c.uid)}" onclick="openCashInfo(${c.uid});return false;" title="Info"><i class="fas fa-circle-info"></i></a>
        ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("cash", "cashEdit", c.uid)}" onclick="openEditCashOp(${c.uid});return false;" title="Redaktə"><i class="fas fa-pen"></i></a>` : ""}
        ${userCanDelete("cash") ? `<button class="icon-btn delete" onclick="delCashOp(${c.uid})" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
      </td>
    </tr>`;
    })
    .join("")
    + (cashRowsAll.length ? (() => {
        const totIn  = cashRowsAll.filter(c=>c.type==="in").reduce((a,b)=>a+n(b.amount),0);
        const totOut = cashRowsAll.filter(c=>c.type==="out").reduce((a,b)=>a+n(b.amount),0);
        const net    = totIn - totOut;
        return `<tr class="total-row">
          <td colspan="4"><strong>Cəmi (${cashRowsAll.length} əməliyyat)</strong></td>
          <td><span style="font-size:1rem;font-weight:700;color:${net<0?"#FF3B30":"inherit"}">${money(net)} AZN</span></td>
          <td colspan="5"></td>
        </tr>`;
      })() : "");

  const incomeF  = cashRowsAll.filter((c) => c.type === "in").reduce((a, b) => a + n(b.amount), 0);
  const expenseF = cashRowsAll.filter((c) => c.type === "out").reduce((a, b) => a + n(b.amount), 0);
  // Balans — bütün vaxt üzrə ümumi balans (filtrə baxmayaraq)
  const allCashForBalance = db.cash.filter((c) => cashAccId ? Number(c.accountId||1) === Number(cashAccId) : true);
  const totalInAll  = allCashForBalance.filter((c) => c.type === "in").reduce((a, b) => a + n(b.amount), 0);
  const totalOutAll = allCashForBalance.filter((c) => c.type === "out").reduce((a, b) => a + n(b.amount), 0);
  byId("cashIn").innerText = money(incomeF);
  byId("cashOut").innerText = money(expenseF);
  byId("cashBal").innerText = money(totalInAll - totalOutAll);
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
          ${userCanEdit() ? `<a class="icon-btn edit" href="${erpOpHref("cash", "accountEdit", i)}" onclick="openAccount(${i});return false;" title="Edit"><i class="fas fa-pen"></i></a>` : ""}
          ${userCanDelete("accounts") ? `<button class="icon-btn delete" onclick="delAccount(${i})" title="Sil" ${delDisabled}><i class="fas fa-trash"></i></button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  // companies (developer only)
  const compBody = byId("tblCompanies");
  if (compBody) {
    if (!isDeveloper()) {
      compBody.innerHTML = "";
    } else {
      const curCid = meta?.session?.companyId;
      compBody.innerHTML = meta.companies
        .map((c, i) => {
          const active = c.id === curCid;
          const sub = c.subscription || {};
          const now = new Date();
          const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
          let subBadge = "";
          if (sub.active) {
            const paid = (sub.paidUntil || "") >= curMonth;
            subBadge = paid
              ? `<span class="pill paid">✅ ${money(sub.monthlyAmount)} AZN</span>`
              : `<span class="pill overdue">⚠️ Ödənilməyib</span>`;
          } else {
            subBadge = `<span class="pill" style="background:#f1f5f9;color:#64748b">Pulsuz</span>`;
          }
          const paidBtn = (sub.active && !((sub.paidUntil||"") >= curMonth))
            ? `<button class="icon-btn" type="button" onclick="markCompanyPaid(${i})" title="Ödəniş qeyd et" style="color:#16a34a"><i class="fas fa-credit-card"></i></button>`
            : `<span class="icon-btn-placeholder"></span>`;
          const disabledStyle = c.disabled ? 'opacity:.55' : '';
          const activeBadge = c.disabled
            ? '<span class="pill overdue">DEAKTİV</span>'
            : active ? '<span class="pill paid">AKTİV</span>' : "—";
          const restoreBtn = (c.disabled && isDeveloper())
            ? `<button class="icon-btn" type="button" onclick="restoreCompany(${i})" title="Bərpa et" style="color:#16a34a"><i class="fas fa-rotate-left"></i></button>`
            : `<span class="icon-btn-placeholder"></span>`;
          return `<tr style="${disabledStyle}">
            <td>${i + 1}</td>
            <td><b>${escapeHtml(c.name)}</b></td>
            <td><code style="font-size:.78rem">${escapeHtml(c.id)}</code></td>
            <td>${activeBadge}</td>
            <td>${subBadge}</td>
            <td class="tbl-actions">
              <button class="btn-mini-pay" type="button" onclick="useCompany('${escapeAttr(c.id)}')" ${(active || c.disabled) ? "disabled" : ""}>Seç</button>
              <button class="icon-btn" type="button" onclick="openCompanyInfo(${i})" title="Məlumat"><i class="fas fa-circle-info"></i></button>
              ${isDeveloper() ? `<a class="icon-btn edit" href="${erpOpHref("companies","companyEdit",i)}" onclick="openCompany(${i});return false;" title="Redaktə"><i class="fas fa-pen"></i></a><button class="icon-btn delete" onclick="delCompany(${i})" title="${c.disabled ? 'Tam sil' : 'Deaktiv et'}"><i class="fas fa-${c.disabled ? 'trash' : 'ban'}"></i></button>` : ""}
              ${restoreBtn}
              ${paidBtn}
            </td>
          </tr>`;
        })
        .join("");
    }
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
            ${(isDeveloper() || isAdmin()) ? `<a class="icon-btn edit" href="${erpOpHref("users", "userEdit", u.uid)}" onclick="openUser('${uidAttr}');return false;" title="Edit"><i class="fas fa-pen"></i></a><button class="icon-btn delete" onclick="delUser('${uidAttr}')" title="Sil"><i class="fas fa-trash"></i></button>` : ""}
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
    const auditActionClass = { create: "paid", update: "partial", delete: "unpaid", restore: "warn", reset: "unpaid", export: "partial", import: "partial" };
    const auditActionLabel = { create: "Yaratdı", update: "Yenilədi", delete: "Sildi", restore: "Bərpa", reset: "Sıfırladı", export: "Export", import: "Import", recalc: "Yenidən hesab" };
    const auditTargetLabel = { sales: "Satış", purch: "Alış", cash: "Kassa", cust: "Müştəri", supp: "Təchizatçı", prod: "Məhsul", staff: "Əməkdaş", accounts: "Hesab", users: "İstifadəçi", company: "Şirkət", settings: "Ayarlar", trash: "Səbət" };
    auditBody.innerHTML = list
      .map((a, i) => {
        const d = a.details && typeof a.details === "object" ? a.details : {};
        const pillClass = auditActionClass[a.action] || "partial";
        const actLabel = auditActionLabel[a.action] || a.action || "-";
        const tgtLabel = auditTargetLabel[a.target] || a.target || "-";
        const invNo = d.invNo || d.inv || "";
        const amount = d.amount != null ? `${money(d.amount)} AZN` : "";
        const custName = d.customerName || d.fullName || d.name || "";
        const note = [invNo, custName, amount, d.kind ? `(${d.kind})` : ""].filter(Boolean).join(" · ");
        return `
        <tr>
          <td>${i + 1}</td>
          <td style="white-space:nowrap">${fmtDT(a.ts)}</td>
          <td>${escapeHtml(a.user || "-")}</td>
          <td><span class="pill ${pillClass}" style="font-size:.75rem">${escapeHtml(actLabel)}</span></td>
          <td>${escapeHtml(tgtLabel)}</td>
          <td style="font-size:.82rem;color:var(--text-muted)">${escapeHtml(note) || "-"}</td>
          <td><button class="btn-mini-pay" type="button" onclick="openAuditDetails(${a.uid})">Bax</button></td>
        </tr>`;
      })
      .join("");
  }

  // trash
  const trashBody = byId("tblTrash");
  if (trashBody) {
    const trashTypeLabelMap = { cust: "Müştəri", supp: "Təchizatçı", prod: "Məhsul", purch: "Alış", sales: "Satış", cash: "Kassa", staff: "Əməkdaş" };
    const list = (db.trash || []).slice().sort((a, b) => (a.deletedAt > b.deletedAt ? -1 : 1));
    trashBody.innerHTML = list
      .map((t, i) => {
        const typeLabel = trashTypeLabelMap[t.type] || t.type || "-";
        let name = "-", invNo = "", amount = "";
        if (t.type === "cust") { name = `${t.item?.sur || ""} ${t.item?.name || ""} ${t.item?.father || ""}`.trim(); }
        else if (t.type === "supp") { name = t.item?.co || "-"; }
        else if (t.type === "prod") { name = t.item?.name || "-"; }
        else if (t.type === "purch") { invNo = t.item?.invNo || invFallback("purch", t.item?.uid); name = t.item?.name || "-"; amount = t.item?.amount ? `${money(t.item.amount)} AZN` : ""; }
        else if (t.type === "sales") { invNo = t.item?.invNo || invFallback("sales", t.item?.uid); name = t.item?.customerName || "-"; amount = t.item?.amount ? `${money(t.item.amount)} AZN` : ""; }
        else if (t.type === "staff") { name = t.item?.name || "-"; }
        else if (t.type === "cash") { name = t.item?.source || `Kassa #${t.item?.uid || ""}`; amount = t.item?.amount ? `${money(t.item.amount)} AZN` : ""; }
        return `
        <tr>
          <td>${i + 1}</td>
          <td style="white-space:nowrap">${fmtDT(t.item?.date || t.deletedAt)}</td>
          <td><span class="pill partial" style="font-size:.75rem">${escapeHtml(typeLabel)}</span></td>
          <td>${invNo ? `<strong>${escapeHtml(invNo)}</strong> · ` : ""}${escapeHtml(name)}</td>
          <td style="white-space:nowrap">${escapeHtml(amount) || "-"}</td>
          <td>${escapeHtml(t.deletedBy || "-")}</td>
          <td style="white-space:nowrap">${fmtDT(t.deletedAt)}</td>
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
  renderReports();

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
              <td class="tbl-actions"><a class="icon-btn info" href="${erpOpHref("sales", "saleInfo", idx)}" onclick="openSaleInfo(${idx});return false;" title="Info"><i class="fas fa-circle-info"></i></a></td>
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
            <td class="tbl-actions"><button class="btn-mini" type="button" onclick="openStaffReportSales('${escapeAttr(String(st.uid))}')" title="${escapeAttr(t("btn_sales_list"))}"><i class="fas fa-list"></i> ${escapeHtml(t("btn_view"))}</button></td>
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
  byId("st-stock").innerText = String(Math.floor(stockCount));
  byId("st-debts").innerText = money(debtorSum);
  byId("st-creditor").innerText = money(creditorSum);
  byId("st-cash").innerText = money(totalAccountsBalance());

  // New KPI cards
  const todayStr = new Date().toISOString().slice(0, 10);
  const thisMonthStr = todayStr.slice(0, 7);
  const monthSales = (db.sales||[]).filter((s) => !s.returnedAt && String(s.date||"").slice(0,7) === thisMonthStr).reduce((a,s) => a + n(s.amount), 0);
  const monthPurch = (db.purch||[]).filter((p) => !p.returnedAt && String(p.date||"").slice(0,7) === thisMonthStr).reduce((a,p) => a + n(p.amount), 0);
  const monthExp  = (db.cash||[]).filter((c) => c.type === "out" && c.link?.kind === "expense" && String(c.date||"").slice(0,7) === thisMonthStr).reduce((a,c) => a + n(c.amount), 0);
  const todaySales = (db.sales||[]).filter((s) => !s.returnedAt && String(s.date||"").slice(0,10) === todayStr).reduce((a,s) => a + n(s.amount), 0);

  const today2 = new Date();
  const todayISO2 = todayStr;
  const dayMs2 = 86400000;
  const toDayStart2 = (iso) => { const [y,m,d] = String(iso||"").slice(0,10).split("-").map(Number); if(!y||!m||!d) return null; return new Date(y,m-1,d).getTime(); };
  let overdueCount = 0, overdueAmt = 0;
  for (const s of db.sales||[]) {
    if (s.returnedAt || String(s.saleType||"").toLowerCase() !== "kredit") continue;
    const schedule = buildCreditSchedule(s);
    for (const r of schedule.rows) {
      if (r.remaining > 0.001) {
        const due = toDayStart2(r.due);
        if (due && today2.getTime() - due > 0) { overdueCount++; overdueAmt += r.remaining; break; }
      }
    }
  }

  const setEl = (id, val) => { const el = byId(id); if (el) el.innerText = val; };
  setEl("st-month-sales", money(monthSales));
  setEl("st-month-purch", money(monthPurch));
  setEl("st-month-exp",   money(monthExp));
  setEl("st-overdue-cnt", String(overdueCount));
  setEl("st-today-sales", money(todaySales));
  setEl("dashStatOverdueAmt", money(overdueAmt));

  // Recent sales table
  const recentSalesEl = byId("dashRecentSales");
  if (recentSalesEl) {
    const recS = (db.sales||[]).filter((s) => !s.returnedAt).slice().sort((a,b) => (a.date>b.date?-1:1)).slice(0,5);
    recentSalesEl.innerHTML = recS.map((s) => `<tr><td style="white-space:nowrap">${fmtDT(s.date)}</td><td>${escapeHtml(s.invNo||invFallback("sales",s.uid))}</td><td>${escapeHtml(s.customerName||"-")}</td><td>${money(s.amount)} AZN</td></tr>`).join("") || `<tr><td colspan="4">Məlumat yoxdur</td></tr>`;
  }
  // Recent purch table
  const recentPurchEl = byId("dashRecentPurch");
  if (recentPurchEl) {
    const recP = (db.purch||[]).filter((p) => !p.returnedAt).slice().sort((a,b) => (a.date>b.date?-1:1)).slice(0,5);
    recentPurchEl.innerHTML = recP.map((p) => `<tr><td style="white-space:nowrap">${fmtDT(p.date)}</td><td>${escapeHtml(p.invNo||invFallback("purch",p.uid))}</td><td>${escapeHtml(p.name||"-")}</td><td>${money(p.amount)} AZN</td></tr>`).join("") || `<tr><td colspan="4">Məlumat yoxdur</td></tr>`;
  }

  // Dashboard charts: son 6 ay satış
  const now = new Date();
  const last6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    last6.push({ key: `${y}-${m}` });
  }
  const salesByMonth = last6.map(({ key }) => {
    const sum = (db.sales || [])
      .filter((s) => !s.returnedAt && inMonth(s.date, key))
      .reduce((a, s) => a + n(s.amount), 0);
    return sum;
  });
  const maxSales = Math.max(1, ...salesByMonth);
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
    const shortLabels = last6.map(({ key }) => {
      const [, mo] = key.split("-");
      return chartMonthAbbr(Number(mo) - 1);
    });
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
      <div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(t("dash_lbl_purch"))}</span><div class="dash-bar-track"><div class="dash-bar-fill purch" style="width:${(purchThisMonth/maxPVS*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(purchThisMonth)} AZN</span></div>
      <div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(t("dash_lbl_sales"))}</span><div class="dash-bar-track"><div class="dash-bar-fill sales" style="width:${(salesThisMonth/maxPVS*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(salesThisMonth)} AZN</span></div>
    </div>`;
  }

  // Son 6 ay alış (AZN)
  const purchByMonth = last6.map(({ key }) => (db.purch || []).filter((p) => inMonth(p.date, key)).reduce((a, p) => a + n(p.amount), 0));
  const purchChartEl = byId("dashChartPurch");
  if (purchChartEl) {
    const shortLabels2 = last6.map(({ key }) => {
      const [, mo] = key.split("-");
      return chartMonthAbbr(Number(mo) - 1);
    });
    purchChartEl.innerHTML = buildVBarHtml(purchByMonth, shortLabels2, "purch");
  }

  // Debitor vs Kreditor borclar
  const maxDebt = Math.max(1, debtorSum, creditorSum);
  const debtCredEl = byId("dashChartDebtVsCredit");
  if (debtCredEl) {
    debtCredEl.innerHTML = `<div class="dash-hbar-wrap">
      <div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(t("dash_lbl_debtor"))}</span><div class="dash-bar-track"><div class="dash-bar-fill debt" style="width:${(debtorSum/maxDebt*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(debtorSum)} AZN</span></div>
      <div class="dash-bar-row"><span class="dash-bar-label">${escapeHtml(t("dash_lbl_creditor"))}</span><div class="dash-bar-track"><div class="dash-bar-fill credit" style="width:${(creditorSum/maxDebt*100).toFixed(1)}%"></div></div><span class="dash-bar-val-out">${money(creditorSum)} AZN</span></div>
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

  // Mobil üçün cədvəlləri scroll wrapper-a al
  if (window.innerWidth <= 768) wrapMobileTables();
}

function wrapMobileTables() {
  document.querySelectorAll(
    ".card table, .modal-body table, .modal-body-inner table, .table-wrap table"
  ).forEach((tbl) => {
    const parent = tbl.parentElement;
    if (!parent || parent.classList.contains("tbl-scroll-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "tbl-scroll-wrap";
    parent.insertBefore(wrap, tbl);
    wrap.appendChild(tbl);
  });
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
  formatDateInput,
  closeMdl,
  popupDismiss,
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
  refreshSubcats,
  refreshCustomerInvoices,
  refreshSupplierInvoices,
  addExpenseCategory,
  addExpenseSubcategory,
  filterDebts,
  filterCreditOnly,
  filterCreditor,
  openFounderForm,
  saveFounder,
  deleteFounder,
  openFounderCashOp,
  saveFounderCashOp,
  openFounderPayHistory,
  applyJobPreset,
  toggleAllUserPerms,
  toggleAllUserSecs,
  openCreditorInfo,
  openCreditorPurchPayHistory,
  openCreditorPayment,
  saveCreditorPayment,
  openCreditorInvoicePayment,
  saveCreditorInvoicePayment,
  openSupplierPaymentHistory,
  openDebtorInfo,
  openDebtorPayment,
  debPayInvChanged,
  setRepView,
  syncRepFilters,
  renderReports,
  saveDebtorPayment,
  syncAutoUserIdentity,
  toggleUserManualMode,
  refreshFromCloud,
  delItem,
  searchSaleItem,
  handleSaleItemChange,
  toggleSaleInitialPayment,
  toggleCreditBox,
  togglePostTaksit,
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
  testTelegram,
  openTelegramSettings,
  saveTelegramSettings,
  testTelegramModal,
  renderSettingsPage,
  saveSettingsPage,
  testTelegramPage,
  sendDailyOverdueReport,
  toggleSubFields,
  markCompanyPaid,
  openCompanyInfo,
  deleteCompanyPayment,
  restoreCompany,
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

/* ── Profil foto: meta.users.profilePhotoDataUrl → Firestore (saveMeta); localStorage yalnız köhnə ehtiyat ── */
function compressProfilePhotoDataUrl(dataUrl, maxEdge = 400, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) return resolve(dataUrl);
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const tw = Math.round(w * scale);
        const th = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, tw, th);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
function getProfilePhoto(uid) {
  const u = meta.users?.find((x) => Number(x.uid) === Number(uid));
  if (u?.profilePhotoDataUrl) return u.profilePhotoDataUrl;
  try {
    return localStorage.getItem("profilePhoto_" + uid) || "";
  } catch {
    return "";
  }
}
function setProfilePhoto(uid, dataUrl) {
  const idx = meta.users.findIndex((x) => Number(x.uid) === Number(uid));
  if (idx >= 0) {
    meta.users[idx] = { ...meta.users[idx], profilePhotoDataUrl: dataUrl };
    saveMeta();
  }
  try {
    localStorage.setItem("profilePhoto_" + uid, dataUrl);
  } catch {}
}
function removeProfilePhoto(uid) {
  const idx = meta.users.findIndex((x) => Number(x.uid) === Number(uid));
  if (idx >= 0) {
    const u = { ...meta.users[idx] };
    delete u.profilePhotoDataUrl;
    meta.users[idx] = u;
    saveMeta();
  }
  try {
    localStorage.removeItem("profilePhoto_" + uid);
  } catch {}
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
  reader.onload = async (ev) => {
    const u = currentUser();
    if (!u) return;
    const raw = ev.target.result;
    const dataUrl = await compressProfilePhotoDataUrl(String(raw || ""));
    setProfilePhoto(u.uid, dataUrl);
    renderSidebarUser();
  };
  reader.readAsDataURL(file);
}

function renderSidebarUser() {
  const el = byId("sidebarUserInfo");
  if (!el) return;
  if (!meta?.session) { el.innerHTML = ""; return; }
  const u = currentUser();
  const displayName = u ? (String(u.fullName || "").trim() || String(u.username || "").trim()) : t("role_fallback");
  const role = u?.role === "developer" ? "Developer" : u?.role === "admin" ? "Admin" : u?.role === "owner" ? t("role_owner") : t("role_user");
  const initials = displayName.split(" ").map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "U";
  const email = u?.email || "";
  const photo = u ? getProfilePhoto(u.uid) : "";
  const avatarInner = photo
    ? `<img src="${escapeAttr(photo)}" class="sidebar-user-avatar-img" alt="${escapeAttr(initials)}">`
    : escapeHtml(initials);
  el.innerHTML = `
    <div class="sidebar-user-avatar" title="${escapeAttr(t("lbl_photo_upload"))}" onclick="triggerProfilePhotoUpload()">${avatarInner}<span class="sidebar-avatar-cam"><i class="fas fa-camera"></i></span></div>
    <input type="file" id="profilePhotoFileInput" accept="image/*" style="display:none" onchange="onProfilePhotoSelected(event)">
    <div class="sidebar-user-name">${escapeHtml(displayName)}</div>
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
  const compName = comp?.name || comp?.id || "";
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
  const comp = (meta?.companies || []).find((c) => c.id === (meta?.session?.companyId || ""));
  const compName = String(db.settings?.companyName || comp?.name || "").trim();
  titleEl.textContent = compName;
}

function initApp() {
  // mark all search inputs so CSS can target them specifically
  document.querySelectorAll(".search-container input, .search-plain input").forEach(el => el.setAttribute("data-search","1"));
  if (!window.__slideoverPadResizeInit) {
    window.__slideoverPadResizeInit = true;
    let slideoverPadResizeT;
    window.addEventListener("resize", () => {
      const m = document.getElementById("mdlMain");
      if (!m?.classList.contains("modal--open") || !m.classList.contains("modal--slideover")) return;
      clearTimeout(slideoverPadResizeT);
      slideoverPadResizeT = setTimeout(() => syncSlideoverContentPad(), 120);
    });
  }
  applyAccessUI();
  applySidebarState();
  initHeaderCompactSearch();
  initLang();
  applyLangToUI();
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
  const fromHash = parseAppSectionFromHash();
  const usedHash = !!(fromHash && isValidAppSection(fromHash) && userCanSection(fromHash));
  if (usedHash) {
    secToShow = fromHash;
    navToUse = findNavLinkForSection(fromHash);
  }
  if (!secToShow) {
    const lastSection = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("bakfon_lastSection")) || null;
    if (lastSection && isValidAppSection(lastSection) && userCanSection(lastSection)) {
      const navLink = findNavLinkForSection(lastSection);
      if (!navLink || navLink.style.display !== "none") {
        secToShow = lastSection;
        navToUse = navLink || null;
      }
    }
  }
  if (!secToShow) {
    const firstVisible = Array.from(document.querySelectorAll(".nav-link[data-sec]")).find(
      (el) => el.style.display !== "none"
    );
    const firstSecId = firstVisible?.getAttribute("data-sec");
    if (firstVisible && firstSecId && userCanSection(firstSecId)) {
      secToShow = firstSecId;
      navToUse = firstVisible;
    }
  }
  runMigrations();
  if (secToShow) showSec(secToShow, navToUse, { skipHash: usedHash });
  bindSidebarNavClicks();
  renderAll();
  requestAnimationFrame(() => consumeHashDeepLink());
  startDailyReportScheduler();
  checkSubscriptionStatus();
}

function hideLoading() {
  const loadingEl = byId("loadingOverlay");
  if (loadingEl) loadingEl.classList.add("hidden");
  if (_softOpTimer) {
    clearTimeout(_softOpTimer);
    _softOpTimer = null;
  }
  _softOpDepth = 0;
  byId("softLoadingCenter")?.classList.add("hidden");
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
  if (!isOnline()) {
    _pl.hide();
    showOfflineBlock(true);
    window.addEventListener("online", () => location.reload());
    return;
  }
  if (!window.__erpHashNavBound) {
    window.__erpHashNavBound = true;
    window.addEventListener("hashchange", onErpHashChange);
  }
  window.addEventListener("offline", () => showOfflineBlock(true));
  window.addEventListener("online", () => location.reload());
  window.__loginCompanyFromUrl = getLoginCompanyFromUrl();

  var loadingHidden = false;
  var timeoutId = setTimeout(function () {
    if (loadingHidden) return;
    loadingHidden = true;
    _pl.hide();
    hideLoading();
    toast("Yüklənmə vaxtı keçdi. Yeniləyin və ya interneti yoxlayın.", "err", 5000);
    console.warn("Bakfon ERP: init timeout");
  }, 12000);

  try {
    _pl.step("auth");
    initFirestore();
    if (useFirestore()) await ensureFirestoreAuth();

    _pl.step("meta");
    meta = await loadMetaAsync();
    ensureMetaDefaults();
    if (useFirestore()) saveMeta();

    _pl.step("data");
    if (meta.session) {
      db = await loadCompanyDBAsync();
    } else {
      db = defaultDB();
    }
    subscribeRealtime();
    startRealtimeAutoRefresh();

    _pl.step("ready");
    if (!loadingHidden) {
      loadingHidden = true;
      clearTimeout(timeoutId);
      hideLoading();
      setTimeout(() => { _pl.hide(); initApp(); }, 200);
    }
  } catch (e) {
    if (!loadingHidden) {
      loadingHidden = true;
      clearTimeout(timeoutId);
      _pl.hide();
      hideLoading();
      toast("Başlatma xətası: " + (e && e.message ? e.message : "Yeniləyin."), "err", 5000);
      console.error("Bakfon ERP init xətası:", e);
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
  }, 10000);
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
function closeNotifDropdown() {
  const dd = byId("notifDropdown");
  if (dd) dd.classList.remove("notif-dropdown-open");
  document.removeEventListener("click", _notifOutsideClick);
}
function _notifOutsideClick(e) {
  const dd = byId("notifDropdown");
  const btn = document.querySelector(".header-btn-icon[onclick*='openNotifications']");
  if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) closeNotifDropdown();
}
function openNotifications(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  if (!meta?.session) return showLoginOverlay(true);
  const triggerBtn = document.querySelector(".header-btn-icon[onclick*='openNotifications']");
  let dd = byId("notifDropdown");
  if (!dd) {
    dd = document.createElement("div");
    dd.id = "notifDropdown";
    dd.className = "notif-dropdown";
    document.body.appendChild(dd);
  }
  if (dd.classList.contains("notif-dropdown-open")) {
    closeNotifDropdown();
    return;
  }
  const list = getNotifications();
  const iconMap = { neg: "fa-circle-exclamation", overdue: "fa-clock", stock: "fa-box", info: "fa-circle-info" };
  const rows = list.map((x) => {
    const icon = iconMap[x.kind] || "fa-circle-info";
    const secMap = { neg: "cash", overdue: "overdue", stock: "stock" };
    const secId = secMap[x.kind];
    const actionBtn = secId
      ? `<button class="notif-action-btn" onclick="closeNotifDropdown();goSecWithLoad('${secId}',null)">Bölməyə keç →</button>`
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
  dd.innerHTML = `
    <div class="notif-dd-header">
      <span>${t("notifications")}</span>
      ${list.length ? `<span class="notif-count-badge">${list.length}</span>` : ""}
    </div>
    <div class="notif-dd-list">
      ${rows || `<div class="notif-empty"><i class="fas fa-check-circle"></i><span>${t("no_notifications")}</span></div>`}
    </div>
  `;
  if (triggerBtn) {
    const rect = triggerBtn.getBoundingClientRect();
    dd.style.right = (window.innerWidth - rect.right) + "px";
    dd.style.top = (rect.bottom + 6) + "px";
    dd.style.left = "";
  }
  dd.classList.add("notif-dropdown-open");
  setTimeout(() => document.addEventListener("click", _notifOutsideClick), 0);
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
    { id: "overdue",   label: t("page_debts_loans"), icon: "fa-clock" },
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
        action: () => { closeSpotlight(); goSecWithLoad(s.id, findNavLinkForSection(s.id)); }
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
        action: () => { closeSpotlight(); goSecWithLoad("cust", findNavLinkForSection("cust")); }
      }))
    });

    // Products
    const prods = (db.prod || []).filter((p) => `${p.name} ${p.code || ""} ${p.uid}`.toLowerCase().includes(q)).slice(0, 5);
    if (prods.length) groups.push({
      label: t("nav_prod"),
      items: prods.map((p) => ({
        icon: "fa-box-open", name: p.name, sub: `${t("code")}: ${p.code || "-"} • ${money(p.price)} AZN`, tag: t("product"),
        action: () => { closeSpotlight(); goSecWithLoad("prod", findNavLinkForSection("prod")); }
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
          action: () => {
            closeSpotlight();
            goSecWithLoad("sales", findNavLinkForSection("sales"));
            setTimeout(() => openSaleInfo && openSaleInfo(idx >= 0 ? idx : 0), 200);
          }
        };
      })
    });

    // Suppliers
    const supps = (db.supp || []).filter((s) => `${s.co} ${s.contact || ""}`.toLowerCase().includes(q)).slice(0, 4);
    if (supps.length) groups.push({
      label: t("nav_supp"),
      items: supps.map((s) => ({
        icon: "fa-truck", name: s.co, sub: s.contact || "", tag: t("supplier"),
        action: () => { closeSpotlight(); goSecWithLoad("supp", findNavLinkForSection("supp")); }
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
    nav_dash: "Nəzarət paneli", nav_cust: "Müştərilər", nav_supp: "Təchizatçılar",
    nav_prod: "Məhsullar", nav_purch: "Alışlar", nav_stock: "Anbar",
    nav_sales: "Satışlar", nav_staff: "Əməkdaşlar", nav_debts: "Borclar",
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

/** Əlavə tərcümə açarları (UI, filtrlər, cədvəl başlıqları). */
const EXTRA_LANG = {
  az: {
    lang_changed: "Dil yeniləndi",
    welcome_title: "Xoş gəldiniz, {name}!",
    page_debts_deb: "Borclar",
    page_debts_loans: "Borclar — kreditlər",
    page_debts_cred: "Borclar — kreditor",
    nav_users: "İstifadəçilər",
    nav_trash: "Səbət",
    nav_companies: "Şirkətlər",
    nav_tools: "Alətlər",
    nav_settings: "Ayarlar",
    nav_dev: "Developer",
    nav_accounts: "Hesablar",
    nav_profile: "Profil",
    opt_pick: "Seçin",
    opt_debts: "Debitor",
    opt_creditor: "Kreditor",
    opt_loans: "Kreditlər",
    debts_sub_all: "Hamısı",
    debts_sub_paid: "Tam ödənilmiş",
    debts_sub_partial: "Qismən ödənilmiş",
    debts_sub_unpaid: "Ödənilməmiş",
    filt_active: "Aktiv",
    filt_returned: "Qaytarılanlar",
    stock_in_warehouse: "Anbardadır",
    stock_sold: "Satılıb",
    stock_returned: "Qaytarılıb",
    ov_sub_all: "Ümumi kreditlər",
    ov_sub_overdue: "Vaxtı keçmiş kreditlər",
    cred_sub_open: "Ödənilməmiş / Qismən",
    cred_sub_all: "Hamısı",
    cred_sub_paid: "Tam ödənilmiş",
    cred_sub_partial: "Qismən",
    cred_sub_unpaid: "Ödənilməmiş",
    cash_opt_all: "Hamısı",
    cash_opt_in: "Mədaxil",
    cash_opt_out: "Məxaric",
    rep_view_summary: "Xülasə",
    rep_view_monthly: "Aylar üzrə",
    rep_view_sales: "Satışlar",
    rep_view_purch: "Alışlar",
    rep_view_expense: "Xərclər",
    rep_view_staff: "Əməkdaş",
    pager_prev: "Əvvəl",
    pager_next: "Növbəti",
    mon_1: "Yan", mon_2: "Fev", mon_3: "Mar", mon_4: "Apr", mon_5: "May", mon_6: "İyn",
    mon_7: "İyl", mon_8: "Avq", mon_9: "Sen", mon_10: "Okt", mon_11: "Noy", mon_12: "Dek",
    dash_lbl_purch: "Alış",
    dash_lbl_sales: "Satış",
    dash_lbl_debtor: "Debitor",
    dash_lbl_creditor: "Kreditor",
    ph_search: "Axtar...",
    ph_imei_search: "IMEI / Seriya ilə axtar...",
    ph_header_search: "Axtarış...",
    hint_ctrl_k: "Ctrl+K",
    dash_stat_cust: "Müştəri",
    dash_stat_stock: "Anbarda",
    dash_stat_debt: "Debitor borc (AZN)",
    dash_stat_cred: "Kreditor borc (AZN)",
    dash_stat_cash: "Ümumi balans (bütün hesablar)",
    dash_chart_sales6: "Son 6 ay satış (AZN)",
    dash_chart_pvs: "Alış vs Satış (bu ay)",
    dash_chart_purch6: "Son 6 ay alış (AZN)",
    dash_chart_debtcred: "Debitor vs Kreditor borclar",
    dash_mini_sales_yr: "Bu il satış cəmi (AZN)",
    dash_mini_purch_yr: "Bu il alış cəmi (AZN)",
    dash_mini_stock_n: "Anbarda məhsul sayı",
    lbl_debt_type: "Borc növü",
    lbl_subselect: "Alt seçim",
    lbl_date_range: "Tarix aralığı",
    lbl_search: "Axtarış",
    lbl_delay_range: "Gecikmə gün aralığı",
    lbl_lang: "Dil",
    role_fallback: "İstifadəçi",
    role_owner: "Sahibkar",
    role_user: "İstifadəçi",
    lbl_photo_upload: "Şəkil yüklə",
    btn_new_cust: "Yeni Müştəri",
    btn_new_supp: "Yeni Təchizatçı",
    btn_new_prod: "Yeni Məhsul",
    btn_new_purch: "Yeni Alış",
    btn_new_sale: "Yeni Satış",
    btn_new_staff: "Yeni Əməkdaş",
    btn_staff_calc: "Əməkhaqqı hesabla",
    btn_staff_pay: "Ödə",
    btn_ret_adv: "Qaytarma avansları",
    btn_cash_count: "Kassa sayımı",
    btn_day_close: "Gün sonu",
    btn_cash_diff: "Artıq/Əskik",
    btn_accounts: "Hesablar",
    btn_new_cash_op: "Yeni əməliyyat",
    btn_new_company: "Yeni şirkət",
    btn_reset_company: "Şirkəti sıfırla",
    btn_new_user: "Yeni istifadəçi",
    btn_audit_clear: "Təmizlə",
    btn_trash_empty: "Hamısını sil",
    btn_export: "Export",
    btn_import: "Import",
    btn_csv: "CSV",
    btn_recalc: "Yenidən hesabla",
    btn_skins: "Skinlər",
    btn_qr: "QR",
    btn_settings: "Ayarlar",
    btn_test_seed: "Test baza yüklə",
    btn_cust_import: "Müştəri bazası (Excel/CSV) import",
    cash_stat_in: "Mədaxil",
    cash_stat_out: "Məxaric",
    cash_stat_bal: "Balans",
    cash_stat_adv: "Qaytarma avansı",
    rep_stat_sales: "Satış",
    rep_stat_sales_paid: "Satış (ödənilən)",
    rep_stat_purch: "Alış",
    rep_stat_exp: "Xərc",
    rep_stat_payroll: "Əməkhaqqı (ay üzrə)",
    rep_stat_pl: "Mənfəət/Zərər",
    rep_stat_pl_cash: "Nağdlaşan mənfəət",
    rep_hdr_monthly: "Ay üzrə detallı",
    rep_hdr_staff: "Əməkdaş hesabatı / Əməkhaqqı",
    rep_col_pct: "Faiz",
    tools_note_lbl: "Qeyd",
    tools_note_val: "Export/Import yalnız cari şirkət datasına aiddir.",
    tools_import_title: "Baza import",
    tools_import_hint: "Excel-də müştəri bazası (Ad, Soyad, FİN, Mobil və s.) hazırlayıb import etdikdə həmin müştərilər Müştərilər siyahısına düşər. Siyahıda cədvəl sütunları, ətraflı məlumat isə hər müştərinin Info pəncərəsində görünər.",
    users_intro_html: "Rolları (user / admin / developer) və icazələri bu siyahıda istifadəçi üzərində <strong>Redaktə</strong> ilə dəyişə bilərsiniz.",
    th_num: "#", th_id: "ID", th_actions: "Əməliyyat", th_name_full: "Ad Soyad Ata", th_mobile: "Mobil", th_fin: "FİN", th_serial: "Seriya №", th_guarantor: "Zamin",
    th_company: "Şirkət", th_contact: "Məsul", th_voen: "VÖEN", th_name: "Ad", th_cat: "Kateqoriya", th_subcat: "Alt kateqoriya",
    th_inv: "Qaimə", th_date: "Tarix", th_purch_date: "Alış tarixi", th_supplier: "Təchizatçı", th_staff: "Əməkdaş", th_amount: "Məbləğ", th_paid: "Ödənilən", th_balance: "Qalıq", th_status: "Status", th_type: "Tip",
    th_product: "Məhsul", th_qty: "Say", th_kind: "Növ", th_price: "Qiymət", th_imei1: "IMEI 1", th_imei2: "IMEI 2", th_remain: "Qalıq say",
    th_customer: "Müştəri", th_inv_no: "Qaimə №", th_pay_amt: "Ödəniş məbləği", th_account: "Hesab", th_pay_type: "Ödəniş növü",
    th_user: "İstifadəçi", th_target: "Hədəf", th_detail: "Detallı", th_deleted_by: "Silən", th_role: "Rol", th_active: "Aktiv", th_username: "İstifadəçi adı",
    th_code: "Kod", th_active_co: "Aktiv", th_info: "Info", th_staff_name: "Ad Soyad", th_position: "Vəzifə", th_phone: "Telefon", th_salary: "Standart maaş", th_pct: "Faiz %",
    th_cust_debt: "Cəmi borc", th_cust_name_long: "Müştəri (Ad Soyad Ata)", th_sched: "Cədvəl üzrə", th_paid_full: "Ödənilmiş", th_due: "Ödənilməli", th_pay_date: "Ödəmə tarixi", th_delay_days: "Gecikmə günü",
    th_sale_count: "Satış sayı", th_sale_sum: "Satış cəmi", th_comm: "Komissiya", th_base_sal: "Baza maaş", th_total: "Yekun",
    btn_view: "Bax",
    btn_sales_list: "Satış siyahısı",
  },
  ru: {
    lang_changed: "Язык изменён",
    welcome_title: "Добро пожаловать, {name}!",
    page_debts_deb: "Задолженности — дебитор",
    page_debts_loans: "Задолженности — кредиты",
    page_debts_cred: "Задолженности — кредитор",
    nav_users: "Пользователи",
    nav_trash: "Корзина",
    nav_companies: "Компании",
    nav_tools: "Инструменты",
    nav_settings: "Настройки",
    nav_dev: "Разработчик",
    nav_accounts: "Счета",
    nav_profile: "Профиль",
    opt_pick: "Выберите",
    opt_debts: "Дебитор",
    opt_creditor: "Кредитор",
    opt_loans: "Кредиты",
    debts_sub_all: "Все",
    debts_sub_paid: "Полностью оплачено",
    debts_sub_partial: "Частично оплачено",
    debts_sub_unpaid: "Не оплачено",
    filt_active: "Активные",
    filt_returned: "Возвраты",
    stock_in_warehouse: "На складе",
    stock_sold: "Продано",
    stock_returned: "Возвращено",
    ov_sub_all: "Все кредиты",
    ov_sub_overdue: "Просроченные кредиты",
    cred_sub_open: "Не оплачено / Частично",
    cred_sub_all: "Все",
    cred_sub_paid: "Полностью оплачено",
    cred_sub_partial: "Частично",
    cred_sub_unpaid: "Не оплачено",
    cash_opt_all: "Все",
    cash_opt_in: "Приход",
    cash_opt_out: "Расход",
    rep_view_summary: "Сводка",
    rep_view_monthly: "По месяцам",
    rep_view_sales: "Продажи",
    rep_view_purch: "Закупки",
    rep_view_expense: "Расходы",
    rep_view_staff: "Сотрудники",
    pager_prev: "Назад",
    pager_next: "Далее",
    mon_1: "Янв", mon_2: "Фев", mon_3: "Мар", mon_4: "Апр", mon_5: "Май", mon_6: "Июн",
    mon_7: "Июл", mon_8: "Авг", mon_9: "Сен", mon_10: "Окт", mon_11: "Ноя", mon_12: "Дек",
    dash_lbl_purch: "Закупка",
    dash_lbl_sales: "Продажа",
    dash_lbl_debtor: "Дебитор",
    dash_lbl_creditor: "Кредитор",
    ph_search: "Поиск...",
    ph_imei_search: "Поиск по IMEI / серии...",
    ph_header_search: "Поиск...",
    hint_ctrl_k: "Ctrl+K",
    dash_stat_cust: "Клиенты",
    dash_stat_stock: "На складе",
    dash_stat_debt: "Дебиторская задолженность (AZN)",
    dash_stat_cred: "Кредиторская задолженность (AZN)",
    dash_stat_cash: "Общий баланс (все счета)",
    dash_chart_sales6: "Продажи за 6 мес. (AZN)",
    dash_chart_pvs: "Закупки vs Продажи (этот месяц)",
    dash_chart_purch6: "Закупки за 6 мес. (AZN)",
    dash_chart_debtcred: "Дебитор vs Кредитор",
    dash_mini_sales_yr: "Продажи за год (AZN)",
    dash_mini_purch_yr: "Закупки за год (AZN)",
    dash_mini_stock_n: "Кол-во товаров на складе",
    lbl_debt_type: "Тип задолженности",
    lbl_subselect: "Подвыбор",
    lbl_date_range: "Период",
    lbl_search: "Поиск",
    lbl_delay_range: "Дни просрочки",
    lbl_lang: "Язык",
    role_fallback: "Пользователь",
    role_owner: "Владелец",
    role_user: "Пользователь",
    lbl_photo_upload: "Загрузить фото",
    btn_new_cust: "Новый клиент",
    btn_new_supp: "Новый поставщик",
    btn_new_prod: "Новый товар",
    btn_new_purch: "Новая закупка",
    btn_new_sale: "Новая продажа",
    btn_new_staff: "Новый сотрудник",
    btn_staff_calc: "Расчёт зарплаты",
    btn_staff_pay: "Оплатить",
    btn_ret_adv: "Авансы возвратов",
    btn_cash_count: "Инвентаризация кассы",
    btn_day_close: "Закрытие дня",
    btn_cash_diff: "Излишек/недостача",
    btn_accounts: "Счета",
    btn_new_cash_op: "Новая операция",
    btn_new_company: "Новая компания",
    btn_reset_company: "Сбросить компанию",
    btn_new_user: "Новый пользователь",
    btn_audit_clear: "Очистить",
    btn_trash_empty: "Удалить всё",
    btn_export: "Экспорт",
    btn_import: "Импорт",
    btn_csv: "CSV",
    btn_recalc: "Пересчитать",
    btn_skins: "Скины",
    btn_qr: "QR",
    btn_settings: "Настройки",
    btn_test_seed: "Загрузить тестовую базу",
    btn_cust_import: "Импорт клиентов (Excel/CSV)",
    cash_stat_in: "Приход (нал.)",
    cash_stat_out: "Расход (нал.)",
    cash_stat_bal: "Баланс",
    cash_stat_adv: "Аванс возврата",
    rep_stat_sales: "Продажи",
    rep_stat_sales_paid: "Продажи (оплачено)",
    rep_stat_purch: "Закупки",
    rep_stat_exp: "Расход",
    rep_stat_payroll: "Зарплата (за месяц)",
    rep_stat_pl: "Прибыль/убыток",
    rep_stat_pl_cash: "Денежная прибыль",
    rep_hdr_monthly: "Детально по месяцам",
    rep_hdr_staff: "Отчёт по сотрудникам / Зарплата",
    rep_col_pct: "Процент",
    tools_note_lbl: "Примечание",
    tools_note_val: "Экспорт/импорт относится только к данным текущей компании.",
    tools_import_title: "Импорт базы",
    tools_import_hint: "Подготовьте в Excel базу клиентов (имя, ФИН, телефон и т.д.) — после импорта они появятся в разделе Клиенты.",
    users_intro_html: "Роли (user / admin / developer) и права можно менять в списке через <strong>Редактирование</strong> пользователя.",
    th_num: "#", th_id: "ID", th_actions: "Действия", th_name_full: "ФИО", th_mobile: "Моб.", th_fin: "ФИН", th_serial: "Серия №", th_guarantor: "Поручитель",
    th_company: "Компания", th_contact: "Ответств.", th_voen: "ИНН", th_name: "Название", th_cat: "Категория", th_subcat: "Подкатегория",
    th_inv: "Накладная", th_date: "Дата", th_purch_date: "Дата закупки", th_supplier: "Поставщик", th_staff: "Сотрудник", th_amount: "Сумма", th_paid: "Оплачено", th_balance: "Остаток", th_status: "Статус", th_type: "Тип",
    th_product: "Товар", th_qty: "Кол-во", th_kind: "Вид", th_price: "Цена", th_imei1: "IMEI 1", th_imei2: "IMEI 2", th_remain: "Остаток",
    th_customer: "Клиент", th_inv_no: "№ накладной", th_pay_amt: "Сумма платежа", th_account: "Счёт", th_pay_type: "Тип оплаты",
    th_user: "Пользователь", th_target: "Цель", th_detail: "Детали", th_deleted_by: "Удалил", th_role: "Роль", th_active: "Активен", th_username: "Логин",
    th_code: "Код", th_active_co: "Активна", th_info: "Инфо", th_staff_name: "ФИО", th_position: "Должность", th_phone: "Телефон", th_salary: "Оклад", th_pct: "Процент %",
    th_cust_debt: "Всего долг", th_cust_name_long: "Клиент (ФИО)", th_sched: "По графику", th_paid_full: "Оплачено", th_due: "К оплате", th_pay_date: "Дата оплаты", th_delay_days: "Дней просрочки",
    th_sale_count: "Кол-во продаж", th_sale_sum: "Сумма продаж", th_comm: "Комиссия", th_base_sal: "Базовый оклад", th_total: "Итого",
    btn_view: "Смотр",
    btn_sales_list: "Список продаж",
  },
  en: {
    lang_changed: "Language updated",
    welcome_title: "Welcome, {name}!",
    page_debts_deb: "Debts — receivables",
    page_debts_loans: "Debts — loans",
    page_debts_cred: "Debts — payables",
    nav_users: "Users",
    nav_trash: "Trash",
    nav_companies: "Companies",
    nav_tools: "Tools",
    nav_settings: "Settings",
    nav_dev: "Developer",
    nav_accounts: "Accounts",
    nav_profile: "Profile",
    opt_pick: "Select",
    opt_debts: "Receivables",
    opt_creditor: "Payables",
    opt_loans: "Loans",
    debts_sub_all: "All",
    debts_sub_paid: "Fully paid",
    debts_sub_partial: "Partially paid",
    debts_sub_unpaid: "Unpaid",
    filt_active: "Active",
    filt_returned: "Returned",
    stock_in_warehouse: "In stock",
    stock_sold: "Sold",
    stock_returned: "Returned",
    ov_sub_all: "All loans",
    ov_sub_overdue: "Overdue loans",
    cred_sub_open: "Unpaid / Partial",
    cred_sub_all: "All",
    cred_sub_paid: "Fully paid",
    cred_sub_partial: "Partial",
    cred_sub_unpaid: "Unpaid",
    cash_opt_all: "All",
    cash_opt_in: "Incoming",
    cash_opt_out: "Outgoing",
    rep_view_summary: "Summary",
    rep_view_monthly: "By month",
    rep_view_sales: "Sales",
    rep_view_purch: "Purchases",
    rep_view_expense: "Expenses",
    rep_view_staff: "Staff",
    pager_prev: "Prev",
    pager_next: "Next",
    mon_1: "Jan", mon_2: "Feb", mon_3: "Mar", mon_4: "Apr", mon_5: "May", mon_6: "Jun",
    mon_7: "Jul", mon_8: "Aug", mon_9: "Sep", mon_10: "Oct", mon_11: "Nov", mon_12: "Dec",
    dash_lbl_purch: "Purchase",
    dash_lbl_sales: "Sale",
    dash_lbl_debtor: "Receivables",
    dash_lbl_creditor: "Payables",
    ph_search: "Search...",
    ph_imei_search: "Search by IMEI / serial...",
    ph_header_search: "Search...",
    hint_ctrl_k: "Ctrl+K",
    dash_stat_cust: "Customers",
    dash_stat_stock: "In stock",
    dash_stat_debt: "Receivables (AZN)",
    dash_stat_cred: "Payables (AZN)",
    dash_stat_cash: "Total balance (all accounts)",
    dash_chart_sales6: "Last 6 months sales (AZN)",
    dash_chart_pvs: "Purchase vs Sale (this month)",
    dash_chart_purch6: "Last 6 months purchases (AZN)",
    dash_chart_debtcred: "Receivables vs Payables",
    dash_mini_sales_yr: "Sales this year (AZN)",
    dash_mini_purch_yr: "Purchases this year (AZN)",
    dash_mini_stock_n: "Products in stock",
    lbl_debt_type: "Debt type",
    lbl_subselect: "Sub-filter",
    lbl_date_range: "Date range",
    lbl_search: "Search",
    lbl_delay_range: "Overdue days range",
    lbl_lang: "Language",
    role_fallback: "User",
    role_owner: "Owner",
    role_user: "User",
    lbl_photo_upload: "Upload photo",
    btn_new_cust: "New customer",
    btn_new_supp: "New supplier",
    btn_new_prod: "New product",
    btn_new_purch: "New purchase",
    btn_new_sale: "New sale",
    btn_new_staff: "New staff",
    btn_staff_calc: "Calculate payroll",
    btn_staff_pay: "Pay",
    btn_ret_adv: "Return advances",
    btn_cash_count: "Cash count",
    btn_day_close: "Day close",
    btn_cash_diff: "Over/short",
    btn_accounts: "Accounts",
    btn_new_cash_op: "New transaction",
    btn_new_company: "New company",
    btn_reset_company: "Reset company data",
    btn_new_user: "New user",
    btn_audit_clear: "Clear",
    btn_trash_empty: "Delete all",
    btn_export: "Export",
    btn_import: "Import",
    btn_csv: "CSV",
    btn_recalc: "Recalculate",
    btn_skins: "Skins",
    btn_qr: "QR",
    btn_settings: "Settings",
    btn_test_seed: "Load test database",
    btn_cust_import: "Customer import (Excel/CSV)",
    cash_stat_in: "Income (cash)",
    cash_stat_out: "Expense (cash)",
    cash_stat_bal: "Balance",
    cash_stat_adv: "Return advance",
    rep_stat_sales: "Sales",
    rep_stat_sales_paid: "Sales (paid)",
    rep_stat_purch: "Purchases",
    rep_stat_exp: "Expense",
    rep_stat_payroll: "Payroll (month)",
    rep_stat_pl: "Profit/Loss",
    rep_stat_pl_cash: "Cash profit",
    rep_hdr_monthly: "Monthly detail",
    rep_hdr_staff: "Staff report / Payroll",
    rep_col_pct: "Percent",
    tools_note_lbl: "Note",
    tools_note_val: "Export/Import applies only to the current company data.",
    tools_import_title: "Database import",
    tools_import_hint: "Prepare customers in Excel (name, PIN, mobile, etc.) — after import they appear in Customers. Details are in each customer Info window.",
    users_intro_html: "Roles (user / admin / developer) and permissions can be changed per user via <strong>Edit</strong>.",
    th_num: "#", th_id: "ID", th_actions: "Actions", th_name_full: "Full name", th_mobile: "Mobile", th_fin: "PIN", th_serial: "Serial №", th_guarantor: "Guarantor",
    th_company: "Company", th_contact: "Contact", th_voen: "Tax ID", th_name: "Name", th_cat: "Category", th_subcat: "Subcategory",
    th_inv: "Invoice", th_date: "Date", th_purch_date: "Purchase date", th_supplier: "Supplier", th_staff: "Staff", th_amount: "Amount", th_paid: "Paid", th_balance: "Balance", th_status: "Status", th_type: "Type",
    th_product: "Product", th_qty: "Qty", th_kind: "Kind", th_price: "Price", th_imei1: "IMEI 1", th_imei2: "IMEI 2", th_remain: "Qty left",
    th_customer: "Customer", th_inv_no: "Invoice №", th_pay_amt: "Payment amount", th_account: "Account", th_pay_type: "Payment type",
    th_user: "User", th_target: "Target", th_detail: "Detail", th_deleted_by: "Deleted by", th_role: "Role", th_active: "Active", th_username: "Username",
    th_code: "Code", th_active_co: "Active", th_info: "Info", th_staff_name: "Name", th_position: "Position", th_phone: "Phone", th_salary: "Base salary", th_pct: "Percent %",
    th_cust_debt: "Total debt", th_cust_name_long: "Customer (full name)", th_sched: "Per schedule", th_paid_full: "Paid", th_due: "Due", th_pay_date: "Payment date", th_delay_days: "Days overdue",
    th_sale_count: "Sales count", th_sale_sum: "Sales total", th_comm: "Commission", th_base_sal: "Base salary", th_total: "Total",
    btn_view: "View",
    btn_sales_list: "Sales list",
  }
};

let _currentLang = localStorage.getItem("erp_lang") || "az";
function t(key, vars) {
  const lc = _currentLang;
  let s = (LANGS[lc] || LANGS.az)[key];
  if (s == null) s = (EXTRA_LANG[lc] || EXTRA_LANG.az)[key];
  if (s == null) s = LANGS.az[key];
  if (s == null) s = EXTRA_LANG.az[key];
  if (s == null) s = key;
  s = String(s);
  if (vars && typeof vars === "object") {
    Object.keys(vars).forEach((k) => {
      s = s.split(`{${k}}`).join(String(vars[k]));
    });
  }
  return s;
}
function chartMonthAbbr(monthIndex0) {
  return t(`mon_${monthIndex0 + 1}`);
}
function applyLangMappedOptions(sel, valueToKey) {
  if (!sel) return;
  Array.from(sel.options).forEach((o) => {
    const k = valueToKey[o.value];
    if (k) o.textContent = t(k);
  });
}
function applyLangDebtUI() {
  const typeMap = { "": "opt_pick", debts: "opt_debts", creditor: "opt_creditor", overdue: "opt_loans" };
  document.querySelectorAll(".debt-type-select option").forEach((o) => {
    const k = typeMap[o.value];
    if (k) o.textContent = t(k);
  });
  const debtsSt = { "": "opt_pick", all: "debts_sub_all", paid: "debts_sub_paid", partial: "debts_sub_partial", unpaid: "debts_sub_unpaid" };
  byId("debtsStatus")?.querySelectorAll("option").forEach((o) => {
    const k = debtsSt[o.value];
    if (k) o.textContent = t(k);
  });
  const ovSt = { "": "opt_pick", all: "ov_sub_all", overdue: "ov_sub_overdue" };
  byId("overdueView")?.querySelectorAll("option").forEach((o) => {
    const k = ovSt[o.value];
    if (k) o.textContent = t(k);
  });
  const crSt = { "": "opt_pick", open: "cred_sub_open", all: "cred_sub_all", paid: "cred_sub_paid", partial: "cred_sub_partial", unpaid: "cred_sub_unpaid" };
  byId("credStatus")?.querySelectorAll("option").forEach((o) => {
    const k = crSt[o.value];
    if (k) o.textContent = t(k);
  });
}
function applyLangCashReports() {
  applyLangMappedOptions(byId("cashType"), { all: "cash_opt_all", in: "cash_opt_in", out: "cash_opt_out" });
  applyLangMappedOptions(byId("repView"), {
    summary: "rep_view_summary",
    monthly: "rep_view_monthly",
    sales: "rep_view_sales",
    purch: "rep_view_purch",
    expense: "rep_view_expense",
    staff: "rep_view_staff",
  });
}
function applyLangExtraFilters() {
  applyLangMappedOptions(byId("purchStatus"), { active: "filt_active", returned: "filt_returned", all: "debts_sub_all" });
  applyLangMappedOptions(byId("stockStatus"), {
    all: "debts_sub_all",
    stock: "stock_in_warehouse",
    sold: "stock_sold",
    returned: "stock_returned",
  });
  applyLangMappedOptions(byId("salesStatus"), { active: "filt_active", returned: "filt_returned", all: "debts_sub_all" });
}
function applyLangPagerButtons() {
  document.querySelectorAll(".btn-pager").forEach((btn) => {
    const oc = btn.getAttribute("onclick") || "";
    if (oc.includes("pagePrev")) btn.textContent = t("pager_prev");
    else if (oc.includes("pageNext")) btn.textContent = t("pager_next");
  });
}
function applyLangToNav() {
  document.querySelectorAll(".nav-link[data-sec]").forEach((el) => {
    const sec = el.getAttribute("data-sec");
    if (!sec) return;
    const key = sec === "debts" ? "nav_debts" : `nav_${sec}`;
    const label = t(key);
    const span = el.querySelector(".nav-text");
    if (span) span.textContent = label;
    el.setAttribute("data-tip", label);
  });
  document.querySelectorAll(".nav-link.dev-toggle").forEach((el) => {
    const lab = t("nav_dev");
    const span = el.querySelector(".nav-text");
    if (span) span.textContent = lab;
    el.setAttribute("data-tip", lab);
  });
}
function applyLangToStaticDom() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (!k) return;
    el.textContent = t(k);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (k) el.setAttribute("placeholder", t(k));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const k = el.getAttribute("data-i18n-title");
    if (k) el.setAttribute("title", t(k));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const k = el.getAttribute("data-i18n-aria-label");
    if (k) el.setAttribute("aria-label", t(k));
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const k = el.getAttribute("data-i18n-html");
    if (k) el.innerHTML = t(k);
  });
}
function applyLangToUI() {
  applyLangToNav();
  applyLangToStaticDom();
  applyLangDebtUI();
  applyLangCashReports();
  applyLangExtraFilters();
  applyLangPagerButtons();
  setupNavTooltips();
}
function setLang(lang) {
  if (!LANGS[lang]) return;
  _currentLang = lang;
  localStorage.setItem("erp_lang", lang);
  const sel = byId("langSelect");
  if (sel) sel.value = lang;
  applyLangToUI();
  if (typeof runSpotlight === "function" && byId("spotlightOverlay")?.classList.contains("open")) {
    try {
      runSpotlight();
    } catch (e) {}
  }
  if (meta?.session) {
    try {
      refreshHeaderBar();
      renderSidebarUser();
      renderAll();
    } catch (e) {}
  }
  toast(t("lang_changed"));
}
function initLang() {
  const saved = localStorage.getItem("erp_lang") || "az";
  _currentLang = saved;
  const sel = byId("langSelect");
  if (sel) sel.value = saved;
}

