import { collection, query, where, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref, getBlob } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { callAdmin } from "./admin-settings-client.js?v=admin_settings_2";

export function startDriverVerificationReview({ db, storage }) {
  const host = document.getElementById("driverVerificationReview");
  if (!host || !db || !storage) return () => {};
  const urls = new Set(); let disposed = false;
  const stop = onSnapshot(query(collection(db, "driver_applications"), where("status", "==", "pending"), limit(100)), (snap) => {
    for (const url of urls) URL.revokeObjectURL(url); urls.clear(); host.replaceChildren();
    const heading = document.createElement("h2"); heading.textContent = "شناختی دستاویزات کی منظوری"; host.append(heading);
    if (snap.empty) { const note = document.createElement("p"); note.textContent = "کوئی درخواست زیرِ انتظار نہیں۔"; host.append(note); }
    for (const item of snap.docs) {
      const data = item.data(); const card = document.createElement("article"); card.style.cssText = "padding:16px;border:1px solid #ddd;margin:12px 0";
      const title = document.createElement("h3"); title.textContent = data.fullName;
      const details = document.createElement("p"); details.textContent = `شناختی کارڈ: ${data.cnic} · اجازت نامہ: ${data.licenseNumber}`;
      const status = document.createElement("p"); status.setAttribute("role", "status");
      card.append(title, details); const viewed = new Set(); const buttons = [];
      const approve = document.createElement("button"); approve.type = "button"; approve.textContent = "منظور کریں"; approve.disabled = true;
      for (const [key, label] of Object.entries({ cnicFront: "شناختی کارڈ سامنے", cnicBack: "شناختی کارڈ پیچھے", license: "اجازت نامہ", selfie: "تازہ تصویر" })) {
        const show = document.createElement("button"); show.type = "button"; show.textContent = label;
        show.addEventListener("click", async () => {
          show.disabled = true;
          try {
            // Authenticated reads; do not generate or persist public download-token URLs.
            const blob = await getBlob(ref(storage, data.proofs[key].path), 5 * 1024 * 1024);
            if (disposed || !card.isConnected) return;
            const url = URL.createObjectURL(blob); urls.add(url);
            const image = document.createElement("img"); image.src = url; image.alt = label; image.style.cssText = "display:block;max-width:100%;max-height:400px";
            await image.decode();
            if (disposed || !card.isConnected) { URL.revokeObjectURL(url); urls.delete(url); return; }
            card.insertBefore(image, status); viewed.add(key); approve.disabled = viewed.size !== 4;
          } catch { status.textContent = "تصویر نہیں کھلی۔ رابطہ اور اختیار چیک کریں۔"; show.disabled = false; }
        });
        card.append(show); buttons.push(show);
      }
      const reject = document.createElement("button"); reject.type = "button"; reject.textContent = "مسترد کریں";
      const decide = async (decision) => {
        const reason = decision === "rejected" ? window.prompt("مسترد کرنے کی وجہ لکھیں:") : "";
        if (decision === "rejected" && !reason?.trim()) return;
        if (!window.confirm(decision === "approved" ? "چاروں تصاویر دیکھ کر اس ڈرائیور کی شناخت منظور کریں؟" : "درخواست مسترد کریں؟")) return;
        approve.disabled = true; reject.disabled = true;
        try { await callAdmin("reviewDriverVerification", { uid: item.id, ticketId: data.ticketId, decision, reason }); }
        catch { status.textContent = "فیصلہ محفوظ نہیں ہوا۔ درخواست بدل گئی ہو تو صفحہ تازہ کریں۔"; approve.disabled = viewed.size !== 4; reject.disabled = false; }
      };
      approve.addEventListener("click", () => void decide("approved")); reject.addEventListener("click", () => void decide("rejected"));
      card.append(approve, reject, status); host.append(card);
    }
  }, () => { host.textContent = "شناختی درخواستیں نہیں کھل سکیں۔ اختیار اور رابطہ چیک کریں۔"; });
  return () => { disposed = true; stop(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); host.replaceChildren(); };
}
