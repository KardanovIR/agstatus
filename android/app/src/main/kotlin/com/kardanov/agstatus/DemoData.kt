package com.kardanov.agstatus

import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * Believable fake sessions for demo mode, plus a tick() that walks them
 * through plausible status transitions so the board feels alive.
 */
object DemoData {

    /**
     * The demo's two Focus hosts, so the board shows both faces of the
     * control: a listener that is online, and one that went quiet. Ids are
     * 32 hex like the real per-board hashes.
     */
    private const val DEMO_MACBOOK_ID = "3f9a1c7e5b2d4086a9c1e3f5b7d90246"
    private const val DEMO_MAC_MINI_ID = "7c2e9b4d1f8a6035c4e2a8b6d0f13579"

    /** The one demo session that runs subagents. */
    private const val REVIEW_ID = "demo-review"

    /** The workflow session's own line, which a waiting subagent's takes over. */
    private const val REVIEW_MESSAGE = "Running the review-and-verify workflow"

    /**
     * Nine sessions in five projects, two of them blocked: a real evening of
     * agent work, and the board the project-sections mockups draw. Projects
     * are shared, Claude's and Codex's cards sit in one section, one session
     * has moved to another folder since it started, one has no folder at all,
     * and two blocked cards give the needs-you bar a walk ("Show", then
     * "Next"). Each says where it started (`homeProject`) as a current server
     * would.
     */
    fun initialSessions(): List<Session> {
        val now = System.currentTimeMillis()
        return listOf(
            // A workflow at full stretch — the prototype's ten subagents with
            // fifteen already done — so the board shows two rows, the footer
            // and the session screen's list. Newest, so it leads its section.
            // Its tick takes it through the rest of the turn: see advanceReview.
            Session(
                id = REVIEW_ID,
                name = "Review and verify the subtasks branch",
                status = AgentStatus.PLANNING,
                message = REVIEW_MESSAGE,
                project = "claude-status",
                homeProject = "claude-status",
                createdAt = now - 38 * 60_000L,
                updatedAt = now - 5_000L,
                subtasks = demoSubtasks(
                    reviewRows.mapIndexed { index, (label, state, activity) ->
                        // Numbered from 3, as two finished before these
                        // started; agstatus_open_subtask 9 is verify:hook.
                        demoSubtask(n = index + 3, label = label, state = state, activity = activity)
                    },
                    done = 15,
                ),
            ),
            // Codex Desktop started at `/`: no folder yet, so No project,
            // and no place on its line.
            Session(
                id = "demo-codex-desktop",
                name = "Codex",
                status = AgentStatus.PLANNING,
                message = "Reading the brief",
                source = "codex",
                createdAt = now - 2 * 60_000L,
                updatedAt = now - 8_000L,
            ),
            // It ran `cd web`: it keeps its place under acme-api, and its
            // line says "in web".
            Session(
                id = "demo-webapp",
                name = "Add rate limiting to /login",
                status = AgentStatus.TESTING,
                message = "npm test — 42 passing, 1 pending",
                project = "web",
                homeProject = "acme-api",
                createdAt = now - 95 * 60_000L,
                updatedAt = now - 14_000L,
            ),
            Session(
                id = "demo-api-server",
                name = "api-server",
                status = AgentStatus.CODING,
                message = "Editing src/auth/token.ts",
                project = "acme-api",
                homeProject = "acme-api",
                createdAt = now - 42 * 60_000L,
                updatedAt = now - 15_000L,
                // An IDE session whose machine's listener has gone quiet: the
                // control is there, disabled, with the reason under it.
                host = SessionHost(
                    machine = HostMachine(id = DEMO_MAC_MINI_ID, name = "Mac mini"),
                    app = HostApp(slug = "vscode", name = "VS Code", kind = "ide"),
                ),
            ),
            // Codex beside Claude in another project: its mark tells them apart.
            Session(
                id = "demo-listener",
                name = "agstatus-listener-windows-terminal-focus",
                status = AgentStatus.TESTING,
                message = "npm test -- focus/wt — 57 passed",
                project = "claude-status",
                homeProject = "claude-status",
                source = "codex",
                createdAt = now - 64 * 60_000L,
                updatedAt = now - 60_000L,
            ),
            // The first blocked card in reading order: what the bar names first.
            Session(
                id = "demo-login",
                name = "Fix the login redirect",
                status = AgentStatus.BLOCKED,
                message = "Approve: git push --force-with-lease",
                project = "acme-api",
                homeProject = "acme-api",
                createdAt = now - 31 * 60_000L,
                updatedAt = now - 2 * 60_000L,
                host = SessionHost(
                    machine = HostMachine(id = DEMO_MACBOOK_ID, name = "MacBook"),
                    app = HostApp(slug = "agterm", name = "agterm", kind = "terminal"),
                ),
            ),
            Session(
                id = "demo-data-pipeline",
                name = "data-pipeline",
                status = AgentStatus.BLOCKED,
                message = "Needs permission approval",
                project = "etl-jobs",
                homeProject = "etl-jobs",
                createdAt = now - 18 * 60_000L,
                updatedAt = now - 3 * 60_000L,
                // The hero case: blocked in a terminal on a machine whose
                // listener is online, so "Bring to front" is live.
                host = SessionHost(
                    machine = HostMachine(id = DEMO_MACBOOK_ID, name = "MacBook"),
                    app = HostApp(slug = "agterm", name = "agterm", kind = "terminal"),
                ),
            ),
            // A Codex session so the demo board shows both agents' limit
            // blocks, not just Claude's.
            Session(
                id = "demo-docs-site",
                name = "docs-site",
                status = AgentStatus.DONE,
                message = "All tasks complete — 12 files changed",
                project = "docs",
                homeProject = "docs",
                source = "codex",
                createdAt = now - 3 * 3_600_000L,
                updatedAt = now - 26 * 60_000L,
            ),
            // An untitled Codex session, named after its folder.
            Session(
                id = "demo-acme-codex",
                name = "acme-api",
                status = AgentStatus.DONE,
                message = "Turn finished",
                project = "acme-api",
                homeProject = "acme-api",
                source = "codex",
                createdAt = now - 70 * 60_000L,
                updatedAt = now - 41 * 60_000L,
            ),
        ) + extraProjectSessions(now)
    }

