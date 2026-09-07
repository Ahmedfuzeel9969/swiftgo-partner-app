import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, HOST, APPS, ACCOUNTS, safeChild, previewConfigModule, contentSecurityPolicy } from './config.mjs';
import { fixturePng } from './fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function portal(password, checks) {
  return `<!doctype html><html lang="ur" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>محفوظ آزمائشی ایپس</title>
<style>body{font:18px/1.9 Tahoma,Arial,sans-serif;background:#f1f5f9;color:#16263c;margin:0}main{max-width:900px;margin:auto;padding:24px}h1{font-size:28px}.notice{background:#fff0c4;border:2px solid #ae7c00;border-radius:12px;padding:16px}.apps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:20px 0}.apps a{background:#064a60;color:white;padding:20px;text-align:center;border-radius:12px;text-decoration:none}code{direction:ltr;display:inline-block;word-break:break-all;background:white;padding:0 8px}table{border-collapse:collapse;width:100%;font-size:16px}th,td{text-align:right;padding:10px;border-bottom:1px solid #ccd5df}li{margin-bottom:8px}</style>
<main><h1>پہلے مرحلے کی الگ آزمائشی ایپس</h1><div class="notice">یہ صرف اسی کمپیوٹر پر چلتی ہیں۔ اصل فائر بیس پر کچھ شائع نہیں ہوا۔ تمام کھاتے، رقم اور مقام فرضی ہیں۔ حقیقی ادائیگی یا اپنی اصلی شناختی تصویر استعمال نہ کریں۔</div>
<div class="apps">${APPS.map((app) => `<a href="http://${HOST}:${app.port}${app.path}?emulators=1" target="_blank" rel="noopener">${escape(app.label)} ایپ کھولیں</a>`).join('')}</div>
<h2>داخل ہونے کا آسان طریقہ</h2><p>ہر ایپ کے اوپر بائیں طرف زرد آزمائشی ڈبے میں کھاتہ منتخب کرکے «آزمائشی کھاتے سے داخل ہوں» دبائیں۔ اپنی اصل گوگل شناخت استعمال نہ کریں۔ ہر ایپ کا الگ رابطہ ہے، اس لیے کھاتے آپس میں نہیں بدلیں گے۔</p>
<p>اس نشست کا صرف آزمائشی پاس ورڈ: <code>${escape(password)}</code></p>
<table><thead><tr><th>کھاتہ</th><th>آزمائشی ای میل</th></tr></thead><tbody>${ACCOUNTS.map((a) => `<tr><td>${escape(a.label)}</td><td><code>${escape(a.email)}</code></td></tr>`).join('')}</tbody></table>
<h2>کیا چیک کریں؟</h2><ol>
<li>مالک کی ایپ میں دو فرضی گاڑیاں ہیں۔ نئی گاڑی شامل کرکے یا خالی گاڑی کا کوڈ تازہ کرکے بارہ ہندسوں والا کوڈ حاصل کریں۔</li>
<li>منظور شدہ ڈرائیور پہلے گاڑی سے الگ ہو، پھر مالک کا نیا کوڈ استعمال کرکے گاڑی جوڑے۔ شناخت کے بغیر نئے ڈرائیور کو گاڑی نہیں جوڑنی چاہیے۔</li>
<li>سپر منتظم میں پانچ سو فرضی روپے کی درخواست منظور کریں؛ دوبارہ اسی درخواست سے رقم نہیں بڑھنی چاہیے۔ یہ حقیقی ادائیگی نہیں ہے۔</li>
<li>نئے ڈرائیور کے کھاتے سے شناختی فارم کھولیں۔ نام میں «آزمائشی ڈرائیور»، شناختی نمبر میں تیرہ صفر، اور اجازت نامہ نمبر میں «TEST-ONLY» لکھیں۔ <a href="/__preview/sample.png" download="preview-document.png">یہ فرضی تصویر محفوظ کریں</a> اور چاروں جگہ یہی استعمال کریں۔ اصل دستاویز ہرگز نہ دیں۔</li>
<li>سپر منتظم کو ایک پہلے سے بنی فرضی شناختی درخواست بھی ملے گی۔ چاروں تصویریں دیکھ کر منظوری یا انکار جانچیں۔</li>
<li>کسٹمر کی ایپ میں نقشے سے دو مقامات منتخب کرکے سرور کی قیمت کی تصدیق دیکھیں۔ رعایتی کوڈ <code>TEST10</code> ہے۔ نقشہ/راستہ اور بیرونی کتابخانوں کے لیے انٹرنیٹ ضروری ہے۔</li>
</ol><div class="notice">نقشے کا مقام مستقل فرضی ہے؛ چلتی گاڑی، موبائل پس منظر، مختلف نیٹ ورکس کے براہِ راست رابطے اور حقیقی گوگل داخلے کی حتمی جانچ یہاں ثابت نہیں ہوتی۔ کسی مقام کی تحریر خودکار متحرک سفر کا ثبوت نہیں۔</div>
<p>خدمات کی ابتدائی جانچ: ${escape(checks.join('، '))}۔ ظاہری/براؤزر جانچ صارف نے ابھی تصدیق نہیں کی۔</p>
<p>کمپیوٹر یا آزمائشی خدمت بند ہونے پر یہ روابط بند ہو جائیں گے۔ دوبارہ چلانے پر نئی فرضی نشست بنتی ہے؛ پچھلی آزمائشی تبدیلیاں مستقل محفوظ نہیں ہوتیں۔</p></main></html>`;
}

