import SwiftUI
import UIKit

/// The live board: one glanceable card per agent session, in one section per
/// agent.
struct BoardView: View {
    @Environment(SessionStore.self) private var store
    @Environment(NotificationManager.self) private var notifications
    @AppStorage("pushTipShown") private var pushTipShown = false

    @State private var showPairSheet = false
    @State private var showSettings = false
    @State private var copiedWebhook = false
    @State private var path = NavigationPath()

    /// Which side each card sits on where cards run two across. Kept here and
    /// not in the container that draws them: containers are swapped when the
    /// board is rotated or an agent arrives, and a card's side has to outlive
    /// the swap.
    @State private var sides = CardSides()
    /// The card an alarm last brought into view, for as long as its ring shows.
    @State private var jumped: String?
    /// Counts the jumps. The ring's two seconds run from the LAST press, and a
    /// second press on the same alarm leaves `jumped` holding an equal id,
    /// which would restart nothing.
    @State private var jumpStamp = 0
    /// The same card, for VoiceOver: an alarm that scrolled the board and left
    /// the cursor on the head would have moved nothing for that reader.
    @AccessibilityFocusState private var focusedCard: String?
    /// Redraws every minute so the "resets in …" countdowns stay honest. One
    /// clock for the whole board, handed to every head: heads now live both
    /// above the scroll view and inside it, and a clock apiece would let two
    /// countdowns on one screen disagree for most of a minute.
    private static let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    @State private var now = Date()

    /// The narrowest a column may be, growing with the reader's text size.
    ///
    /// Scaled so that large text steps the board DOWN an arrangement — an iPad
    /// drops from columns to the stack, then to the list — instead of holding
    /// its columns and cutting every name in them. At the default size it is
    /// exactly `BoardArrangement.minColumn`, and the head's thresholds scale
    /// by the same factor (`BoardPlan.scale`).
    @ScaledMetric(relativeTo: .title3) private var minColumn = BoardArrangement.minColumn

