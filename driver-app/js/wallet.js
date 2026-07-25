/**
 * Phase 37 — Driver wallet recharge requests.
 */

import {
  addDoc,
  collection,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const COMPANY_ACCOUNTS = Object.freeze({
  jazzcash: "0300-1234567",
  easypaisa: "0345-7654321",
});

const els = {
  section: null,
  backdrop: null,
  closeBtn: null,
  form: null,
  method: null,
  amount: null,
  tid: null,
  message: null,
  submitBtn: null,
  openBtn: null,
  jazzcashNumber: null,
  easypaisaNumber: null,
};

let getDriver = () => null;
let onToast = () => {};

function setMessage(text = "", type = "") {
  if (!els.message) return;
  els.message.textContent = text;
  els.message.classList.remove("is-success", "is-error");
  if (type) els.message.classList.add(type === "success" ? "is-success" : "is-error");
}

function updatePaymentInstructions() {
  const method = els.method?.value || "jazzcash";
  if (els.jazzcashNumber) {
    els.jazzcashNumber.textContent = COMPANY_ACCOUNTS.jazzcash;
    els.jazzcashNumber.parentElement.hidden = method !== "jazzcash";
  }
  if (els.easypaisaNumber) {
    els.easypaisaNumber.textContent = COMPANY_ACCOUNTS.easypaisa;
    els.easypaisaNumber.parentElement.hidden = method !== "easypaisa";
  }
}

export function openRechargeSection() {
  if (!els.section) return;
  els.section.hidden = false;
  els.section.setAttribute("aria-hidden", "false");
  setMessage("");
  els.form?.reset();
  if (els.method) els.method.value = "jazzcash";
  updatePaymentInstructions();
  requestAnimationFrame(() => els.amount?.focus());
}

export function closeRechargeSection() {
  if (!els.section) return;
  els.section.hidden = true;
  els.section.setAttribute("aria-hidden", "true");
  setMessage("");
}

function readFormValues() {
  const method = els.method?.value;
  const amount = Number(els.amount?.value);
  const tid = (els.tid?.value || "").trim();

  if (!method || !["jazzcash", "easypaisa"].includes(method)) {
    throw new Error("ادائیگی کا طریقہ منتخب کریں۔");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("درست رقم درج کریں۔");
  }
  if (amount > 500000) {
    throw new Error("زیادہ سے زیادہ رقم Rs. 500,000 ہے۔");
  }
  if (!tid || tid.length < 4) {
    throw new Error("ٹرانزیکشن ID درج کریں۔");
  }

  return { method, amount: Math.round(amount), tid };
}

async function submitRechargeRequest(event) {
  event.preventDefault();
  setMessage("");

  const driver = getDriver();
  if (!driver?.uid) {
    setMessage("براہ کرم پہلے لاگ اِن کریں۔", "error");
    return;
  }

  let values;
  try {
    values = readFormValues();
  } catch (error) {
    setMessage(error.message, "error");
    return;
  }

  const { ready, db } = getFirebase();
  if (!ready || !db) {
    setMessage("Firebase دستیاب نہیں ہے۔", "error");
    return;
  }

  if (els.submitBtn) els.submitBtn.disabled = true;
  setMessage("درخواست جمع ہو رہی ہے…");

  try {
    await addDoc(collection(db, "rechargeRequests"), {
      driverId: driver.uid,
      driverName:
        driver.displayName ||
        driver.email?.split("@")[0] ||
        "SwiftGo Driver",
      method: values.method,
      amount: values.amount,
      tid: values.tid,
      status: "pending",
      createdAt: serverTimestamp(),
    });

    const successText =
      "درخواست جمع کر دی گئی۔ ایڈمن کی منظوری کا انتظار کریں۔";
    setMessage(successText, "success");
    onToast(successText);
    els.form?.reset();
    if (els.method) els.method.value = "jazzcash";
    updatePaymentInstructions();
    window.setTimeout(() => closeRechargeSection(), 1800);
  } catch (error) {
    console.warn("[SwiftGo Partner] recharge request", error);
    setMessage(
      error?.code === "permission-denied"
        ? "اجازت نہیں ملی — دوبارہ کوشش کریں۔"
        : "درخواست جمع نہیں ہو سکی۔",
      "error"
    );
  } finally {
    if (els.submitBtn) els.submitBtn.disabled = false;
  }
}

export function initWalletRecharge(options = {}) {
  getDriver = options.getDriver || getDriver;
  onToast = options.onToast || onToast;

  els.section = document.getElementById("rechargeSection");
  els.backdrop = document.getElementById("rechargeBackdrop");
  els.closeBtn = document.getElementById("rechargeCloseBtn");
  els.form = document.getElementById("rechargeForm");
  els.method = document.getElementById("rechargeMethod");
  els.amount = document.getElementById("rechargeAmount");
  els.tid = document.getElementById("rechargeTid");
  els.message = document.getElementById("rechargeFormMessage");
  els.submitBtn = document.getElementById("rechargeSubmitBtn");
  els.openBtn = document.getElementById("rechargeWalletBtn");
  els.jazzcashNumber = document.getElementById("rechargeJazzcashNumber");
  els.easypaisaNumber = document.getElementById("rechargeEasypaisaNumber");

  els.openBtn?.addEventListener("click", openRechargeSection);
  els.backdrop?.addEventListener("click", closeRechargeSection);
  els.closeBtn?.addEventListener("click", closeRechargeSection);
  els.method?.addEventListener("change", updatePaymentInstructions);
  els.form?.addEventListener("submit", submitRechargeRequest);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.section && !els.section.hidden) {
      closeRechargeSection();
    }
  });

  updatePaymentInstructions();
}
