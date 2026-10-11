// Kopplingen till Firebase. Uppgifterna nedan är inte hemliga –
// säkerheten sköts av reglerna i firestore.rules.
const V = "10.12.2";
const base = `https://www.gstatic.com/firebasejs/${V}`;

const { initializeApp } = await import(`${base}/firebase-app.js`);
export const A = await import(`${base}/firebase-auth.js`);
export const F = await import(`${base}/firebase-firestore.js`);

const firebaseConfig = {
  apiKey: "AIzaSyDRm88aI7sbMnboU3UBrZVUTubQFS4_DdY",
  authDomain: "campingliv-a2e96.firebaseapp.com",
  projectId: "campingliv-a2e96",
  storageBucket: "campingliv-a2e96.firebasestorage.app",
  messagingSenderId: "470047949504",
  appId: "1:470047949504:web:5c76b2d1f20b64730a6325",
};

export const app = initializeApp(firebaseConfig);
export const auth = A.getAuth(app);
auth.languageCode = "sv";
export const db = F.getFirestore(app);