    /**
     * Screenshot switch for the board grouped by project, set from
     * MainActivity's intent in a debug build before the demo starts, as iOS's
     * manyprojects scenario: that many more sessions (1 to 12), each in a
     * project of its own. Their names sort among the demo's own, one is too
     * long for a phone's label line, two differ only in case, and the last is
     * blocked, so the bar has a card far down the board to bring. Anything
     * else leaves the demo's nine.
     */
    var extraProjects: Int = 0

    private fun extraProjectSessions(now: Long): List<Session> {
        val count = if (extraProjects in 1..extraProjectNames.size) extraProjects else return emptyList()
        return extraProjectNames.take(count).mapIndexed { index, folder ->
            val last = index == count - 1
            Session(
                id = "demo-project-$index",
                name = if (last) "Rotate the staging certificates" else folder,
                status = if (last) AgentStatus.BLOCKED else AgentStatus.IDLE,
                message = if (last) "Approve: terraform apply" else "Waiting for a task",
                project = folder,
                homeProject = folder,
                source = if (index % 3 == 2) "codex" else "claude",
                createdAt = now - (90 + index) * 60_000L,
                updatedAt = now - (50 + index) * 60_000L,
            )
        }
    }

    private val extraProjectNames = listOf(
        "agstatus-listener-windows-terminal-focus",
        "billing",
        "Design-System",
        "design-system",
        "infra",
        "mobile",
        "ops-runbooks",
        "payments",
        "search",
        "web",
        "warehouse",
        "zeta",
    )

    /**
     * Every working session (planning, coding, testing) as if it last reported
     * [minutes] ago. Past ten that is a stale card, which the demo never shows
     * otherwise: its sessions are seconds to a few minutes old. Zero or less
     * leaves the sessions as they are. iOS's AGSTATUS_DEMO_STALE.
     */
    fun aged(sessions: List<Session>, minutes: Int): List<Session> {
        if (minutes <= 0) return sessions
        val at = System.currentTimeMillis() - minutes * 60_000L
        return sessions.map { session ->
            if (!session.status.isActive) return@map session
            val updatedAt = minOf(session.updatedAt, at)
            session.copy(updatedAt = updatedAt, createdAt = minOf(session.createdAt, updatedAt))
        }
    }

