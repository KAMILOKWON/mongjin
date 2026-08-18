package com.studiozzzg.mongjin;

import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.coordinatorlayout.widget.CoordinatorLayout;

import com.getcapacitor.BridgeActivity;
import com.google.android.libraries.ads.mobile.sdk.MobileAds;
import com.google.android.libraries.ads.mobile.sdk.banner.AdSize;
import com.google.android.libraries.ads.mobile.sdk.banner.AdView;
import com.google.android.libraries.ads.mobile.sdk.banner.BannerAd;
import com.google.android.libraries.ads.mobile.sdk.banner.BannerAdEventCallback;
import com.google.android.libraries.ads.mobile.sdk.banner.BannerAdRequest;
import com.google.android.libraries.ads.mobile.sdk.common.AdLoadCallback;
import com.google.android.libraries.ads.mobile.sdk.common.FullScreenContentError;
import com.google.android.libraries.ads.mobile.sdk.common.LoadAdError;
import com.google.android.libraries.ads.mobile.sdk.initialization.InitializationConfig;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MongjinAds";

    private final AtomicBoolean adsInitialized = new AtomicBoolean(false);
    private AdView adView;
    private WebView webView;
    private ViewGroup adContainer;
    private int originalWebViewPaddingLeft;
    private int originalWebViewPaddingTop;
    private int originalWebViewPaddingRight;
    private int originalWebViewPaddingBottom;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prepareAdContainer();
        requestConsentAndInitializeAds();
    }

    private void prepareAdContainer() {
        if (getBridge() == null) return;

        webView = getBridge().getWebView();
        originalWebViewPaddingLeft = webView.getPaddingLeft();
        originalWebViewPaddingTop = webView.getPaddingTop();
        originalWebViewPaddingRight = webView.getPaddingRight();
        originalWebViewPaddingBottom = webView.getPaddingBottom();

        ViewParent parent = webView.getParent();
        if (parent instanceof ViewGroup) {
            adContainer = (ViewGroup) parent;
        }
    }

    private void requestConsentAndInitializeAds() {
        if (adContainer == null) return;

        ConsentInformation consentInformation = UserMessagingPlatform.getConsentInformation(this);
        ConsentRequestParameters parameters = new ConsentRequestParameters.Builder().build();

        consentInformation.requestConsentInfoUpdate(
            this,
            parameters,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(
                this,
                formError -> {
                    if (formError != null) {
                        Log.w(TAG, "AdMob consent form failed: " + formError);
                    }
                    if (consentInformation.canRequestAds()) {
                        initializeAds();
                    }
                }
            ),
            formError -> {
                Log.w(TAG, "AdMob consent info update failed: " + formError);
                if (consentInformation.canRequestAds()) {
                    initializeAds();
                }
            }
        );

        // Consent can already be available from a previous launch.
        if (consentInformation.canRequestAds()) {
            initializeAds();
        }
    }

    private void initializeAds() {
        if (!adsInitialized.compareAndSet(false, true)) return;

        new Thread(() -> MobileAds.initialize(
            this,
            new InitializationConfig.Builder(getString(R.string.admob_app_id)).build(),
            initializationStatus -> runOnUiThread(this::loadBanner)
        )).start();
    }

    private void loadBanner() {
        if (adContainer == null || adView != null || isFinishing()) return;

        adView = new AdView(this);
        adView.setVisibility(View.GONE);
        adView.setBackgroundColor(Color.rgb(241, 238, 232));

        if (adContainer instanceof CoordinatorLayout) {
            CoordinatorLayout.LayoutParams layoutParams = new CoordinatorLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            layoutParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
            ((CoordinatorLayout) adContainer).addView(adView, layoutParams);
        } else {
            FrameLayout.LayoutParams layoutParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
            );
            adContainer.addView(adView, layoutParams);
        }

        adView.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            updateWebViewBottomInset();
        });

        adContainer.post(() -> {
            if (adView == null) return;

            float density = getResources().getDisplayMetrics().density;
            int widthDp = Math.max(1, Math.round(adContainer.getWidth() / density));
            AdSize adSize = AdSize.getLargeAnchoredAdaptiveBannerAdSize(this, widthDp);
            BannerAdRequest request = new BannerAdRequest.Builder(
                getString(R.string.admob_banner_ad_unit_id),
                adSize
            ).build();

            adView.loadAd(request, new AdLoadCallback<BannerAd>() {
                @Override
                public void onAdLoaded(@NonNull BannerAd bannerAd) {
                    bannerAd.setAdEventCallback(new BannerAdEventCallback() {
                        @Override
                        public void onAdImpression() {
                            Log.d(TAG, "AdMob banner impression recorded");
                        }

                        @Override
                        public void onAdClicked() {
                            Log.d(TAG, "AdMob banner clicked");
                        }

                        @Override
                        public void onAdShowedFullScreenContent() {}

                        @Override
                        public void onAdDismissedFullScreenContent() {}

                        @Override
                        public void onAdFailedToShowFullScreenContent(
                            @NonNull FullScreenContentError error
                        ) {
                            Log.w(TAG, "AdMob banner failed to show: " + error);
                        }
                    });
                    adView.setVisibility(View.VISIBLE);
                    adView.post(MainActivity.this::updateWebViewBottomInset);
                    Log.d(TAG, "AdMob banner loaded");
                }

                @Override
                public void onAdFailedToLoad(@NonNull LoadAdError error) {
                    Log.w(TAG, "AdMob banner failed to load: " + error);
                    adView.setVisibility(View.GONE);
                    updateWebViewBottomInset();
                }
            });
        });
    }

    private void updateWebViewBottomInset() {
        if (webView == null) return;
        int adHeight = adView != null && adView.getVisibility() == View.VISIBLE
            ? adView.getHeight()
            : 0;
        webView.setPadding(
            originalWebViewPaddingLeft,
            originalWebViewPaddingTop,
            originalWebViewPaddingRight,
            originalWebViewPaddingBottom + adHeight
        );
    }

    @Override
    public void onDestroy() {
        if (webView != null) {
            webView.setPadding(
                originalWebViewPaddingLeft,
                originalWebViewPaddingTop,
                originalWebViewPaddingRight,
                originalWebViewPaddingBottom
            );
        }
        if (adView != null) {
            if (adView.getParent() instanceof ViewGroup) {
                ((ViewGroup) adView.getParent()).removeView(adView);
            }
            adView.destroy();
            adView = null;
        }
        super.onDestroy();
    }
}
