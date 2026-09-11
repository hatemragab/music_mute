package com.hatem.musicmute.download

data class DownloadProgress(
    val percent: Int,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
) {
    companion object {
        fun parse(percent: Float, line: String): DownloadProgress {
            val values = Regex("VOCAL:(\\d+):([\\d]+|NA)").find(line)
            val received = values?.groupValues?.get(1)?.toLongOrNull() ?: 0
            val total = values?.groupValues?.get(2)?.toLongOrNull()?.takeIf { it > 0 }
            return DownloadProgress(
                if (percent.isFinite()) percent.toInt().coerceIn(0, 99) else 0,
                received,
                total,
            )
        }
    }
}