    /** Listener presence for the demo hosts: the MacBook is on, the Mac mini went quiet. */
    fun machines(): List<MachinePresence> {
        val now = System.currentTimeMillis()
        return listOf(
            MachinePresence(id = DEMO_MACBOOK_ID, name = "MacBook", online = true, since = now - 55 * 60_000L),
            MachinePresence(id = DEMO_MAC_MINI_ID, name = "Mac mini", online = false, lastSeen = now - 5 * 60_000L),
        )
    }

    /**
     * Plan-limit bars matching a busy-but-not-throttled evening: one block per
     * agent, each with its own session, all-models and per-model windows.
     */
    fun usage(): List<UsageInfo> {
        val now = System.currentTimeMillis()
        return listOf(
            UsageInfo(
                source = "claude",
                windows = listOf(
                    UsageWindow(
                        id = "session",
                        label = "Current session",
                        usedPct = 34.0,
                        resetsAt = now + 137 * 60_000L,
                    ),
                    UsageWindow(
                        id = "week",
                        label = "Weekly (all models)",
                        usedPct = 62.0,
                        resetsAt = now + 2 * 86_400_000L + 5 * 3_600_000L,
                    ),
                    UsageWindow(
                        id = "week_fable",
                        label = "Weekly (Fable)",
                        usedPct = 41.0,
                        resetsAt = now + 2 * 86_400_000L + 5 * 3_600_000L,
                    ),
                ),
                updatedAt = now,
            ),
            UsageInfo(
                source = "codex",
                windows = codexWindows(now).take(if (limitWindows in 1..6) limitWindows else 3),
                updatedAt = now,
            ),
        )
    }

    /**
     * Screenshot switches for the usage screens, set from MainActivity's
     * intent in a debug build before the demo starts, as iOS's
     * AGSTATUS_DEMO_LIMITS and AGSTATUS_DEMO_FIRST_DAY.
     *
     * [limitWindows], 1 to 6, gives Codex that many of the six windows one
     * report may carry, in its usage block and its history alike: the chart's
     * six patterns and marks can only be looked at with six. Anything else
     * leaves the demo's three.
     *
     * [firstDayWindows] starts those windows' history today, with a single
     * reading, as on a board's first day; "all" is every window.
     */
    var limitWindows: Int = 0
    var firstDayWindows: Set<String> = emptySet()

    /** Codex at the six windows a report may carry; the demo shows the first three. */
    private fun codexWindows(now: Long): List<UsageWindow> {
        val week = now + 4 * 86_400_000L + 2 * 3_600_000L
        return listOf(
            UsageWindow(id = "week", label = "Weekly (all models)", usedPct = 47.0, resetsAt = week),
            UsageWindow(
                id = "session_gpt_6_astra",
                label = "Session (GPT-6-Astra)",
                usedPct = 22.0,
                resetsAt = now + 96 * 60_000L,
            ),
            UsageWindow(id = "week_gpt_6_astra", label = "Weekly (GPT-6-Astra)", usedPct = 38.0, resetsAt = week),
            UsageWindow(
                id = "session_gpt_6_mini",
                label = "Session (GPT-6-Mini)",
                usedPct = 9.0,
                resetsAt = now + 41 * 60_000L,
            ),
            UsageWindow(id = "week_gpt_6_mini", label = "Weekly (GPT-6-Mini)", usedPct = 64.0, resetsAt = week),
            UsageWindow(id = "week_review", label = "Weekly (code review)", usedPct = 12.0, resetsAt = week),
        )
    }

    /**
     * A month of plausible detail behind those bars, generated locally so demo
     * mode never touches the network: weekly caps sawtoothing as they reset,
     * session windows wandering, and per-project token totals underneath.
     * Deterministic, so a demo screenshot looks the same every launch.
     */
    fun usageHistory(
        days: Int = UsageDetail.DEFAULT_DAYS,
        nowMillis: Long = System.currentTimeMillis(),
    ): UsageHistory {
        val range = UsageDetail.dayRange(days, nowMillis)
        if (range.isEmpty()) return UsageHistory(days = days)
        val blocks = usage()
        return UsageHistory(
            days = days,
            history = blocks.flatMap { info ->
                info.windows.mapIndexed { index, window ->
                    demoSeries(info.source, window, range, index, nowMillis)
                }
            },
            projects = blocks.flatMap { demoProjectDays(it.source, range) },
        )
    }

