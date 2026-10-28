package com.kardanov.agstatus

/**
 * Which subagents a card shows as rows, and what the rows and their footer
 * say. Kept out of the composables so it can be tested, and so it stays the
 * same arithmetic as the web board's pick() and the iOS app's SubtaskSlots:
 * three clients must put the same subagent in the same slot.
 */

// MARK: - Ledger

/**
 * One card's slots: how many it had, and which subagents held them, top to
 * bottom. It lives beside the session, never in it, because every frame
 * replaces the session whole — and in the store, not the card, because a
 * LazyColumn forgets a card's remembered state the moment it scrolls away.
 */
data class SubtaskLedger(val slots: Int, val shown: List<String>)

// MARK: - SubtaskSlots

object SubtaskSlots {

    /**
     * Rows on a card. Android draws every card by the phone rules — it has no
     * tablet layout — so two rows, and a footer that opens the session screen
     * rather than unfolding the list in place.
     */
    const val PHONE_SLOTS = 2

    /** What [pick] answers: the ledger to keep, and the rows to draw, top to bottom. */
    data class Pick(val ledger: SubtaskLedger, val rows: List<Subtask>)

    /**
     * The rows that fit, slot by slot. The owner's rule is oldest and
     * slot-stable: a row keeps its slot until it finishes, so "keep its
     * place" wins over exact start order, and a row that takes a freed slot
     * can stand above one that started before it.
     *
     *  - First drawing, or a new slot count: the blocked subagents, then the
     *    oldest of the rest, listed in start order.
     *  - A finish leaves a hole in its own slot, and the next hidden subagent
     *    in start order takes it in place. No other row moves.
     *  - A blocked subagent always gets a slot: a free one, else the
     *    bottom-most slot whose row is not blocked. The row it displaces
     *    comes back only into a slot a finish frees.
     *  - Once approved, a row keeps its slot until it finishes.
     *  - A slot nothing can take closes.
     *
     * Idempotent — asked again with the ledger it returned and the same
     * items, it answers the same — so a card can resolve its rows in
     * composition from whatever ledger the store holds, and get what the
     * store will keep. The web's expanded, unfolded list has no counterpart
     * here: under the phone rules the footer navigates instead.
     */
    fun pick(ledger: SubtaskLedger?, items: List<Subtask>, slots: Int = PHONE_SLOTS): Pick {
        val live = items.associateBy { it.id }
        val held = if (ledger == null || ledger.slots != slots) {
            val blocked = items.filter { it.state == SubtaskState.BLOCKED }.take(slots)
            val rest = items.filter { it.state != SubtaskState.BLOCKED }.take(slots - blocked.size)
            val chosen = (blocked + rest).mapTo(HashSet()) { it.id }
            items.filter { it.id in chosen }.map { it.id }
        } else {
            ledger.shown
        }

        // A finished row leaves a hole in its own slot.
        val at: MutableList<String?> = held.take(slots).map { id -> id.takeIf { it in live } }.toMutableList()

        for (subtask in items) {
            if (subtask.state != SubtaskState.BLOCKED || subtask.id in at) continue
            var slot = at.indexOf(null)
            if (slot < 0 && at.size < slots) slot = at.size
            if (slot < 0) {
                slot = at.indices.lastOrNull { i ->
                    at[i]?.let { live[it] }?.state != SubtaskState.BLOCKED
                } ?: -1
            }
            // No slot at all when every one already holds a blocked row.
            if (slot == at.size) {
                at.add(subtask.id)
            } else if (slot >= 0) {
                at[slot] = subtask.id // the displaced row goes hidden
            }
        }

        // The next hidden row takes a freed slot in place.
        val hidden = items.filter { it.id !in at }
        var next = 0
        for (slot in 0 until slots) {
            if (next >= hidden.size) break
            if (slot == at.size) at.add(null)
            if (at[slot] == null) at[slot] = hidden[next++].id
        }

        val shown = at.filterNotNull()
        return Pick(SubtaskLedger(slots, shown), shown.mapNotNull { live[it] })
    }

