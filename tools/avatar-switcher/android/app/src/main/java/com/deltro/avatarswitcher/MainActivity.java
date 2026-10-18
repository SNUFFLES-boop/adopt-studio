package com.deltro.avatarswitcher;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;

/**
 * Shows Avatar Switcher running on your PC. The first screen (assets/connect.html)
 * asks for the PC's address; after that the app opens straight to it.
 */
public class MainActivity extends Activity {
    private static final String CONNECT_PAGE = "file:///android_asset/connect.html";
    private static final int PICK_FILE = 1;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private Updater updater;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("switcher", MODE_PRIVATE);
        updater = new Updater(this, prefs);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " AvatarSwitcherApp/1.1");
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "AvatarSwitcherApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("avatarswitcher".equals(uri.getScheme())) {
                    showConnect(null);
                    return true;
                }
                String saved = savedUrl();
                // Stay inside the app for the PC's pages; open anything else in the browser.
                if (saved != null && uri.toString().startsWith(saved)) return false;
                if ("file".equals(uri.getScheme())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !request.getUrl().toString().startsWith("file:")) {
                    showConnect("Couldn't reach Avatar Switcher at " + request.getUrl().getHost()
                            + ". Check it's running on your PC with phone access on, and that your phone is on the same Wi-Fi.");
                }
            }

        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        String saved = savedUrl();
        if (saved != null) web.loadUrl(saved);
        else showConnect(null);
        updater.autoCheck();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updater.onResume();
    }

    private String savedUrl() {
        return prefs.getString("url", null);
    }

    private void showConnect(String error) {
        String url = CONNECT_PAGE;
        if (error != null) url += "?error=" + Uri.encode(error);
        String saved = savedUrl();
        if (saved != null) url += (error != null ? "&" : "?") + "last=" + Uri.encode(saved);
        web.loadUrl(url);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /** Called from connect.html. */
    private class Bridge {
        @JavascriptInterface
        public void checkForUpdates() {
            updater.check(true);
        }

        @JavascriptInterface
        public String version() {
            return updater.installedVersion();
        }

        /** Checks the PC answers before opening it, and reports back to connect.html either way. */
        @JavascriptInterface
        public void connect(String url) {
            Uri u = Uri.parse(url);
            if (!"http".equals(u.getScheme()) || u.getHost() == null) {
                report("That doesn't look like an address. It looks like 192.168.1.20.");
                return;
            }
            String clean = "http://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + "/";
            new Thread(() -> {
                String problem = probe(clean);
                if (problem != null) {
                    report(problem);
                    return;
                }
                prefs.edit().putString("url", clean).apply();
                runOnUiThread(() -> web.loadUrl(clean));
            }).start();
        }

        private String probe(String url) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                int code = conn.getResponseCode();
                if (code == 403) {
                    return "Your PC answered but refused the connection. In Avatar Switcher on the PC, turn phone access off and on again, then try the address it shows.";
                }
                return null; // the switcher page or its PIN page
            } catch (SocketTimeoutException e) {
                return "No answer from " + Uri.parse(url).getHost() + ". Check your phone is on the same Wi-Fi as the PC (not mobile data), and that Avatar Switcher is open with phone access on. Windows Firewall may also be blocking it: allow Avatar Switcher on Private networks.";
            } catch (Exception e) {
                return "Couldn't reach " + Uri.parse(url).getHost() + ". Check your phone is on the same Wi-Fi as the PC (not mobile data), and that Avatar Switcher is open with phone access on.";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        private void report(String message) {
            String js = "window.showConnectError && showConnectError(" + JSONObject.quote(message) + ")";
            runOnUiThread(() -> web.evaluateJavascript(js, null));
        }
    }
}
