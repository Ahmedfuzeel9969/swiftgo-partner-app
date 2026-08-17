package com.swiftgo.customer;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(CustomerP2pKeepAlivePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