    /**
     * Every card's ledger after the session list changed: each resolved from
     * the one the card had a moment ago, dropped with the card's subtask
     * block or with the card itself.
     */
    fun resolve(
        previous: Map<String, SubtaskLedger>,
        sessions: List<Session>,
        slots: Int = PHONE_SLOTS,
    ): Map<String, SubtaskLedger> {
        val resolved = HashMap<String, SubtaskLedger>()
        for (session in sessions) {
            val subtasks = session.subtasks ?: continue
            resolved[session.id] = pick(previous[session.id], subtasks.items, slots).ledger
        }
        return resolved
    }

    /**
     * The line under a card's rows: "+4 more · 12 done". Under the phone rules
     * it is a control while anything is hidden — it opens the session screen,
     * where every subagent is listed — and plain text when it is only a count.
     */
    data class Footer(
        /** "+N more", while some subagents have no row. */
        val more: String?,
        /** "M done", once any finished this turn. */
        val done: String?,
    ) {
        val navigates: Boolean get() = more != null
        val text: String get() = listOfNotNull(more, done).joinToString(SubtaskCopy.SEPARATOR)
    }

    /** The footer for [shown] rows of [total] subagents with [done] finished; null when there is nothing to say. */
    fun footer(total: Int, shown: Int, done: Int): Footer? {
        val hidden = total - shown
        val footer = Footer(
            more = if (hidden > 0) SubtaskCopy.more(hidden) else null,
            done = if (done > 0) SubtaskCopy.done(done) else null,
        )
        return footer.takeIf { it.more != null || it.done != null }
    }

    /**
     * The session screen's order: whoever needs you first, so the row the
     * footer leads to is at the top, then everyone else — failed rows
     * included — in start order.
     */
    fun screenOrder(items: List<Subtask>): List<Subtask> =
        items.filter { it.state == SubtaskState.BLOCKED } + items.filter { it.state != SubtaskState.BLOCKED }

    /**
     * Whether a row's state cell moves on this change. Only into or out of
     * blocked, and into failed: every agent post after a start is a class
     * change, so animating planning ↔ coding ↔ testing would keep rows moving
     * almost all the time, and motion on this board means news.
     */
    fun stateCellMoves(from: SubtaskState, to: SubtaskState): Boolean =
        from != to && (from == SubtaskState.BLOCKED || to == SubtaskState.BLOCKED || to == SubtaskState.FAILED)
}

// MARK: - Copy

/**
 * The subtask copy, word for word the web board's and the iOS app's, so it is
 * pinned by SubtaskCopyTest rather than left to the composables.
 */
object SubtaskCopy {

    /** U+00B7 with a space each side. */
    const val SEPARATOR = " · "

    const val SECTION = "Subtasks"

    /** The timeline's heading, under a Subtasks section. */
    const val TIMELINE = "Timeline"

    /**
     * The footer's tap label. TalkBack reads it after "Double-tap to", so it
     * is an imperative, as the usage bars' "Show … usage detail" is; iOS
     * says the same thing as a hint, "Opens the session screen".
     */
    const val OPEN_SESSION = "Open the session screen"

    fun more(hidden: Int): String = "+$hidden more"

    fun done(done: Int): String = "$done done"

    fun doneThisTurn(done: Int): String = "$done done this turn"

    /**
     * The section's counts, each class apart — a blocked subagent is not
     * running, it is waiting on you: "9 running · 1 blocked · 1 failed",
     * non-zero parts only.
     */
    fun counts(running: Int, blocked: Int, failed: Int): String =
        listOf(running to "running", blocked to "blocked", failed to "failed")
            .filter { (count, _) -> count > 0 }
            .joinToString(SEPARATOR) { (count, word) -> "$count $word" }

    /** The server's name for a subagent it has no label for; here only for a blank one. */
    fun fallbackLabel(n: Int): String = "Subagent $n"

    /** What a screen reader says for a row: "{label}, {state}: {activity}", or without an empty activity. */
    fun rowDescription(subtask: Subtask): String =
        if (subtask.activity.isEmpty()) {
            "${subtask.label}, ${subtask.state.wire}"
        } else {
            "${subtask.label}, ${subtask.state.wire}: ${subtask.activity}"
        }
}
