package com.kardanov.agstatus

import kotlin.math.max

/** Relative timestamps in the board's voice, shared by cards and timelines. */
object TimeFormat {

    /** "just now", "5m ago", "3h ago", "2d ago". Future instants read as now. */
    fun relative(fromMillis: Long, nowMillis: Long): String {
        val seconds = ((nowMillis - fromMillis) / 1000).coerceAtLeast(0)
        return when {
            seconds < 45 -> "just now"
            seconds < 3600 -> "${max(1L, seconds / 60)}m ago"
            seconds < 86_400 -> "${seconds / 3600}h ago"
            else -> "${seconds / 86_400}d ago"
        }
    }

    /**
     * [relative]'s span without "ago" — "14m", "2h", "3d" — what a stale card's
     * "no update for" is followed by. Its first reading is "10m", which states
     * the rule.
     */
    fun age(fromMillis: Long, nowMillis: Long): String {
        val seconds = ((nowMillis - fromMillis) / 1000).coerceAtLeast(0)
        return when {
            seconds < 3600 -> "${max(1L, seconds / 60)}m"
            seconds < 86_400 -> "${seconds / 3600}h"
            else -> "${seconds / 86_400}d"
        }
    }

    /**
     * The same span in words — "14 minutes", "1 hour" — for TalkBack, which can
     * read the face's "14m" as a length.
     */
    fun spokenAge(fromMillis: Long, nowMillis: Long): String {
        val seconds = ((nowMillis - fromMillis) / 1000).coerceAtLeast(0)
        val (count, unit) = when {
            seconds < 3600 -> max(1L, seconds / 60) to "minute"
            seconds < 86_400 -> seconds / 3600 to "hour"
            else -> seconds / 86_400 to "day"
        }
        return if (count == 1L) "1 $unit" else "$count ${unit}s"
    }
}
