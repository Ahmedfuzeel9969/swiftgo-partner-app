package com.swiftgo.partner;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.*;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.location.*;
import com.swiftgo.p2p.NativeRidePeerEngine;
import org.json.JSONObject;

/**
 * Native GPS + admin-gated HTTPS fallback. START_STICKY is conditional on a
 * decryptable, still-valid assignment. Force-stop/reboot are not auto-restarted.
 */
public class DriverLocationForegroundService extends Service {
  static final String ACTION_START = "com.swiftgo.partner.action.START_LOCATION";
  private static final String CHANNEL_ID = "swiftgo_driver_location";
  private static final int NOTIFICATION_ID = 47201;
  private static volatile DriverLocationForegroundService instance;
  private static volatile boolean running;
  private FusedLocationProviderClient fused;
  private LocationCallback callback;
  private BackgroundLocationUploader uploader;
  private NativeRidePeerEngine nativePeer;
  private JSONObject binding;
  private long lastWebAliveElapsed, lifecycle;
  private int fixCount;

  public static boolean isRunning() { return running; }
  public static DriverLocationForegroundService getInstance() { return instance; }
  boolean matches(String id) { return running && binding != null && id.equals(binding.optString("bridgeSessionId")); }
  int lastSequence() { return uploader == null ? 0 : uploader.getLastSequence(); }
  @Override public void onCreate() {
    super.onCreate(); instance = this; running = false;
    fused = LocationServices.getFusedLocationProviderClient(this);
    uploader = new BackgroundLocationUploader(this);
    uploader.setPermanentBindingInvalidListener(reason -> stopSafely("binding_invalid:" + reason));
    nativePeer = new NativeRidePeerEngine(this, "driver", new NativeRidePeerEngine.Listener() {
      public void onPeerLocation(JSONObject fix) {
        new Handler(Looper.getMainLooper()).post(() -> {
          if (NativeLocationPolicy.webAlive(lastWebAliveElapsed, SystemClock.elapsedRealtime()) &&
              DriverLocationPlugin.hasPeerLocationListeners()) DriverLocationPlugin.emitPeerLocationFix(fix);
        });
      }
      public void onState(String state) {
        new Handler(Looper.getMainLooper()).post(() -> notifyState("p2p:" + state));
      }
      public void onCredential(String token, long expiresAtMs) {
        uploader.updateP2pCredential(token, expiresAtMs);
      }
    });
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) {
      nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
        getString(R.string.location_share_channel), NotificationManager.IMPORTANCE_LOW));
    }
  }
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && (!ACTION_START.equals(intent.getAction()) ||
        !DriverLocationPlugin.isCurrentStart(intent.getLongExtra("requestId", -1)))) {
      if (!running) stopSafely("invalid_start");
      return running ? START_STICKY : START_NOT_STICKY;
    }
    JSONObject next = null;
    if (intent != null) {
      try { next = new JSONObject(intent.getStringExtra("binding")); } catch (Exception ignored) {}
      if (!BackgroundLocationUploader.validBinding(next)) { stopSafely("invalid_binding"); return START_NOT_STICKY; }
    }
    final long version = ++lifecycle;
    running = false; removeGps(); nativePeer.pause(); lastWebAliveElapsed = 0;
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
      else startForeground(NOTIFICATION_ID, notification());
    } catch (RuntimeException e) {
      stopSafely("foreground_start_denied"); return START_NOT_STICKY;
    }
    BackgroundLocationUploader.Ready ready = (ok, restored) -> {
      if (version != lifecycle) return;
      if (!ok || restored == null) { stopSafely("restore_or_storage_failed"); return; }
      binding = restored;
      nativePeer.configure(binding);
      lastWebAliveElapsed = intent == null ? 0 : SystemClock.elapsedRealtime();
      startGps(version);
    };
    if (intent == null) uploader.restore(ready); else uploader.configure(next, ready);
    return START_STICKY;
  }
  private void startGps(long version) {
    long interval = Math.min(60_000L, Math.max(2000L, binding.optLong("intervalMs", 4000L)));
    LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
      .setMinUpdateIntervalMillis(Math.max(1000L, interval / 2))
      .setMaxUpdateAgeMillis(0).setWaitForAccurateLocation(false).build();
    callback = new LocationCallback() {
      @Override public void onLocationResult(LocationResult result) {
        if (version == lifecycle && running && result != null && result.getLastLocation() != null) onGpsFix(result.getLastLocation());
      }
    };
    try {
      fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
        .addOnSuccessListener(ignored -> {
          if (version != lifecycle) return;
          running = true; notifyState("started");
        })
        .addOnFailureListener(error -> { if (version == lifecycle) stopSafely("location_request_denied"); });
    } catch (RuntimeException e) { stopSafely("permission_denied"); }
  }
  private void onGpsFix(Location loc) {
    long elapsed = SystemClock.elapsedRealtime();
    long age = elapsed - loc.getElapsedRealtimeNanos() / 1_000_000L;
    if (age < 0 || age > NativeLocationPolicy.MAX_FIX_AGE_MS ||
        !NativeLocationPolicy.fresh(loc.getTime(), System.currentTimeMillis())) return;
    boolean webAlive = NativeLocationPolicy.webAlive(lastWebAliveElapsed, elapsed)
      && DriverLocationPlugin.hasLocationListeners();
    JSONObject fix = new JSONObject();
    try {
      fix.put("lat", loc.getLatitude()).put("lng", loc.getLongitude())
        .put("accuracyM", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL)
        .put("headingDeg", loc.hasBearing() ? loc.getBearing() : JSONObject.NULL)
        .put("speedMps", loc.hasSpeed() ? loc.getSpeed() : JSONObject.NULL)
        .put("observedAt", loc.getTime()).put("source", "native_gps")
        .put("rideId", binding.optString("rideId"))
        .put("bridgeSessionId", binding.optString("bridgeSessionId"))
        .put("resumeSequence", uploader.getLastSequence()).put("webAlive", webAlive);
      fixCount++;
      if (webAlive) {
        nativePeer.pause();
        DriverLocationPlugin.emitLocationFix(fix);
      } else {
        nativePeer.resume();
        nativePeer.offerLocation(fix);
        // Direct delivery owns the grace/healthy period. Firebase becomes
        // eligible only after native P2P has failed for the admin-set timeout.
        if (nativePeer.shouldFallback()) uploader.enqueueFix(fix, false);
      }
    } catch (Exception ignored) {}
  }
  boolean noteWebAlive(String id, int sequence) {
    if (!matches(id) || !DriverLocationPlugin.hasLocationListeners()) return false;
    lastWebAliveElapsed = SystemClock.elapsedRealtime();
    uploader.noteWebAlive(id, sequence);
    nativePeer.pause();
    JSONObject peerFix = nativePeer.takeLastPeerFix();
    if (peerFix != null) DriverLocationPlugin.emitPeerLocationFix(peerFix);
    return true;
  }
  boolean updateCredential(String id, String token, long expiry) {
    if (!matches(id)) return false;
    uploader.updateCredential(id, token, expiry);
    return true;
  }
  boolean updateP2pCredential(String id, String token, long expiry) {
    if (!matches(id)) return false;
    nativePeer.updateCredential(token, expiry);
    try { binding.put("p2pToken", token).put("p2pTokenExpiresAtMs", expiry); uploader.updateP2pCredential(token, expiry); }
    catch (Exception ignored) { return false; }
    return true;
  }
  @Override public void onTaskRemoved(Intent intent) {
    lastWebAliveElapsed = 0;
    // A valid native location service may continue; its credential and server gates still apply.
    super.onTaskRemoved(intent);
  }
  private void removeGps() {
    try { if (callback != null) fused.removeLocationUpdates(callback); } catch (RuntimeException ignored) {}
    callback = null;
  }
  void stopSafely(String reason) {
    ++lifecycle; running = false; removeGps();
    if (uploader != null) uploader.clear();
    notifyState("stopped:" + reason);
    stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
  }
  private void notifyState(String value) {
    JSONObject result = new JSONObject();
    try {
      result.put("state", value).put("rideId", binding == null ? "" : binding.optString("rideId"))
        .put("bridgeSessionId", binding == null ? "" : binding.optString("bridgeSessionId"))
        .put("fixCount", fixCount);
      if (uploader != null) result.put("upload", uploader.getDiagnostics());
      if (nativePeer != null) result.put("p2p", nativePeer.diagnostics());
      DriverLocationPlugin.emitServiceState(result);
    } catch (Exception ignored) {}
  }
  private Notification notification() {
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(getString(R.string.location_share_title)).setContentText(getString(R.string.location_share_text))
      .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
  }
  @Override public void onDestroy() {
    ++lifecycle; running = false; removeGps();
    if (uploader != null) uploader.shutdown(); // persisted valid snapshot remains; no flush-then-abort race
    if (nativePeer != null) nativePeer.shutdown();
    if (instance == this) instance = null;
    super.onDestroy();
  }
  @Override public IBinder onBind(Intent intent) { return null; }
}
