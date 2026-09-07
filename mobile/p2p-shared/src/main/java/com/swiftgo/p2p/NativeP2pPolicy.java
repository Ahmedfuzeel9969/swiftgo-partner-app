package com.swiftgo.p2p;

import org.json.JSONArray;
import org.json.JSONObject;

/** Pure validation shared by both Android roles. */
public final class NativeP2pPolicy {
  public static final String SIGNAL_URL =
    "https://us-central1-swiftgo-ride-app.cloudfunctions.net/nativeRidePeerTransport";
  public static final long MAX_FIX_AGE_MS = 30_000L;
  public static final long MAX_FIX_FUTURE_MS = 10_000L;
  private NativeP2pPolicy() {}

  public static boolean active(String value) {
    return "accepted".equals(value) || "arrived".equals(value) || "in_progress".equals(value);
  }

  public static boolean id(String value, int max) {
    return value != null && value.length() >= 1 && value.length() <= max &&
      value.matches("[A-Za-z0-9_-]+");
  }

  public static boolean endpoint(String value) { return SIGNAL_URL.equals(value); }

  public static boolean credential(long expiry, long now) {
    return expiry > now + 5_000L && expiry <= now + 31L * 60_000L;
  }

  public static boolean fresh(long observedAt, long now) {
    return observedAt > 0 && observedAt >= now - MAX_FIX_AGE_MS && observedAt <= now + MAX_FIX_FUTURE_MS;
  }

  public static boolean coordinates(double lat, double lng) {
    return Double.isFinite(lat) && Double.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  public static boolean validBinding(JSONObject value, String role) {
    if (value == null || !("driver".equals(role) || "customer".equals(role)) ||
        !active(value.optString("rideStatus")) || !endpoint(value.optString("signalUrl")) ||
        !credential(value.optLong("p2pTokenExpiresAtMs"), System.currentTimeMillis()) ||
        value.optString("p2pToken").isEmpty()) return false;
    for (String key : new String[]{"rideId", "vehicleId", "assignmentSessionToken", "bridgeSessionId"}) {
      if (!id(value.optString(key), 256)) return false;
    }
    if (value.optInt("assignmentVersion") < 1) return false;
    if ("driver".equals(role) && !id(value.optString("trackingSessionId"), 64)) return false;
    return validIce(value.optJSONArray("iceServers"));
  }

  static boolean validIce(JSONArray servers) {
    if (servers == null || servers.length() < 1 || servers.length() > 12) return false;
    for (int i = 0; i < servers.length(); i++) {
      JSONObject server = servers.optJSONObject(i);
      if (server == null) return false;
      Object raw = server.opt("urls");
      JSONArray urls = raw instanceof JSONArray ? (JSONArray) raw : new JSONArray().put(raw);
      if (urls.length() < 1 || urls.length() > 8) return false;
      for (int j = 0; j < urls.length(); j++) {
        String url = String.valueOf(urls.opt(j));
        if (url.length() > 512 || !url.matches("(?i)^(stun|stuns|turn|turns):[^\\s]+$")) return false;
      }
      if (server.has("username") && server.optString("username").length() > 1024) return false;
      if (server.has("credential") && server.optString("credential").length() > 2048) return false;
    }
    return true;
  }
}