    /**
     * Advances a random subset of sessions (at least one) along plausible
     * transitions, refreshing messages and updatedAt. An emptied demo board
     * re-seeds itself so the demo never dead-ends. [random] is for the tests,
     * which need a demo they can replay.
     */
    fun tick(sessions: List<Session>, random: Random = Random): List<Session> {
        if (sessions.isEmpty()) return initialSessions()
        val now = System.currentTimeMillis()
        val updated = sessions.toMutableList()
        var changedAny = false

        for (index in updated.indices) {
            if (random.nextDouble() < 0.45) {
                updated[index] = step(updated[index], now, random)
                changedAny = true
            }
        }
        if (!changedAny) {
            val index = updated.indices.random(random)
            updated[index] = step(updated[index], now, random)
        }
        return updated
    }

    /** A believable timeline for a demo session, ending in its current state. */
    fun history(session: Session): List<HistoryEvent> {
        // A full session's worth of steps: enough to fill the timeline on the
        // largest phone, and to show a blocked stretch resolving.
        val steps = listOf(
            Triple(AgentStatus.IDLE, "Session started", 46L),
            Triple(AgentStatus.PLANNING, "Reading the codebase…", 44L),
            Triple(AgentStatus.PLANNING, "Drafting an implementation plan", 40L),
            Triple(AgentStatus.CODING, "Editing src/auth/token.ts", 35L),
            Triple(AgentStatus.CODING, "Implementing retry with backoff", 31L),
            Triple(AgentStatus.TESTING, "npm test — 41 passing, 2 failing", 26L),
            Triple(AgentStatus.CODING, "Fixing null check in parser.js", 22L),
            Triple(AgentStatus.BLOCKED, "Needs permission approval", 18L),
            Triple(AgentStatus.CODING, "Refactoring api/routes.ts", 14L),
            Triple(AgentStatus.TESTING, "npm test — 42 passing, 1 pending", 9L),
            Triple(AgentStatus.CODING, "Writing SessionStore.kt", 5L),
        )
        val events = steps.mapIndexed { index, (status, message, minutesAgo) ->
            HistoryEvent(
                seq = index.toLong(),
                status = status,
                message = message,
                at = session.updatedAt - minutesAgo * 60_000L,
            )
        } + HistoryEvent(
            seq = steps.size.toLong(),
            status = session.status,
            message = session.message,
            at = session.updatedAt,
        )
        return events.reversed() // newest first, like the server
    }

    // MARK: - Internals

    /**
     * One window's recorded readings. Weekly caps climb through a seven-day
     * cycle and drop when they reset; session windows wander. A block's last
     * window only starts halfway through the range, because a board records a
     * limit from the day it first saw it — that late start is exactly what the
     * detail screen's footnote is about. Readings are emitted only when the
     * value changes, matching the step function the server stores.
     */
    private fun demoSeries(
        source: String,
        window: UsageWindow,
        days: List<String>,
        index: Int,
        nowMillis: Long,
    ): UsageSeries {
        val random = Random(source.hashCode() * 31 + window.id.hashCode())
        val weekly = window.id.startsWith("week")
        val hours = if (weekly) intArrayOf(11) else intArrayOf(7, 13, 19)
        val firstDay = when {
            "all" in firstDayWindows || window.id in firstDayWindows -> days.lastIndex
            index == 2 && days.size > 8 -> days.size / 2
            else -> 0
        }

        val points = mutableListOf<UsagePoint>()
        var previous = Double.NaN
        // A session window wanders from wherever it was rather than being
        // redrawn each reading: consecutive readings of a real limit correlate.
        var level = 24.0 + random.nextInt(20)
        for (dayIndex in firstDay until days.size) {
            val phase = (dayIndex - firstDay) % 7
            for (hour in hours) {
                val at = UsageDetail.dayStartMillis(days[dayIndex]) + hour * 3_600_000L
                if (at > nowMillis) continue // no readings from the future
                val value = if (weekly) {
                    5.0 + phase * 9.0 + random.nextInt(7)
                } else {
                    level = (level + random.nextInt(-11, 12)).coerceIn(6.0, 76.0)
                    level
                }
                val rounded = value.roundToInt().toDouble()
                if (rounded != previous) {
                    points += UsagePoint(at = at, usedPct = rounded)
                    previous = rounded
                }
            }
        }
        // Land on the percentage the board's bars are showing right now.
        if (previous != window.usedPct) {
            points += UsagePoint(at = nowMillis, usedPct = window.usedPct)
        }
        return UsageSeries(source = source, windowId = window.id, points = points)
    }

