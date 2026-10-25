package org.yours.wallet;

import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.util.Map;

/**
 * Old Android System WebViews (bridge audit 25 Oct 2026, B9). Capacitor checks isMainFrame only when the WebView
 * supports WEB_MESSAGE_LISTENER; otherwise it falls back to addJavascriptInterface, which every frame in the wallet
 * WebView can call, so a bApp iframe could reach YoursNative (secure storage, keys). On such a WebView this client
 * refuses to load any frame document into the wallet WebView (bApp frames show an empty page). Newer WebViews are
 * untouched. The in-app dApp browser is a separate WebView with its own main-frame check.
 */
public class FrameGuardClient extends BridgeWebViewClient {
    private static final String TAG = "FrameGuard";

    public FrameGuardClient(Bridge bridge) {
        super(bridge);
    }

    /** True when Capacitor's bridge is reachable from every frame on this device. */
    public static boolean framesUnsafe(Bridge bridge) {
        return !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || bridge.getConfig().isUsingLegacyBridge();
    }

    /** A sub-frame's document load (iframe navigation), as far as the request tells: not main frame, GET, asks for HTML. */
    static boolean isFrameDocument(WebResourceRequest request) {
        if (request.isForMainFrame() || !"GET".equalsIgnoreCase(request.getMethod())) return false;
        Map<String, String> h = request.getRequestHeaders();
        String accept = h == null ? null : h.get("Accept");
        return accept != null && accept.contains("text/html");
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (isFrameDocument(request)) {
            Log.w(TAG, "Frame refused on this WebView (update Android System WebView): " + request.getUrl().getHost());
            return new WebResourceResponse(
                "text/html",
                "utf-8",
                403,
                "Forbidden",
                null,
                new ByteArrayInputStream(
                    "<p style=\"font:14px sans-serif;color:#999\">Update Android System WebView to open this here.</p>"
                        .getBytes()
                )
            );
        }
        return super.shouldInterceptRequest(view, request);
    }
}
