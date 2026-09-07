package com.swiftgo.partner;

import java.net.URI;

/** Pure policy: can be exercised on the JVM without an Android device. */
final class NativeLocationPolicy {
  static final String BASE = "https://us-central1-swiftgo-ride-app.cloudfunctions.net/";
  static final long MAX_FIX_AGE_MS = 30_000L;
  static final long WEB_LEASE_MS = 15_000L;
  static boolean active(String status) {
    return "accepted".equals(status) || "arrived".equals(status) || "in_progress".equals(status);
  }
  static boolean endpoint(String value, boolean refresh) {
    String path = refresh ? "refreshBackgroundDriverLocationCredential" : "ingestBackgroundDriverLocation";
    // Exact match also excludes credentials, ports, fragments, redirects and encoded alternate paths.
    try { return URI.create(BASE + path).equals(URI.create(value)) && (BASE + path).equals(value); }
    catch (Exception e) { return false; }
  }
  static boolean fresh(long observed, long now) {
    return observed > 0 && observed <= now + 5000L && now - observed <= MAX_FIX_AGE_MS;
  }
  static boolean credential(long expires, long now) {
    return expires > now + 5000L && expires <= now + 31 * 60_000L;
  }
  static boolean webAlive(long heartbeat, long elapsed) {
    return heartbeat > 0 && elapsed >= heartbeat && elapsed - heartbeat <= WEB_LEASE_MS;
  }
  static boolean terminal(String reason) {
    switch (reason) {
      case "ASSIGNMENT_TOKEN_MISMATCH": case "NOT_ASSIGNED_DRIVER": case "RIDE_NOT_ACTIVE":
      case "VEHICLE_MISMATCH": case "DRIVER_NOT_AUTHORIZED": case "RIDE_NOT_FOUND":
      case "VEHICLE_NOT_FOUND": case "INVALID_BINDING": case "INVALID_SESSION":
      case "TOKEN_EXPIRED": case "INVALID_TOKEN": case "INVALID_SIGNATURE": case "UNSUPPORTED_VERSION":
        return true;
      default: return false;
    }
  }
  static boolean drop(String reason) {
    return "CADENCE_SKIP".equals(reason) || "FIREBASE_DISABLED".equals(reason) ||
      "P2P_FIRST_GRACE".equals(reason) || reason.contains("duplicate") ||
      reason.contains("out_of_order") || reason.contains("noop") || reason.startsWith("invalid_") ||
      reason.contains("stale") || reason.equals("INVALID_SEQUENCE");
  }
}
