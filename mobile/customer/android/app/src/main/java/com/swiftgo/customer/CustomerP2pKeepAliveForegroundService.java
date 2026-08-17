package com.swiftgo.customer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the Capacitor process foreground-eligible during an active P2P ride.
 *
 * The WebRTC session itself remains in the existing WebView JavaScript. This
 * service neither subscribes to Firestore nor performs a Firebase fallback.
 */
public final class CustomerP2pKeepAliveForegroundService extends Service {
  static final String ACTION_START = "com.swiftgo.customer.action.START_P2P_KEEPALIVE";
  static final String ACTION_STOP = "com.swiftgo.customer.action.STOP_P2P_KEEPALIVE";
  static final String EXTRA_RIDE_ID = "rideId";
  static final String EXTRA_RIDE_STATUS = "rideStatus";

  private static final String CHANNEL_ID = "swiftgo_customer_p2p";
  private static final int NOTIFICATION_ID = 47202;

  private PowerManager.WakeLock wakeLock;

  @Override
  public void onCreate() {
    super.onCreate();
    ensureChannel();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      stopSafely();
      return START_NOT_STICKY;
    }

    startForeground(NOTIFICATION_ID, buildNotification());
    acquireWakeLock();
    return START_STICKY;
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    // Continue while a trackable ride remains active; JS P2P owns its session.
    super.onTaskRemoved(rootIntent);
  }

  private Notification buildNotification() {
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentIntent = PendingIntent.getActivity(
        this,
        0,
        launch != null ? launch : new Intent(this, MainActivity.class),
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );

    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.p2p_keepalive_title))
        .setContentText(getString(R.string.p2p_keepalive_text))
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(contentIntent)
        .build();
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        getString(R.string.p2p_keepalive_channel),
        NotificationManager.IMPORTANCE_LOW
    );
    channel.setDescription(getString(R.string.p2p_keepalive_channel_desc));
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.createNotificationChannel(channel);
  }

  private void acquireWakeLock() {
    try {
      PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
      if (power == null || (wakeLock != null && wakeLock.isHeld())) return;
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SwiftGo:CustomerP2P");
      wakeLock.setReferenceCounted(false);
      // Bounded guard; active JS refreshes/restarts as needed, avoiding an indefinite lock.
      wakeLock.acquire(10 * 60_000L);
    } catch (Exception ignored) {
      // Foreground-service priority remains useful if OEM rejects wake locks.
    }
  }

  private void stopSafely() {
    if (wakeLock != null && wakeLock.isHeld()) {
      try {
        wakeLock.release();
      } catch (Exception ignored) {
      }
    }
    stopForeground(true);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    if (wakeLock != null && wakeLock.isHeld()) {
      try {
        wakeLock.release();
      } catch (Exception ignored) {
      }
    }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