export function makeHandler({ dist, app, password, checks = [] }) {
  return async (req, res) => {
    const expectedHost = `${HOST}:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) { res.writeHead(403); res.end('Loopback origin required'); return; }
    const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': contentSecurityPolicy(), 'X-SwiftGo-Preview': PROJECT };
    function send(status, body, type = 'text/plain; charset=utf-8', extra = {}) { res.writeHead(status, { ...headers, 'Content-Type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); }
    if (!['GET', 'HEAD'].includes(req.method)) { send(405, 'Read-only local preview'); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, `http://${expectedHost}`).pathname);
      if (pathname === '/__preview/health') { send(200, JSON.stringify({ project: PROJECT, synthetic: true, checks }), MIME['.json']); return; }
      if (pathname === '/__preview/info') { send(200, JSON.stringify({ project: PROJECT, password, app, accounts: ACCOUNTS.filter((a) => a.app === app.key) }), MIME['.json']); return; }
      if (pathname === '/__preview/' || pathname === '/__preview') { send(200, portal(password, checks), MIME['.html']); return; }
      if (pathname === '/__preview/sample.png') { send(200, fixturePng(), MIME['.png'], { 'Content-Disposition': 'attachment; filename="preview-document.png"' }); return; }
      if (pathname === '/__preview/bootstrap.js' || pathname === '/__preview/panel.mjs') {
        send(200, await fs.readFile(path.join(HERE, pathname.endsWith('.js') ? 'bootstrap.js' : 'panel.mjs')), MIME['.js']); return;
      }
      // No production project config reaches the browser, even if the flag fails.
      if (/^\/(?:customer\/|partner\/|owner\/|admin\/)?js\/firebase-config\.js$/.test(pathname)) { send(200, previewConfigModule(), MIME['.js']); return; }
      if (pathname === '/') { send(302, '', MIME['.html'], { Location: `${app.path}?emulators=1` }); return; }
      const relative = pathname.replace(/^\//, '');
      let target = safeChild(dist, relative, path);
      if ((await fs.stat(target)).isDirectory()) {
        if (!pathname.endsWith('/')) { send(302, '', MIME['.html'], { Location: `${pathname}/?emulators=1` }); return; }
        target = path.join(target, 'index.html');
      }
      const real = await fs.realpath(target);
      if (!real.startsWith(`${await fs.realpath(dist)}${path.sep}`)) throw new Error('UNSAFE_PATH');
      const extension = path.extname(target).toLowerCase();
      if (!MIME[extension]) { send(404, 'Not available in preview'); return; }
      let body = await fs.readFile(target);
      if (extension === '.html') {
        let html = body.toString('utf8');
        html = html.replace(/<head([^>]*)>/i, '<head$1><script src="/__preview/bootstrap.js"></script>');
        html = html.replace(/<\/body>/i, '<script type="module" src="/__preview/panel.mjs"></script></body>');
        body = html;
      }
      send(200, body, MIME[extension]);
    } catch (error) { send(error.message === 'UNSAFE_PATH' ? 403 : 404, 'Not available in local preview'); }
  };
}

export async function startServers(options) {
  const servers = [];
  try {
    for (const app of APPS) {
      const server = http.createServer(makeHandler({ ...options, app }));
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(app.port, HOST, resolve); });
      servers.push(server);
    }
    return servers;
  } catch (error) { for (const server of servers) server.close(); throw error; }
}
