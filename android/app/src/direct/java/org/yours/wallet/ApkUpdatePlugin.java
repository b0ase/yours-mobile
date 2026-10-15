package org.yours.wallet;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;

/**
 * In-app update for the direct APK (src/mobile/update/). Direct flavour only: this class is not in the
 * Play build, and MainActivity registers it by name when BuildConfig.CHANNEL is android-direct.
 *
 * download  https://bwalletx.com/download/*.apk only, no redirects, into cache/updates/, SHA-256 checked
 *           against the expected value from latest.json; a mismatch deletes the file and rejects.
 * install   the verified file through the existing FileProvider (cache-path) to the package installer.
 *           Same applicationId and signing key, so Android updates in place and the wallet data stays.
 */
@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {
    private static final String HOST = "bwalletx.com";
    private static final long MAX_BYTES = 512L * 1024 * 1024;
    private volatile File verified;

    private File updatesDir() {
        File d = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static boolean trusted(URL u) {
        return "https".equals(u.getProtocol()) && HOST.equals(u.getHost()) && u.getPort() == -1
                && u.getUserInfo() == null && u.getPath().startsWith("/download/") && u.getPath().endsWith(".apk");
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url", "");
        final String expected = call.getString("sha256", "").trim().toLowerCase(Locale.ROOT);
        if (!expected.matches("[0-9a-f]{64}")) {
            call.reject("No valid SHA-256 to check the download against.");
            return;
        }
        new Thread(() -> {
            File out = new File(updatesDir(), "bwalletx-update.apk");
            verified = null;
            HttpsURLConnection c = null;
            try {
                URL u = new URL(url);
                if (!trusted(u)) throw new Exception("Updates only come from https://bwalletx.com.");
                c = (HttpsURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                if (c.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new Exception("Download failed (bwalletx.com answered " + c.getResponseCode() + ").");
                }
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long total = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_BYTES) throw new Exception("Download too large.");
                        md.update(buf, 0, n);
                        fo.write(buf, 0, n);
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
                String actual = hex.toString();
                if (!MessageDigest.isEqual(actual.getBytes(), expected.getBytes())) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    throw new Exception("The download didn't match its published fingerprint (SHA-256), so it was not installed.");
                }
                verified = out;
                JSObject r = new JSObject();
                r.put("sha256", actual);
                call.resolve(r);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed.");
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't open Install unknown apps. Find it in Settings › Apps › bWalletX.");
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        File f = verified;
        if (f == null || !f.exists()) {
            call.reject("No verified update downloaded.");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't open the Android installer.");
        }
    }

    @PluginMethod
    public void openSite(PluginCall call) {
        try {
            URL u = new URL(call.getString("url", ""));
            if (!"https".equals(u.getProtocol()) || !HOST.equals(u.getHost())) throw new Exception();
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u.toString())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't open bwalletx.com.");
        }
    }
}
