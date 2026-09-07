// This helper signs in ONLY to the Auth emulator. It does not bypass app gates.
const response = await fetch('/__preview/info', { cache: 'no-store' });
if (!response.ok) throw new Error('PREVIEW_INFO_UNAVAILABLE');
const info = await response.json();
if (location.hostname !== '127.0.0.1' || info.project !== 'demo-swiftgo-phase1') throw new Error('LOCAL_PREVIEW_ONLY');
const box = document.createElement('aside');
box.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483000;max-width:min(350px,92vw)';
const shadow = box.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>:host{font-family:Tahoma,Arial,sans-serif;color:#152238;font-size:14px}details{background:#fff4cf;border:2px solid #926a00;border-radius:12px;box-shadow:0 4px 20px #0003;padding:10px;direction:rtl}summary{cursor:pointer;font-weight:bold;line-height:1.7}p{line-height:1.7;margin:8px 0}button,select{font:inherit;padding:9px;border-radius:7px;border:1px solid #756640;background:white;margin:4px 0;max-width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:#064ac3}code{direction:ltr;display:inline-block;word-break:break-all}small{display:block;line-height:1.8}[role=status]{font-weight:bold}</style>
<details open><summary>صرف آزمائشی نسخہ — فرضی مقام</summary><p>یہ اصل ایپ نہیں۔ حقیقی رقم، شناختی تصاویر یا ذاتی معلومات استعمال نہ کریں۔</p><select aria-label="آزمائشی کھاتہ"></select><br><button data-login>آزمائشی کھاتے سے داخل ہوں</button> <button data-logout>باہر نکلیں</button><p role="status">رابطہ تیار کیا جا رہا ہے…</p><small>نقشے پر مقام مستقل فرضی ہے؛ اسے چلتی گاڑی کی کامیاب جانچ نہ سمجھیں۔</small><p><a href="/__preview/" target="_blank" rel="noopener">چاروں ایپس اور جانچ کی ہدایات</a></p><small>یہ ڈبہ بند کرنے کے لیے اوپر والی سرخی دبائیں۔</small></details>`;
document.body.append(box);
const status = shadow.querySelector('[role=status]');
const select = shadow.querySelector('select');
const login = shadow.querySelector('[data-login]');
const logout = shadow.querySelector('[data-logout]');
login.disabled = true; logout.disabled = true;
for (const account of info.accounts) { const option = document.createElement('option'); option.value = account.uid; option.textContent = account.label; select.append(option); }
try {
  const firebase = await import(`${info.app.path}js/firebase.js`);
  const { signInWithEmailAndPassword, signOut, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
  const assertLocalAuth = () => {
    if (!firebase.useEmulators || firebase.app?.options.projectId !== info.project || firebase.auth?.emulatorConfig?.host !== '127.0.0.1' || firebase.auth.emulatorConfig.port !== 9099) throw new Error('SAFE_EMULATOR_CONNECTION_REQUIRED');
  };
  assertLocalAuth();
  onAuthStateChanged(firebase.auth, (user) => { status.textContent = user ? `داخل ہیں: ${user.email}` : 'فرضی کھاتے سے داخل ہونے کا بٹن دبائیں۔'; });
  login.disabled = false; logout.disabled = false;
  login.addEventListener('click', async () => {
    login.disabled = true;
    try {
      assertLocalAuth();
      const account = info.accounts.find((item) => item.uid === select.value);
      if (!account) throw new Error('UNKNOWN_PREVIEW_ACCOUNT');
      await signInWithEmailAndPassword(firebase.auth, account.email, info.password);
      status.textContent = `داخل ہیں: ${account.email}`;
      shadow.querySelector('details').open = false;
    } catch (error) { status.textContent = `داخلہ نہیں ہوا: ${error.code || error.message}`; }
    finally { login.disabled = false; }
  });
  logout.addEventListener('click', async () => {
    try { assertLocalAuth(); await signOut(firebase.auth); } catch (error) { status.textContent = `خروج نہیں ہوا: ${error.code || error.message}`; }
  });
} catch (error) { status.textContent = `محفوظ آزمائشی رابطہ دستیاب نہیں: ${error.code || error.message}`; }
