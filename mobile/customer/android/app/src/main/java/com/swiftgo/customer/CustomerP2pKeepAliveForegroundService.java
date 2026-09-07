package com.swiftgo.customer;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.*;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.location.*;
import com.swiftgo.p2p.NativeP2pPolicy;
import com.swiftgo.p2p.NativeP2pStore;
import com.swiftgo.p2p.NativeRidePeerEngine;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Customer GPS + native data-only WebRTC hand-off after WebView death. */
public final class CustomerP2pKeepAliveForegroundService extends Service {
  static final String ACTION_START = "com.swiftgo.customer.action.START_P2P_KEEPALIVE";
  private static final long WEB_ALIVE_MS = 12_000L;
  private static final String CHANNEL = "swiftgo_customer_p2p";
  private static volatile CustomerP2pKeepAliveForegroundService instance;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService storageWorker = Executors.newSingleThreadExecutor();
  private final Runnable ownership = new Runnable() {
    public void run() {
      if (!running || binding == null) return;
      if (webAlive()) nativePeer.pause(); else nativePeer.resume();
      main.postDelayed(this, 2_000L);
    }
  };
  private FusedLocationProviderClient fused;
  private LocationCallback callback;
  private NativeRidePeerEngine nativePeer;
  private NativeP2pStore store;
  private JSONObject binding;
  private String session = "";
  private long heartbeat, lifecycle;
  private int sequence;
  private boolean running;

  static CustomerP2pKeepAliveForegroundService getInstance() { return instance; }
  static boolean valid(JSONObject value) { return NativeP2pPolicy.validBinding(value, "customer"); }
  boolean matches(String id) { return running && !session.isEmpty() && session.equals(id); }