    /// At an accessibility size a phone pins the agent line, not its heads:
    /// `BoardArrangement.headsScroll`.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Compact on a phone held sideways, and only there: it keeps the list,
    /// with the agent line pinned. The one size class the board reads, and it
    /// is never asked about width (`BoardArrangement`).
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        NavigationStack(path: $path) {
            // The board is arranged from its MEASURED width, read here, once,
            // at the root. A reader is synchronous: the width is known in the
            // same pass that lays the board out, so no frame is ever drawn for
            // the wrong one. Writing a measurement into state instead would
            // draw the phone's list on an iPad for one frame at every launch
            // and every rotation.
            //
            // It is the width inside the safe area, which is the width the
            // content actually gets — on a phone in landscape as well.
            GeometryReader { geo in
                // One reader for whichever container is live, so an alarm
                // does not need to know whether it is scrolling a List or a
                // ScrollView.
                ScrollViewReader { scroller in
                    board(plan(for: geo.size.width), scroller: scroller)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            // Both destinations live at the root, on a view that is always
            // there. The session one used to hang off the List — but the List
            // is now one of three containers that replace each other when the
            // board is rotated or an agent arrives, and a destination declared
            // on a container that has just been swapped out is gone from under
            // the screen it pushed.
            //
            // Two value types, so the two cannot collide: a session id is a
            // String, an agent's usage is a UsageDetailRoute.
            .navigationDestination(for: UsageDetailRoute.self) { route in
                UsageDetailView(source: route.source)
            }
            .navigationDestination(for: String.self) { sessionId in
                SessionHistoryView(sessionId: sessionId)
            }
            .environment(\.openSession) { path.append($0) }
            .environment(\.openUsage) { path.append(UsageDetailRoute(source: $0)) }
            .navigationTitle("AgStatus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("AgStatus")
                        .font(.system(.headline, design: .rounded).weight(.bold))
                        .foregroundStyle(Theme.textPrimary)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if store.isDemo {
                        demoBadge
                    } else {
                        connectionDot
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // The demo badge says where you are; this says how you leave.
                    if store.isDemo {
                        Button("Exit Demo") {
                            store.stopDemo()
                        }
                        .font(.subheadline.weight(.semibold))
                        .tint(Theme.textSecondary)
                    }
                    if store.board?.token != nil && store.connection != .boardGone {
                        Button {
                            showPairSheet = true
                        } label: {
                            Image(systemName: "laptopcomputer.and.arrow.down")
                        }
                        .accessibilityLabel("Pair your computer")
                    }
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .task { await openHistoryForScreenshots() }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task(id: store.board) {
                if let board = store.board, board.token != nil, !pushTipShown {
                    await notifications.probeServerSupport(for: board)
                }
            }
            .onReceive(Self.clock) { now = $0 }
            // The body draws from `sides.resolved(for:)`, and this stores the
            // same answer — so the first frame a card appears in already has
            // it on its side, and every later frame finds it there.
            .onChange(of: store.sessions.map(\.id), initial: true) {
                sides = sides.resolved(for: groups)
            }
            // A different board is different cards. Starting again is also
            // what stops the ledger growing without end across a day of
            // switching boards.
            .onChange(of: store.board) { sides = CardSides().resolved(for: groups) }
            .onChange(of: store.isDemo) { sides = CardSides().resolved(for: groups) }
            // The ring says "this is the blocked card you asked for". Once the
            // card is no longer blocked it would be saying something untrue.
            .onChange(of: store.sessions.filter { $0.status == .blocked }.map(\.id)) { _, blocked in
                if let jumped, !blocked.contains(jumped) { self.jumped = nil }
            }
            .task(id: jumpStamp) { await fadeRing() }
        }
    }

    /// The board itself: what is pinned, what scrolls, and the streak beneath.
    private func board(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        VStack(spacing: 0) {
            if !plan.groups.isEmpty && store.connection != .boardGone {
                pinned(plan, scroller: scroller)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            Group {
                if store.connection == .boardGone {
                    boardGoneView
                } else if store.sessions.isEmpty {
                    // "No agents yet" is only true when we're actually live —
                    // while (re)connecting, an empty list just means "unknown".
                    if store.isDemo || store.connection == .live {
                        emptyState(hasAgents: !plan.groups.isEmpty)
                    } else {
                        connectingState
                    }
                } else {
                    sessionBoard(plan, scroller: scroller)
                }
            }

            // Pinned under the list rather than inside it: the streak is
            // about the board, not about any card, and a row that scrolled
            // away with the sessions would be a different claim. It enters
            // from the bottom the way the heads enter from the top, so the
            // two pieces of board-level chrome behave as a pair.
            //
            // Absent until the first fetch lands, and absent again if it
            // fails — `days > 0` covers both. A streak is ambient; an
            // apology where a number should be is worse than silence.
            if store.streak.days > 0 && store.connection != .boardGone {
                StreakBar(streak: store.streak)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .settles(on: plan.shape)
        // Keyed on the limits the heads show, as it was when the heads were
        // only limit bars: a head arriving or leaving, or a bar moving. Not on
        // the groups themselves, which change with every message of every
        // session and would animate the whole board each time.
        .motion(.snappy, value: plan.groups.map(\.usage))
        .motion(.snappy, value: store.streak)
        #if DEBUG
        .frame(maxWidth: Self.widthForScreenshots.map { $0 + 2 * Theme.Space.md })
        #endif
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await jumpForScreenshots(plan, scroller: scroller) }
    }

    /// Debug-only deep links so screenshot automation can reach the pushed
    /// screens, which have no launch argument and cannot be tapped by simctl.
    /// AGSTATUS_OPEN_HISTORY=1 opens the first session's timeline;
    /// AGSTATUS_OPEN_USAGE=<source> opens that agent's usage history.
    private func openHistoryForScreenshots() async {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let source = environment["AGSTATUS_OPEN_USAGE"], !source.isEmpty {
            // Demo usage is seeded synchronously; a real board's arrives over SSE.
            for _ in 0..<40 {
                if !store.usage.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if path.isEmpty {
                path.append(UsageDetailRoute(source: source))
            }
            return
        }
        guard environment["AGSTATUS_OPEN_HISTORY"] == "1" else { return }
        // Demo sessions are seeded synchronously; a real board arrives over SSE.
        for _ in 0..<40 {
            if !store.sessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let first = store.sessions.first, path.isEmpty {
            path.append(first.id)
        }
        #endif
    }

    #if DEBUG
    /// AGSTATUS_BOARD_WIDTH=<pt> clamps the board to that width inside its
    /// gutters, whatever the device. It is how a full-screen iPad is made to
    /// stand in for one in Split View: 646 has to give the phone's list on a
    /// device whose size class is regular, and simctl cannot open Split View.
    private static let widthForScreenshots: CGFloat? =
        ProcessInfo.processInfo.environment["AGSTATUS_BOARD_WIDTH"]
            .flatMap(Double.init)
            .map { CGFloat($0) }
    #endif

    /// AGSTATUS_JUMP=<source> presses that agent's alarm once the board has
    /// been laid out, because simctl cannot tap and the jump is the one piece
    /// of this layout that only exists after a touch.
    private func jumpForScreenshots(_ plan: BoardPlan, scroller: ScrollViewProxy) async {
        #if DEBUG
        guard let source = ProcessInfo.processInfo.environment["AGSTATUS_JUMP"],
              !source.isEmpty else { return }
        // Demo sessions are seeded synchronously, so the plan this task was
        // started with already holds them; the wait is for the scroll view to
        // have a first layout to scroll.
        try? await Task.sleep(for: .milliseconds(600))
        jump(to: source, in: plan, scroller: scroller)
        #endif
    }

    // MARK: - Plan

    /// The agents on the board, each with its sessions and its limits.
    private var groups: [AgentGroup] {
        AgentGroup.make(sessions: store.sessions, usage: store.usage)
    }

    /// Everything one pass of layout decides, from the width it was given.
    private func plan(for outerWidth: CGFloat) -> BoardPlan {
        var width = max(0, outerWidth - 2 * Theme.Space.md)
        #if DEBUG
        if let clamp = Self.widthForScreenshots { width = min(width, clamp) }
        #endif
        let groups = groups
        let compactHeight = verticalSizeClass == .compact
        return BoardPlan(
            width: width,
            scale: minColumn / BoardArrangement.minColumn,
            groups: groups,
            arrangement: BoardArrangement.resolve(width: width, agents: groups.count, minColumn: minColumn,
                                                  compactHeight: compactHeight),
            wide: BoardArrangement.fit(width: width, minColumn: minColumn) >= 2,
            idle: store.sessions.isEmpty,
            largeText: typeSize.isAccessibilitySize,
            compactHeight: compactHeight,
            sides: sides.resolved(for: groups)
        )
    }

    // MARK: - Pinned

    /// What stays above the scroll view: the agents' heads, where the limit
    /// bars already sat. The list scrolls beneath, so what is pinned never
    /// leaves the screen — and with it, every agent's alarm.
    @ViewBuilder
    private func pinned(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        if plan.idle {
            // Nothing running. The heads are the limits again and nothing
            // more: side by side as the limit blocks were, up to three across
            // where there is room and two where there is not.
            headRows(plan, perRow: plan.wide ? min(plan.groups.count, 3) : 2,
                     gap: BoardArrangement.headGap, level: plan.wide, scroller: scroller)
                .padding(.horizontal, Theme.Space.md)
                .padding(.top, 10)
                .padding(.bottom, 2)
        } else if plan.headsScroll {
            // More agents than this board pins heads for: on a wide board more
            // than fit, on a phone more than two — or, on a phone held
            // sideways or at an accessibility text size, any at all. Their
            // heads scroll with their sections; this one line is what stays.
            agentLine(plan, scroller: scroller)
        } else {
            switch plan.arrangement {
            case .narrow:
                // Two across, each keeping its own height; the only agent
                // takes the whole row. A third agent no longer gets a row of
                // its own here — see `BoardArrangement.narrowPinnedHeads`.
                headRows(plan, perRow: 2, gap: BoardArrangement.headGap, level: false, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .columns:
                // The same tracks as the columns beneath, from the same
                // arithmetic and inside the same gutters, so a head cannot
                // stand anywhere but over its own cards.
                headRows(plan, perRow: plan.groups.count, gap: BoardArrangement.agentGutter,
                         level: true, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .stackedOne:
                // One agent: there is nothing to put beside it, so its head
                // runs the full width, still pinned, as its limits were when
                // they were only bars.
                headRows(plan, perRow: 1, gap: 0, level: false, canStrip: true, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .stackedMany:
                // Always `headsScroll`, and drawn above. The case is here
                // for the switch to be exhaustive, and draws the same line.
                agentLine(plan, scroller: scroller)
            }
        }
    }

    /// One pinned line for every agent: its name, which takes you to its
    /// section, and its alarm, which takes you to its first blocked card.
    private func agentLine(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        AgentLine(groups: plan.groups,
                  width: plan.width,
                  scale: plan.scale,
                  onSection: { source in
                      withMotion(.snappy) {
                          scroller.scrollTo(JumpTarget.section(source), anchor: .top)
                      }
                  },
                  onJump: { jump(to: $0, in: plan, scroller: scroller) })
            .padding(.horizontal, Theme.Space.md)
    }

    /// The heads in rows of `perRow`, every one a fixed track wide.
    ///
    /// `level` draws a row as one band: each head stretches to the tallest in
    /// its row. Where the heads are not level, a short last row — one head
    /// under a pair — is given the full width, so a third agent on an idle
    /// phone board is a line of its own and not half of an empty row. (With
    /// sessions running, a phone never pins a third head: `headsScroll`.)
    private func headRows(_ plan: BoardPlan, perRow: Int, gap: CGFloat, level: Bool,
                          canStrip: Bool = false, scroller: ScrollViewProxy) -> some View {
        let track = BoardArrangement.track(width: plan.width, count: perRow, gap: gap)
        return VStack(alignment: .leading, spacing: BoardArrangement.headGap) {
            ForEach(plan.groups.rows(of: perRow), id: \.first?.source) { row in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(row) { group in
                        AgentHead(group: group,
                                  width: !level && row.count == 1 ? plan.width : track,
                                  canStrip: canStrip,
                                  showsNoLimits: plan.arrangement != .narrow,
                                  fillsHeight: level,
                                  scale: plan.scale,
                                  alone: !level && row.count == 1,
                                  peers: row.filter { $0.blocked > 0 && $0.id != group.id },
                                  now: now,
                                  onJump: { jump(to: group.source, in: plan, scroller: scroller) })
                    }
                }
                // Lets the row settle on its tallest head's height, which is
                // what `fillsHeight` then stretches the others to.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Sessions

    /// The cards, in whichever container the width calls for.
    ///
    /// Three containers, and they replace each other outright. A change of
    /// arrangement is never cross-faded: two boards drawn over one another for
    /// a third of a second is the overlapping-text defect `scrollChrome`
    /// already describes, at the size of the whole screen. The same holds
    /// inside the list when its agents change — see `groupedList`.
    @ViewBuilder
    private func sessionBoard(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        switch plan.arrangement {
        case .narrow:
            scrollChrome(groupedList(plan, scroller: scroller))
                .transition(.identity)
        case .columns:
            scrollChrome(columnBoard(plan))
                .transition(.identity)
        case .stackedOne, .stackedMany:
            scrollChrome(stackedBoard(plan, scroller: scroller))
                .transition(.identity)
        }
    }

    /// What every container carries, whichever one is live: pull to refresh,
    /// the motion of a card arriving or leaving, and the push tip above the
    /// bottom edge.
    private func scrollChrome<Container: View>(_ container: Container) -> some View {
        container
            .refreshable { await store.refresh() }
            // Keyed on the ORDER of cards, not their contents. Animating on
            // `store.sessions` crossfaded every card whenever any field changed, so
            // a session whose message updated drew the old and new text on top of
            // each other for the length of the transition — it read as a rendering
            // bug, which is what it was. Motion on this board should mean a card
            // arrived, left or moved; a message changing in place is not news.
            .motion(.snappy, value: store.sessions.map(\.id))
            .safeAreaInset(edge: .bottom) {
                if showsPushTip {
                    pushTip
                }
            }
    }

    /// Where two columns do not fit — a phone, or an iPad in Split View — and
    /// on a phone held sideways, the sessions stay one list, because the list
    /// is the only container that can be swiped, and the swipe is how a phone
    /// has always dismissed a card.
    private func groupedList(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        List {
            if plan.headsScroll {
                // Three agents or more, or any number on a phone held sideways
                // or at an accessibility text size: the agent line is pinned
                // above, and each agent's full head opens its group and
                // scrolls with it, as the sections of a wide board do. No
                // pinned group name as well — it would stand directly over a
                // head saying the same name, which is the repetition one agent
                // already avoids.
                ForEach(plan.groups, id: \.section) { group in
                    AgentHead(group: group,
                              width: plan.width,
                              canStrip: true,
                              scale: plan.scale,
                              now: now,
                              onJump: { jump(to: group.source, in: plan, scroller: scroller) })
                        // Where the agent line's names send the list. A row
                        // is the one thing in a List that can be scrolled to.
                        .id(JumpTarget.section(group.source))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        // The wide board's spacing: the first head 10pt under
                        // the agent line, a head 24pt under the card before it
                        // (6 of that is the card's own), and 8pt above its
                        // first card (the card brings 6). No swipe: a head is
                        // not something to dismiss.
                        .listRowInsets(EdgeInsets(top: group.id == plan.groups.first?.id ? 10 : 18,
                                                  leading: Theme.Space.md, bottom: 2,
                                                  trailing: Theme.Space.md))
                    ForEach(group.sessions) { session in
                        row(session, in: group)
                    }
                }
            } else if plan.groups.count > 1 {
                ForEach(plan.groups, id: \.section) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            row(session, in: group)
                        }
                    } header: {
                        // A plain list pins its section headers by itself.
                        // What it does not do is draw them our way: the
                        // system insets a header, capitalises it, and rules a
                        // line under it. The label brings its own ground and
                        // its own padding, so all three are turned off.
                        GroupLabel(group: group, leads: group.id == plan.groups.first?.id)
                            .listRowInsets(EdgeInsets())
                            .textCase(nil)
                    }
                    .listSectionSeparator(.hidden)
                    .modifier(FlushSection())
                }
            } else {
                // One agent has its head directly above: a second name would
                // only repeat it. No Section at all, because an empty header
                // still takes its height — and this is the board most people
                // look at every day, which should not gain a gap for a
                // feature it is not using.
                ForEach(plan.groups, id: \.section) { group in
                    ForEach(group.sessions) { session in
                        row(session, in: group)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .modifier(OpaquePinnedLabels(pinned: plan.groups.count > 1 && !plan.headsScroll))
        .environment(\.cardsSwipeToDismiss, true)
        // The list is rebuilt, not morphed, when the set of agents changes:
        // one agent is a flat run of rows and two are sections, and animating
        // between those drew every card twice for a fifth of a second and
        // dropped the list back to its top.
        .settles(on: plan.shape)
    }

    private func row(_ session: Session, in group: AgentGroup) -> some View {
        card(session, in: group)
            // No invisible full-card NavigationLink any more. It was
            // an overlay across the whole card, which meant it sat on
            // top of the Focus and Resume controls and could swallow
            // the tap meant for them — a card that opens history when
            // you asked it to raise a window. A tap on the card's content
            // column opens history instead, and the Focus control sits in
            // the rail, outside that gesture.
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) {
                    Task { await store.dismiss(session) }
                } label: {
                    Label("Dismiss", systemImage: "xmark.circle.fill")
                }
                .tint(Theme.color(for: .blocked))
            }
    }

    /// One column per agent, under the head pinned over it.
    ///
    /// Eager stacks, not lazy ones. A hosted board holds fifty cards at most,
    /// which is nothing to lay out — and a stack that knows every card's
    /// height is what makes a jump land exactly, a removal close its gap
    /// properly, and the scroll offset hold still when a card far above
    /// changes height.
    private func columnBoard(_ plan: BoardPlan) -> some View {
        ScrollView {
            HStack(alignment: .top, spacing: BoardArrangement.agentGutter) {
                ForEach(plan.groups) { group in
                    cardStack(group.sessions, in: group)
                        .frame(width: plan.track, alignment: .top)
                        // Read one agent at a time. Left to itself VoiceOver
                        // goes across the columns row by row, which deals the
                        // agents' cards into one another.
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("\(group.name) sessions")
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.top, Self.scrollTop - Self.cardLead)
            .padding(.bottom, Self.scrollBottom)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .settles(on: plan.shape)
        }
    }

    /// Agents stacked full width, cards two across: one agent under its pinned
    /// head, or several, each under a head that scrolls with it.
    private func stackedBoard(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        let many = plan.arrangement == .stackedMany
        return ScrollView {
            // 24pt between two agents' sections, of which each head carries
            // the last 4 as its own — see `cardStack`.
            VStack(alignment: .leading, spacing: many ? BoardArrangement.agentGutter - Self.sectionLead : 0) {
                ForEach(plan.groups) { group in
                    // No spacing here: the cards bring the 8pt that separates
                    // them from their head.
                    VStack(alignment: .leading, spacing: 0) {
                        if many {
                            AgentHead(group: group,
                                      width: plan.width,
                                      canStrip: true,
                                      scale: plan.scale,
                                      now: now,
                                      onJump: { jump(to: group.source, in: plan, scroller: scroller) })
                                .padding(.top, Self.sectionLead)
                                .id(JumpTarget.section(group.source))
                        }
                        // Two columns that each keep their cards — see CardSides.
                        HStack(alignment: .top, spacing: BoardArrangement.cardGap) {
                            ForEach(CardSides.Side.allCases, id: \.self) { side in
                                cardStack(plan.sides.cards(group.sessions, on: side), in: group)
                                    .frame(width: plan.side, alignment: .top)
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("\(group.name) sessions")
                }
            }
            .padding(.horizontal, Theme.Space.md)
            // A section's head stands a little further below the agent line
            // than a card stands below a head: the line is a rule across the
            // screen, and a box hard under a rule reads as hanging from it.
            .padding(.top, many ? 10 - Self.sectionLead : Self.scrollTop - Self.cardLead)
            .padding(.bottom, Self.scrollBottom)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .settles(on: plan.shape)
        }
    }

    /// The first card sits 8pt under what is pinned (2 of it is the pinned
    /// area's own), as the list's first row always has.
    private static let scrollTop: CGFloat = 6
    private static let scrollBottom: CGFloat = 18

    /// How far below the top edge a jump leaves what it brought there: a card
    /// by the gap that separates it from a head, a section by half of that.
    private static let cardLead = Theme.Space.xs
    private static let sectionLead = Theme.Space.xxs

    /// One agent's cards in a column, 12pt apart.
    ///
    /// Each card carries `cardLead` of that gap as padding ABOVE itself, inside
    /// the view a jump scrolls to, and the stack supplies the rest. That is
    /// what makes a jump land right: `scrollTo(_:anchor: .top)` puts a view's
    /// top edge hard against the scroll view's, and a card flush under the
    /// heads reads as cut off — but a card that owns the 8pt above it comes to
    /// rest 8pt down, exactly, with no arithmetic on a scroll view's height.
    ///
    /// The obvious alternative does not work, and was tried: a view of no
    /// height standing 8pt above the card in an overlay, given the id instead.
    /// It is laid out where it should be, and ScrollViewReader ignores where —
    /// asked to scroll to it, it brings the CARD's top to the edge, whether the
    /// overlay is placed by an alignment guide or by negative padding, and
    /// whether it stands 8pt up or 30. An id in an overlay evidently answers
    /// with the frame of the view it is laid over.
    ///
    /// So a stack of cards begins with 8pt of air, and whatever holds one
    /// allows for that: see the top padding of the two containers.
    private func cardStack(_ sessions: [Session], in group: AgentGroup) -> some View {
        VStack(spacing: BoardArrangement.cardGap - Self.cardLead) {
            ForEach(sessions) { session in
                card(session, in: group)
                    .padding(.top, Self.cardLead)
                    .id(JumpTarget.card(session.id))
            }
        }
    }

    private func card(_ session: Session, in group: AgentGroup) -> some View {
        SessionCardView(session: session, agentName: group.name, jumpFocus: $focusedCard)
            .overlay {
                // A ring only where one is news: the card the alarm just
                // brought into view. Neutral ink — a green ring on a card
                // that is not done would be a colour claiming a state.
                if jumped == session.id {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg + 4, style: .continuous)
                        .strokeBorder(Theme.textPrimary, lineWidth: 2)
                        .padding(-4)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    // MARK: - Jump

    /// Brings `source`'s first blocked card into view and marks it.
    ///
    /// This is the other half of "a card keeps its place". A card that becomes
    /// blocked is recoloured where it stands, which may be a screen down, so
    /// the alarm in its agent's head has to be the way to it.
    private func jump(to source: String, in plan: BoardPlan, scroller: ScrollViewProxy) {
        guard let group = plan.groups.first(where: { $0.source == source }) else { return }
        let target: Session?
        switch plan.arrangement {
        case .narrow, .columns:
            target = group.firstBlocked
        case .stackedOne, .stackedMany:
            target = plan.sides.firstBlocked(in: group.sessions)
        }
        guard let target else { return }
        withMotion(.snappy) {
            switch plan.arrangement {
            case .narrow:
                // List rows answer to their session's own id.
                scroller.scrollTo(target.id, anchor: listAnchor(plan))
            case .columns, .stackedOne, .stackedMany:
                scroller.scrollTo(JumpTarget.card(target.id), anchor: .top)
            }
            jumped = target.id
            jumpStamp += 1
        }
        focusedCard = target.id
    }

    /// Where a jumped-to row comes to rest in the List.
    ///
    /// The design wants it at the top, clear of the group's name stuck there.
    /// A List gives no way to say "38pt down": it does not honour a fractional
    /// anchor (0.1 moved the row to two fifths of the way down, in the
    /// simulator), and a row is the only thing in it that can be scrolled to.
    ///
    /// What it does do, on iOS 26, is treat its own pinned header as the top:
    /// `.top` brings the row to rest directly under the label, the card 6pt
    /// beneath it. That is the design's answer to within a few points, so
    /// where it has been seen to hold it is used.
    ///
    /// It has only been seen on 26. An older list that put the row at the
    /// very top would hide the card's name behind the label — the one outcome
    /// a jump must not have, since the name is what you jumped to read. So
    /// before 26, with several agents, the row goes to the centre, which no
    /// version can put under anything. With one agent there is no label, nor
    /// wherever the heads scroll (three agents or more, a phone held sideways,
    /// an accessibility text size), which leaves nothing pinned inside the
    /// list — and there the top is simply the top.
    private func listAnchor(_ plan: BoardPlan) -> UnitPoint {
        if plan.groups.count < 2 || plan.headsScroll { return .top }
        if #available(iOS 26.0, *) { return .top }
        return .center
    }

    /// The ring is an answer to a tap, not a state: it goes after a couple of
    /// seconds, or sooner if another alarm is pressed.
    private func fadeRing() async {
        guard jumped != nil else { return }
        #if DEBUG
        // A frozen demo board is being photographed, and a ring that leaves
        // on a timer turns the capture into a race.
        if DemoData.isFrozen { return }
        #endif
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        withMotion { jumped = nil }
    }

    // MARK: - Push tip

    /// One-time nudge: the board is live, the server can push, and the user
    /// hasn't opted in (or dismissed the tip) yet.
    private var showsPushTip: Bool {
        !pushTipShown
            && !store.isDemo
            && store.connection == .live
            && !store.sessions.isEmpty
            && notifications.state == .off
            && notifications.serverPushAvailable == true
            && store.board?.token != nil
    }

    private var pushTip: some View {
        HStack(spacing: 10) {
            Image(systemName: "bell.badge")
                .font(.subheadline)
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            Text("Get a ping when an agent needs you")
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Enable") {
                withMotion { pushTipShown = true }
                if let board = store.board {
                    Task { await notifications.enable(for: board) }
                }
            }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.accent)
            Button {
                withMotion { pushTipShown = true }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notification tip")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.cardBorder)
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Empty state

    /// No sessions on the board — in one of two quite different situations.
    ///
    /// `hasAgents` is whether any agent has a head above this, which with no
    /// sessions means it reports plan limits. Limits on the board prove it is
    /// paired and that an agent has reported, so "No agents yet" and a
    /// prominent "Pair your computer" under two named heads with live bars
    /// contradicted the screen they were on. It is a common state, too: the
    /// morning after the evening's sessions have expired. There the board
    /// says only that nothing is running. Pairing a further computer stays in
    /// the toolbar, and the webhook in Settings, where they always were.
    ///
    /// A board with no heads at all keeps the first-run copy and the button.
    private func emptyState(hasAgents: Bool) -> some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityHidden(true)
                if hasAgents {
                    Text("Nothing running")
                        .font(.system(.title2, design: .rounded).weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("Sessions appear here when an agent starts.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                } else {
                    firstRun
                }
            }
            .padding(24)
            .padding(.top, 64)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
    }

    /// A board nothing has reported to: how to get something onto it.
    @ViewBuilder
    private var firstRun: some View {
        Text("No agents yet")
            .font(.system(.title2, design: .rounded).weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
        Text("Pair your computer and your coding agents will show up here the moment they report in.")
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .multilineTextAlignment(.center)

        if store.board?.token != nil {
            Button {
                showPairSheet = true
            } label: {
                Label("Pair your computer", systemImage: "laptopcomputer.and.arrow.down")
                    .font(.headline)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .padding(.top, 4)
        }

        if let board = store.board {
            VStack(spacing: 8) {
                Text("Or send updates straight to the webhook:")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                webhookRow(board.webhookURL)
            }
            .padding(.top, 16)
        }
    }

    private func webhookRow(_ url: URL) -> some View {
        Button {
            UIPasteboard.general.string = url.absoluteString
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withMotion { copiedWebhook = true }
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                withMotion { copiedWebhook = false }
            }
        } label: {
            HStack(spacing: 8) {
                Text(url.absoluteString)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: copiedWebhook ? "checkmark" : "doc.on.doc")
                    .font(.footnote)
                    .foregroundStyle(copiedWebhook ? Theme.color(for: .done) : Theme.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy webhook URL")
    }

    // MARK: - Connecting

    private var connectingState: some View {
        ScrollView {
            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.textSecondary)
                Text("Connecting to your board…")
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                Text("Pull down to retry.")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary.opacity(0.7))
            }
            .padding(.top, 160)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
    }

    // MARK: - Board gone

    private var boardGoneView: some View {
        VStack(spacing: 16) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 44))
                .foregroundStyle(Theme.color(for: .blocked))
                .accessibilityHidden(true)
            Text("This board no longer exists")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("It was probably deleted. Your device is fine — just set up a new one.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                store.disconnectBoard()
            } label: {
                Text("Start over")
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .padding(.top, 4)
        }
        .padding(32)
    }

    // MARK: - Toolbar bits

    private var connectionDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 9, height: 9)
            .shadow(color: dotColor.opacity(0.6), radius: 3)
            .accessibilityLabel(dotDescription)
    }

    private var dotColor: Color {
        switch store.connection {
        case .live:
            Theme.color(for: .done)
        case .connecting, .reconnecting:
            Theme.color(for: .testing)
        case .boardGone:
            Theme.color(for: .blocked)
        case .idle, .demo:
            Theme.color(for: .idle)
        }
    }

    private var dotDescription: String {
        switch store.connection {
        case .live: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .boardGone: "Board not found"
        case .idle: "Not connected"
        case .demo: "Demo"
        }
    }

    /// Says where you are, quietly.
    ///
    /// It used to be drawn in `coding` blue while the control beside it took
    /// the accent green — two different colours in one toolbar, neither of them
    /// meaning anything. It is a label, not a state and not an action, so it
    /// takes text colours: the chrome should say what it is without competing
    /// with the cards, which are the only things on this screen carrying colour
    /// that means something.
    private var demoBadge: some View {
        Text("DEMO")
            .font(.caption2.weight(.bold))
            .kerning(1)
            .fixedSize()
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(Capsule().strokeBorder(Theme.cardBorder))
            .accessibilityLabel("Demo mode")
    }
}

// MARK: - Layout plan

/// One pass of layout: the width the board was measured at, and everything
/// that follows from it. Made fresh on every render and never stored — see
/// `BoardView.plan(for:)`.
private struct BoardPlan {
    /// The board's width inside its 16pt gutters. Every other width on the
    /// board is arithmetic from this one.
    let width: CGFloat
    /// The Dynamic Type factor: 1 at the default text size.
    let scale: CGFloat
    let groups: [AgentGroup]
    let arrangement: BoardArrangement
    /// Whether two columns fit the width. An idle board asks it to choose
    /// between two heads across and three. It is the width's answer and not
    /// the arrangement's: a phone held sideways keeps its sessions in a list,
    /// but its idle heads take the one row its width allows, which is the row
    /// a short screen wants.
    let wide: Bool
    /// No sessions: the heads are the limits and nothing else.
    let idle: Bool
    /// An accessibility text size.
    let largeText: Bool
    /// A phone held sideways: the list, whatever the width.
    let compactHeight: Bool
    let sides: CardSides

    /// Whether the heads scroll with their sections under one pinned agent
    /// line. Never on an idle board, where the heads are all there is.
    var headsScroll: Bool {
        !idle && BoardArrangement.headsScroll(arrangement, agents: groups.count,
                                              largeText: largeText, compactHeight: compactHeight)
    }

    /// One agent's column, and the head over it.
    var track: CGFloat { BoardArrangement.track(width: width, count: groups.count) }
    /// One side of a pair of cards.
    var side: CGFloat { BoardArrangement.track(width: width, count: 2, gap: BoardArrangement.cardGap) }

    /// The board's shape. A change of it is drawn, not animated — see
    /// `settles(on:)`.
    var shape: Shape {
        Shape(arrangement: arrangement, tracks: arrangement == .columns ? groups.count : 0, idle: idle,
              headsScroll: headsScroll, agents: groups.map(\.source))
    }

    struct Shape: Hashable {
        let arrangement: BoardArrangement
        /// How many columns, where there are columns. A third agent arriving
        /// keeps the arrangement and still re-cuts every track on the board.
        let tracks: Int
        let idle: Bool
        /// Pinned heads or the agent line. A phone turned on its side keeps
        /// its list, but trades the one for the other, and its list's groups
        /// go from named sections to heads among the rows.
        let headsScroll: Bool
        /// Which agents are on the board. One arriving or leaving changes
        /// every head and every group even where the arrangement and the
        /// track count stay as they were — two agents becoming two different
        /// agents, or the phone's list going from one group to two.
        let agents: [String]
    }
}

private extension View {
    /// Applies a change of `shape` at once, whatever animation it arrived in.
    ///
    /// When the board changes shape — an agent arrives and two columns become
    /// three, the last card of one is dismissed, the device is rotated — every
    /// card is re-cut to a new width in the same update that some other card
    /// arrived or left in, and that update is animated. Left alone, each card
    /// would cross-fade from its old line breaks to its new ones while sliding
    /// to its new track: the whole board drawn twice, overlapping, for a third
    /// of a second. Motion here means one card has news. A re-flow is not one
    /// card's news, so it is simply drawn.
    func settles(on shape: BoardPlan.Shape) -> some View {
        transaction(value: shape) { $0.animation = nil }
    }
}

// MARK: - Streak

/// The streak, pinned under the board.
///
/// One row, and deliberately the quietest thing on screen: it reports, it does
/// not ask. The cards are the only things here allowed to demand attention, and
/// a streak that competed with a `blocked` card would be exactly backwards —
/// this is ambient context, that is somebody waiting on you.
///
/// The metals are the only colour on this board that does not mean a state, so
/// they are fenced to this row and never touch a card. The rank is also carried
/// by a pip count, because roughly one man in twelve cannot separate five
/// metals by hue and the board's second design principle says state is never
/// carried by colour alone — a rank is no different.
///
/// Not interactive. The obvious destination would be the usage screen, but that
/// screen is per-agent and a streak spans all of them, so a tap would have to
/// pick one arbitrarily. A row that goes somewhere half-chosen is worse than a
/// row that stays put.
private struct StreakBar: View {
    let streak: Streak

    /// How far along the current rung, 0–1. Measured between the tier reached
    /// and the next one rather than from zero, so the bar fills at a readable
    /// rate instead of crawling for a month between Gold and Platinum.
    private var progress: Double {
        guard let next = streak.next else { return 1 }
        let floor = streak.tier?.days ?? 0
        let span = Double(next.days - floor)
        guard span > 0 else { return 1 }
        return min(1, max(0, Double(streak.days - floor) / span))
    }

    private var metal: Color {
        switch streak.tier {
        case .wood: Theme.tierWood
        case .bronze: Theme.tierBronze
        case .silver: Theme.tierSilver
        case .gold: Theme.tierGold
        case .platinum: Theme.tierPlatinum
        case nil: Theme.textSecondary
        }
    }

    /// The rank as a count, not only as a colour.
    private var pips: Int { streak.tier?.pips ?? 0 }

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: streak.tier == nil ? "circle.dotted" : "star.fill")
                .font(.system(size: 13))
                .foregroundStyle(metal)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                    if let tier = streak.tier {
                        Text(tier.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(metal)
                            .lineLimit(1)
                            .fixedSize()
                        // Countable, not decorative. As 10x3 capsules these
                        // read as a dashed rule — a shape that looks like data
                        // and carries none. Dots at 5pt with real gaps can
                        // actually be counted at a glance, which is the whole
                        // job: the rank must survive without hue, because
                        // roughly one man in twelve cannot separate the metals.
                        HStack(spacing: Theme.Space.xxs) {
                            ForEach(0..<StreakTier.allCases.count, id: \.self) { index in
                                Circle()
                                    .fill(index < pips ? metal : Color.clear)
                                    .overlay(
                                        Circle().strokeBorder(
                                            index < pips ? Color.clear : Theme.cardBorder,
                                            lineWidth: 1
                                        )
                                    )
                                    .frame(width: 5, height: 5)
                            }
                        }
                        .accessibilityHidden(true)
                    }
                    // Whole words or the short form, never "19 day" over "s".
                    // VoiceOver reads the bar's own label, not these.
                    ViewThatFits(in: .horizontal) {
                        Text("\(streak.days) day\(streak.days == 1 ? "" : "s") active")
                            .fixedSize()
                        Text("\(streak.days)d")
                            .fixedSize()
                    }
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    // Offered the width before the forecast. Both can fall
                    // back to something smaller, so without this the row
                    // halves the room between them, and "19 days active" went
                    // to "19d" beside a forecast it had room for. The day
                    // count is the fact; the forecast is the one to go first.
                    .layoutPriority(1)

                    Spacer(minLength: Theme.Space.xs)

                    // Drops out whole rather than truncating. At large Dynamic
                    // Type "16d to Platinum" beside a tier name and a day count
                    // overruns 390pt, and a clipped "16d to Plat…" is worse
                    // than no forecast at all.
                    if let next = streak.next, let togo = streak.daysToNext, togo > 0 {
                        ViewThatFits(in: .horizontal) {
                            Text("\(togo)d to \(next.name)")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(Theme.textTertiary)
                                .fixedSize()
                            // Not EmptyView, which ViewThatFits does not count:
                            // with it the forecast never dropped out, and at
                            // accessibility sizes the tier broke a few letters
                            // to a line beside it.
                            FitsAsNothing()
                        }
                    }
                }

                // A track, and only while there is somewhere to go. At the top
                // rung `progress` is 1, and a full-width bar under a dark board
                // is the brightest thing on screen — an ambient counter
                // out-shouting a card that needs a human, which is backwards.
                // Nothing left to reach means nothing to draw.
                //
                // The fill is neutral rather than the metal for the same
                // reason: this is a position, not an achievement to celebrate.
                if streak.next != nil {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.raised)
                            Capsule()
                                .fill(Theme.textTertiary)
                                .frame(width: max(2, geo.size.width * progress))
                        }
                    }
                    .frame(height: 2)
                }
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.top, Theme.Space.xs)
        .padding(.bottom, Theme.Space.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.cardBorder).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    /// Spelled out, because the pips and the metal say nothing to a screen
    /// reader and "Silver, 14, 16" would be a riddle.
    private var accessibilityText: String {
        let run = "\(streak.days) day\(streak.days == 1 ? "" : "s") active"
        guard let tier = streak.tier else {
            if let next = streak.next, let togo = streak.daysToNext {
                return "\(run). \(togo) more to reach \(next.name)."
            }
            return run
        }
        guard let next = streak.next, let togo = streak.daysToNext, togo > 0 else {
            return "\(tier.name) tier. \(run). Top of the ladder."
        }
        return "\(tier.name) tier. \(run). \(togo) more to reach \(next.name)."
    }
}

// MARK: - List chrome

/// A list section with none of the system's own space around it.
///
/// A plain list stands every section header 22pt clear of whatever is above
/// it — measured in the simulator, and written down nowhere. That is 22pt of
/// nothing between the heads and the first group's name, and again before
/// every later one, on a board where 12pt is the gap between two cards. The
/// label already carries the space it wants, so the system's is taken out.
///
/// Two ways, because the direct one is new. iOS 26 can zero a section's
/// margins and does exactly that: checked on 26.5, where the first label then
/// sits flush under the heads and the rest 6pt under the card before them.
/// Before 26 the nearest thing is the section spacing, which on 26.5 closes
/// the gap between sections and leaves the first header's alone. Nothing older
/// than 26 was available to run this on, so on iOS 17 and 18 expect the first
/// group's name to stand up to 22pt lower than drawn, and no worse.
private struct FlushSection: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.listSectionMargins(.vertical, 0)
        } else {
            content.listSectionSpacing(0)
        }
    }
}

/// Keeps a pinned group name opaque while it hands over to the next one.
///
/// iOS 26 fades a pinned section header out as the following header pushes it
/// off, and the fade takes the header's own background with it. For the length
/// of that hand-over the last card of the outgoing group showed straight
/// through its name — "Claude 3" printed over "8m ago · 1.4M", two lines of
/// text on one, and exactly where the alarm's jump leaves the list when it
/// bottoms out. The hard edge style puts the system's own opaque band behind
/// whatever is pinned at the top, so the name may dim as it leaves but nothing
/// is read through it.
///
/// Checked on 26.5, the only runtime here. Before 26 a plain list's pinned
/// headers are pushed off without fading, so the label's own ground is enough
/// and there is nothing to switch on.
private struct OpaquePinnedLabels: ViewModifier {
    /// Whether the list has group names to pin at all. With one agent there
    /// are none, and the hard edge would leave an empty band where one stood.
    let pinned: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(pinned ? .hard : .automatic, for: .top)
        } else {
            content
        }
    }
}
