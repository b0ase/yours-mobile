package org.yours.wallet;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native side of src/mobile/tabs/iconBadge.ts (Android): the launcher icon's number, where the launcher allows it.
 *
 * Android has no API to put a number on the icon. Launchers badge an app from its notifications: a dot on Pixel, a
 * count on Samsung and others, read from each notification's number (push.bwalletx.com sends it as FCM
 * notification_count). So, degrading silently:
 *   - count above 0: nothing can be set from here; resolves { applied: false }.
 *   - count 0 after some (clearDelivered: everything was read in the app): remove our chat notifications still in the
 *     shade (channel "chat", src/mobile/push/register.ts), which clears the launcher badge. Other channels (meeting
 *     invites, a live Space, local notices) are left alone.
 */
@CapacitorPlugin(name = "AppBadge")
public class AppBadgePlugin extends Plugin {
    static final String CHAT_CHANNEL = "chat";
    static final int MAX_COUNT = 9999;

    static int clamp(Integer n) {
        return n == null ? 0 : Math.max(0, Math.min(n, MAX_COUNT));
    }

    @PluginMethod
    public void set(PluginCall call) {
        int count = clamp(call.getInt("count", 0));
        boolean clearDelivered = Boolean.TRUE.equals(call.getBoolean("clearDelivered", false));
        int cleared = 0;
        if (count == 0 && clearDelivered && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    for (StatusBarNotification sbn : nm.getActiveNotifications()) {
                        if (CHAT_CHANNEL.equals(sbn.getNotification().getChannelId())) {
                            nm.cancel(sbn.getTag(), sbn.getId());
                            cleared++;
                        }
                    }
                }
            } catch (Exception ignored) {
                // No access to the shade on this device: the badge clears when the notifications are opened.
            }
        }
        JSObject ret = new JSObject();
        ret.put("applied", cleared > 0);
        ret.put("cleared", cleared);
        call.resolve(ret);
    }
}
