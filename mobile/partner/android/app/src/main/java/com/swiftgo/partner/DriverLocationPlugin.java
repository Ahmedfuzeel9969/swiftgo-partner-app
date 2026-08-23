package com.swiftgo.partner;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Capacitor bridge for DriverLocationForegroundService.
 */
@CapacitorPlugin(
    name = "DriverLocation",
    permissions = {
      @Permission(
          alias = "location",
          strings = {
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION
          })
    })
public class DriverLocationPlugin extends Plugin {
  private static DriverLocationPlugin instance;
  private static final AtomicInteger listenerCount = new AtomicInteger(0);

  @Override
  public void load() {
    instance = this;
  }

  static boolean hasLocationListeners() {
    return listenerCount.get() > 0 && instance != null;
  }

  static void emitLocationFix(JSONObject fix) {
    DriverLocationPlugin plugin = instance;
    if (plugin == null || fix == null) return;
    try {
      JSObject data = new JSObject(fix.toString());
      plugin.notifyListeners("locationFix", data, true);
    } catch (Exception ignored) {
    }
  }

  static void emitServiceState(JSONObject state) {
    DriverLocationPlugin plugin = instance;
    if (plugin == null || state == null) return;
    try {
      JSObject data = new JSObject(state.toString());
      plugin.notifyListeners("serviceState", data, true);
    } catch (Exception ignored) {
    }
  }

  @PluginMethod
  public void start(PluginCall call) {
    if (!hasFineLocation()) {
      requestPermissionForAlias("location", call, "locationPermsCallback");
      return;
    }
    startServiceFromCall(call);
  }

  @PermissionCallback
  private void locationPermsCallback(PluginCall call) {
    if (!hasFineLocation()) {
      call.reject("LOCATION_PERMISSION_DENIED");
      return;
    }
    startServiceFromCall(call);
  }

  private void startServiceFromCall(PluginCall call) {
    String rideId = call.getString("rideId", "");
    String vehicleId = call.getString("vehicleId", "");
    String driverUid = call.getString("driverUid", "");
    String trackingSessionId = call.getString("trackingSessionId", "");
    String uploadUrl = call.getString("uploadUrl", "");
    String token = call.getString("token", "");
    if (rideId.isEmpty() || vehicleId.isEmpty() || trackingSessionId.isEmpty()) {
      call.reject("INVALID_START_ARGS");
      return;
    }
    Intent intent = new Intent(getContext(), DriverLocationForegroundService.class);
    intent.setAction(DriverLocationForegroundService.ACTION_START);
    intent.putExtra(DriverLocationForegroundService.EXTRA_RIDE_ID, rideId);
    intent.putExtra(DriverLocationForegroundService.EXTRA_VEHICLE_ID, vehicleId);
    intent.putExtra(DriverLocationForegroundService.EXTRA_DRIVER_UID, driverUid);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TRACKING_SESSION_ID, trackingSessionId);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_ASSIGNMENT_TOKEN,
        call.getString("assignmentSessionToken", ""));
    intent.putExtra(DriverLocationForegroundService.EXTRA_UPLOAD_URL, uploadUrl);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_REFRESH_URL, call.getString("refreshUrl", ""));
    intent.putExtra(DriverLocationForegroundService.EXTRA_TOKEN, token);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TOKEN_EXPIRES_AT,
        call.getLong("tokenExpiresAtMs", 0L));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_RIDE_STATUS, call.getString("rideStatus", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_INTERVAL_MS, call.getLong("intervalMs", 4000L));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_LAST_SEQUENCE, call.getInt("lastSequence", 0));

    ContextCompat.startForegroundService(getContext(), intent);
    if (listenerCount.get() < 1) listenerCount.set(1);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    ret.put("running", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void stop(PluginCall call) {
    Intent intent = new Intent(getContext(), DriverLocationForegroundService.class);
    intent.setAction(DriverLocationForegroundService.ACTION_STOP);
    getContext().startService(intent);
    listenerCount.set(0);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    ret.put("running", false);
    call.resolve(ret);
  }

  @PluginMethod
  public void updateCredential(PluginCall call) {
    Intent intent = new Intent(getContext(), DriverLocationForegroundService.class);
    intent.setAction(DriverLocationForegroundService.ACTION_UPDATE_CREDENTIAL);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TOKEN, call.getString("token", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TOKEN_EXPIRES_AT,
        call.getLong("tokenExpiresAtMs", 0L));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_REFRESH_URL, call.getString("refreshUrl", ""));
    getContext().startService(intent);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void noteWebAlive(PluginCall call) {
    Intent intent = new Intent(getContext(), DriverLocationForegroundService.class);
    intent.setAction(DriverLocationForegroundService.ACTION_WEB_ALIVE);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_LAST_SEQUENCE, call.getInt("lastSequence", -1));
    getContext().startService(intent);
    if (listenerCount.get() <= 0) listenerCount.set(1);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void updateSession(PluginCall call) {
    Intent intent = new Intent(getContext(), DriverLocationForegroundService.class);
    intent.setAction(DriverLocationForegroundService.ACTION_UPDATE_SESSION);
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_RIDE_STATUS, call.getString("rideStatus", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_INTERVAL_MS, call.getLong("intervalMs", 4000L));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_LAST_SEQUENCE, call.getInt("lastSequence", 0));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_UPLOAD_URL, call.getString("uploadUrl", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_REFRESH_URL, call.getString("refreshUrl", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TOKEN, call.getString("token", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TOKEN_EXPIRES_AT,
        call.getLong("tokenExpiresAtMs", 0L));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_TRACKING_SESSION_ID,
        call.getString("trackingSessionId", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_RIDE_ID, call.getString("rideId", ""));
    intent.putExtra(
        DriverLocationForegroundService.EXTRA_VEHICLE_ID, call.getString("vehicleId", ""));
    getContext().startService(intent);
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void getState(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("running", DriverLocationForegroundService.isRunning());
    ret.put("native", true);
    ret.put("hasListeners", hasLocationListeners());
    call.resolve(ret);
  }

  private boolean hasFineLocation() {
    return ContextCompat.checkSelfPermission(
            getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
  }

  @Override
  protected void handleOnDestroy() {
    // Do not stop the foreground service — it must survive activity destroy.
    instance = null;
    listenerCount.set(0);
    super.handleOnDestroy();
  }
}
