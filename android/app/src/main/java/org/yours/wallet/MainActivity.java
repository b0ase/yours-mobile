package org.yours.wallet;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YoursNativePlugin.class);
        registerPlugin(SpaceSessionPlugin.class);
        super.onCreate(savedInstanceState);
        // Keep seed phrases and balances out of screenshots, screen recordings
        // and the recent-apps thumbnail. Debug builds skip it so QA can capture.
        if (!BuildConfig.DEBUG) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    /**
     * Leaving the app (Home, app switch) with a Space that has live video open: float it as
     * picture-in-picture. API 31+ does this itself via setAutoEnterEnabled (SpaceSessionPlugin).
     */
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                && SpaceSessionPlugin.pipWanted && !isInPictureInPictureMode()) {
            try {
                enterPictureInPictureMode(SpaceSessionPlugin.pipParams(this));
            } catch (Exception ignored) {
                // PiP turned off for this app in system settings.
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        SpaceSessionPlugin.pipChanged(inPip);
    }
}