    /**
     * Daily per-project token totals. Quiet days are deliberate: a flat block
     * of thirty identical bars reads as fake at a glance.
     */
    private fun demoProjectDays(source: String, days: List<String>): List<ProjectDay> {
        val projects = demoProjects[source] ?: return emptyList()
        val random = Random(source.hashCode())
        val rows = mutableListOf<ProjectDay>()
        for (day in days) {
            val quiet = random.nextDouble() < 0.16
            for ((project, weight) in projects) {
                if (quiet || random.nextDouble() < 0.22) continue
                val spread = 0.45 + random.nextDouble() * 1.15
                // Rounded to 100K, the granularity a real token report lands on.
                val tokens = (weight * spread * 12_000_000.0).roundToLong() / 100_000L * 100_000L
                if (tokens <= 0L) continue
                rows += ProjectDay(source = source, project = project, day = day, tokens = tokens)
            }
        }
        return rows
    }

    /** The demo sessions' projects, weighted so one clearly leads the board. */
    private val demoProjects: Map<String, List<Pair<String, Double>>> = mapOf(
        "claude" to listOf("acme-api" to 1.0, "acme-web" to 0.64, "etl-jobs" to 0.27),
        "codex" to listOf("docs" to 0.58, "acme-web" to 0.31),
    )

    private fun step(session: Session, now: Long, random: Random): Session =
        if (session.id == REVIEW_ID) advanceReview(session, now, random) else advance(session, now, random)

    // MARK: - Subagents

    /**
     * One step of the workflow session, as its hook and the server would
     * report it. While the parent's turn runs, one subagent starts, finishes,
     * fails, or blocks or is approved: changes that move a row. An activity
     * is never rewritten in place, which the 1.7 hook does not send either.
     *
     * Now and then the parent's own turn ends with its subagents still at
     * work, and the card reads WORKING until the last of them finishes. Then
     * "Reading subagent results" while the parent reads them, then done, the
     * tally gone with the turn, and in time a new prompt starts the workflow
     * over. So the demo shows every state a card with subagents can be in,
     * the WORKING card and a failed row's mark among them — on Android the
     * demo is the only place to see them before a real 1.7 board.
     */
    private fun advanceReview(session: Session, now: Long, random: Random): Session {
        // The parent has read the results; its report turn ends with nothing left running.
        if (session.message == READING_RESULTS) return turnOver(session, now)
        val subtasks = session.subtasks
            // Done, the tally gone with the turn: in time, a new prompt.
            ?: return if (random.nextDouble() < 0.35) newPrompt(session, now) else session.copy(updatedAt = now)
        val items = subtasks.items.toMutableList()
        // Every subagent finished while the turn ran: the turn ends quietly.
        if (items.none { it.state != SubtaskState.FAILED }) return turnOver(session, now)

        var done = subtasks.done
        // With something live, turnEnded is exactly "the parent's turn is over".
        var ownEnded = subtasks.turnEnded
        val waiting = items.indexOfFirst { it.state == SubtaskState.BLOCKED }
        val working = items.indices.filter { items[it].state.isWorking }
        val roll = random.nextDouble()
        when {
            // Approval comes before anything else blocks.
            waiting >= 0 && roll < 0.5 -> {
                val row = items[waiting]
                items[waiting] = row.copy(state = SubtaskState.CODING, activity = row.activity.removePrefix(APPROVE))
            }
            // Only rows waiting on you, or failed ones: nothing moves until you answer.
            working.isEmpty() -> Unit
            waiting < 0 && roll < 0.15 -> {
                val index = working.random(random)
                items[index] = items[index].copy(state = SubtaskState.BLOCKED, activity = APPROVE + items[index].activity)
            }
            roll < 0.25 && items.count { it.state == SubtaskState.FAILED } < MAX_DEMO_FAILED -> {
                // One of the two that have run longest, which the card
                // usually shows: the crossed circle is then seen on the
                // board, not only on the session screen.
                val index = working.take(2).random(random)
                items[index] = items[index].copy(state = SubtaskState.FAILED, activity = failures.random(random))
            }
            // The parent's own turn ends, its subagents still at work.
            !ownEnded && roll < 0.37 -> ownEnded = true
            // Once the turn is over nothing new starts, so the work runs down.
            ownEnded || roll < 0.75 || items.size >= MAX_DEMO_ROWS -> {
                items.removeAt(working.random(random))
                done += 1
            }
            else -> {
                val n = items.maxOf { it.n } + 1
                val (label, state, activity) = startRows[n % startRows.size]
                items += demoSubtask(n = n, label = label, state = state, activity = activity)
            }
        }
        return reported(session, ownEnded, items, done, now)
    }

