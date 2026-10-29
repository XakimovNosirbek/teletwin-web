package uz.dtwin.teletwin;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    static final String APP_URL = "https://dtwin.uz/teletwin/web/";
    private static final String DEEP_LINK_SCHEME = "teletwin";

    private TeleTwinBridge teleTwinBridge;
    private boolean clearHistoryOnLoad;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        teleTwinBridge = new TeleTwinBridge(this);
        bridgeBuilder.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    // A deep link reloads the app; without this, Back would return to the previous copy of it.
                    if (clearHistoryOnLoad) {
                        clearHistoryOnLoad = false;
                        webView.clearHistory();
                    }
                }
            }
        );
        super.onCreate(savedInstanceState);

        // Back closes the open chat or modal (the web app keeps them in history);
        // on the chat list it sends the app to the background instead of ending the session.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    WebView webView = bridge != null ? bridge.getWebView() : null;
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        moveTaskToBack(true);
                    }
                }
            }
        );
    }

    @Override
    protected void load() {
        // The bridge script has to be registered before the bridge loads the first page.
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        if (webView != null) teleTwinBridge.install(webView);
        super.load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (bridge == null || intent == null) return;
        teleTwinBridge.handleNotificationIntent(intent);
        String target = deepLinkTarget(intent.getData());
        if (target != null) {
            // Handle each link once, also across activity re-creation.
            intent.setData(null);
            clearHistoryOnLoad = true;
            bridge.getWebView().loadUrl(target);
        }
    }

    /**
     * teletwin://resolve?domain=x becomes APP_URL#?tgaddr=tg%3A%2F%2Fresolve%3Fdomain%3Dx,
     * the start-up parameter the web app already reads for tg:// links.
     */
    static String deepLinkTarget(Uri uri) {
        if (uri == null || !DEEP_LINK_SCHEME.equalsIgnoreCase(uri.getScheme())) return null;
        String rest = uri.getEncodedSchemeSpecificPart();
        if (rest == null) return APP_URL;
        while (rest.startsWith("/")) rest = rest.substring(1);
        if (rest.isEmpty()) return APP_URL;
        return APP_URL + "#?tgaddr=" + Uri.encode("tg://" + rest);
    }
}
