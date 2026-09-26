package com.hatem.musicmute.ui.auth

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/** Keep the monotonic resend timer in the button's scope, out of account/form composition. */
@Composable
internal fun CooldownContent(until: Long, content: @Composable (Long) -> Unit) {
    val owner = LocalLifecycleOwner.current
    val seconds by produceState(cooldownSeconds(until, SystemClock.elapsedRealtime()), until, owner) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            do {
                value = cooldownSeconds(until, SystemClock.elapsedRealtime())
                if (value > 0) delay(1_000)
            } while (value > 0)
        }
    }
    content(seconds)
}

internal fun cooldownSeconds(until: Long, now: Long): Long =
    ((until - now).coerceAtLeast(0) + 999) / 1_000
