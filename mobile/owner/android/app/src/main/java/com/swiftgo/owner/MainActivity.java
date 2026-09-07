package com.swiftgo.owner;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(com.swiftgo.mobile.NativeSettingsPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
