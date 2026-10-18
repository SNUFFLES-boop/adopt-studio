package com.deltro.avatarswitcher;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Checks this project's GitHub releases for a newer Avatar Switcher app and installs it
 * with Android's package installer (Android asks the user to confirm).
 */
final class Updater {
    private static final String RELEASES = "https://api.github.com/repos/SNUFFLES-boop/adopt-studio/releases?per_page=20";
    private static final String TAG_PREFIX = "avatar-switcher-v";
    private static final String APK_NAME = "AvatarSwitcher.apk";
    private static final String ACTION_INSTALLED = "com.deltro.avatarswitcher.INSTALL_STATUS";
    private static final long AUTO_CHECK_EVERY_MS = 12L * 60 * 60 * 1000;

    private final Activity activity;
    private final SharedPreferences prefs;
    private String pendingUrl, pendingDigest, pendingVersion;
    private boolean waitingForPermission;

    Updater(Activity activity, SharedPreferences prefs) {
        this.activity = activity;
        this.prefs = prefs;
    }

    String installedVersion() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** Called on start; checks at most every 12 hours and stays quiet unless there's an update. */
    void autoCheck() {
        long last = prefs.getLong("lastUpdateCheck", 0);
        if (System.currentTimeMillis() - last < AUTO_CHECK_EVERY_MS) return;
        check(false);
    }

    void check(boolean manual) {
        if (manual) toast("Checking for updates…");
        new Thread(() -> {
            try {
                JSONObject best = null;
                String bestVersion = null;
                JSONArray rels = new JSONArray(new String(get(RELEASES, 4 << 20), "UTF-8"));
                for (int i = 0; i < rels.length(); i++) {
                    JSONObject r = rels.getJSONObject(i);
                    String tag = r.optString("tag_name");
                    if (r.optBoolean("draft") || r.optBoolean("prerelease") || !tag.startsWith(TAG_PREFIX)) continue;
                    String v = tag.substring(TAG_PREFIX.length());
                    JSONArray assets = r.optJSONArray("assets");
                    if (assets == null) continue;
                    for (int j = 0; j < assets.length(); j++) {
                        JSONObject a = assets.getJSONObject(j);
                        if (APK_NAME.equals(a.optString("name")) && (bestVersion == null || compare(v, bestVersion) > 0)) {
                            best = a;
                            bestVersion = v;
                        }
                    }
                }
                prefs.edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply();
                String have = installedVersion();
                if (best == null || compare(bestVersion, have) <= 0) {
                    if (manual) toast("You have the newest version (" + have + ").");
                    return;
                }
                if (!manual && bestVersion.equals(prefs.getString("skippedVersion", ""))) return;
                final String url = best.optString("browser_download_url");
                final String digest = best.optString("digest", "").replace("sha256:", "");
                final String version = bestVersion;
                activity.runOnUiThread(() -> offer(version, have, url, digest));
            } catch (Exception e) {
                if (manual) toast("Couldn't check for updates. Check your internet connection.");
            }
        }).start();
    }

    private void offer(String version, String have, String url, String digest) {
        if (activity.isFinishing()) return;
        new AlertDialog.Builder(activity)
                .setTitle("Update available")
                .setMessage("Avatar Switcher " + version + " is ready (you have " + have + ").\n\nUpdate the PC app too, so they match: open Avatar Switcher on your PC and click Update now.")
                .setPositiveButton("Update", (d, w) -> startInstall(url, digest, version))
                .setNeutralButton("Skip this version", (d, w) -> prefs.edit().putString("skippedVersion", version).apply())
                .setNegativeButton("Later", null)
                .show();
    }

    private void startInstall(String url, String digest, String version) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingUrl = url;
            pendingDigest = digest;
            pendingVersion = version;
            new AlertDialog.Builder(activity)
                    .setTitle("Allow updates")
                    .setMessage("Android needs your OK for Avatar Switcher to install its own updates. On the next screen, turn on \"Allow from this source\", then come back.")
                    .setPositiveButton("Open settings", (d, w) -> {
                        waitingForPermission = true;
                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName())));
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
            return;
        }
        download(url, digest, version);
    }

    /** Call from onResume: continues an update once the user has allowed installs. */
    void onResume() {
        if (!waitingForPermission) return;
        waitingForPermission = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity.getPackageManager().canRequestPackageInstalls()) {
            download(pendingUrl, pendingDigest, pendingVersion);
        } else {
            toast("Updates weren't allowed. You can try again from Check for updates.");
        }
    }

    private void download(String url, String digest, String version) {
        AlertDialog progress = new AlertDialog.Builder(activity)
                .setTitle("Updating to " + version)
                .setMessage("Downloading…")
                .setCancelable(false)
                .show();
        new Thread(() -> {
            try {
                byte[] apk = get(url, 100 << 20);
                if (digest != null && !digest.isEmpty() && !digest.equalsIgnoreCase(sha256(apk))) {
                    throw new Exception("The download was damaged. Try again.");
                }
                activity.runOnUiThread(() -> progress.setMessage("Installing… Android will ask you to confirm."));
                install(apk);
                activity.runOnUiThread(progress::dismiss);
            } catch (Exception e) {
                activity.runOnUiThread(() -> {
                    progress.dismiss();
                    new AlertDialog.Builder(activity).setTitle("Update failed")
                            .setMessage(e.getMessage() != null ? e.getMessage() : "Couldn't download the update.")
                            .setPositiveButton("OK", null).show();
                });
            }
        }).start();
    }

    private void install(byte[] apk) throws Exception {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (OutputStream out = session.openWrite("update.apk", 0, apk.length)) {
                out.write(apk);
                session.fsync(out);
            }
            registerResultReceiver();
            Intent result = new Intent(ACTION_INSTALLED).setPackage(activity.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(activity, id, result, flags);
            session.commit(pi.getIntentSender());
        }
    }

    private boolean receiverRegistered;

    private void registerResultReceiver() {
        if (receiverRegistered) return;
        receiverRegistered = true;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(confirm);
                    }
                } else if (status != PackageInstaller.STATUS_SUCCESS) {
                    String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    boolean conflict = status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE;
                    new AlertDialog.Builder(activity).setTitle("Update not installed")
                            .setMessage(conflict
                                    ? "This update is signed differently from the app you have (older test builds were). Uninstall Avatar Switcher once, then install the new version from the Releases page. Future updates will work from inside the app."
                                    : "Android didn't install the update" + (msg != null ? ": " + msg : "."))
                            .setPositiveButton("OK", null).show();
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_INSTALLED);
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
    }

    private static byte[] get(String url, int max) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.setRequestProperty("Accept", "application/vnd.github+json");
        conn.setRequestProperty("User-Agent", "AvatarSwitcherApp");
        conn.setInstanceFollowRedirects(true);
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("GitHub answered " + code + ".");
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                int n;
                while ((n = in.read(chunk)) > 0) {
                    buf.write(chunk, 0, n);
                    if (buf.size() > max) throw new Exception("The download is too large.");
                }
                return buf.toByteArray();
            }
        } finally {
            conn.disconnect();
        }
    }

    private static String sha256(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** Returns >0 when a is newer than b ("1.2.10" > "1.2.9"). */
    static int compare(String a, String b) {
        String[] pa = a.split("\\."), pb = b.split("\\.");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int x = i < pa.length ? parse(pa[i]) : 0, y = i < pb.length ? parse(pb[i]) : 0;
            if (x != y) return x - y;
        }
        return 0;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9]", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void toast(String msg) {
        activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
    }
}
