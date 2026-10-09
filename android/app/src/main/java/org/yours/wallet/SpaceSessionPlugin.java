package org.yours.wallet;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Rational;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;

/**
 * Native side of src/mobile/spaces/background.ts (Android only).
 *
 * start/update/stop  the SpaceSessionService foreground service + its notification.
 * setPip             whether leaving the app should float the Space's video (picture-in-picture),
 *                    and its shape. MainActivity enters PiP on onUserLeaveHint when this is on.
 * events             "action" {action: "mute"|"leave"} from notification/PiP buttons;
 *                    "pip" {active} when the window goes in or out of picture-in-picture.
 */
@CapacitorPlugin(name = "SpaceSession")
public class SpaceSessionPlugin extends Plugin {
    private static SpaceSessionPlugin instance;
    static volatile boolean pipWanted = false;
    static volatile int pipW = 16, pipH = 9;
    static volatile boolean pipOnStage = false, pipMicOn = false;

    @Override
    public void load() {
        instance = this;
    }

    static void dispatch(String action) {
        SpaceSessionPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("action", action);
        p.notifyListeners("action", o, true);
    }

    static void pipChanged(boolean active) {
        SpaceSessionPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("active", active);
        p.notifyListeners("pip", o, true);
    }

    private Intent serviceIntent(PluginCall call) {
        return new Intent(getContext(), SpaceSessionService.class)
                .setAction(SpaceSessionService.ACTION_UPDATE)
                .putExtra(SpaceSessionService.EXTRA_TITLE, call.getString("title", ""))
                .putExtra(SpaceSessionService.EXTRA_ON_STAGE, Boolean.TRUE.equals(call.getBoolean("onStage", false)))
                .putExtra(SpaceSessionService.EXTRA_MIC_ON, Boolean.TRUE.equals(call.getBoolean("micOn", false)));
    }

    /** Start or refresh the foreground service (same call: startForegroundService re-posts the notification). */
    @PluginMethod
    public void start(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), serviceIntent(call));
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't start the Space service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), SpaceSessionService.class));
        pipWanted = false;
        updatePipParams();
        call.resolve();
    }

    @PluginMethod
    public void setPip(PluginCall call) {
        pipWanted = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        boolean portrait = Boolean.TRUE.equals(call.getBoolean("portrait", false));
        pipW = portrait ? 9 : 16;
        pipH = portrait ? 16 : 9;
        pipOnStage = Boolean.TRUE.equals(call.getBoolean("onStage", false));
        pipMicOn = Boolean.TRUE.equals(call.getBoolean("micOn", false));
        updatePipParams();
        call.resolve();
    }

    @PluginMethod
    public void pipSupported(PluginCall call) {
        JSObject o = new JSObject();
        o.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && getActivity().getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE));
        call.resolve(o);
    }

    private void updatePipParams() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().setPictureInPictureParams(pipParams(getActivity()));
            } catch (Exception ignored) {
                // Not supported on this device: PiP just never starts.
            }
        });
    }

    /** PiP window shape and its Mute/Leave buttons. API 31+ also enters PiP by itself on Home. */
    static PictureInPictureParams pipParams(android.content.Context ctx) {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(pipW, pipH));
        ArrayList<RemoteAction> actions = new ArrayList<>();
        if (pipOnStage) actions.add(action(ctx, SpaceSessionService.ACTION_MUTE, 11,
                pipMicOn ? android.R.drawable.ic_lock_silent_mode : android.R.drawable.ic_btn_speak_now, pipMicOn ? "Mute" : "Unmute"));
        actions.add(action(ctx, SpaceSessionService.ACTION_LEAVE, 12, android.R.drawable.ic_menu_close_clear_cancel, "Leave"));
        b.setActions(actions);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(pipWanted).setSeamlessResizeEnabled(false);
        return b.build();
    }

    private static RemoteAction action(android.content.Context ctx, String what, int code, int icon, String label) {
        Intent i = new Intent(ctx, SpaceSessionService.class).setAction(what);
        PendingIntent pi = PendingIntent.getService(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new RemoteAction(Icon.createWithResource(ctx, icon), label, label, pi);
    }
}
