import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

/** Separate onboarding dialog; no client can approve its own profile. */
export function initDriverVerification({ auth, db, functions, storage }) {
  if (!auth || !db || !functions || !storage) return;
  const open = document.createElement("button");
  open.type = "button"; open.textContent = "شناختی منظوری";
  open.hidden = true;
  open.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:2200;padding:10px;border-radius:10px";
  const dialog = document.createElement("dialog");
  dialog.dir = "rtl"; dialog.style.cssText = "width:min(92vw,480px);max-height:90vh;overflow:auto;border-radius:12px;padding:22px";
  dialog.setAttribute("aria-labelledby", "verificationHeading");
  // Static template only; user/status content is assigned via textContent.
  dialog.innerHTML = `<h2 id="verificationHeading">ڈرائیور کی شناختی منظوری</h2>
    <p data-status role="status"></p><p>تصاویر صرف شناختی جانچ کے لیے جمع ہوں گی۔ جمع ہونے کے بعد انہیں بدلنا یا ہٹانا ممکن نہیں؛ حذف کی درخواست مدد کے ذریعے دیں۔</p>
    <form><label>پورا نام <input name="fullName" required maxlength="120"></label><br>
    <label>شناختی کارڈ نمبر <input name="cnic" required pattern="[0-9 -]{13,17}" inputmode="numeric"></label><br>
    <label>ڈرائیونگ اجازت نامہ نمبر <input name="licenseNumber" required maxlength="40"></label><br>
    <label>شناختی کارڈ کا سامنے والا رخ <input name="cnicFront" type="file" accept="image/jpeg,image/png,image/webp" required></label><br>
    <label>شناختی کارڈ کا پچھلا رخ <input name="cnicBack" type="file" accept="image/jpeg,image/png,image/webp" required></label><br>
    <label>ڈرائیونگ اجازت نامے کی تصویر <input name="license" type="file" accept="image/jpeg,image/png,image/webp" required></label><br>
    <label>اپنی تازہ تصویر <input name="selfie" type="file" accept="image/jpeg,image/png,image/webp" required></label><br>
    <p>ہر تصویر پانچ میگا بائٹ سے کم ہو۔</p><button type="submit">جانچ کے لیے جمع کریں</button></form>
    <button type="button" data-close>بند کریں</button>`;
  document.body.append(open, dialog);
  open.addEventListener("click", () => dialog.showModal());
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  const status = dialog.querySelector("[data-status]");
  const form = dialog.querySelector("form");
  let stop = () => {}; let statusValue = "";
  onAuthStateChanged(auth, (user) => {
    stop(); open.hidden = !user; form.reset(); dialog.close();
    if (!user) return;
    stop = onSnapshot(doc(db, "partners", user.uid), (snap) => {
      statusValue = snap.data()?.driverApprovalStatus || "not_submitted";
      if (statusValue === "pending" && !snap.data()?.driverApplicationId) statusValue = "not_submitted";
      status.textContent = statusValue === "approved" ? "آپ کی شناخت منظور ہو چکی ہے۔" : statusValue === "pending" ? "درخواست جمع ہے؛ منتظم کی جانچ کا انتظار کریں۔" : "دستاویزات جمع کرائیں؛ منظوری کے بعد گاڑی جوڑ سکیں گے۔";
      open.hidden = statusValue === "approved";
      form.hidden = ["approved", "pending"].includes(statusValue);
    }, () => { status.textContent = "منظوری کی حالت معلوم نہیں ہو سکی۔"; form.hidden = true; });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!auth.currentUser || !form.reportValidity()) return;
    const uid = auth.currentUser.uid;
    const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try {
      const keys = ["cnicFront", "cnicBack", "license", "selfie"];
      const files = keys.map((key) => form.elements[key].files[0]);
      if (files.some((file) => !file || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size === 0 || file.size >= 5 * 1024 * 1024)) throw new Error("INVALID_IMAGE");
      const input = Object.fromEntries(["fullName", "cnic", "licenseNumber"].map((key) => [key, form.elements[key].value.trim()]));
      status.textContent = "دستاویزات محفوظ طریقے سے جمع ہو رہی ہیں…";
      const { data: ticket } = await httpsCallable(functions, "beginDriverVerification")({});
      await Promise.all(keys.map((key, index) => uploadBytes(ref(storage, ticket.paths[key]), files[index], { contentType: files[index].type })));
      if (auth.currentUser?.uid !== uid) throw new Error("AUTH_CHANGED");
      await httpsCallable(functions, "submitDriverVerification")({ ...input, ticketId: ticket.ticketId });
      status.textContent = "درخواست جمع ہو گئی۔ منتظم کی منظوری کا انتظار کریں۔"; form.reset(); form.hidden = true;
    } catch (error) {
      status.textContent = String(error?.code).includes("resource-exhausted") ? "آج کی کوششوں کی حد مکمل ہے؛ مدد سے رابطہ کریں۔" : "درخواست جمع نہیں ہوئی۔ تصاویر، معلومات اور رابطہ چیک کرکے دوبارہ کوشش کریں۔";
    } finally { button.disabled = false; }
  });
}