  @Override public void onCreate() {
    super.onCreate(); instance = this; fused = LocationServices.getFusedLocationProviderClient(this);
    store = new NativeP2pStore(this, "customer");
    nativePeer = new NativeRidePeerEngine(this, "customer", new NativeRidePeerEngine.Listener() {
      public void onPeerLocation(JSONObject fix) {
        main.post(() -> {
          try { if (binding != null) binding.put("lastPeerFix", fix); } catch (Exception ignored) {}
          persist();
          if (webAlive() && CustomerP2pKeepAlivePlugin.hasPeerLocationListeners())
            CustomerP2pKeepAlivePlugin.emitPeerLocationFix(fix);
        });
      }
      public void onState(String state) { main.post(() -> emitState("p2p:" + state)); }
      public void onCredential(String token, long expiresAtMs) {
        main.post(() -> {
          try { if (binding != null) binding.put("p2pToken", token).put("p2pTokenExpiresAtMs", expiresAtMs); }
          catch (Exception ignored) {}
          persist();
        });
      }
    });
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL,
      getString(R.string.p2p_keepalive_channel), NotificationManager.IMPORTANCE_LOW));
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && (!ACTION_START.equals(intent.getAction()) ||
        !CustomerP2pKeepAlivePlugin.isCurrentStart(intent.getLongExtra("requestId", -1)))) {
      if (!running) stopSafely("invalid_start"); return running ? START_STICKY : START_NOT_STICKY;
    }
    final long version = ++lifecycle;
    running = false; removeGps(); nativePeer.pause(); main.removeCallbacks(ownership);
    JSONObject next = null;
    if (intent != null) try { next = new JSONObject(intent.getStringExtra("binding")); } catch (Exception ignored) {}
    if (intent != null && !valid(next)) { stopSafely("invalid_binding"); return START_NOT_STICKY; }
    try {
      int type = Build.VERSION.SDK_INT >= 29
        ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION | ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
      if (Build.VERSION.SDK_INT >= 29) startForeground(47202, notification(), type); else startForeground(47202, notification());
    } catch (RuntimeException e) { stopSafely("foreground_start_denied"); return START_NOT_STICKY; }
    if (next != null) configure(version, next); else restore(version);
    return START_STICKY;
  }

  private void configure(long version, JSONObject next) {
    binding = next; session = next.optString("bridgeSessionId"); heartbeat = SystemClock.elapsedRealtime();
    sequence = Math.max(0, next.optInt("customerSequence"));
    persist(); startNative(version);
  }

  private void restore(long version) {
    storageWorker.execute(() -> {
      try {
        JSONObject restored = store.read();
        if (!valid(restored)) throw new IllegalStateException("RESTORE_DENIED");
        main.post(() -> { if (version == lifecycle) {
          binding = restored; session = restored.optString("bridgeSessionId"); heartbeat = 0;
          sequence = Math.max(0, restored.optInt("customerSequence")); startNative(version);
        }});
      } catch (Exception e) { main.post(() -> { if (version == lifecycle) stopSafely("restore_denied"); }); }
    });
  }

  private void startNative(long version) {
    if (version != lifecycle || binding == null) return;
    nativePeer.configure(binding); startGps(version); main.removeCallbacks(ownership); main.post(ownership);
  }

  private void startGps(long version) {
    long interval = Math.max(2_000L, Math.min(60_000L, binding.optLong("locationIntervalMs", 4_000L)));
    LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
      .setMinUpdateIntervalMillis(Math.max(1_000L, interval / 2)).setMaxUpdateAgeMillis(0).build();
    callback = new LocationCallback() {
      @Override public void onLocationResult(LocationResult result) {
        if (version == lifecycle && running && result != null && result.getLastLocation() != null) onGps(result.getLastLocation());
      }
    };
    try {
      fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
        .addOnSuccessListener(unused -> { if (version == lifecycle) { running = true; emitState("started"); } })
        .addOnFailureListener(error -> { if (version == lifecycle) stopSafely("location_request_denied"); });
    } catch (RuntimeException e) { stopSafely("permission_denied"); }
  }

  private void onGps(Location location) {
    long age = SystemClock.elapsedRealtime() - location.getElapsedRealtimeNanos() / 1_000_000L;
    if (age < 0 || age > NativeP2pPolicy.MAX_FIX_AGE_MS ||
        !NativeP2pPolicy.fresh(location.getTime(), System.currentTimeMillis()) || webAlive()) return;
    JSONObject fix = new JSONObject();
    try {
      if (sequence >= Integer.MAX_VALUE - 1) { stopSafely("sequence_exhausted"); return; }
      sequence++;
      fix.put("lat", location.getLatitude()).put("lng", location.getLongitude())
        .put("observedAt", location.getTime()).put("sequence", sequence)
        .put("trackingSessionId", binding.optString("customerTrackingSessionId"));
      if (location.hasAccuracy()) fix.put("accuracyM", location.getAccuracy());
      if (location.hasBearing()) fix.put("headingDeg", location.getBearing());
      if (location.hasSpeed()) fix.put("speedMps", location.getSpeed());
      binding.put("customerSequence", sequence); persist();
      nativePeer.resume(); nativePeer.offerLocation(fix); nativePeer.offerCustomerFallback(fix);
    } catch (Exception ignored) {}
  }

  boolean noteWebAlive(String id) {
    if (!matches(id)) return false;
    heartbeat = SystemClock.elapsedRealtime(); nativePeer.pause();
    JSONObject fix = nativePeer.takeLastPeerFix();
    if (fix == null && binding != null) fix = binding.optJSONObject("lastPeerFix");
    if (fix != null) CustomerP2pKeepAlivePlugin.emitPeerLocationFix(fix);
    if (binding != null) binding.remove("lastPeerFix"); persist(); return true;
  }

  boolean updateCredential(String id, String token, long expiry) {
    if (!matches(id) || token == null || token.isEmpty() ||
        !NativeP2pPolicy.credential(expiry, System.currentTimeMillis())) return false;
    nativePeer.updateCredential(token, expiry);
    try { binding.put("p2pToken", token).put("p2pTokenExpiresAtMs", expiry); persist(); return true; }
    catch (Exception e) { return false; }
  }

  private boolean webAlive() {
    return heartbeat > 0 && SystemClock.elapsedRealtime() - heartbeat <= WEB_ALIVE_MS &&
      CustomerP2pKeepAlivePlugin.hasBridgeInstance();
  }

  private void persist() {
    final JSONObject snapshot;
    try { snapshot = binding == null ? null : new JSONObject(binding.toString()); }
    catch (Exception e) { return; }
    if (snapshot == null) return;
    try { storageWorker.execute(() -> { try { store.write(snapshot); } catch (Exception ignored) {} }); }
    catch (RejectedExecutionException ignored) {}
  }

  @Override public void onTaskRemoved(Intent rootIntent) { heartbeat = 0; nativePeer.resume(); super.onTaskRemoved(rootIntent); }
  @Override public void onTimeout(int startId, int fgsType) { stopSafely("system_timeout"); }

  void stopSafely(String reason) {
    ++lifecycle; running = false; session = ""; heartbeat = 0; main.removeCallbacks(ownership);
    removeGps(); if (nativePeer != null) nativePeer.pause();
    if (store != null) store.clear(); emitState("stopped:" + reason);
    stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
  }

  private void emitState(String state) {
    JSONObject value = new JSONObject();
    try { value.put("state", state).put("bridgeSessionId", session)
      .put("p2p", nativePeer == null ? JSONObject.NULL : nativePeer.diagnostics()); }
    catch (Exception ignored) {}
    CustomerP2pKeepAlivePlugin.emitServiceState(value);
  }

  private Notification notification() {
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(getString(R.string.p2p_keepalive_title)).setContentText(getString(R.string.p2p_keepalive_text))
      .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPriority(NotificationCompat.PRIORITY_LOW).build();
  }

  private void removeGps() {
    try { if (callback != null) fused.removeLocationUpdates(callback); } catch (RuntimeException ignored) {}
    callback = null;
  }

  @Override public void onDestroy() {
    ++lifecycle; running = false; main.removeCallbacks(ownership);
    removeGps();
    if (nativePeer != null) nativePeer.shutdown(); storageWorker.shutdownNow();
    if (instance == this) instance = null; super.onDestroy();
  }
  @Override public IBinder onBind(Intent intent) { return null; }
}
