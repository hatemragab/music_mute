package com.hatem.musicmute.playback

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** Position ticks must never invalidate navigation, artwork, queue or playback controls. */
internal fun PlaybackState.withoutPosition(): PlaybackState = copy(positionMs = 0)

internal fun Flow<PlaybackState>.controls(): Flow<PlaybackState> =
    map { it.withoutPosition() }.distinctUntilChanged()
