# Bakfon ERP

Statik (HTML/CSS/JS) ERP tətbiqi. Məlumatlar LocalStorage ilə işləyir; istəyə görə Firebase Firestore realtime rejimi də aktiv olur (konfiq olduqda).

## İşə salmaq

- **Sadə üsul**: `index.html` faylını brauzerdə aç.
- **Lokal server (məsləhətdir)**:

```bash
python3 -m http.server 8000
```

Sonra aç:
- UI: `http://127.0.0.1:8000`

## Qeydlər

- Firestore istifadə edəcəksənsə `firebase-config.js` içində `FIREBASE_CONFIG` düzgün olmalıdır.
