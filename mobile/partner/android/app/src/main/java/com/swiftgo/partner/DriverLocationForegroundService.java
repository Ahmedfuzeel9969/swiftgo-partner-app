package com.swiftgo.partner;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

/**
 * Foreground location service for active rides.
 * Keeps GPS alive across background / screen-lock / task-removed.
 * When WebView is alive, fixes are delivered to JS (P2P-first).
 * When WebView is dead, fixes upload via authenticated HTTPS ingest.
 */
public class DriverLocationForegroundService extends Service {
  public static final String ACTION_START = "com.swiftgo.partner.action.START_LOCATION";
  public static final String ACTION_STOP = "com.swiftgo.partner.action.STOP_LOCATION";
  public static final String ACTION_UPDATE_CREDENTIAL =
      "com.swiftgo.partner.action.UPDATE_CREDENTIAL";
  public static final String ACTION_WEB_ALIVE = "com.swiftgo.partner.action.WEB_ALIVE";
  public static final String ACTION_UPDATE_SESSION =
      "com.swiftgo.partner.action.UPDATE_SESSION";

  public static final String EXTRA_RIDE_ID = "rideId";
  public static final String EXTRA_VEHICLE_ID = "vehicleId";
  public static final String EXTRA_DRIVER_UID = "driverUid";
  public static final String EXTRA_TRACKING_SESSION_ID = "trackingSessionId";
  public static final String EXTRA_ASSIGNMENT_TOKEN = "assignmentSessionToken";
  public static final String EXTRA_UPLOAD_URL = "uploadUrl";
  public static final String EXTRA_REFRESH_URL = "refreshUrl";
  public static final String EXTRA_TOKEN = "token";
  public static final String EXTRA_TOKEN_EXPIRES_AT = "tokenExpiresAtMs";
  public static final String EXTRA_RIDE_STATUS = "rideStatus";
  public static final String EXTRA_INTERVAL_MS = "intervalMs";
  public static final String EXTRA_LAST_SEQUENCE = "lastSequence";

  private static final String CHANNEL_ID = "swiftgo_driver_location";
  private static final int NOTIFICATION_ID = 47201;
  private static final long WEB_ALIVE_TIMEOUT_MS = 15_000L;
  private static final String BINDING_PREFS = "swiftgo_driver_location_binding";
  private static final String KEY_BINDING_ACTIVE = "active";
  private static final String KEY_BINDING_RIDE_ID = "rideId";
  private static final String KEY_BINDING_RIDE_STATUS = "rideStatus";
  private static final String KEY_BINDING_INTERVAL_MS = "intervalMs";

  private static volatile DriverLocationForegroundService instance;
  private static volatile boolean running;

  private FusedLocationProviderClient fusedClient;
  private LocationCallback locationCallback;
  private BackgroundLocationUploader uploader;
  private String rideId = "";
  private String rideStatus = "";
  private long intervalMs = 4_000L;
  private long lastWebAliveAtMs = 0L;
  private long lastFixAtMs = 0L;
  private int fixCount = 0;

  public static boolean isRunning() {
    return running;
  }

