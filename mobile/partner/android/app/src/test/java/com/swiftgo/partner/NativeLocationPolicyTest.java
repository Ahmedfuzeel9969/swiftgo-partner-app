package com.swiftgo.partner;
import org.junit.Test;
import static org.junit.Assert.*;
public class NativeLocationPolicyTest {
  @Test public void onlyActiveRides() {
    for (String value : new String[]{"accepted", "arrived", "in_progress"}) assertTrue(NativeLocationPolicy.active(value));
    for (String value : new String[]{"completed", "cancelled", "", "searching"}) assertFalse(NativeLocationPolicy.active(value));
  }
  @Test public void endpointsAreExactHttps() {
    String url = NativeLocationPolicy.BASE + "ingestBackgroundDriverLocation";
    assertTrue(NativeLocationPolicy.endpoint(url, false));
    for (String value : new String[]{url + "?token=x", url + "#x", url.replace("https:", "http:"), url.replace(".net/", ".net.evil/")})
      assertFalse(NativeLocationPolicy.endpoint(value, false));
    assertFalse(NativeLocationPolicy.endpoint(url, true));
  }
  @Test public void queueHasFiniteFreshness() {
    assertTrue(NativeLocationPolicy.fresh(100_000, 120_000));
    assertFalse(NativeLocationPolicy.fresh(100_000, 130_001));
    assertFalse(NativeLocationPolicy.fresh(130_000, 100_000));
    assertFalse(NativeLocationPolicy.fresh(0, 100_000));
  }
  @Test public void noRestoreWithExpiredCredential() {
    assertTrue(NativeLocationPolicy.credential(1_000_000, 100_000));
    assertFalse(NativeLocationPolicy.credential(0, 100_000));
    assertFalse(NativeLocationPolicy.credential(100_000, 100_000));
    assertFalse(NativeLocationPolicy.credential(Long.MAX_VALUE, 100_000));
  }
  @Test public void webLeaseUsesMonotonicBound() {
    assertTrue(NativeLocationPolicy.webAlive(1000, 15_000));
    assertFalse(NativeLocationPolicy.webAlive(0, 15_000));
    assertFalse(NativeLocationPolicy.webAlive(1000, 16_001));
    assertFalse(NativeLocationPolicy.webAlive(1000, 500));
  }
  @Test public void revokedAssignmentIsTerminal() {
    for (String reason : new String[]{"RIDE_NOT_ACTIVE", "DRIVER_NOT_AUTHORIZED", "NOT_ASSIGNED_DRIVER", "ASSIGNMENT_TOKEN_MISMATCH", "TOKEN_EXPIRED"})
      assertTrue(NativeLocationPolicy.terminal(reason));
    assertFalse(NativeLocationPolicy.terminal("network_error"));
  }
  @Test public void adminSuppressionIsDroppedNeverReplayed() {
    for (String reason : new String[]{"FIREBASE_DISABLED", "P2P_FIRST_GRACE", "CADENCE_SKIP"}) assertTrue(NativeLocationPolicy.drop(reason));
    assertFalse(NativeLocationPolicy.drop("network_error"));
  }
}
