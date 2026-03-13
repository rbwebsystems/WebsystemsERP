// Firebase Firestore – Realtime sinxronizasiya
// FIREBASE_CONFIG təyin etsəniz məlumat buluda yazılır və bütün cihazlar/istifadəçilər eyni anda yenilənir.
// null saxlasanız proqram yalnız brauzerin localStorage istifadə edər (realtime olmaz).

var FIREBASE_CONFIG = null;

// Realtime aktiv etmək üçün:
// 1. https://console.firebase.google.com açın, layihə yaradın (və ya mövcud seçin).
// 2. Sol menyuda "Build" → "Firestore Database" → "Create database" (test rejimində başlaya bilərsiniz).
// 3. Layihə parametrləri: dişli ikonu → "Layihə parametrləri" → "Ümumi" → "Sizin uygulamalarınız" → Web (</>) ikonu.
// 4. Orada gördüyünüz firebaseConfig obyektinin sahələrini aşağıdakı nümunəyə uyğun doldurub null əvəzinə yapışdırın.

// Nümunə (null yerinə yapışdırın):
// FIREBASE_CONFIG = {
//   apiKey: "AIza...",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project-id",
//   storageBucket: "your-project.appspot.com",
//   messagingSenderId: "123456789",
//   appId: "1:123456789:web:abc..."
// };