  @Nullable
  public static DriverLocationForegroundService getInstance() {
    return instance;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    running = true;
    fusedClient = LocationServices.getFusedLocationProviderClient(this);
    uploader = new BackgroundLocationUploader(this);
    uploader.setPermanentBindingInvalidListener(
        reason -> stopSelfSafe("binding_invalid:" + reason));
    ensureChannel();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null) {
      if (restoreStickyBinding()) {
        startAsForeground();
        startLocationUpdates();
        lastWebAliveAtMs = 0L;
        notifyPluginState("restored_sticky");
        return START_STICKY;
      }
      stopSelfSafe("sticky_no_binding");
      return START_NOT_STICKY;
    }
    String action = intent.getAction() != null ? intent.getAction() : ACTION_START;
    if (ACTION_STOP.equals(action)) {
      stopSelfSafe("stop_action");
      return START_NOT_STICKY;
    }
    if (ACTION_UPDATE_CREDENTIAL.equals(action)) {
      String token = intent.getStringExtra(EXTRA_TOKEN);
      long exp = intent.getLongExtra(EXTRA_TOKEN_EXPIRES_AT, 0L);
      String refreshUrl = intent.getStringExtra(EXTRA_REFRESH_URL);
      if (uploader != null) {
        uploader.updateCredential(token, exp);
        if (refreshUrl != null && !refreshUrl.trim().isEmpty()) {
          uploader.updateRefreshUrl(refreshUrl);
        }
      }
      notifyPluginState("credential_updated");
      return START_STICKY;
    }
    if (ACTION_WEB_ALIVE.equals(action)) {
      lastWebAliveAtMs = System.currentTimeMillis();
      int seq = intent.getIntExtra(EXTRA_LAST_SEQUENCE, -1);
      if (seq >= 0 && uploader != null) uploader.updateLastSequence(seq);
      return START_STICKY;
    }
    if (ACTION_UPDATE_SESSION.equals(action)) {
      applyStartExtras(intent);
      persistActiveBinding();
      return START_STICKY;
    }

