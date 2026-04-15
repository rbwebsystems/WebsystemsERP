// Firebase Firestore – Realtime sinxronizasiya
// FIREBASE_CONFIG təyin etsəniz məlumat buluda yazılır və bütün cihazlar/istifadəçilər eyni anda yenilənir.
// null saxlasanız proqram yalnız brauzerin localStorage istifadə edər (realtime olmaz).

// RB Websystems layihəsi – compat SDK (script.js firebase.initializeApp istifadə edir)
var FIREBASE_CONFIG = {
  apiKey: "AIzaSyCqPSFmKPZSq-TKu4vhMMwcS4fi6Y71t1k",
  authDomain: "rbwebsystems-d2da2.firebaseapp.com",
  projectId: "rbwebsystems-d2da2",
  storageBucket: "rbwebsystems-d2da2.firebasestorage.app",
  messagingSenderId: "148404762518",
  appId: "1:148404762518:web:55fbc2b88de4cbb91c4fb7",
  measurementId: "G-FLSSQ8QQ8K",
  /** Callable `issueAuthToken` regionu — functions/index.js-dəki onCall region ilə eyni olmalıdır. */
  functionsRegion: "europe-west1",
};
