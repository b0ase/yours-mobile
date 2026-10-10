package org.yours.wallet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps a live Space playing while you use other apps (src/mobile/spaces/background.ts).
 *
 * Started when you join a Space, stopped when you leave or it ends. The ongoing notification reads
 * "Listening to <title>" (or "Speaking in <title>" on stage) with Mute/Unmute (on stage only) and
 * Leave; tapping it reopens the app. Type is mediaPlayback, plus microphone while on stage, so the
 * WebView's WebRTC mic keeps working in the background (Android 14 foreground-service types).
 * Button taps go to SpaceSessionPlugin, which tells the web layer.
 */
public class SpaceSessionService extends Service {
    static final String CHANNEL = "space_live";
    static final int NOTIFICATION_ID = 4401;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ON_STAGE = "onStage";
    static final String EXTRA_MIC_ON = "micOn";
    static final String ACTION_UPDATE = "org.yours.wallet.space.UPDATE";
    static final String ACTION_MUTE = "org.yours.wallet.space.MUTE";
    static final String ACTION_LEAVE = "org.yours.wallet.space.LEAVE";

    static volatile boolean running = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && (ACTION_MUTE.equals(intent.getAction()) || ACTION_LEAVE.equals(intent.getAction()))) {
            SpaceSessionPlugin.dispatch(ACTION_MUTE.equals(intent.getAction()) ? "mute" : "leave");
            return START_NOT_STICKY;
        }
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        boolean onStage = intent != null && intent.getBooleanExtra(EXTRA_ON_STAGE, false);
        boolean micOn = intent != null && intent.getBooleanExtra(EXTRA_MIC_ON, false);
        ensureChannel();
        Notification n = build(title == null || title.isEmpty() ? "a Space" : title, onStage, micOn);
        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (onStage && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
        } catch (Exception e) {
            // Android 14 refuses the microphone type without RECORD_AUDIO or from the background:
            // fall back to playback only so listening still survives.
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, n,
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);
            } catch (Exception e2) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away: the WebView (and the Space connection) is gone, so drop the notification.
        SpaceSessionPlugin.dispatch("leave");
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Live Spaces", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while you are in a live Space");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent self(String action, int code) {
        Intent i = new Intent(this, SpaceSessionService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification build(String title, boolean onStage, boolean micOn) {
        Intent open = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_bwallet)
                .setContentTitle((onStage ? "Speaking in " : "Listening to ") + title)
                .setContentText(onStage ? (micOn ? "Your mic is on" : "You're muted") : "Live Space")
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (onStage) b.addAction(0, micOn ? "Mute" : "Unmute", self(ACTION_MUTE, 1));
        b.addAction(0, "Leave", self(ACTION_LEAVE, 2));
        return b.build();
    }
}
