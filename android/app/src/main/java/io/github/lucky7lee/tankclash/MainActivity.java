package io.github.lucky7lee.tankclash;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.annotation.NonNull;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

public class MainActivity extends Activity {

    private static final String APP_START_URL = "https://appassets.androidplatform.net/assets/index.html";

    // =========================================================================
    // Google Official AdMob Test Ad Unit IDs
    // (Replace with your production AdMob Ad Unit IDs after AdMob approval)
    // =========================================================================
    private static final String ADMOB_BANNER_UNIT_ID = "ca-app-pub-3940256099942544/6300978111";
    private static final String ADMOB_INTERSTITIAL_UNIT_ID = "ca-app-pub-3940256099942544/1033173712";
    private static final String ADMOB_REWARDED_UNIT_ID = "ca-app-pub-3940256099942544/5224354917";

    private WebView webView;
    private FrameLayout bannerContainer;
    private AdView bannerAdView;
    private InterstitialAd interstitialAd;
    private RewardedAd rewardedAd;
    private boolean isLoadingInterstitial = false;
    private boolean isLoadingRewarded = false;
    private long lastBackPressTime = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        // Keep screen on during artillery battles and match dark navy theme
        Window window = getWindow();
        if (window != null) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            window.setStatusBarColor(Color.parseColor("#0B1220"));
            window.setNavigationBarColor(Color.parseColor("#0B1220"));
            window.getDecorView().setBackgroundColor(Color.parseColor("#0B1220"));
        }

        LinearLayout rootLayout = new LinearLayout(this);
        rootLayout.setOrientation(LinearLayout.VERTICAL);
        rootLayout.setBackgroundColor(Color.parseColor("#0B1220"));
        rootLayout.setFitsSystemWindows(true);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B1220"));
        webView.setHorizontalScrollBarEnabled(false);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Expose native bridge for AdMob Banner / Interstitial / Rewarded Ads & Android detection
        webView.addJavascriptInterface(new TankClashBridge(), "TankClashAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url != null && "appassets.androidplatform.net".equals(url.getHost())) {
                    String path = url.getPath();
                    if (path != null && path.startsWith("/assets/")) {
                        String assetPath = path.substring("/assets/".length());
                        if (assetPath.isEmpty() || assetPath.endsWith("/")) {
                            assetPath = "index.html";
                        }
                        try {
                            InputStream is = getAssets().open(assetPath);
                            String mime = getMimeType(assetPath);
                            return new WebResourceResponse(mime, "UTF-8", is);
                        } catch (IOException e) {
                            return new WebResourceResponse("text/plain", "UTF-8", null);
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url != null && "appassets.androidplatform.net".equals(url.getHost())) {
                    return false;
                }
                if (url != null) {
                    try {
                        Intent browserIntent = new Intent(Intent.ACTION_VIEW, url);
                        startActivity(browserIntent);
                    } catch (Exception ignored) {
                    }
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient());

        // 1. Add WebView taking all available height above the bottom banner
        LinearLayout.LayoutParams webParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
        );
        rootLayout.addView(webView, webParams);

        // 2. Add Bottom AdMob Banner Container (Shown on Menu / Setup / Lobby / Waiting Room)
        bannerContainer = new FrameLayout(this);
        bannerContainer.setBackgroundColor(Color.parseColor("#090F1C"));
        LinearLayout.LayoutParams bannerWrapParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rootLayout.addView(bannerContainer, bannerWrapParams);

        setContentView(rootLayout);

        // Initialize AdMob SDK and preload Banner, Interstitial, and Rewarded Ads
        initAdMobAds();

        webView.loadUrl(APP_START_URL);
    }

    private void initAdMobAds() {
        try {
            MobileAds.initialize(this, initializationStatus -> {
                runOnUiThread(() -> {
                    setupBannerAd();
                    preloadInterstitialAd();
                    preloadRewardedAd();
                });
            });
        } catch (Exception ignored) {
        }
    }

    private void setupBannerAd() {
        if (bannerContainer == null) return;
        try {
            bannerAdView = new AdView(this);
            bannerAdView.setAdUnitId(ADMOB_BANNER_UNIT_ID);
            bannerAdView.setAdSize(AdSize.BANNER);

            FrameLayout.LayoutParams adParams = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER_HORIZONTAL
            );
            bannerContainer.removeAllViews();
            bannerContainer.addView(bannerAdView, adParams);

            AdRequest adRequest = new AdRequest.Builder().build();
            bannerAdView.loadAd(adRequest);
        } catch (Exception ignored) {
        }
    }

    private void preloadInterstitialAd() {
        if (isLoadingInterstitial || interstitialAd != null) return;
        isLoadingInterstitial = true;
        AdRequest adRequest = new AdRequest.Builder().build();
        InterstitialAd.load(
                this,
                ADMOB_INTERSTITIAL_UNIT_ID,
                adRequest,
                new InterstitialAdLoadCallback() {
                    @Override
                    public void onAdLoaded(@NonNull InterstitialAd ad) {
                        interstitialAd = ad;
                        isLoadingInterstitial = false;
                    }

                    @Override
                    public void onAdFailedToLoad(@NonNull LoadAdError loadAdError) {
                        interstitialAd = null;
                        isLoadingInterstitial = false;
                    }
                }
        );
    }

    private void preloadRewardedAd() {
        if (isLoadingRewarded || rewardedAd != null) return;
        isLoadingRewarded = true;
        AdRequest adRequest = new AdRequest.Builder().build();
        RewardedAd.load(
                this,
                ADMOB_REWARDED_UNIT_ID,
                adRequest,
                new RewardedAdLoadCallback() {
                    @Override
                    public void onAdLoaded(@NonNull RewardedAd ad) {
                        rewardedAd = ad;
                        isLoadingRewarded = false;
                        notifyJsRewardedState(true);
                    }

                    @Override
                    public void onAdFailedToLoad(@NonNull LoadAdError loadAdError) {
                        rewardedAd = null;
                        isLoadingRewarded = false;
                        notifyJsRewardedState(false);
                    }
                }
        );
    }

    private void notifyJsRewardedState(final boolean ready) {
        if (webView == null) return;
        webView.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.onNativeRewardedReady && window.onNativeRewardedReady(" + ready + ");",
                        null
                );
            }
        });
    }

    private void notifyJsInterstitialClosed(final String callbackId, final boolean shown) {
        if (webView == null) return;
        final String safeId = callbackId == null ? "" : callbackId.replace("'", "");
        webView.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.onNativeAdClosed && window.onNativeAdClosed('" + safeId + "', 'interstitial', " + shown + ");",
                        null
                );
            }
        });
    }

    private void notifyJsRewardEarned(final String rewardType, final boolean earned) {
        if (webView == null) return;
        final String safeType = rewardType == null ? "supply" : rewardType.replace("'", "");
        webView.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.onNativeRewardEarned && window.onNativeRewardEarned('" + safeType + "', " + earned + ");",
                        null
                );
            }
        });
    }

    private static String getMimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){ return !!(window.handleAndroidBack && window.handleAndroidBack()); })()",
                result -> {
                    if ("true".equals(result)) {
                        return;
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressTime < 2000) {
                        finish();
                    } else {
                        lastBackPressTime = now;
                        Toast.makeText(
                                MainActivity.this,
                                "뒤로 버튼을 한 번 더 누르면 게임을 종료합니다.",
                                Toast.LENGTH_SHORT
                        ).show();
                    }
                }
        );
    }

    public class TankClashBridge {
        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public void setBannerVisible(final boolean visible) {
            runOnUiThread(() -> {
                if (bannerContainer != null) {
                    bannerContainer.setVisibility(visible ? View.VISIBLE : View.GONE);
                }
            });
        }

        @JavascriptInterface
        public boolean isRewardedAdReady() {
            return rewardedAd != null;
        }

        @JavascriptInterface
        public void showInterstitialAd(final String callbackId) {
            runOnUiThread(() -> {
                if (interstitialAd != null) {
                    InterstitialAd adToShow = interstitialAd;
                    interstitialAd = null;
                    adToShow.setFullScreenContentCallback(new FullScreenContentCallback() {
                        @Override
                        public void onAdDismissedFullScreenContent() {
                            preloadInterstitialAd();
                            notifyJsInterstitialClosed(callbackId, true);
                        }

                        @Override
                        public void onAdFailedToShowFullScreenContent(@NonNull AdError adError) {
                            preloadInterstitialAd();
                            notifyJsInterstitialClosed(callbackId, false);
                        }
                    });
                    adToShow.show(MainActivity.this);
                } else {
                    preloadInterstitialAd();
                    notifyJsInterstitialClosed(callbackId, false);
                }
            });
        }

        @JavascriptInterface
        public void showRewardedAd(final String rewardType) {
            runOnUiThread(() -> {
                if (rewardedAd != null) {
                    RewardedAd adToShow = rewardedAd;
                    rewardedAd = null;
                    final boolean[] earnedFlag = {false};

                    adToShow.setFullScreenContentCallback(new FullScreenContentCallback() {
                        @Override
                        public void onAdDismissedFullScreenContent() {
                            preloadRewardedAd();
                            notifyJsRewardEarned(rewardType, earnedFlag[0]);
                        }

                        @Override
                        public void onAdFailedToShowFullScreenContent(@NonNull AdError adError) {
                            preloadRewardedAd();
                            notifyJsRewardEarned(rewardType, false);
                        }
                    });

                    adToShow.show(MainActivity.this, rewardItem -> {
                        earnedFlag[0] = true;
                    });
                } else {
                    preloadRewardedAd();
                    Toast.makeText(
                            MainActivity.this,
                            "테스트 광고를 불러오는 중입니다. 잠시 후 다시 시도해 주세요!",
                            Toast.LENGTH_SHORT
                    ).show();
                    notifyJsRewardEarned(rewardType, false);
                }
            });
        }
    }

    @Override
    protected void onPause() {
        if (bannerAdView != null) {
            bannerAdView.pause();
        }
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        if (bannerAdView != null) {
            bannerAdView.resume();
        }
    }

    @Override
    protected void onDestroy() {
        if (bannerAdView != null) {
            bannerAdView.destroy();
            bannerAdView = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
