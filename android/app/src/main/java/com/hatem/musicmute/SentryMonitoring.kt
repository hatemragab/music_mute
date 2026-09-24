package com.hatem.musicmute

import android.app.Application
import io.sentry.android.core.SentryAndroid

internal object SentryMonitoring {
    fun initialize(application: Application) {
        if (!BuildConfig.SENTRY_ENABLED || BuildConfig.SENTRY_DSN.isBlank()) return
        SentryAndroid.init(application) { options ->
            options.dsn = BuildConfig.SENTRY_DSN
            options.environment = "production"
            options.release = "musicmute-android@${BuildConfig.VERSION_NAME}"
            options.dist = "${BuildConfig.UPDATE_DISTRIBUTION}.${BuildConfig.VERSION_CODE}"
            options.maxBreadcrumbs = 0
            options.tracesSampleRate = 0.0
            options.isSendDefaultPii = false
            options.isAttachScreenshot = false
            options.isAttachViewHierarchy = false
            options.isEnableAutoSessionTracking = false
            options.beforeSend = io.sentry.SentryOptions.BeforeSendCallback { event, _ ->
                event.user = null
                event.request = null
                event.breadcrumbs = null
                event.message = null
                event.extras = emptyMap()
                event.contexts.clear()
                event.tags = mapOf("component" to "android")
                event.exceptions?.forEach { it.value = "Application failure" }
                event
            }
        }
    }
}
