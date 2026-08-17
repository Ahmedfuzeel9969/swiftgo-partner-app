package com.swiftgo.partner;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Persistent queue + HTTPS upload for background location when WebView is dead.
 */
final class BackgroundLocationUploader {
  private static final String PREFS = "swiftgo_bg_location";
  private static final String QUEUE_FILE = "bg_location_queue.json";
  private static final int MAX_QUEUE = 40;
  private static final long BASE_RETRY_MS = 2_000L;
  private static final long MAX_RETRY_MS = 60_000L;
  private static final long QUEUE_RETRY_INTERVAL_MS = 15_000L;

  private final Context appContext;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final AtomicBoolean flushing = new AtomicBoolean(false);
  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private ConnectivityManager.NetworkCallback networkCallback;
  private Runnable queueRetryRunnable;

  private volatile String uploadUrl = "";
  private volatile String token = "";
  private volatile long tokenExpiresAtMs = 0L;
  private volatile int lastSequence = 0;
  private volatile long lastUploadAtMs = 0L;
  private volatile int uploadedCount = 0;
  private volatile int rejectedCount = 0;
  private volatile int queuedCount = 0;
  private volatile String lastReason = "";

  BackgroundLocationUploader(Context context) {
    this.appContext = context.getApplicationContext();
    loadPrefs();
    registerNetworkCallback();
    scheduleQueueRetry();
  }

