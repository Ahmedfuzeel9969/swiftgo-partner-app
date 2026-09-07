/* Served only by the loopback preview server, before any application scripts. */
(() => {
  'use strict';
  if (location.hostname !== '127.0.0.1' || !['8786', '8787', '8788', '8789'].includes(location.port)) throw new Error('LOCAL_PREVIEW_ONLY');
  Object.defineProperty(window, '__SWIFTGO_WANT_EMULATORS__', { value: true, writable: false });
  // All positions in this preview are explicitly synthetic; never request real GPS.
  const position = () => ({ coords: { latitude: 24.8607, longitude: 67.0011, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: 0 }, timestamp: Date.now() });
  const watches = new Map(); let next = 0;
  Object.defineProperty(navigator, 'geolocation', { configurable: false, value: {
    getCurrentPosition(success) { setTimeout(() => success(position()), 0); },
    watchPosition(success) { const id = ++next; setTimeout(() => { if (watches.has(id)) success(position()); }, 0); watches.set(id, setInterval(() => success(position()), 3000)); return id; },
    clearWatch(id) { clearInterval(watches.get(id)); watches.delete(id); },
  } });
  addEventListener('pagehide', () => { for (const timer of watches.values()) clearInterval(timer); watches.clear(); });
  // Avoid accidental calls/messages to the real contact numbers still in the app.
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const target = new URL(anchor.href, location.href);
    if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') {
      event.preventDefault(); event.stopImmediatePropagation();
      alert('آزمائشی نسخے سے حقیقی کال، پیغام یا بیرونی صفحہ نہیں کھولا جائے گا۔');
    }
  }, true);
})();
