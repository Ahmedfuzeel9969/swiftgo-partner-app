/**
 * Firebase web config — Auth, Firestore, and Hosting all use swiftgo-ride-app.
 * Customer and Driver apps share this same backend project.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCOxicIjAxPSPK24MAUe_Nv_X8EFRejQiw",
  authDomain: "swiftgo-ride-app.firebaseapp.com",
  projectId: "swiftgo-ride-app",
  storageBucket: "swiftgo-ride-app.firebasestorage.app",
  messagingSenderId: "120370160153",
  appId: "1:120370160153:web:d8324a2529142be85f8088",
};

export function isFirebaseConfigured() {
  return (
    typeof firebaseConfig.apiKey === "string" &&
    firebaseConfig.apiKey !== "YOUR_API_KEY" &&
    firebaseConfig.projectId !== "YOUR_PROJECT_ID"
  );
}