  private void registerNetworkCallback() {
    try {
      ConnectivityManager cm =
          (ConnectivityManager) appContext.getSystemService(Context.CONNECTIVITY_SERVICE);
      if (cm == null) return;
      networkCallback =
          new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
              requestFlush();
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
              if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                requestFlush();
              }
            }
          };
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
        cm.registerDefaultNetworkCallback(networkCallback);
      } else {
        NetworkRequest request =
            new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        cm.registerNetworkCallback(request, networkCallback);
      }
    } catch (Exception ignored) {
      networkCallback = null;
    }
  }

  private void scheduleQueueRetry() {
    if (queueRetryRunnable != null) return;
    queueRetryRunnable =
        new Runnable() {
          @Override
          public void run() {
            if (queuedCount > 0) requestFlush();
            mainHandler.postDelayed(this, QUEUE_RETRY_INTERVAL_MS);
          }
        };
    mainHandler.postDelayed(queueRetryRunnable, QUEUE_RETRY_INTERVAL_MS);
  }

  void configure(String uploadUrl, String token, long tokenExpiresAtMs, int lastSequence) {
    this.uploadUrl = uploadUrl != null ? uploadUrl.trim() : "";
    this.token = token != null ? token.trim() : "";
    this.tokenExpiresAtMs = tokenExpiresAtMs;
    if (lastSequence > this.lastSequence) this.lastSequence = lastSequence;
    savePrefs();
  }

  void updateCredential(String token, long tokenExpiresAtMs) {
    if (token != null && !token.trim().isEmpty()) {
      this.token = token.trim();
      this.tokenExpiresAtMs = tokenExpiresAtMs;
      savePrefs();
    }
  }

  void updateLastSequence(int sequence) {
    if (sequence > lastSequence) {
      lastSequence = sequence;
      savePrefs();
    }
  }

  int nextSequence() {
    lastSequence += 1;
    savePrefs();
    return lastSequence;
  }

  int getLastSequence() {
    return lastSequence;
  }

  boolean hasValidCredential(long nowMs) {
    return token != null
        && !token.isEmpty()
        && uploadUrl != null
        && !uploadUrl.isEmpty()
        && tokenExpiresAtMs > nowMs + 5_000L;
  }

  JSONObject getDiagnostics() {
    JSONObject o = new JSONObject();
    try {
      o.put("queued", queuedCount);
      o.put("uploaded", uploadedCount);
      o.put("rejected", rejectedCount);
      o.put("lastSequence", lastSequence);
      o.put("lastUploadAtMs", lastUploadAtMs);
      o.put("lastReason", lastReason);
      o.put("hasCredential", hasValidCredential(System.currentTimeMillis()));
      o.put("tokenExpiresAtMs", tokenExpiresAtMs);
    } catch (Exception ignored) {
    }
    return o;
  }

  void enqueueFix(JSONObject fix, boolean force) {
    executor.execute(
        () -> {
          try {
            JSONArray queue = readQueue();
            // Coalesce: keep only latest pending fix plus force markers.
            JSONObject item = new JSONObject();
            item.put("fix", fix);
            item.put("force", force);
            item.put("enqueuedAt", System.currentTimeMillis());
            // Drop older pending items — latest fix wins for live tracking.
            JSONArray next = new JSONArray();
            next.put(item);
            // Preserve a small backlog of older items only if force recovery.
            for (int i = 0; i < queue.length() && next.length() < MAX_QUEUE; i++) {
              JSONObject prev = queue.optJSONObject(i);
              if (prev == null) continue;
              if (prev.optBoolean("force", false) && next.length() < 4) {
                next.put(prev);
              }
            }
            writeQueue(next);
            queuedCount = next.length();
            flushLocked();
          } catch (Exception e) {
            lastReason = "enqueue_error";
          }
        });
  }

  void requestFlush() {
    executor.execute(this::flushLocked);
  }

  void clearQueue() {
    executor.execute(
        () -> {
          writeQueue(new JSONArray());
          queuedCount = 0;
        });
  }

  private void flushLocked() {
    if (!flushing.compareAndSet(false, true)) return;
    try {
      long now = System.currentTimeMillis();
      if (!hasValidCredential(now)) {
        lastReason = "credential_missing_or_expired";
        return;
      }
      JSONArray queue = readQueue();
      if (queue.length() == 0) {
        queuedCount = 0;
        return;
      }
      List<JSONObject> remaining = new ArrayList<>();
      long backoff = BASE_RETRY_MS;
      for (int i = 0; i < queue.length(); i++) {
        JSONObject item = queue.optJSONObject(i);
        if (item == null) continue;
        JSONObject fix = item.optJSONObject("fix");
        boolean force = item.optBoolean("force", false);
        if (fix == null) continue;
        UploadResult result = postFix(fix, force);
        if (result.accepted || "CADENCE_SKIP".equals(result.reason) || isDuplicate(result.reason)) {
          if (result.accepted) uploadedCount += 1;
          else rejectedCount += 1;
          lastReason = result.reason;
          lastUploadAtMs = System.currentTimeMillis();
          backoff = BASE_RETRY_MS;
          continue;
        }
        if (isAuthFailure(result.reason)) {
          lastReason = result.reason;
          remaining.add(item);
          // Stop — need credential refresh from web when possible.
          for (int j = i + 1; j < queue.length(); j++) {
            JSONObject rest = queue.optJSONObject(j);
            if (rest != null) remaining.add(rest);
          }
          break;
        }
        // Transient — keep and retry later with backoff.
        lastReason = result.reason.isEmpty() ? "upload_failed" : result.reason;
        remaining.add(item);
        for (int j = i + 1; j < queue.length(); j++) {
          JSONObject rest = queue.optJSONObject(j);
          if (rest != null) remaining.add(rest);
        }
        try {
          Thread.sleep(Math.min(MAX_RETRY_MS, backoff));
        } catch (InterruptedException ignored) {
          Thread.currentThread().interrupt();
        }
        backoff = Math.min(MAX_RETRY_MS, backoff * 2);
        break;
      }
      JSONArray next = new JSONArray();
      for (JSONObject o : remaining) next.put(o);
      writeQueue(next);
      queuedCount = next.length();
    } finally {
      flushing.set(false);
    }
  }

  private boolean isDuplicate(String reason) {
    return reason != null
        && (reason.contains("duplicate")
            || reason.contains("out_of_order")
            || reason.contains("noop"));
  }

  private boolean isAuthFailure(String reason) {
    return "TOKEN_EXPIRED".equals(reason)
        || "INVALID_SIGNATURE".equals(reason)
        || "INVALID_TOKEN".equals(reason)
        || "ASSIGNMENT_TOKEN_MISMATCH".equals(reason)
        || "NOT_ASSIGNED_DRIVER".equals(reason)
        || "RIDE_NOT_ACTIVE".equals(reason);
  }

  private UploadResult postFix(JSONObject fix, boolean force) {
    UploadResult out = new UploadResult();
    HttpURLConnection conn = null;
    try {
      URL url = new URL(uploadUrl);
      conn = (HttpURLConnection) url.openConnection();
      conn.setConnectTimeout(12_000);
      conn.setReadTimeout(12_000);
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      JSONObject body = new JSONObject();
      body.put("token", token);
      body.put("fix", fix);
      body.put("force", force);
      byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
      conn.setFixedLengthStreamingMode(bytes.length);
      try (OutputStream os = conn.getOutputStream()) {
        os.write(bytes);
      }
      int code = conn.getResponseCode();
      String response = readStream(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
      JSONObject parsed = response.isEmpty() ? new JSONObject() : new JSONObject(response);
      out.httpCode = code;
      out.ok = parsed.optBoolean("ok", code >= 200 && code < 300);
      out.accepted = parsed.optBoolean("accepted", false);
      out.reason = parsed.optString("reason", code >= 200 && code < 300 ? "ok" : "http_" + code);
    } catch (Exception e) {
      out.ok = false;
      out.accepted = false;
      out.reason = "network_error";
    } finally {
      if (conn != null) conn.disconnect();
    }
    return out;
  }

  private static String readStream(java.io.InputStream in) {
    if (in == null) return "";
    try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
      StringBuilder sb = new StringBuilder();
      String line;
      while ((line = br.readLine()) != null) sb.append(line);
      return sb.toString();
    } catch (Exception e) {
      return "";
    }
  }

  private File queueFile() {
    return new File(appContext.getFilesDir(), QUEUE_FILE);
  }

  private JSONArray readQueue() {
    File f = queueFile();
    if (!f.exists()) return new JSONArray();
    try (FileInputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[(int) Math.min(f.length(), 256_000)];
      int n = in.read(buf);
      if (n <= 0) return new JSONArray();
      return new JSONArray(new String(buf, 0, n, StandardCharsets.UTF_8));
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  private void writeQueue(JSONArray arr) {
    try (FileOutputStream out = new FileOutputStream(queueFile(), false)) {
      out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
    } catch (Exception ignored) {
    }
  }

  private void loadPrefs() {
    SharedPreferences p = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    uploadUrl = p.getString("uploadUrl", "");
    token = p.getString("token", "");
    tokenExpiresAtMs = p.getLong("tokenExpiresAtMs", 0L);
    lastSequence = p.getInt("lastSequence", 0);
  }

  private void savePrefs() {
    appContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString("uploadUrl", uploadUrl)
        .putString("token", token)
        .putLong("tokenExpiresAtMs", tokenExpiresAtMs)
        .putInt("lastSequence", lastSequence)
        .apply();
  }

  void shutdown() {
    try {
      if (networkCallback != null) {
        ConnectivityManager cm =
            (ConnectivityManager) appContext.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) cm.unregisterNetworkCallback(networkCallback);
      }
    } catch (Exception ignored) {
    }
    networkCallback = null;
    if (queueRetryRunnable != null) {
      mainHandler.removeCallbacks(queueRetryRunnable);
      queueRetryRunnable = null;
    }
    executor.shutdownNow();
  }

  static final class UploadResult {
    boolean ok;
    boolean accepted;
    String reason = "";
    int httpCode;
  }
}
