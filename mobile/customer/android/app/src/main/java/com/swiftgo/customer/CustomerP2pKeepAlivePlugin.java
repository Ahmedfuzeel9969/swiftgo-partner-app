package com.swiftgo.customer;

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

@CapacitorPlugin(name = "CustomerP2pKeepAlive", permissions = {
  @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
})
public final class CustomerP2pKeepAlivePlugin extends Plugin {
  private static volatile CustomerP2pKeepAlivePlugin instance;
  private static final AtomicLong revision = new AtomicLong();
  private final Handler main = new Handler(Looper.getMainLooper());
  @Override public void load() { instance = this; }
  static boolean isCurrentStart(long id) { return id == revision.get(); }
  static boolean hasBridgeInstance() { return instance != null; }
  static boolean hasPeerLocationListeners() { return instance != null && instance.hasListeners("peerLocationFix"); }
  static void emitPeerLocationFix(JSONObject value) { emit("peerLocationFix", value); }
  static void emitServiceState(JSONObject value) { emit("serviceState", value); }
  private static void emit(String name, JSONObject value) {
    CustomerP2pKeepAlivePlugin plugin = instance;
    if (plugin == null || value == null) return;
    try { plugin.notifyListeners(name, new JSObject(value.toString()), false); } catch (Exception ignored) {}
  }

  @PluginMethod public void start(PluginCall call) {
    long id = revision.incrementAndGet(); call.getData().put("_requestId", id);
    if (!CustomerP2pKeepAliveForegroundService.valid(call.getData())) { call.reject("INVALID_BINDING"); return; }
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
      if (!isCurrentStart(id)) { call.reject("START_CANCELLED"); return; }
      try {
        Intent intent = new Intent(getContext(), CustomerP2pKeepAliveForegroundService.class)
          .setAction(CustomerP2pKeepAliveForegroundService.ACTION_START)
          .putExtra("binding", call.getData().toString()).putExtra("requestId", id);
        ContextCompat.startForegroundService(getContext(), intent);
        awaitRunning(call, call.getString("bridgeSessionId", ""), id, 50);
      } catch (RuntimeException e) { call.reject("FOREGROUND_START_DENIED"); }
    });
  }
  private void awaitRunning(PluginCall call, String session, long id, int remaining) {
    if (!isCurrentStart(id)) { call.reject("START_CANCELLED"); return; }
    CustomerP2pKeepAliveForegroundService service = CustomerP2pKeepAliveForegroundService.getInstance();
    if (service != null && service.matches(session)) { call.resolve(new JSObject().put("ok", true).put("running", true)); return; }
    if (remaining <= 0) { if (service != null) service.stopSafely("start_timeout"); call.reject("NATIVE_START_TIMEOUT"); return; }
    main.postDelayed(() -> awaitRunning(call, session, id, remaining - 1), 100);
  }
  @PluginMethod public void noteWebAlive(PluginCall call) {
    main.post(() -> { CustomerP2pKeepAliveForegroundService service = CustomerP2pKeepAliveForegroundService.getInstance();
      call.resolve(new JSObject().put("ok", service != null && service.noteWebAlive(call.getString("bridgeSessionId", "")))); });
  }
  @PluginMethod public void updateCredential(PluginCall call) {
    main.post(() -> { CustomerP2pKeepAliveForegroundService service = CustomerP2pKeepAliveForegroundService.getInstance();
      boolean ok = service != null && service.updateCredential(call.getString("bridgeSessionId", ""),
        call.getString("token", ""), call.getLong("tokenExpiresAtMs", 0L));
      call.resolve(new JSObject().put("ok", ok)); });
  }
  @PluginMethod public void stop(PluginCall call) {
    revision.incrementAndGet(); main.post(() -> { CustomerP2pKeepAliveForegroundService service = CustomerP2pKeepAliveForegroundService.getInstance();
      if (service != null) service.stopSafely("explicit_stop"); else new com.swiftgo.p2p.NativeP2pStore(getContext(), "customer").clear();
      call.resolve(new JSObject().put("ok", true).put("running", false)); });
  }
  private boolean hasFineLocation() {
    return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }
  @Override protected void handleOnDestroy() { if (instance == this) instance = null; super.handleOnDestroy(); }
}
