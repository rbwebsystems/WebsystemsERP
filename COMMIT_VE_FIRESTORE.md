# Nəyi commit etməli və Firestore necə qurulur

## 1. Commit etməli olduğunuz fayllar

Bakfon ERP üçün əsas proyekt faylları (bunları commit edin):

| Fayl / qovluq | Commit? | Qeyd |
|---------------|--------|------|
| `index.html` | Bəli | Ana səhifə |
| `style.css` | Bəli | Ümumi stillər |
| `script.js` | Bəli | Bütün məntiq |
| `firebase-config.js` | İstəyə bağlı | `FIREBASE_CONFIG = null` ilə commit edə bilərsiniz; real açarlar yazacaq olsanız, `.gitignore`-da `firebase-config.js` açın |
| `firebase-config.example.js` | Bəli | Nümunə konfiq (repoda qalsın) |
| `syncro-logo.png` | Bəli | Loqo şəklini istifadə etsəniz |
| `.gitignore` | Bəli | Commit siyahısı |

**Commit etməyin:**  
- `.venv/`, `node_modules/` (əgər əlavə etsəniz), `templates/` (artıq ignore-da)  
- Şəxsi API açarları olan `firebase-config.js` (əgər reponu açıq edəcəksinizsə, bu faylı ignore edin və nümunəni istifadə edin)

**Git əmri (hamısını stage etmək):**
```bash
git add index.html style.css script.js firebase-config.example.js .gitignore COMMIT_VE_FIRESTORE.md
git add syncro-logo.png
# firebase-config.js yalnız null ilə commit etmək istəyirsinizsə:
git add firebase-config.js
git status
git commit -m "Bakfon ERP: UI, kassa, debitor qaimə seçimi, realtime hazırlığı"
```

---

## 2. Firestore necə ayarlanır

Realtime işləməsi üçün Firebase layihəsi və Firestore lazımdır.

### Addım 1: Firebase layihəsi

1. **https://console.firebase.google.com** açın və Google ilə daxil olun.
2. **"Layihə əlavə et"** (və ya mövcud layihəni seçin).
3. Layihə adı məs: `bakfon-erp` → **Davam et** → (Analytics istəyə bağlı) → **Layihə yarat**.

### Addım 2: Firestore Database

1. Solda **Build** → **Firestore Database**.
2. **Create database**.
3. **"Start in test mode"** seçin (development üçün; sonra qaydaları möhkəmləndirin).
4. Region seçin (məs: `europe-west1`) → **Enable**.

### Addım 3: Web app və konfiq

1. Solda **Layihə parametrləri** (dişli) → **Ümumi**.
2. Aşağıda **"Sizin uygulamalarınız"** → **Web** ikonu `</>`.
3. Tətbiq adı məs: `Bakfon ERP` → **Register app** (əgər artıq app varsa, onun konfiqini götürün).
4. **Firebase SDK** bölməsində **Config** obyektini göstərir (firebaseConfig). Məs:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc..."
};
```

5. Bu obyekti **`firebase-config.js`** faylında `FIREBASE_CONFIG`-ə kopyalayın:

```javascript
var FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc..."
};
```

6. Faylı saxlayın. Proqramı açanda giriş edib şirkət seçəndən sonra header-da **"Realtime"** görünəcək və məlumat bütün cihazlarda sinxron olacaq.

### Addım 4: Təhlükəsizlik qaydaları (isteğe bağlı, məsləhətdir)

Firestore Console → **Rules** bölməsində test rejimindən sonra məhdudiyyət qoya bilərsiniz. Bakfon ERP hazırda Firebase Auth istifadə etmir, ona görə çox sadə nümunə belə ola bilər (yalnız bu layihə üçün, öz ehtiyacınıza görə dəyişin):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /config/{doc} { allow read, write: if true; }
    match /companies/{companyId} { allow read, write: if true; }
  }
}
```

İstəsəniz sonra `request.auth != null` və ya öz şərtlərinizi əlavə edə bilərsiniz.

---

## Qısa xülasə

- **Commit:** `index.html`, `style.css`, `script.js`, `firebase-config.example.js`, `.gitignore`, (istəsəniz) `firebase-config.js` (null ilə), loqo və bu təlimat.
- **Firestore:** Firebase Console → Layihə → Firestore yarat (test mode) → Web app əlavə et → Konfiqi `firebase-config.js`-də `FIREBASE_CONFIG`-ə yapışdır.

Bu addımlardan sonra realtime işləyəcək.
