package uz.dtwin.teletwin;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native side of res/raw/teletwin_bridge.js: web notifications and file downloads,
 * which Android WebView does not provide on its own. Only https://dtwin.uz can reach it.
 */
final class TeleTwinBridge {

    static final String ORIGIN = "https://dtwin.uz";
    static final String EXTRA_NOTIFICATION_SESSION = "uz.dtwin.teletwin.NOTIFICATION_SESSION";
    static final String EXTRA_NOTIFICATION_ID = "uz.dtwin.teletwin.NOTIFICATION_ID";

    private static final String TAG = "TeleTwinBridge";
    private static final String CHANNEL_ID = "messages";
    private static final String PREFS = "teletwin";
    private static final String PREF_NOTIFICATIONS_ASKED = "notificationsAsked";
    private static final String DOWNLOAD_FOLDER = "TeleTwin";

    private final AppCompatActivity activity;
    private final ActivityResultLauncher<String> permissionLauncher;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    // Touched only on the io thread.
    private final Map<Integer, Download> downloads = new HashMap<>();
    private JavaScriptReplyProxy replyProxy;

    private static final class Download {
        String name;
        Uri uri;
        File file;
        OutputStream out;
    }

    /** Must be created in onCreate: it registers an activity result launcher. */
    TeleTwinBridge(AppCompatActivity activity) {
        this.activity = activity;
        this.permissionLauncher = activity.registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            granted -> {
                prefs().edit().putBoolean(PREF_NOTIFICATIONS_ASKED, true).apply();
                sendPermission();
            }
        );
        createNotificationChannel();
    }

    /** Call before the first page load so the document-start script reaches it. */
    boolean install(WebView webView) {
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            Log.w(TAG, "WebView is too old for the TeleTwin bridge; notifications and downloads are off");
            return false;
        }
        Set<String> origins = Collections.singleton(ORIGIN);
        WebViewCompat.addWebMessageListener(webView, "TeleTwinNative", origins, this::onMessage);
        WebViewCompat.addDocumentStartJavaScript(webView, readScript(), origins);
        return true;
    }

    /** A tap on one of our notifications opened the activity. */
    void handleNotificationIntent(Intent intent) {
        if (intent == null || !intent.hasExtra(EXTRA_NOTIFICATION_ID)) return;
        JSONObject message = new JSONObject();
        try {
            message.put("type", "notification-click");
            message.put("session", intent.getStringExtra(EXTRA_NOTIFICATION_SESSION));
            message.put("id", intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0));
        } catch (JSONException ignored) {
            return;
        }
        intent.removeExtra(EXTRA_NOTIFICATION_ID);
        post(message);
    }

    private void onMessage(WebView view, WebMessageCompat webMessage, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy proxy) {
        if (!isMainFrame || webMessage.getData() == null) return;
        JSONObject message;
        try {
            message = new JSONObject(webMessage.getData());
        } catch (JSONException e) {
            return;
        }
        replyProxy = proxy;
        String type = message.optString("type");
        switch (type) {
            case "init":
                sendPermission();
                break;
            case "notification-request-permission":
                requestNotificationPermission();
                break;
            case "notification-show":
                showNotification(message);
                break;
            case "notification-close":
                NotificationManagerCompat.from(activity).cancel(notificationId(message.optString("session"), message.optInt("id")));
                break;
            case "download-start":
            case "download-chunk":
            case "download-end":
            case "download-error":
                io.execute(() -> onDownloadMessage(type, message));
                break;
            default:
                break;
        }
    }

    // region Notifications

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            activity.getString(R.string.notification_channel_messages),
            NotificationManager.IMPORTANCE_HIGH
        );
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private SharedPreferences prefs() {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String permissionState() {
        if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) return "granted";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !prefs().getBoolean(PREF_NOTIFICATIONS_ASKED, false)) {
            return "default";
        }
        return "denied";
    }

    private void requestNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs().getBoolean(PREF_NOTIFICATIONS_ASKED, false)
        ) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        sendPermission();
    }

    private void sendPermission() {
        JSONObject message = new JSONObject();
        try {
            message.put("type", "permission");
            message.put("value", permissionState());
        } catch (JSONException ignored) {
            return;
        }
        post(message);
    }

    private static int notificationId(String session, int id) {
        return 31 * (session == null ? 0 : session.hashCode()) + id;
    }

    private void showNotification(JSONObject message) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(activity);
        if (!manager.areNotificationsEnabled()) return;

        String session = message.optString("session");
        int id = message.optInt("id");
        int notificationId = notificationId(session, id);

        Intent intent = new Intent(activity, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_NOTIFICATION_SESSION, session)
            .putExtra(EXTRA_NOTIFICATION_ID, id);
        PendingIntent contentIntent = PendingIntent.getActivity(
            activity,
            notificationId,
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        String body = message.optString("body");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_teletwin)
            .setColor(ContextCompat.getColor(activity, R.color.ic_launcher_background))
            .setContentTitle(message.optString("title"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setSilent(message.optBoolean("silent"))
            .setContentIntent(contentIntent);

        try {
            manager.notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission was revoked", e);
        }
    }

    // endregion

    // region Downloads

    private void onDownloadMessage(String type, JSONObject message) {
        int id = message.optInt("id");
        try {
            switch (type) {
                case "download-start":
                    startDownload(id, message.optString("name"), message.optString("mime"));
                    break;
                case "download-chunk": {
                    Download download = downloads.get(id);
                    if (download != null) download.out.write(Base64.decode(message.optString("data"), Base64.NO_WRAP));
                    break;
                }
                case "download-end":
                    finishDownload(id);
                    break;
                default:
                    failDownload(id, message.optString("name"));
                    break;
            }
        } catch (IOException | IllegalArgumentException e) {
            Log.w(TAG, "Download failed", e);
            Download download = downloads.get(id);
            failDownload(id, download != null ? download.name : message.optString("name"));
        }
    }

    private static String safeFileName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (clean.isEmpty() || clean.equals(".") || clean.equals("..")) clean = "file";
        return clean.length() > 120 ? clean.substring(clean.length() - 120) : clean;
    }

    private void startDownload(int id, String rawName, String mime) throws IOException {
        Download download = new Download();
        download.name = safeFileName(rawName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, download.name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            ContentResolver resolver = activity.getContentResolver();
            download.uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (download.uri == null) throw new IOException("MediaStore insert failed");
            download.out = resolver.openOutputStream(download.uri);
            if (download.out == null) throw new IOException("MediaStore stream failed");
        } else {
            // Android 7-9: the app's own Downloads folder needs no storage permission.
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) throw new IOException("No external storage");
            download.file = new File(dir, download.name);
            download.out = new FileOutputStream(download.file);
        }
        downloads.put(id, download);
    }

    private void finishDownload(int id) throws IOException {
        Download download = downloads.remove(id);
        if (download == null) return;
        download.out.close();
        String location;
        if (download.uri != null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(download.uri, values, null, null);
            location = Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_FOLDER + "/" + download.name;
        } else {
            location = download.file.getAbsolutePath();
        }
        toast(activity.getString(R.string.download_saved, location));
    }

    private void failDownload(int id, String name) {
        Download download = downloads.remove(id);
        if (download != null) {
            try {
                download.out.close();
            } catch (IOException ignored) {
                // Already broken.
            }
            if (download.uri != null) activity.getContentResolver().delete(download.uri, null, null);
            if (download.file != null && !download.file.delete()) Log.w(TAG, "Could not delete partial file");
        }
        toast(activity.getString(R.string.download_failed, safeFileName(name)));
    }

    // endregion

    private void post(JSONObject message) {
        activity.runOnUiThread(() -> {
            if (replyProxy == null) return;
            try {
                replyProxy.postMessage(message.toString());
            } catch (IllegalStateException e) {
                // The page that owned this channel is gone.
                replyProxy = null;
            }
        });
    }

    private void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }

    private String readScript() {
        try (InputStream in = activity.getResources().openRawResource(R.raw.teletwin_bridge)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("Missing teletwin_bridge.js", e);
        }
    }
}