    /**
     * The workflow session as the server reports it, from the parent's own
     * reading and its rows: a waiting subagent's approval first; then, once
     * the parent's turn is over, the busiest subagent's state and "N
     * subagents still running"; then, every one finished, "Reading subagent
     * results" until the parent is back; otherwise the parent's own line.
     */
    private fun reported(session: Session, ownEnded: Boolean, items: List<Subtask>, done: Int, now: Long): Session {
        val live = items.filter { it.state != SubtaskState.FAILED }
        val blocked = live.filter { it.state == SubtaskState.BLOCKED }
        val working = live.filter { it.state.isWorking }
        val (status, message) = when {
            blocked.isNotEmpty() -> AgentStatus.BLOCKED to
                "Needs approval: ${blocked.first().label}" + if (blocked.size > 1) " +${blocked.size - 1}" else ""
            ownEnded && working.isNotEmpty() -> busiest(working) to
                if (working.size == 1) "1 subagent still running" else "${working.size} subagents still running"
            ownEnded -> AgentStatus.PLANNING to READING_RESULTS
            else -> AgentStatus.PLANNING to REVIEW_MESSAGE
        }
        return session.copy(
            status = status,
            message = message,
            subtasks = if (items.isEmpty() && done == 0) {
                null
            } else {
                demoSubtasks(items, done, turnEnded = ownEnded && live.isNotEmpty())
            },
            updatedAt = now,
        )
    }

    /** Testing over coding over planning: the state a card reads while its subagents outlast the turn. */
    private fun busiest(working: List<Subtask>): AgentStatus = when {
        working.any { it.state == SubtaskState.TESTING } -> AgentStatus.TESTING
        working.any { it.state == SubtaskState.CODING } -> AgentStatus.CODING
        else -> AgentStatus.PLANNING
    }

    /** The turn fully over: the parent's own line, and the tally and failed rows gone with the turn. */
    private fun turnOver(session: Session, now: Long): Session =
        session.copy(status = AgentStatus.DONE, message = TURN_FINISHED, subtasks = null, updatedAt = now)

    /** A new prompt: the workflow starts over, numbered from 1, nothing done yet. */
    private fun newPrompt(session: Session, now: Long): Session {
        val items = reviewRows.mapIndexed { index, (label, state, activity) ->
            demoSubtask(n = index + 1, label = label, state = state, activity = activity)
        }
        return reported(session, ownEnded = false, items = items, done = 0, now = now)
    }

    private fun demoSubtask(n: Int, label: String, state: SubtaskState, activity: String) =
        Subtask(id = "demo-agent-$n", n = n, label = label, state = state, activity = activity)

    /** Counts exactly as the server sends them: derived from the rows, plus the tally. */
    private fun demoSubtasks(items: List<Subtask>, done: Int, turnEnded: Boolean = false) = Subtasks(
        turnEnded = turnEnded,
        running = items.count { it.state.isWorking },
        blocked = items.count { it.state == SubtaskState.BLOCKED },
        failed = items.count { it.state == SubtaskState.FAILED },
        done = done,
        items = items,
    )

    private const val APPROVE = "Approve: "
    private const val MAX_DEMO_ROWS = 12

    /** Failed rows stay listed until the turn is over; two at most keeps the demo plausible. */
    private const val MAX_DEMO_FAILED = 2

    /** The hook's Stop line, and so the parent's own once its turn is over. */
    private const val TURN_FINISHED = "Turn finished"

    /** The server's line between the last subagent finishing and the parent reading the results. */
    private const val READING_RESULTS = "Reading subagent results"