    applyStartExtras(intent);
    persistActiveBinding();
    startAsForeground();
    startLocationUpdates();
    lastWebAliveAtMs = System.currentTimeMillis();
    notifyPluginState("started");
    return START_STICKY;
  }

  private void persistActiveBinding() {
    if (rideId.isEmpty() || rideStatus.isEmpty()) return;
    getBindingPrefs()
        .edit()
        .putBoolean(KEY_BINDING_ACTIVE, true)
        .putString(KEY_BINDING_RIDE_ID, rideId)
        .putString(KEY_BINDING_RIDE_STATUS, rideStatus)
        .putLong(KEY_BINDING_INTERVAL_MS, intervalMs)
        .apply();
  }

  private boolean restoreStickyBinding() {
    SharedPreferences prefs = getBindingPrefs();
    if (!prefs.getBoolean(KEY_BINDING_ACTIVE, false)) return false;
    rideId = safe(prefs.getString(KEY_BINDING_RIDE_ID, ""));
    rideStatus = safe(prefs.getString(KEY_BINDING_RIDE_STATUS, ""));
    intervalMs = Math.max(2_000L, prefs.getLong(KEY_BINDING_INTERVAL_MS, 4_000L));
    if (rideId.isEmpty() || rideStatus.isEmpty()) return false;
    return uploader != null && uploader.hasPersistedUploadConfig();
  }

  private void clearPersistedBinding() {
    getBindingPrefs().edit().clear().apply();
  }

  private SharedPreferences getBindingPrefs() {
    return getSharedPreferences(BINDING_PREFS, MODE_PRIVATE);
  }

  private void applyStartExtras(Intent intent) {
    rideId = safe(intent.getStringExtra(EXTRA_RIDE_ID));
    rideStatus = safe(intent.getStringExtra(EXTRA_RIDE_STATUS));
    intervalMs = Math.max(2_000L, intent.getLongExtra(EXTRA_INTERVAL_MS, 4_000L));
    String uploadUrl = safe(intent.getStringExtra(EXTRA_UPLOAD_URL));
    String refreshUrl = safe(intent.getStringExtra(EXTRA_REFRESH_URL));
    String token = safe(intent.getStringExtra(EXTRA_TOKEN));
    long exp = intent.getLongExtra(EXTRA_TOKEN_EXPIRES_AT, 0L);
    int lastSeq = intent.getIntExtra(EXTRA_LAST_SEQUENCE, 0);
    if (uploader != null) {
      uploader.configure(uploadUrl, refreshUrl, token, exp, lastSeq);
    }
  }

  private void startAsForeground() {
    Notification notification = buildNotification();
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }
  }

  private Notification buildNotification() {
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentIntent =
        PendingIntent.getActivity(
            this,
            0,
            launch != null ? launch : new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.location_share_title))
        .setContentText(getString(R.string.location_share_text))
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentIntent)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .build();
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel =
        new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.location_share_channel),
            NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(getString(R.string.location_share_channel_desc));
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) nm.createNotificationChannel(channel);
  }

  private void startLocationUpdates() {
    if (locationCallback != null) return;
    LocationRequest request =
        new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(Math.max(1_000L, intervalMs / 2))
            .setMinUpdateDistanceMeters(0f)
            .setWaitForAccurateLocation(false)
            .build();

    locationCallback =
        new LocationCallback() {
          @Override
          public void onLocationResult(LocationResult locationResult) {
            if (locationResult == null) return;
            Location loc = locationResult.getLastLocation();
            if (loc == null) return;
            onGpsFix(loc);
          }
        };

    try {
      fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
    } catch (SecurityException e) {
      notifyPluginState("permission_denied");
      stopSelfSafe("permission_denied");
    }
  }

  private void onGpsFix(Location loc) {
    lastFixAtMs = System.currentTimeMillis();
    fixCount += 1;
    boolean webAlive = (lastFixAtMs - lastWebAliveAtMs) <= WEB_ALIVE_TIMEOUT_MS
        && DriverLocationPlugin.hasLocationListeners();

    int sequence;
    if (webAlive) {
      // JS owns sequence while WebView is alive; native still emits raw fix.
      sequence = 0;
    } else {
      sequence = uploader != null ? uploader.nextSequence() : 0;
    }

    JSONObject fix = new JSONObject();
    try {
      fix.put("lat", loc.getLatitude());
      fix.put("lng", loc.getLongitude());
      fix.put("accuracyM", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL);
      fix.put("headingDeg", loc.hasBearing() ? loc.getBearing() : JSONObject.NULL);
      fix.put("speedMps", loc.hasSpeed() ? loc.getSpeed() : JSONObject.NULL);
      fix.put("observedAt", loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis());
      fix.put("source", "native_gps");
      if (sequence > 0) fix.put("sequence", sequence);
      fix.put("rideId", rideId);
      fix.put("rideStatus", rideStatus);
      fix.put("webAlive", webAlive);
    } catch (Exception ignored) {
    }

    DriverLocationPlugin.emitLocationFix(fix);

    if (!webAlive && uploader != null && sequence > 0) {
      uploader.enqueueFix(fix, false);
    }
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    // Keep service alive after swipe-away from recents.
    lastWebAliveAtMs = 0L;
    if (uploader != null) uploader.requestFlush();
    super.onTaskRemoved(rootIntent);
  }

  private void stopSelfSafe(String reason) {
    clearPersistedBinding();
    if (uploader != null) {
      uploader.clearQueue();
      uploader.clearCredentialState();
    }
    try {
      if (fusedClient != null && locationCallback != null) {
        fusedClient.removeLocationUpdates(locationCallback);
      }
    } catch (Exception ignored) {
    }
    locationCallback = null;
    notifyPluginState("stopped:" + reason);
    running = false;
    stopForeground(true);
    stopSelf();
  }

  private void notifyPluginState(String state) {
    JSONObject o = new JSONObject();
    try {
      o.put("state", state);
      o.put("rideId", rideId);
      o.put("rideStatus", rideStatus);
      o.put("fixCount", fixCount);
      o.put("lastFixAtMs", lastFixAtMs);
      o.put("webAliveTimeoutMs", WEB_ALIVE_TIMEOUT_MS);
      if (uploader != null) o.put("upload", uploader.getDiagnostics());
    } catch (Exception ignored) {
    }
    DriverLocationPlugin.emitServiceState(o);
  }

  @Override
  public void onDestroy() {
    try {
      if (fusedClient != null && locationCallback != null) {
        fusedClient.removeLocationUpdates(locationCallback);
      }
    } catch (Exception ignored) {
    }
    if (uploader != null) {
      uploader.requestFlush();
      uploader.shutdown();
    }
    running = false;
    instance = null;
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private static String safe(String v) {
    return v == null ? "" : v.trim();
  }
}
