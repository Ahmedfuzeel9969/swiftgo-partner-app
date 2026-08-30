import { callAdmin } from "./admin-settings-client.js";

/** Operator-only, preview-first controls. Destructive calls also require a server deployment opt-in. */
export function initPrivacyMaintenance() {
  const anchor = document.getElementById("locationReportingSettingsForm");
  if (!anchor || document.getElementById("privacyMaintenancePanel")) return;
  const section = document.createElement("section");
  section.id = "privacyMaintenancePanel";
  section.dir = "rtl";
  section.innerHTML = `<h3>معلومات کی مدت اور محفوظ صفائی</h3>
    <p>یہ ترتیب لوکیشن کے پی ٹو پی یا فائر بیس وقفے نہیں بدلتی۔ خودکار عمل الگ سروری فعالی کے بغیر نہیں چلتا۔ قانونی مدت اور اصل حذف کی منظوری پہلے ضروری ہے۔</p>
    <p>منظور شدہ مدت: مالی ثبوت متعلقہ مالی سال کے اختتام کے بعد دس سال؛ منظور شدہ شناخت کھاتہ بند ہونے کے بعد ایک سال؛ مسترد یا واپس لی گئی شناخت نوّے دن؛ عام ذاتی معلومات کی صفائی تیس دن پر واجب۔ قانونی روک یا بقایا معاملہ ہو تو صفائی رکتی ہے۔ کمپنی کی رجسٹریشن ابھی درج نہیں؛ مالی سال کا اختتام فی الحال تیس جون ہے۔</p>
    <form id="privacyMaintenanceForm">
      <label><input id="privacyExpiry" type="checkbox"> وقت ختم ہونے والی تلاش اور پیشکش بند کرنے کی اجازت</label><br>
      <label><input id="privacyPurge" type="checkbox"> منظور شدہ معلومات کی محفوظ صفائی کی اجازت؛ اصل حذف کی سروری فعالی الگ ہے</label><br>
      <label>منظور شدہ پالیسی کا حوالہ <input id="privacyPolicy" maxlength="64" pattern="[A-Za-z0-9_-]{3,64}" placeholder="approved-policy-reference"></label><br>
      <label>ہر زمرے میں زیادہ سے زیادہ ریکارڈ <input id="privacyLimit" type="number" min="1" max="50" value="25" required></label><br>
      <button type="button" id="privacyLoad">ترتیب دیکھیں</button>
      <button type="button" id="privacyApprovedPolicy">منظور شدہ پالیسی کا حوالہ لگائیں</button>
      <button type="submit">ترتیب محفوظ کریں</button>
      <button type="button" id="privacyPreview">صرف صفائی کا جائزہ</button>
    </form>
    <p>کھاتہ حذف: پہلے جائزہ، پھر مقررہ وقت اور اجازت پر ایک محدود حصہ۔ مالی و شناختی ثبوت الگ مدت تک رہیں گے؛ محفوظ نقلوں کے مکمل حذف کا دعویٰ نہیں۔</p>
    <label>درخواست والے صارف کی شناخت <input id="privacyRequestUid" maxlength="128" autocomplete="off"></label>
    <button type="button" id="privacyReview">درخواست کا جائزہ درج کریں</button>
    <button type="button" id="privacyRetry">داخلہ بند کرنے کی دوبارہ کوشش</button>
    <button type="button" id="privacyAccountPreview">مدت اور رکاوٹیں دیکھیں</button>
    <button type="button" id="privacyAccountExecute" hidden>ذاتی معلومات کا اگلا محدود حصہ صاف کریں</button>
    <p>شناختی ریکارڈ:</p>
    <label>قسم <select id="privacyIdentityCollection"><option value="driver_applications">ڈرائیور کی موجودہ درخواست</option><option value="driver_application_history">ڈرائیور کی سابق درخواست</option><option value="owner_applications">مالک کی درخواست</option></select></label>
    <label>ریکارڈ کی شناخت <input id="privacyIdentityId" maxlength="128" autocomplete="off"></label>
    <button type="button" id="privacyIdentityPreview">شناخت کی مدت دیکھیں</button>
    <button type="button" id="privacyIdentityExecute" hidden>واجب شناخت اور اس کی اصل فائلیں صاف کریں</button>
    <button type="button" id="privacyFinancePreview">مالی ریکارڈ کا اگلا جائزہ</button>
    <p>قانونی روک: نیچے منتخب ریکارڈ اور اس کی شناخت پہلے تصدیق کریں۔ ختم شدہ قانونی معاملے کی روک صرف باقاعدہ جائزے کے بعد ہٹائیں۔</p>
    <label>قسم <select id="privacyHoldCollection"><option value="account_deletion_requests">کھاتہ حذف کی درخواست</option><option value="rides">سواری</option><option value="driver_applications">ڈرائیور کی شناخت</option><option value="driver_application_history">سابق شناخت</option><option value="owner_applications">مالک کی درخواست</option><option value="ledger_transactions">مالی اندراج</option><option value="support_reports">شکایت</option></select></label>
    <label>ریکارڈ کی شناخت <input id="privacyHoldId" maxlength="128" autocomplete="off"></label>
    <label>وجہ <select id="privacyHoldReason"><option value="complaint">شکایت</option><option value="accident">حادثہ</option><option value="outstanding_balance">بقایا رقم</option><option value="legal_proceeding">قانونی کارروائی</option><option value="review_resolved">جائزے کے بعد معاملہ ختم</option></select></label>
    <button type="button" id="privacyHold">روک درج کریں</button>
    <button type="button" id="privacyReleaseHold">روک ختم کریں</button>
    <p id="privacyMaintenanceStatus" role="status" aria-live="polite">پہلے ترتیب دیکھیں۔ یہ صفحہ مکمل حذف کی تصدیق نہیں ہے۔</p>`;
  anchor.insertAdjacentElement("afterend", section);
  const el = (id) => section.querySelector(`#${id}`), status = el("privacyMaintenanceStatus");
  let loaded = false;
  let approvedPolicy = "", executorAvailable = false, financeCursor = null;
  const labels = { active_ride: "جاری سواری", fleet_ownership: "گاڑیوں کی ملکیت", vehicle_assignment: "گاڑی سے ڈرائیور کا تعلق",
    financial_balance: "باقی مالی حساب", legal_hold: "قانونی روک", identity_legal_hold: "شناخت پر قانونی روک",
    support_evidence_review: "شکایت کے ثبوت کا جائزہ", admin_handover: "انتظامی اختیار کی منتقلی",
    closure_date_missing: "کھاتہ بند ہونے کی معتبر تاریخ نہیں", personal_period_not_due: "تیس دن پورے نہیں ہوئے",
    identity_period_not_due: "شناخت کی مدت ابھی باقی ہے", identity_date_or_status_review: "شناخت کی تاریخ یا حالت کا جائزہ",
    identity_still_referenced: "یہ تصاویر موجودہ شناخت میں بھی استعمال ہورہی ہیں",
    approved_disposition_plan_required: "منظور شدہ پالیسی کے مطابق جائزہ" };
  const blockers = (items) => items.length ? items.map((b) => labels[b] || "مزید سروری جائزہ").join("، ") : "کوئی درج رکاوٹ نہیں";
  const date = (n) => n ? new Date(n).toLocaleDateString("ur-PK") : "معتبر تاریخ دستیاب نہیں";
  const run = async (action) => {
    const buttons = section.querySelectorAll("button"); buttons.forEach((b) => { b.disabled = true; });
    status.textContent = "جانچ جاری ہے…";
    try { await action(); } catch (error) { status.textContent = `عمل مکمل نہیں ہوا: ${String(error?.code || "unavailable")}`; }
    finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
  el("privacyLoad").addEventListener("click", () => run(async () => {
    const result = await callAdmin("getPrivacyMaintenanceStatus");
    el("privacyExpiry").checked = result.policy.expiryEnabled; el("privacyPurge").checked = result.policy.purgeEnabled;
    el("privacyPolicy").value = result.policy.policyVersion; el("privacyLimit").value = result.policy.batchLimit; loaded = true;
    approvedPolicy = result.approvedPolicy?.version || ""; executorAvailable = result.erasureExecutorAvailable === true;
    el("privacyAccountExecute").hidden = !executorAvailable; el("privacyIdentityExecute").hidden = !executorAvailable;
    status.textContent = result.schedulerExportEnabled ? "سروری عمل موجود ہے؛ محفوظ پالیسی کے مطابق چلے گا۔" : "خودکار سروری عمل فعال نہیں؛ یہ صرف ترتیب ہے۔";
  }));
  el("privacyApprovedPolicy").addEventListener("click", () => {
    if (!loaded || !approvedPolicy) { status.textContent = "پہلے موجودہ ترتیب دیکھیں۔"; return; }
    el("privacyPolicy").value = approvedPolicy; status.textContent = "حوالہ لگ گیا؛ ابھی ترتیب محفوظ یا صفائی شروع نہیں ہوئی۔";
  });
  el("privacyMaintenanceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!loaded) { status.textContent = "محفوظ کرنے سے پہلے موجودہ ترتیب دیکھیں۔"; return; }
    const input = { expiryEnabled: el("privacyExpiry").checked, purgeEnabled: el("privacyPurge").checked,
      policyVersion: el("privacyPolicy").value.trim(), batchLimit: Number(el("privacyLimit").value) };
    if ((input.expiryEnabled || input.purgeEnabled) && !window.confirm("کیا اس پالیسی کی باقاعدہ منظوری موجود ہے؟ سروری فعالی ہونے پر اجازت یافتہ عارضی معلومات حذف ہوسکتی ہیں۔")) return;
    run(async () => { await callAdmin("savePrivacyMaintenanceSettings", input); status.textContent = "ترتیب محفوظ ہوئی؛ کسی فوری صفائی یا کھاتے کے حذف کا حکم نہیں دیا گیا۔"; });
  });
  el("privacyPreview").addEventListener("click", () => run(async () => {
    const r = await callAdmin("previewExpiredPrivateData");
    status.textContent = `محدود جائزہ: ${r.scanned} ریکارڈ دیکھے، ${r.eligible} صفائی کے قابل؛ حذف صفر۔ بغیر مدت والے پرانے ریکارڈ اس گنتی میں شامل نہیں۔`;
  }));
  el("privacyReview").addEventListener("click", () => run(async () => {
    const r = await callAdmin("reviewAccountDeletion", { uid: el("privacyRequestUid").value.trim(), policyVersion: el("privacyPolicy").value.trim() });
    status.textContent = `جائزہ درج ہوا؛ حذف مکمل نہیں۔ ${blockers(r.blockers)}`;
  }));
  el("privacyRetry").addEventListener("click", () => run(async () => {
    const r = await callAdmin("retryDeletionAuthBlock", { uid: el("privacyRequestUid").value.trim() });
    status.textContent = r.authBlockStatus === "retry_required" ? "داخلہ بندش کی سروری کوشش ناکام ہوئی؛ دوبارہ کوشش درکار ہے۔" : "داخلہ بندش کی تصدیق ہوگئی؛ ذاتی معلومات کا حذف ابھی مکمل نہیں۔";
  }));
  el("privacyAccountPreview").addEventListener("click", () => run(async () => {
    const r = await callAdmin("previewAccountDisposition", { uid: el("privacyRequestUid").value.trim() });
    status.textContent = `ذاتی صفائی: ${date(r.personalDataDueAt)}؛ منظور شدہ شناخت: ${date(r.approvedIdentityDueAt)}۔ ${blockers(r.blockers)}۔ مکمل حصے ${r.progress.step} / ${r.progress.totalSteps}۔ مالی ثبوت اور محفوظ نقلیں الگ ہیں۔`;
  }));
  el("privacyAccountExecute").addEventListener("click", () => {
    if (!executorAvailable || !window.confirm("صرف اس صارف کی واجب ذاتی معلومات کا ایک حصہ حذف کریں؟ یہ عمل واپس نہیں ہوگا؛ مالی ثبوت برقرار رہیں گے۔")) return;
    run(async () => {
      const r = await callAdmin("executeAccountDispositionPage", { uid: el("privacyRequestUid").value.trim(), confirm: approvedPolicy });
      status.textContent = r.personalDataErased ? "عام ذاتی معلومات اور داخلہ صاف ہوگئے۔ مدت والے مالی و شناختی ثبوت اور محفوظ نقلیں مکمل حذف میں شمار نہیں۔" : "ایک محدود حصہ مکمل؛ اگلا حصہ الگ بٹن سے چلائیں۔";
    });
  });
  const identityInput = () => ({ collection: el("privacyIdentityCollection").value, id: el("privacyIdentityId").value.trim() });
  el("privacyIdentityPreview").addEventListener("click", () => run(async () => {
    const r = await callAdmin("previewIdentityDisposition", identityInput());
    status.textContent = r.absent ? "ریکارڈ موجود نہیں؛ اس سے تمام محفوظ نقول کا حذف ثابت نہیں ہوتا۔" : `شناخت کی مدت: ${date(r.dueAt)}۔ ${blockers(r.blockers)}۔ اصل فائلیں: ${r.proofCount}؛ حذف صفر۔`;
  }));
  el("privacyIdentityExecute").addEventListener("click", () => {
    if (!executorAvailable || !window.confirm("اس واجب شناختی ریکارڈ اور اس سے منسلک اصل تصاویر کا ناقابلِ واپسی حذف کریں؟")) return;
    run(async () => {
      const r = await callAdmin("executeIdentityDisposition", { ...identityInput(), confirm: approvedPolicy });
      status.textContent = r.completed ? "شناخت کا بنیادی ریکارڈ اور منظور شدہ اصل فائلیں صاف ہوگئیں؛ فراہم کنندہ کی محفوظ نقول کی تصدیق الگ ہے۔" : `صفائی نہیں ہوئی۔ ${blockers(r.blockers || [])}`;
    });
  });
  el("privacyFinancePreview").addEventListener("click", () => run(async () => {
    const r = await callAdmin("previewFinancialRetention", { cursor: financeCursor }); financeCursor = r.nextCursor;
    status.textContent = `مالی جائزہ، حذف صفر۔ ${r.records.map((item) => `${item.id}: ${date(item.retainUntil)}${item.legalHold ? "؛ قانونی روک" : ""}`).join(" | ")} ${financeCursor ? "اگلا صفحہ باقی ہے۔" : "صفحے کا اختتام۔"}`;
  }));
  for (const [button, hold] of [["privacyHold", true], ["privacyReleaseHold", false]]) el(button).addEventListener("click", () => {
    if (!window.confirm(hold ? "منتخب ریکارڈ پر قانونی روک درج کریں؟" : "کیا قانونی جائزہ مکمل ہے اور منتخب ریکارڈ کی روک ختم کرنا درست ہے؟")) return;
    run(async () => { await callAdmin("setRetentionLegalHold", { collection: el("privacyHoldCollection").value,
      id: el("privacyHoldId").value.trim(), hold, reasonCode: el("privacyHoldReason").value }); status.textContent = "روک کی تبدیلی اور اس کا ثبوت محفوظ ہوگئے۔"; });
  });
}
