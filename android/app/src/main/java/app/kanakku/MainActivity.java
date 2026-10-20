package app.kanakku;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.hardware.fingerprint.FingerprintManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.Executor;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 41;
    private static final int DRIVE_AUTH = 42;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private static final String DRIVE_FOLDER = "Kanakku Backups";

    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;

    // pending Drive operation while waiting for Google consent
    private String driveOp;
    private String driveName;
    private byte[] driveData;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The app UI never navigates to the internet.
                return !"appassets.androidplatform.net".equals(request.getUrl().getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose file"), FILE_CHOOSER);
                } catch (Exception e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "KanakkuNative");
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER && pendingChooser != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            pendingChooser.onReceiveValue(result);
            pendingChooser = null;
        } else if (requestCode == DRIVE_AUTH) {
            if (resultCode != RESULT_OK) {
                driveResult(false, "Google sign-in was cancelled", null);
                return;
            }
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(data);
                runDrive(r.getAccessToken());
            } catch (Exception e) {
                driveResult(false, "Google sign-in failed: " + e.getMessage(), null);
            }
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.kanakkuBack && window.kanakkuBack()) ? 'y' : 'n'", value -> {
            if (value == null || !value.contains("y")) MainActivity.super.onBackPressed();
        });
    }

    private void js(String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    private File writeShareFile(String name, byte[] bytes) throws Exception {
        File dir = new File(getCacheDir(), "share");
        dir.mkdirs();
        File f = new File(dir, name);
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(bytes);
        }
        return f;
    }

    // ------------------------------------------------------------------ Fingerprint

    private boolean biometricReady() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                BiometricManager bm = getSystemService(BiometricManager.class);
                return bm != null && bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS;
            } else if (Build.VERSION.SDK_INT == 29) {
                BiometricManager bm = getSystemService(BiometricManager.class);
                return bm != null && bm.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
            } else if (Build.VERSION.SDK_INT == 28) {
                FingerprintManager fm = getSystemService(FingerprintManager.class);
                return fm != null && fm.isHardwareDetected() && fm.hasEnrolledFingerprints();
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private void showBiometric() {
        if (Build.VERSION.SDK_INT < 28) {
            js("window.kanakkuBioResult && kanakkuBioResult(false)");
            return;
        }
        Executor ex = getMainExecutor();
        BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                .setTitle("Unlock Kanakku")
                .setSubtitle("Use your fingerprint")
                .setNegativeButton("Use PIN", ex, (d, w) -> js("window.kanakkuBioResult && kanakkuBioResult(false)"))
                .build();
        prompt.authenticate(new CancellationSignal(), ex, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                js("window.kanakkuBioResult && kanakkuBioResult(true)");
            }

            @Override
            public void onAuthenticationError(int code, CharSequence msg) {
                js("window.kanakkuBioResult && kanakkuBioResult(false)");
            }
        });
    }

    // ------------------------------------------------------------------ Google Drive

    private void startDrive(String op, String name, byte[] data) {
        driveOp = op;
        driveName = name;
        driveData = data;
        AuthorizationRequest req = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_SCOPE)))
                .build();
        Identity.getAuthorizationClient(this).authorize(req)
                .addOnSuccessListener(res -> {
                    if (res.hasResolution()) {
                        try {
                            IntentSender sender = res.getPendingIntent().getIntentSender();
                            startIntentSenderForResult(sender, DRIVE_AUTH, null, 0, 0, 0);
                        } catch (Exception e) {
                            driveResult(false, "Could not open Google sign-in: " + e.getMessage(), null);
                        }
                    } else {
                        runDrive(res.getAccessToken());
                    }
                })
                .addOnFailureListener(e -> driveResult(false, "Google sign-in is not set up: " + e.getMessage(), null));
    }

    private void runDrive(String token) {
        final String op = driveOp, name = driveName;
        final byte[] data = driveData;
        driveData = null;
        new Thread(() -> {
            try {
                if (token == null) throw new Exception("No access token");
                if ("connect".equals(op)) {
                    JSONObject about = new JSONObject(http("GET", "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", token, null, null));
                    String email = about.optJSONObject("user") != null ? about.getJSONObject("user").optString("emailAddress") : "";
                    driveResult(true, "Connected", email);
                } else {
                    String folder = findOrCreateFolder(token);
                    String boundary = "kanakku" + System.currentTimeMillis();
                    JSONObject meta = new JSONObject();
                    meta.put("name", name);
                    meta.put("parents", new JSONArray().put(folder));
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    body.write(("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    body.write(data);
                    body.write(("\r\n--" + boundary + "--").getBytes(StandardCharsets.UTF_8));
                    http("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", token,
                            "multipart/related; boundary=" + boundary, body.toByteArray());
                    driveResult(true, "Uploaded " + name, null);
                }
            } catch (Exception e) {
                driveResult(false, e.getMessage(), null);
            }
        }).start();
    }

    private String findOrCreateFolder(String token) throws Exception {
        String q = "name='" + DRIVE_FOLDER + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
        JSONObject list = new JSONObject(http("GET", "https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + URLEncoder.encode(q, "UTF-8"), token, null, null));
        JSONArray files = list.optJSONArray("files");
        if (files != null && files.length() > 0) return files.getJSONObject(0).getString("id");
        JSONObject meta = new JSONObject();
        meta.put("name", DRIVE_FOLDER);
        meta.put("mimeType", "application/vnd.google-apps.folder");
        JSONObject created = new JSONObject(http("POST", "https://www.googleapis.com/drive/v3/files?fields=id", token, "application/json; charset=UTF-8", meta.toString().getBytes(StandardCharsets.UTF_8)));
        return created.getString("id");
    }

    private String http(String method, String url, String token, String contentType, byte[] body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", contentType);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body);
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
        }
        String text = out.toString("UTF-8");
        if (code >= 400) throw new Exception("Drive error " + code + ": " + text.replaceAll("\\s+", " ").substring(0, Math.min(200, text.length())));
        return text;
    }

    private void driveResult(boolean ok, String msg, String account) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            o.put("op", driveOp == null ? "" : driveOp);
            o.put("msg", msg == null ? "" : msg);
            if (account != null) o.put("account", account);
            js("window.kanakkuDriveResult && kanakkuDriveResult(" + o + ")");
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------------ JS bridge

    private class Bridge {
        /** Saves a file into Downloads/Kanakku. Returns a human readable location or "ERR:..." */
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Kanakku");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "ERR:could not create file";
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        os.write(bytes);
                    }
                    return "Downloads/Kanakku/" + name;
                } else {
                    File dir = new File(getExternalFilesDir(null), "Kanakku");
                    dir.mkdirs();
                    File f = new File(dir, name);
                    try (FileOutputStream os = new FileOutputStream(f)) {
                        os.write(bytes);
                    }
                    return f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "ERR:" + e.getMessage();
            }
        }

        /** Opens the Android share sheet with the file (e.g. to save it to Google Drive). */
        @JavascriptInterface
        public String shareFile(String name, String base64, String mime) {
            try {
                File f = writeShareFile(name, Base64.decode(base64, Base64.DEFAULT));
                Uri uri = FileProvider.getUriForFile(MainActivity.this, "app.kanakku.files", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT, name);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Save backup to…");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(chooser));
                return "ok";
            } catch (Exception e) {
                return "ERR:" + e.getMessage();
            }
        }

        @JavascriptInterface
        public void shareText(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, "Send statement")));
        }

        @JavascriptInterface
        public boolean bioAvailable() {
            return biometricReady();
        }

        @JavascriptInterface
        public void bioAuth() {
            runOnUiThread(MainActivity.this::showBiometric);
        }

        @JavascriptInterface
        public void driveConnect() {
            runOnUiThread(() -> startDrive("connect", null, null));
        }

        @JavascriptInterface
        public void driveUpload(String name, String base64) {
            final byte[] data = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> startDrive("upload", name, data));
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) {
                return "";
            }
        }
    }
}