    /** How a subagent fails, as the hook words it: "Failed: " and the first line of the error. */
    private val failures = listOf(
        "Failed: API error (overloaded)",
        "Failed: Prompt is too long",
    )

    /** The prototype's review-and-verify workflow, in start order. */
    private val reviewRows: List<Triple<String, SubtaskState, String>> = listOf(
        Triple("review:hook", SubtaskState.TESTING, "Run hook tests with --no-file-parallelism"),
        Triple("review:listener", SubtaskState.CODING, "Editing listener.ts"),
        Triple("review:product", SubtaskState.PLANNING, "Searching: SubagentStop payload fields"),
        Triple("review:server", SubtaskState.CODING, "Editing store.ts"),
        Triple("review:ios", SubtaskState.CODING, "Editing SessionCardView.swift"),
        Triple("review:android", SubtaskState.PLANNING, "Reading developer.android.com"),
        Triple("verify:hook", SubtaskState.TESTING, "Run the hook suite — 214 tests"),
        Triple("verify:server", SubtaskState.TESTING, "npm test -- store"),
        Triple("verify:web", SubtaskState.CODING, "Editing card.css"),
        Triple("verify:privacy", SubtaskState.PLANNING, "Search payloads for prompt text"),
    )

    /** What the workflow starts next. */
    private val startRows: List<Triple<String, SubtaskState, String>> = listOf(
        Triple("verify:android", SubtaskState.TESTING, "Run ./gradlew lint"),
        Triple("verify:docs", SubtaskState.CODING, "Editing docs.html"),
        Triple("map:limits", SubtaskState.PLANNING, "Search for the webhook budget"),
        Triple("test:ios", SubtaskState.TESTING, "xcodebuild test -scheme AgStatus"),
        Triple("Draft the 1.7 release notes", SubtaskState.CODING, "Writing v1.7.0.md"),
    )

    private fun advance(session: Session, now: Long, random: Random): Session {
        val status = transitions[session.status]?.random(random) ?: session.status
        val message = if (status != session.status || random.nextBoolean()) {
            messages[status]?.random(random) ?: session.message
        } else {
            session.message
        }
        return session.copy(status = status, message = message, updatedAt = now)
    }

    /** Weighted plausible transitions (duplicates raise the odds of staying put). */
    private val transitions: Map<AgentStatus, List<AgentStatus>> = mapOf(
        AgentStatus.IDLE to listOf(AgentStatus.PLANNING, AgentStatus.PLANNING, AgentStatus.IDLE),
        AgentStatus.PLANNING to listOf(AgentStatus.CODING, AgentStatus.CODING, AgentStatus.PLANNING),
        AgentStatus.CODING to listOf(
            AgentStatus.CODING,
            AgentStatus.CODING,
            AgentStatus.CODING,
            AgentStatus.TESTING,
        ),
        AgentStatus.TESTING to listOf(
            AgentStatus.TESTING,
            AgentStatus.CODING,
            AgentStatus.DONE,
            AgentStatus.BLOCKED,
        ),
        AgentStatus.BLOCKED to listOf(AgentStatus.BLOCKED, AgentStatus.BLOCKED, AgentStatus.CODING),
        AgentStatus.DONE to listOf(AgentStatus.DONE, AgentStatus.DONE, AgentStatus.PLANNING),
    )

    private val messages: Map<AgentStatus, List<String>> = mapOf(
        AgentStatus.IDLE to listOf(
            "Waiting for a task",
            "Session idle",
        ),
        AgentStatus.PLANNING to listOf(
            "Reading the codebase…",
            "Exploring src/ for entry points",
            "Drafting an implementation plan",
            "Reviewing open issues",
        ),
        AgentStatus.CODING to listOf(
            "Editing src/auth/token.ts",
            "Refactoring api/routes.ts",
            "Implementing retry with backoff",
            "Writing SessionStore.kt",
            "Fixing null check in parser.js",
        ),
        AgentStatus.TESTING to listOf(
            "npm test",
            "Running unit tests…",
            "pytest -q — 87 passed",
            "vitest run — 3 suites",
        ),
        AgentStatus.BLOCKED to listOf(
            "Needs permission approval",
            "Waiting for your input",
            "Merge conflict needs review",
        ),
        AgentStatus.DONE to listOf(
            "All tasks complete",
            "PR ready for review",
            "Finished — 12 files changed",
        ),
    )
}
