package com.swiftgo.partner;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Only start may create a service. Stop/heartbeat/refresh never launch one. */
@CapacitorPlugin(name = "DriverLocation", permissions = {
  @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
})
public class DriverLocationPlugin extends Plugin {
  private static volatile DriverLocationPlugin instance;
  private static final AtomicLong startRevision = new AtomicLong();
  private final Handler main = new Handler(Looper.getMainLooper());
  private volatile PluginCall pendingStart;
  private void cancelPending() {
    PluginCall previous = pendingStart;
    pendingStart = null;
    if (previous != null) previous.reject("START_CANCELLED");
  }
  @Override public void load() { instance = this; }
  static boolean isCurrentStart(long id) { return id == startRevision.get(); }
  static boolean hasLocationListeners() { return instance != null && instance.hasListeners("locationFix"); }
  static boolean hasPeerLocationListeners() { return instance != null && instance.hasListeners("peerLocationFix"); }
  static void emitLocationFix(JSONObject value) { emit("locationFix", value); }
  static void emitPeerLocationFix(JSONObject value) { emit("peerLocationFix", value); }
  static void emitServiceState(JSONObject value) { emit("serviceState", value); }
  private static void emit(String name, JSONObject value) {
    DriverLocationPlugin plugin = instance;
    if (plugin == null || value == null) return;
    try { plugin.notifyListeners(name, new JSObject(value.toString()), false); } catch (Exception ignored) {}
  }
  @PluginMethod public void start(PluginCall call) {
    long id = startRevision.incrementAndGet();
    cancelPending();
    pendingStart = call;
    call.getData().put("_requestId", id);
    if (!BackgroundLocationUploader.validBinding(call.getData())) { call.reject("INVALID_BINDING"); return; }
    if (!hasFineLocation()) { requestPermissionForAlias("location", call, "locationPermsCallback"); return; }
    startService(call);
  }
  @PermissionCallback private void locationPermsCallback(PluginCall call) {
    if (!hasFineLocation()) { call.reject("LOCATION_PERMISSION_DENIED"); return; }
    startService(call);
  }
  private void startService(PluginCall call) {
    long id = call.getLong("_requestId", -1L);
    main.post(() -> {
      if (!isCurrentStart(id)) return; // stop/new start already rejected the pending call
      try {
        Intent intent = new Intent(getContext(), DriverLocationForegroundService.class).setAction(DriverLocationForegroundService.ACTION_START);
        intent.putExtra("binding", call.getData().toString()).putExtra("requestId", id);
        ContextCompat.startForegroundService(getContext(), intent);
        awaitRunning(call, id, 50);
      } catch (RuntimeException e) { call.reject("FOREGROUND_START_DENIED"); }
    });
  }
  private void awaitRunning(PluginCall call, long id, int attempts) {
    if (!isCurrentStart(id)) return;
    DriverLocationForegroundService service = DriverLocationForegroundService.getInstance();
    if (service != null && service.matches(call.getString("bridgeSessionId", ""))) {
      JSObject result = new JSObject().put("ok", true).put("running", true).put("lastSequence", service.lastSequence());
      if (pendingStart == call) pendingStart = null;
      call.resolve(result); return;
    }
    if (attempts <= 0) {
      if (service != null) service.stopSafely("start_timeout");
      call.reject("NATIVE_START_TIMEOUT"); return;
    }
    main.postDelayed(() -> awaitRunning(call, id, attempts - 1), 100);
  }
  @PluginMethod public void stop(PluginCall call) {
    startRevision.incrementAndGet(); // also fences permission-dialog / already queued start intents
    cancelPending();
    main.post(() -> {
      DriverLocationForegroundService service = DriverLocationForegroundService.getInstance();
      if (service != null) service.stopSafely("explicit_stop");
      else new SecureLocationStore(getContext()).clear();
      call.resolve(new JSObject().put("ok", true).put("running", false));
    });
  }
  @PluginMethod public void noteWebAlive(PluginCall call) {
    main.post(() -> {
      DriverLocationForegroundService service = DriverLocationForegroundService.getInstance();
      boolean ok = service != null && service.noteWebAlive(call.getString("bridgeSessionId", ""), call.getInt("lastSequence", 0));
      call.resolve(new JSObject().put("ok", ok));
    });
  }
  @PluginMethod public void updateCredential(PluginCall call) {
    main.post(() -> {
      DriverLocationForegroundService service = DriverLocationForegroundService.getInstance();
      boolean ok = service != null && service.updateCredential(call.getString("bridgeSessionId", ""),
        call.getString("token", ""), call.getLong("tokenExpiresAtMs", 0L));
      call.resolve(new JSObject().put("ok", ok));
    });
  }
  @PluginMethod public void updateP2pCredential(PluginCall call) {
    main.post(() -> {
      DriverLocationForegroundService service = DriverLocationForegroundService.getInstance();
      boolean ok = service != null && service.updateP2pCredential(call.getString("bridgeSessionId", ""),
        call.getString("token", ""), call.getLong("tokenExpiresAtMs", 0L));
      call.resolve(new JSObject().put("ok", ok));
    });
  }
  @PluginMethod public void getState(PluginCall call) {
    call.resolve(new JSObject().put("running", DriverLocationForegroundService.isRunning())
      .put("native", true).put("hasListeners", hasLocationListeners()));
  }
  private boolean hasFineLocation() {
    return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }
  @Override protected void handleOnDestroy() {
    startRevision.incrementAndGet();
    if (instance == this) instance = null;
    super.handleOnDestroy();
  }
}
