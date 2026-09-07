package com.swiftgo.p2p;

import android.content.Context;
import android.os.SystemClock;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.*;

/**
 * Data-only native WebRTC engine used only while the Capacitor WebView is not
 * alive.  Signaling is HTTPS + short-lived capability; location stays on the
 * encrypted RTC data channel.  One scheduled worker owns all mutable state.
 */
public final class NativeRidePeerEngine {
  public interface Listener {
    void onPeerLocation(JSONObject fix);
    void onState(String state);
    void onCredential(String token, long expiresAtMs);
  }

  private static final String CHANNEL = "swiftgo-loc-v1";
  private static final int MAX_SDP = 16_384, MAX_MESSAGE = 2_048;
  private static final long POLL_MS = 2_000L, HEARTBEAT_MS = 12_000L;
  private static PeerConnectionFactory sharedFactory;
  private static boolean initialized;

  private final Context context;
  private final String role, oppositeRole;
  private final Listener listener;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "swiftgo-native-p2p"); t.setDaemon(true); return t;
  });
  private final SecureRandom random = new SecureRandom();
  private volatile JSONObject binding, lastPeerFix;
  private JSONObject pendingFix;
  private PeerConnection peer;
  private volatile DataChannel channel;
  private CountDownLatch gathering;
  private volatile HttpURLConnection connection;
  private volatile boolean active, closed;
  private boolean remoteApplied;
  private long generation, lastSignalAt, lastOutboundAt, lastInboundAt;
  private volatile long activeSince, lastAckAt, channelOpenedAt;
  private long lastFallbackAt;
  private int outboundSequence, inboundSequence, reconnects;
  private String peerSessionId = "", trackingSessionId = "", offerFingerprint = "";
  private String state = "IDLE", lastReason = "";

  public NativeRidePeerEngine(Context context, String role, Listener listener) {
    if (!("driver".equals(role) || "customer".equals(role))) throw new IllegalArgumentException("INVALID_ROLE");
    this.context = context.getApplicationContext(); this.role = role;
    this.oppositeRole = "driver".equals(role) ? "customer" : "driver";
    this.listener = listener;
  }

  private static synchronized PeerConnectionFactory factory(Context context) {
    if (!initialized) {
      PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context)
        .setEnableInternalTracer(false).createInitializationOptions());
      initialized = true;
    }
    if (sharedFactory == null) sharedFactory = PeerConnectionFactory.builder().createPeerConnectionFactory();
    return sharedFactory;
  }

  public void configure(JSONObject value) {
    final JSONObject immutable = copy(value);
    worker.execute(() -> {
      if (closed || !NativeP2pPolicy.validBinding(immutable, role)) { setState("REJECTED", "invalid_binding"); return; }
      boolean same = sameAssignment(binding, immutable);
      binding = immutable;
      if (!same) resetSession();
    });
  }

  public void resume() {
    worker.execute(() -> {
      if (closed || binding == null || !NativeP2pPolicy.validBinding(binding, role)) return;
      if (active) return;
      active = true; activeSince = SystemClock.elapsedRealtime(); generation++; reconnects = 0;
      setState("SIGNALING", "webview_absent"); tick(generation);
    });
  }

  /** WebView has reclaimed the RTC route. */
  public void pause() {
    worker.execute(() -> {
      if (!active && "PAUSED".equals(state)) return;
      active = false; generation++; resetSession(); setState("PAUSED", "webview_alive");
    });
  }

  public void updateCredential(String token, long expiresAtMs) {
    worker.execute(() -> {
      if (binding == null || token == null || token.isEmpty() ||
          !NativeP2pPolicy.credential(expiresAtMs, System.currentTimeMillis())) return;
      try { binding.put("p2pToken", token).put("p2pTokenExpiresAtMs", expiresAtMs); }
      catch (Exception ignored) {}
    });
  }

  public void offerLocation(JSONObject fix) {
    final JSONObject immutable = copy(fix);
    worker.execute(() -> {
      if (closed || immutable == null || binding == null ||
          !NativeP2pPolicy.coordinates(immutable.optDouble("lat", Double.NaN), immutable.optDouble("lng", Double.NaN)) ||
          !NativeP2pPolicy.fresh(immutable.optLong("observedAt"), System.currentTimeMillis())) return;
      pendingFix = immutable;
      flushLocation();
    });
  }

  /** Customer-only Firebase safety path, still revalidated against live admin policy on server. */
  public void offerCustomerFallback(JSONObject fix) {
    if (!"customer".equals(role)) return;
    final JSONObject immutable = copy(fix);
    worker.execute(() -> {
      if (!active || closed || immutable == null || binding == null ||
          !binding.optBoolean("firebaseFallbackEnabled", false) || !shouldFallback()) return;
      long now = SystemClock.elapsedRealtime();
      long interval = Math.max(2_000L, Math.min(60_000L, binding.optLong("firebaseWriteIntervalMs", 4_000L)));
      if (lastFallbackAt > 0 && now - lastFallbackAt < interval) return;
      lastFallbackAt = now;
      try {
        JSONObject payloadFix = copy(immutable);
        payloadFix.put("rideId", binding.getString("rideId"))
          .put("assignmentId", binding.getString("assignmentSessionToken"))
          .put("assignmentVersion", binding.getInt("assignmentVersion"))
          .put("role", "customer");
        JSONObject result = post(new JSONObject().put("action", "customer_fallback").put("fix", payloadFix), generation);
        if (!result.optBoolean("ok") && "firebase_disabled".equals(result.optString("reason")))
          binding.put("firebaseFallbackEnabled", false);
      } catch (Exception ignored) { /* latest GPS callback may retry after the bounded interval */ }
    });
  }

  public boolean isHealthy() {
    long ack = lastAckAt;
    long fallback = binding == null ? 12_000L : Math.max(5_000L, Math.min(60_000L, binding.optLong("p2pFallbackAfterMs", 12_000L)));
    return active && channel != null && channel.state() == DataChannel.State.OPEN && ack > 0 &&
      SystemClock.elapsedRealtime() - ack <= fallback;
  }

  public boolean shouldFallback() {
    if (!active) return false;
    long fallback = binding == null ? 12_000L : Math.max(5_000L, Math.min(60_000L, binding.optLong("p2pFallbackAfterMs", 12_000L)));
    return !isHealthy() && SystemClock.elapsedRealtime() - activeSince >= fallback;
  }

  public JSONObject takeLastPeerFix() {
    JSONObject value = lastPeerFix; lastPeerFix = null; return copy(value);
  }

  public JSONObject diagnostics() {
    JSONObject value = new JSONObject();
    try {
      value.put("state", state).put("healthy", isHealthy()).put("active", active)
        .put("lastReason", lastReason).put("reconnects", reconnects)
        .put("sent", outboundSequence).put("received", inboundSequence);
    } catch (Exception ignored) {}
    return value;
  }

  public void shutdown() {
    try { worker.execute(() -> { closed = true; active = false; generation++; resetSession(); disconnect(); }); }
    catch (RejectedExecutionException ignored) {}
    worker.shutdownNow(); disconnect();
  }

  private void tick(long g) {
    if (!current(g)) return;
    try {
      if (!NativeP2pPolicy.validBinding(binding, role)) { setState("FALLBACK", "credential_expired"); return; }
      long now = SystemClock.elapsedRealtime();
      if (binding.optLong("p2pTokenExpiresAtMs") <= System.currentTimeMillis() + 3 * 60_000L) refresh(g);
      if (!current(g)) return;
      if (peer == null) {
        if ("driver".equals(role)) startDriver(g); else pollCustomerOffer(g);
      } else if (now - lastSignalAt >= POLL_MS) {
        if ("driver".equals(role) && !remoteApplied) pollDriverAnswer(g);
        else if ("customer".equals(role) && channel == null) pollCustomerOffer(g);
      }
      long fallback = Math.max(5_000L, Math.min(60_000L,
        binding.optLong("p2pFallbackAfterMs", 12_000L)));
      long healthAt = lastAckAt > 0 ? lastAckAt : channelOpenedAt;
      if (channel != null && channel.state() == DataChannel.State.OPEN && healthAt > 0 &&
          now - healthAt >= fallback) {
        reconnects++; resetSession(); setState("RECONNECTING", "ack_timeout");
      }
      if (channel != null && channel.state() == DataChannel.State.OPEN && now - lastOutboundAt >= HEARTBEAT_MS) sendHeartbeat();
      flushLocation();
    } catch (Exception e) {
      lastReason = "transport_error"; reconnects++;
      resetSession(); setState("RECONNECTING", "transport_error");
    }
    if (current(g)) worker.schedule(() -> tick(g), POLL_MS, TimeUnit.MILLISECONDS);
  }

  private void refresh(long g) throws Exception {
    JSONObject result = post(new JSONObject().put("action", "refresh"), g);
    if (!current(g)) return;
    if (!result.optBoolean("ok") || result.optString("token").isEmpty() ||
        !NativeP2pPolicy.credential(result.optLong("expiresAtMs"), System.currentTimeMillis())) {
      throw new IOException("REFRESH_REJECTED");
    }
    binding.put("p2pToken", result.getString("token"))
      .put("p2pTokenExpiresAtMs", result.getLong("expiresAtMs"));
    if (listener != null) listener.onCredential(result.getString("token"), result.getLong("expiresAtMs"));
  }

  private void startDriver(long g) throws Exception {
    JSONObject revision = post(new JSONObject().put("action", "revision"), g);
    if (!current(g) || revision.optBoolean("ok", true) == false) return;
    createPeer(true);
    peerSessionId = newPeerSessionId();
    trackingSessionId = binding.getString("trackingSessionId");
    SessionDescription offer = createDescription(true);
    JSONObject response = post(new JSONObject().put("action", "offer")
      .put("peerSessionId", peerSessionId).put("sdp", offer.description)
      .put("expectedPeerSessionId", revision.optString("expectedPeerSessionId"))
      .put("expectedOfferFingerprint", revision.optString("expectedOfferFingerprint")), g);
    if (!current(g) || !response.optBoolean("ok")) throw new IOException("OFFER_REJECTED");
    peerSessionId = response.optString("sessionId", peerSessionId);
    offerFingerprint = response.optString("offerFingerprint");
    lastSignalAt = SystemClock.elapsedRealtime(); setState("CONNECTING", "offer_ready");
  }

  private void pollDriverAnswer(long g) throws Exception {
    JSONObject result = post(new JSONObject().put("action", "state"), g);
    lastSignalAt = SystemClock.elapsedRealtime();
    JSONObject session = result.optJSONObject("session");
    if (!current(g) || session == null || !peerSessionId.equals(session.optString("sessionId")) ||
        !offerFingerprint.equals(session.optString("answeredOfferFingerprint"))) return;
    String answer = session.optString("answer");
    if (answer.isEmpty() || answer.length() > MAX_SDP) return;
    setRemote(new SessionDescription(SessionDescription.Type.ANSWER, answer));
    remoteApplied = true; setState("CONNECTING", "answer_applied");
  }

  private void pollCustomerOffer(long g) throws Exception {
    JSONObject result = post(new JSONObject().put("action", "state"), g);
    lastSignalAt = SystemClock.elapsedRealtime();
    JSONObject session = result.optJSONObject("session");
    if (!current(g) || session == null) return;
    String incomingId = session.optString("sessionId"), fingerprint = session.optString("offerFingerprint");
    String offer = session.optString("offer"), incomingTracking = session.optString("trackingSessionId");
    if (!NativeP2pPolicy.id(incomingId, 96) || !NativeP2pPolicy.id(incomingTracking, 64) ||
        offer.isEmpty() || offer.length() > MAX_SDP ||
        (incomingId.equals(peerSessionId) && fingerprint.equals(offerFingerprint))) return;
    resetSession(); peerSessionId = incomingId; offerFingerprint = fingerprint; trackingSessionId = incomingTracking;
    createPeer(false); setRemote(new SessionDescription(SessionDescription.Type.OFFER, offer));
    SessionDescription answer = createDescription(false);
    JSONObject response = post(new JSONObject().put("action", "answer")
      .put("peerSessionId", peerSessionId).put("offerFingerprint", offerFingerprint)
      .put("sdp", answer.description), g);
    if (!current(g) || !response.optBoolean("ok")) throw new IOException("ANSWER_REJECTED");
    remoteApplied = true; setState("CONNECTING", "answer_ready");
  }

  private void createPeer(boolean initiator) throws Exception {
    List<PeerConnection.IceServer> ice = new ArrayList<>();
    JSONArray list = binding.getJSONArray("iceServers");
    for (int i = 0; i < list.length(); i++) {
      JSONObject item = list.getJSONObject(i); Object raw = item.get("urls");
      JSONArray urls = raw instanceof JSONArray ? (JSONArray) raw : new JSONArray().put(raw);
      List<String> values = new ArrayList<>();
      for (int j = 0; j < urls.length(); j++) values.add(String.valueOf(urls.get(j)));
      PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(values);
      if (item.has("username")) builder.setUsername(item.optString("username"));
      if (item.has("credential")) builder.setPassword(item.optString("credential"));
      ice.add(builder.createIceServer());
    }
    PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(ice);
    config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
    gathering = new CountDownLatch(1);
    peer = factory(context).createPeerConnection(config, new PeerObserver());
    if (peer == null) throw new IOException("PEER_CREATE_FAILED");
    if (initiator) wireChannel(peer.createDataChannel(CHANNEL, new DataChannel.Init()));
  }

  private SessionDescription createDescription(boolean offer) throws Exception {
    SdpResult created = new SdpResult();
    if (offer) peer.createOffer(created, new MediaConstraints()); else peer.createAnswer(created, new MediaConstraints());
    SessionDescription description = created.awaitDescription();
    SdpResult local = new SdpResult(); peer.setLocalDescription(local, description); local.awaitSet();
    CountDownLatch latch = gathering;
    if (latch != null && !latch.await(20, TimeUnit.SECONDS)) throw new TimeoutException("ICE_GATHER_TIMEOUT");
    SessionDescription bundled = peer.getLocalDescription();
    if (bundled == null || bundled.description.isEmpty() || bundled.description.length() > MAX_SDP) throw new IOException("BAD_LOCAL_SDP");
    return bundled;
  }

  private void setRemote(SessionDescription description) throws Exception {
    SdpResult remote = new SdpResult(); peer.setRemoteDescription(remote, description); remote.awaitSet();
  }

  private void wireChannel(DataChannel next) {
    if (next == null || !CHANNEL.equals(next.label())) { if (next != null) next.close(); return; }
    if (channel != null && channel != next) channel.close();
    channel = next; next.registerObserver(new DataChannel.Observer() {
      public void onBufferedAmountChange(long previousAmount) {}
      public void onStateChange() {
        worker.execute(() -> {
          if (channel != next) return;
          if (next.state() == DataChannel.State.OPEN) {
            channelOpenedAt = SystemClock.elapsedRealtime();
            setState("CHANNEL_OPEN", "direct"); flushLocation();
          }
          else if (next.state() == DataChannel.State.CLOSED) {
            reconnects++; resetSession(); setState("RECONNECTING", "channel_closed");
          }
        });
      }
      public void onMessage(DataChannel.Buffer buffer) {
        if (buffer.binary || buffer.data.remaining() > MAX_MESSAGE) return;
        byte[] bytes = new byte[buffer.data.remaining()]; buffer.data.get(bytes);
        String text = new String(bytes, StandardCharsets.UTF_8);
        worker.execute(() -> receive(text));
      }
    });
  }

  private void flushLocation() {
    if (pendingFix == null || channel == null || channel.state() != DataChannel.State.OPEN || channel.bufferedAmount() > 64 * 1024) return;
    try {
      int next = outboundSequence + 1;
      JSONObject message = new JSONObject().put("v", 1).put("type", "loc")
        .put("peerSessionId", peerSessionId).put("trackingSessionId", trackingSessionId)
        .put("assignmentVersion", binding.getInt("assignmentVersion"))
        .put("assignmentId", binding.getString("assignmentSessionToken"))
        .put("rideId", binding.getString("rideId")).put("role", role).put("seq", next)
        .put("observedAt", pendingFix.getLong("observedAt"))
        .put("lat", pendingFix.getDouble("lat")).put("lng", pendingFix.getDouble("lng"))
        .put("fixSequence", Math.max(1, pendingFix.optInt("sequence", next)))
        .put("sampleSessionId", "driver".equals(role) ? trackingSessionId :
          pendingFix.optString("trackingSessionId", trackingSessionId));
      nullable(message, "accuracyM", pendingFix.opt("accuracyM"));
      nullable(message, "headingDeg", pendingFix.opt("headingDeg"));
      nullable(message, "speedMps", pendingFix.opt("speedMps"));
      if (send(message)) { outboundSequence = next; pendingFix = null; lastOutboundAt = SystemClock.elapsedRealtime(); }
    } catch (Exception ignored) {}
  }

  private void receive(String text) {
    try {
      if (text.length() > MAX_MESSAGE || binding == null) return;
      JSONObject message = new JSONObject(text);
      if (message.optInt("v") != 1 || !peerSessionId.equals(message.optString("peerSessionId")) ||
          !trackingSessionId.equals(message.optString("trackingSessionId")) ||
          binding.optInt("assignmentVersion") != message.optInt("assignmentVersion") ||
          !oppositeRole.equals(message.optString("role"))) return;
      String type = message.optString("type");
      if ("ack".equals(type)) {
        int sequence = message.optInt("seq");
        String ackKind = message.optString("ackKind");
        if (("loc".equals(ackKind) && sequence > 0 && sequence <= outboundSequence) ||
            ("hb".equals(ackKind) && sequence >= 0 && sequence <= outboundSequence)) {
          lastAckAt = SystemClock.elapsedRealtime(); setState("P2P_HEALTHY", ackKind + "_ack");
        }
        return;
      }
      if ("hb".equals(type)) {
        send(new JSONObject().put("v", 1).put("type", "ack").put("ackKind", "hb")
          .put("peerSessionId", peerSessionId).put("trackingSessionId", trackingSessionId)
          .put("assignmentVersion", binding.getInt("assignmentVersion"))
          .put("seq", message.optInt("seq")).put("observedAt", System.currentTimeMillis()).put("role", role));
        return;
      }
      if (!"loc".equals(type) || !binding.optString("rideId").equals(message.optString("rideId")) ||
          !binding.optString("assignmentSessionToken").equals(message.optString("assignmentId"))) return;
      int sequence = message.optInt("seq"); long observed = message.optLong("observedAt");
      double lat = message.optDouble("lat", Double.NaN), lng = message.optDouble("lng", Double.NaN);
      if (sequence <= inboundSequence || !NativeP2pPolicy.fresh(observed, System.currentTimeMillis()) ||
          !NativeP2pPolicy.coordinates(lat, lng)) return;
      inboundSequence = sequence; lastInboundAt = SystemClock.elapsedRealtime();
      JSONObject fix = new JSONObject().put("lat", lat).put("lng", lng).put("observedAt", observed)
        .put("sequence", Math.max(1, message.optInt("fixSequence", sequence)))
        .put("trackingSessionId", message.optString("sampleSessionId", trackingSessionId))
        .put("source", "native_p2p").put("role", oppositeRole);
      nullable(fix, "accuracyM", message.opt("accuracyM")); nullable(fix, "headingDeg", message.opt("headingDeg"));
      nullable(fix, "speedMps", message.opt("speedMps")); lastPeerFix = copy(fix);
      send(new JSONObject().put("v", 1).put("type", "ack").put("ackKind", "loc")
        .put("peerSessionId", peerSessionId).put("trackingSessionId", trackingSessionId)
        .put("assignmentVersion", binding.getInt("assignmentVersion")).put("seq", sequence)
        .put("observedAt", System.currentTimeMillis()).put("role", role));
      if (listener != null) listener.onPeerLocation(copy(fix));
    } catch (Exception ignored) {}
  }

  private void sendHeartbeat() {
    try {
      if (send(new JSONObject().put("v", 1).put("type", "hb")
          .put("peerSessionId", peerSessionId).put("trackingSessionId", trackingSessionId)
          .put("assignmentVersion", binding.getInt("assignmentVersion"))
          .put("seq", outboundSequence).put("observedAt", System.currentTimeMillis()).put("role", role))) {
        lastOutboundAt = SystemClock.elapsedRealtime();
      }
    } catch (Exception ignored) {}
  }

  private boolean send(JSONObject value) {
    if (channel == null || channel.state() != DataChannel.State.OPEN) return false;
    byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
    return bytes.length <= MAX_MESSAGE && channel.send(new DataChannel.Buffer(ByteBuffer.wrap(bytes), false));
  }

  private JSONObject post(JSONObject payload, long g) throws Exception {
    if (!current(g)) throw new CancellationException();
    payload.put("token", binding.getString("p2pToken"));
    HttpURLConnection conn = (HttpURLConnection) new URL(NativeP2pPolicy.SIGNAL_URL).openConnection();
    connection = conn;
    try {
      conn.setInstanceFollowRedirects(false); conn.setConnectTimeout(10_000); conn.setReadTimeout(10_000);
      conn.setRequestMethod("POST"); conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
      if (bytes.length > 40_000) throw new IOException("REQUEST_TOO_LARGE");
      conn.setFixedLengthStreamingMode(bytes.length);
      try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) throw new IOException("HTTP_" + code);
      try (InputStream input = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] chunk = new byte[2048]; int n;
        while ((n = input.read(chunk)) != -1) { if (out.size() + n > 64_000) throw new IOException("RESPONSE_TOO_LARGE"); out.write(chunk, 0, n); }
        return new JSONObject(out.toString("UTF-8"));
      }
    } finally { conn.disconnect(); if (connection == conn) connection = null; }
  }

  private void resetSession() {
    try { if (channel != null) { channel.unregisterObserver(); channel.close(); channel.dispose(); } } catch (RuntimeException ignored) {}
    try { if (peer != null) { peer.close(); peer.dispose(); } } catch (RuntimeException ignored) {}
    channel = null; peer = null; gathering = null; remoteApplied = false;
    peerSessionId = ""; trackingSessionId = ""; offerFingerprint = "";
    outboundSequence = 0; inboundSequence = 0; lastAckAt = 0; channelOpenedAt = 0; lastSignalAt = 0;
  }

  private void disconnect() { HttpURLConnection value = connection; if (value != null) value.disconnect(); }
  private boolean current(long g) { return active && !closed && g == generation && binding != null; }
  private void setState(String value, String reason) {
    state = value; lastReason = reason;
    if (listener != null) listener.onState(value);
  }
  private String newPeerSessionId() {
    byte[] bytes = new byte[16]; random.nextBytes(bytes); StringBuilder out = new StringBuilder("ps_native_");
    for (byte value : bytes) out.append(String.format(Locale.US, "%02x", value & 0xff)); return out.toString();
  }
  private static boolean sameAssignment(JSONObject a, JSONObject b) {
    if (a == null || b == null) return false;
    for (String key : new String[]{"rideId", "vehicleId", "assignmentSessionToken", "assignmentVersion"})
      if (!String.valueOf(a.opt(key)).equals(String.valueOf(b.opt(key)))) return false;
    return true;
  }
  private static JSONObject copy(JSONObject value) {
    try { return value == null ? null : new JSONObject(value.toString()); } catch (Exception e) { return null; }
  }
  private static void nullable(JSONObject target, String key, Object value) throws Exception {
    target.put(key, value == null || value == JSONObject.NULL ? JSONObject.NULL : value);
  }

  private final class PeerObserver implements PeerConnection.Observer {
    public void onSignalingChange(PeerConnection.SignalingState value) {}
    public void onIceConnectionChange(PeerConnection.IceConnectionState value) {
      worker.execute(() -> {
        if (value == PeerConnection.IceConnectionState.FAILED || value == PeerConnection.IceConnectionState.CLOSED) {
          reconnects++; resetSession();
          setState("RECONNECTING", "ice_" + value.name().toLowerCase(Locale.US));
        }
      });
    }
    public void onIceConnectionReceivingChange(boolean value) {}
    public void onIceGatheringChange(PeerConnection.IceGatheringState value) {
      if (value == PeerConnection.IceGatheringState.COMPLETE && gathering != null) gathering.countDown();
    }
    public void onIceCandidate(IceCandidate value) {}
    public void onIceCandidatesRemoved(IceCandidate[] values) {}
    public void onAddStream(MediaStream value) {}
    public void onRemoveStream(MediaStream value) {}
    public void onDataChannel(DataChannel value) { worker.execute(() -> wireChannel(value)); }
    public void onRenegotiationNeeded() {}
    public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
  }

  private static final class SdpResult implements SdpObserver {
    private final CountDownLatch latch = new CountDownLatch(1);
    private SessionDescription description; private String error;
    public void onCreateSuccess(SessionDescription value) { description = value; latch.countDown(); }
    public void onSetSuccess() { latch.countDown(); }
    public void onCreateFailure(String value) { error = value; latch.countDown(); }
    public void onSetFailure(String value) { error = value; latch.countDown(); }
    SessionDescription awaitDescription() throws Exception {
      awaitSet(); if (description == null) throw new IOException("SDP_MISSING"); return description;
    }
    void awaitSet() throws Exception {
      if (!latch.await(10, TimeUnit.SECONDS)) throw new TimeoutException("SDP_TIMEOUT");
      if (error != null) throw new IOException("SDP_FAILED");
    }
  }
}
