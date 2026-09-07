package com.swiftgo.mobile;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens only this installed app's settings on an explicit UI request. */
@CapacitorPlugin(name = "NativeSettings")
public final class NativeSettingsPlugin extends Plugin {
  @PluginMethod public void openAppSettings(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      try {
        getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", getContext().getPackageName(), null)));
        call.resolve(new JSObject().put("ok", true));
      } catch (RuntimeException e) { call.reject("SETTINGS_UNAVAILABLE"); }
    });
  }
}
