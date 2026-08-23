package com.swiftgo.customer;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Capacitor bridge for the active-ride P2P foreground service. */
@CapacitorPlugin(name = "CustomerP2pKeepAlive")
public final class CustomerP2pKeepAlivePlugin extends Plugin {
  @PluginMethod
  public void start(PluginCall call) {
    String rideId = call.getString("rideId", "").trim();
    String rideStatus = call.getString("rideStatus", "").trim();
    if (rideId.isEmpty()) {
      call.reject("INVALID_RIDE_ID");
      return;
    }
    Intent intent = new Intent(getContext(), CustomerP2pKeepAliveForegroundService.class);
    intent.setAction(CustomerP2pKeepAliveForegroundService.ACTION_START);
    intent.putExtra(CustomerP2pKeepAliveForegroundService.EXTRA_RIDE_ID, rideId);
    intent.putExtra(CustomerP2pKeepAliveForegroundService.EXTRA_RIDE_STATUS, rideStatus);
    ContextCompat.startForegroundService(getContext(), intent);
    JSObject result = new JSObject();
    result.put("ok", true);
    call.resolve(result);
  }

  @PluginMethod
  public void stop(PluginCall call) {
    Intent intent = new Intent(getContext(), CustomerP2pKeepAliveForegroundService.class);
    intent.setAction(CustomerP2pKeepAliveForegroundService.ACTION_STOP);
    getContext().startService(intent);
    JSObject result = new JSObject();
    result.put("ok", true);
    call.resolve(result);
  }
}
