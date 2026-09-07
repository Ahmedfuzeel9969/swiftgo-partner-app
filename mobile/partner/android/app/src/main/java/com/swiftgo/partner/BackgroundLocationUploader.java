package com.swiftgo.partner;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/**
 * Encrypted, assignment-bound latest-fix spool. A single worker owns I/O.
 * Network calls never hold the state lock; generation fences reject late replies.
 * This is ONLY the Firebase fallback, not a native P2P implementation.
 */
final class BackgroundLocationUploader {
  interface Ready { void done(boolean ok, JSONObject state); }
  interface PermanentBindingInvalidListener { void onPermanentBindingInvalid(String reason); }
  private final Object lock = new Object();
  private final Context context;
  private final SecureLocationStore store;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ConnectivityManager connectivity;
  private ConnectivityManager.NetworkCallback network;
  private JSONObject state;
  private long generation, heartbeatElapsed, retryAtElapsed;
  private int failures, uploaded, rejected;
  private boolean closed;
  private String lastReason = "";
  private volatile HttpURLConnection connection;
  private PermanentBindingInvalidListener invalidListener;
  private final Runnable tick = new Runnable() {
    public void run() { requestFlush(); synchronized (lock) { if (!closed) main.postDelayed(this, 15_000); } }
  };

  BackgroundLocationUploader(Context context) {
    this.context = context.getApplicationContext();
    store = new SecureLocationStore(this.context);
    connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    try {
      network = new ConnectivityManager.NetworkCallback() {
        public void onAvailable(Network n) { requestFlush(); }
      };
      if (connectivity != null) connectivity.registerDefaultNetworkCallback(network);
    } catch (RuntimeException e) { network = null; }
    main.postDelayed(tick, 15_000);
  }
  void setPermanentBindingInvalidListener(PermanentBindingInvalidListener l) { invalidListener = l; }
  private long epoch() { synchronized (lock) { return generation; } }
  private boolean current(long g) { return !closed && g == generation; }
  private void submit(long g, Runnable work) {
    try { worker.execute(() -> { synchronized (lock) { if (!current(g)) return; } work.run(); }); }
    catch (RejectedExecutionException ignored) { /* closed service, never restart it */ }
  }
  static boolean validBinding(JSONObject s) {
    if (s == null || !NativeLocationPolicy.active(s.optString("rideStatus"))) return false;
    for (String key : new String[]{"rideId", "vehicleId", "driverUid", "trackingSessionId", "assignmentSessionToken", "bridgeSessionId"}) {
      String value = s.optString(key);
      if (value.isEmpty() || value.length() > 256) return false;
    }
    return NativeLocationPolicy.endpoint(s.optString("uploadUrl"), false)
      && NativeLocationPolicy.endpoint(s.optString("refreshUrl"), true);
  }
  private static boolean sameAssignment(JSONObject a, JSONObject b) {
    if (a == null || b == null) return false;
    for (String key : new String[]{"rideId", "vehicleId", "driverUid", "trackingSessionId", "assignmentSessionToken"}) {
      if (!a.optString(key).equals(b.optString(key))) return false;
    }
    return true;
  }
  void configure(JSONObject input, Ready ready) {
    final long g;
    synchronized (lock) { g = ++generation; heartbeatElapsed = 0; }
    disconnect();
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g)) return;
        try {
          SecureLocationStore.discardLegacy(context);
          JSONObject next = new JSONObject(input.toString());
          if (!validBinding(next)) throw new IllegalStateException("INVALID_BINDING");
          // Preserve the sequence high-water across WebView restart for the SAME assignment only.
          JSONObject previous = state;
          if (previous == null) {
            try { previous = store.read(); } catch (Exception ignored) { store.clear(); }
          }
          int seq = sameAssignment(previous, next) ? previous.optInt("lastSequence") : 0;
          next.put("lastSequence", Math.max(seq, Math.max(0, next.optInt("lastSequence"))));
          next.remove("pending"); // a new live WebView owns delivery, no replay of previous spool
          next.put("schema", 2);
          state = next;
          failures = 0; retryAtElapsed = 0;
          persist();
          main.post(() -> { synchronized (lock) { if (current(g)) ready.done(true, copy(state)); } });
        } catch (Exception e) { invalidate(g, "secure_state_failed"); readyLater(ready, false, g); }
      }
    });
  }
  void restore(Ready ready) {
    final long g = epoch();
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g)) return;
        try {
          SecureLocationStore.discardLegacy(context);
          state = store.read();
          if (!validBinding(state) || state.optInt("schema") != 2 ||
              !hasCredential(System.currentTimeMillis())) throw new IllegalStateException("RESTORE_DENIED");
          if (!freshPending()) state.remove("pending");
          persist();
          readyLater(ready, true, g);
        } catch (Exception e) { invalidate(g, "restore_requires_foreground"); readyLater(ready, false, g); }
      }
    });
  }
  private void readyLater(Ready ready, boolean ok, long g) {
    JSONObject snapshot = copy(state);
    main.post(() -> { synchronized (lock) { if (current(g)) ready.done(ok, snapshot); } });
  }
  boolean matches(String session) { synchronized (lock) { return !closed && state != null && !session.isEmpty() && session.equals(state.optString("bridgeSessionId")); } }
  int getLastSequence() { synchronized (lock) { return state == null ? 0 : state.optInt("lastSequence"); } }
  void noteWebAlive(String session, int sequence) {
    synchronized (lock) {
      if (!matches(session)) return;
      heartbeatElapsed = SystemClock.elapsedRealtime();
    }
    long g = epoch();
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g) || !matches(session)) return;
        try {
          state.put("lastSequence", Math.max(state.optInt("lastSequence"), Math.max(0, sequence)));
          state.remove("pending");
          persist();
        } catch (Exception e) { invalidate(g, "secure_state_failed"); }
      }
    });
  }
  void updateCredential(String session, String token, long expiry) {
    long g = epoch();
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g) || !matches(session) || token.isEmpty() ||
            !NativeLocationPolicy.credential(expiry, System.currentTimeMillis())) return;
        try { state.put("token", token).put("tokenExpiresAtMs", expiry); persist(); }
        catch (Exception e) { invalidate(g, "secure_state_failed"); }
      }
    });
  }
  void updateP2pCredential(String token, long expiry) {
    long g = epoch();
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g) || state == null || token == null || token.isEmpty() ||
            !NativeLocationPolicy.credential(expiry, System.currentTimeMillis())) return;
        try { state.put("p2pToken", token).put("p2pTokenExpiresAtMs", expiry); persist(); }
        catch (Exception e) { invalidate(g, "secure_state_failed"); }
      }
    });
  }
  void enqueueFix(JSONObject fix, boolean ignoredForce) {
    final long g = epoch();
    final JSONObject immutable = copy(fix);
    submit(g, () -> {
      synchronized (lock) {
        if (!current(g) || state == null || immutable == null || webAlive() ||
            !state.optString("rideId").equals(immutable.optString("rideId")) ||
            !state.optString("bridgeSessionId").equals(immutable.optString("bridgeSessionId")) ||
            !NativeLocationPolicy.fresh(immutable.optLong("observedAt"), System.currentTimeMillis())) return;
        try {
          int seq = state.optInt("lastSequence");
          if (seq >= Integer.MAX_VALUE - 1) { invalidate(g, "sequence_exhausted"); return; }
          immutable.put("sequence", seq + 1);
          state.put("lastSequence", seq + 1).put("pending", immutable);
          persist(); // sequence + fix committed together before network delivery
        } catch (Exception e) { invalidate(g, "secure_state_failed"); return; }
      }
      flush(g);
    });
  }
  void requestFlush() { long g = epoch(); submit(g, () -> flush(g)); }
  private boolean hasCredential(long now) {
    return state != null && !state.optString("token").isEmpty() &&
      NativeLocationPolicy.credential(state.optLong("tokenExpiresAtMs"), now);
  }
  private boolean webAlive() { return NativeLocationPolicy.webAlive(heartbeatElapsed, SystemClock.elapsedRealtime()); }
  private boolean freshPending() {
    JSONObject fix = state == null ? null : state.optJSONObject("pending");
    return fix != null && NativeLocationPolicy.fresh(fix.optLong("observedAt"), System.currentTimeMillis());
  }
  private void flush(long g) {
    JSONObject snapshot;
    boolean renew;
    synchronized (lock) {
      if (!current(g) || state == null || SystemClock.elapsedRealtime() < retryAtElapsed) return;
      if (!hasCredential(System.currentTimeMillis())) {
        if (!webAlive()) invalidate(g, "credential_expired_reopen_app");
        return;
      }
      renew = state.optLong("tokenExpiresAtMs") <= System.currentTimeMillis() + 3 * 60_000L;
      if (!renew && (webAlive() || !freshPending())) {
        if (state.has("pending") && !freshPending()) {
          state.remove("pending");
          try { persist(); } catch (Exception e) { invalidate(g, "secure_state_failed"); }
        }
        return;
      }
      snapshot = copy(state);
    }
    JSONObject response = post(g, snapshot, renew);
    synchronized (lock) {
      if (!current(g) || state == null) return;
      String reason = response.optString("reason", "network_error");
      lastReason = reason;
      if (NativeLocationPolicy.terminal(reason)) { invalidate(g, reason); return; }
      try {
        if (renew && response.optBoolean("ok") && !response.optString("token").isEmpty() &&
            NativeLocationPolicy.credential(response.optLong("expiresAtMs"), System.currentTimeMillis())) {
          state.put("token", response.getString("token")).put("tokenExpiresAtMs", response.getLong("expiresAtMs"));
          failures = 0; retryAtElapsed = 0; persist();
          // Upload pending fix on the next tick; do not send a stale point after a slow refresh.
        } else if (!renew && (response.optBoolean("accepted") || NativeLocationPolicy.drop(reason))) {
          if (response.optBoolean("accepted")) uploaded++; else rejected++;
          state.remove("pending"); failures = 0; retryAtElapsed = 0; persist();
        } else {
          failures = Math.min(failures + 1, 5);
          retryAtElapsed = SystemClock.elapsedRealtime() + Math.min(60_000L, 2000L << failures);
        }
      } catch (Exception e) { invalidate(g, "secure_state_failed"); }
    }
  }
  private JSONObject post(long g, JSONObject snapshot, boolean refresh) {
    HttpURLConnection conn = null;
    try {
      String endpoint = snapshot.optString(refresh ? "refreshUrl" : "uploadUrl");
      if (!NativeLocationPolicy.endpoint(endpoint, refresh)) return new JSONObject().put("reason", "INVALID_BINDING");
      conn = (HttpURLConnection) new URL(endpoint).openConnection();
      synchronized (lock) {
        if (!current(g) || (!refresh && (webAlive() || !freshPending()))) return new JSONObject();
        connection = conn;
      }
      conn.setInstanceFollowRedirects(false); conn.setConnectTimeout(10_000); conn.setReadTimeout(10_000);
      conn.setRequestMethod("POST"); conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      JSONObject body = new JSONObject().put("token", snapshot.optString("token"));
      if (!refresh) body.put("fix", snapshot.getJSONObject("pending")).put("force", false);
      byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
      conn.setFixedLengthStreamingMode(bytes.length);
      try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
      int code = conn.getResponseCode();
      if (code < 200 || code >= 500 || (code >= 300 && code < 400)) return new JSONObject().put("reason", "http_" + code);
      InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
      if (stream == null) return new JSONObject().put("reason", "empty_response");
      try (InputStream in = stream; ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
        byte[] chunk = new byte[2048]; int n;
        while ((n = in.read(chunk)) != -1) {
          if (buffer.size() + n > 32_000) throw new IllegalStateException("RESPONSE_TOO_LARGE");
          buffer.write(chunk, 0, n);
        }
        JSONObject result = new JSONObject(buffer.toString("UTF-8"));
        if (code >= 400) { result.put("accepted", false).put("ok", false); }
        return result;
      }
    } catch (Exception e) {
      JSONObject failure = new JSONObject();
      try { failure.put("reason", "network_error"); } catch (Exception ignored) {}
      return failure;
    } finally {
      if (conn != null) conn.disconnect();
      synchronized (lock) { if (connection == conn) connection = null; }
    }
  }
  private void persist() throws Exception { if (state != null) store.write(state); }
  private static JSONObject copy(JSONObject value) {
    try { return value == null ? null : new JSONObject(value.toString()); } catch (Exception e) { return null; }
  }
  private void invalidate(long g, String reason) {
    if (!current(g)) return;
    lastReason = reason; state = null; store.clear();
    main.post(() -> { synchronized (lock) { if (current(g) && invalidListener != null) invalidListener.onPermanentBindingInvalid(reason); } });
  }
  JSONObject getDiagnostics() {
    synchronized (lock) {
      JSONObject result = new JSONObject();
      try { result.put("queued", state != null && state.has("pending") ? 1 : 0).put("uploaded", uploaded)
        .put("rejected", rejected).put("lastReason", lastReason).put("lastSequence", getLastSequence())
        .put("hasCredential", hasCredential(System.currentTimeMillis())); } catch (Exception ignored) {}
      return result;
    }
  }
  private void disconnect() { HttpURLConnection c = connection; if (c != null) c.disconnect(); }
  void clear() {
    synchronized (lock) { ++generation; state = null; heartbeatElapsed = 0; store.clear(); }
    disconnect();
  }
  void shutdown() {
    synchronized (lock) { closed = true; ++generation; }
    main.removeCallbacks(tick);
    try { if (network != null && connectivity != null) connectivity.unregisterNetworkCallback(network); } catch (RuntimeException ignored) {}
    disconnect(); worker.shutdownNow();
  }
}
