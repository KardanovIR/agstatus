import SwiftUI

/// One agent session, readable at arm's length: big name, colored status,
/// last message, and how fresh it all is. A session that reports where it
/// runs also gets a footer with the "Bring to front" control.
struct SessionCardView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.openSession) private var openSession
    @Environment(\.cardsSwipeToDismiss) private var swipesToDismiss
    /// The reader's text size: at an accessibility size the card can stack
    /// (`stacked`), and its name and message take the lines they need.
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Whether the board gives this card a whole column at that text size.
    @Environment(\.cardIsColumnWide) private var columnWide
    let session: Session
    /// Whose session this is, spelled as the agent's head spells it, and
    /// taken from the session itself: a project's section holds every agent's
    /// cards. The face carries the agent's mark (`agentMark`); the name goes
    /// into the card's label, which is what a screen reader hears.
    let agentName: String
    /// Set by the board when the needs-you bar brings this card into view, so
    /// that VoiceOver lands on the card and not on the bar that was pressed.
    let jumpFocus: AccessibilityFocusState<JumpTarget?>.Binding
    /// The room between the agent's mark and the first fact, growing with
    /// the text as the mark does.
    @ScaledMetric(relativeTo: .caption) private var markGap: CGFloat = 4

    /// An active card that has heard nothing for this long is stale: most
    /// likely a dead agent — killed mid-turn, an interrupted turn, which fires
    /// no Stop, a machine gone to sleep — or one very long tool call. The
    /// board cannot tell which, but it knows exactly how long it has heard
    /// nothing, and the card says so (`card`).
    /// Never a card with a subagent running: see `Session.isStaleExempt`.
    static let staleAfter: TimeInterval = 10 * 60

    /// What the card wears. The status as sent, or WORKING while the turn is
    /// over and its subagents still run — tint, edge, badge and staleness all
    /// read this, never the bare status.
    private var display: DisplayStatus { session.displayStatus }

    private var statusColor: Color { Theme.color(for: display) }

    /// At an accessibility text size, a card narrower than one board column
    /// stacks: its status on a line of its own above the text, Focus under it.
    ///
    /// Beside the text nothing in the rail can shrink — the status word is the
    /// card's one reading, Focus is a 44pt target with its word — and with the
    /// time and the tokens figure, which are numbers, they needed 335pt of card
    /// at AX1, 461 at AX3 and 604 at AX5, against 343 on a 375pt phone, 408 on
    /// a 6.9" one and 288 in a 320pt window. So from AX2 the card went past
    /// both edges ("CODIN", the F of the name), and a List cannot scroll
    /// sideways to show them. At AX1 it still fits a phone, but beside the
    /// rail the name gets 13 to 18 characters a line, where stacked it gets 19
    /// to 28. Stacked, no line is wider than its widest single piece.
    ///
    /// The status goes above the text, not under it: it is the card's one
    /// reading, and beside the text it stood at the top. Focus goes under, at
    /// the trailing edge it held, over the line that reports on it.
    ///
    /// The step the board takes too: from an accessibility size a phone's
    /// heads stop being pinned (`BoardArrangement.headsScroll`); below it,
    /// beside the text fits every phone with room over. Where the board gives
    /// the card a column at the reader's size — an iPad's two across, its
    /// full width, and a phone held sideways at the smaller accessibility
    /// sizes — the rail fits beside the text, and stays there
    /// (`cardIsColumnWide`).
    private var stacked: Bool { typeSize.isAccessibilitySize && !columnWide }

    var body: some View {
        // The card's own clock: refreshes the relative timestamp and
        // re-evaluates staleness every 30 s, counted from when the card last
        // ran. A card no longer runs for other cards' events (`BoardAction`),
        // so cards that changed at different moments tick at different
        // moments, and a tick measures one card; cards that appeared together
        // — at launch, or after a change they all read, such as the text size
        // — tick together. Crossing into stale shows up to 30 s late.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            // Measured again only when it changes (`MeasuredOnce`).
            MeasuredOnce { card(now: context.date) }
        }
        // What the system lifts for the menu is the card's own rounded shape,
        // not the rectangle around it: against a dimmed board, square corners
        // on a rounded card show the ground through at all four.
        .contentShape(.contextMenuPreview,
                      RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        // One menu, on every card, on every device — and outside the timeline,
        // so the half-minute tick that refreshes the timestamp does not rebuild
        // a menu somebody has open.
        //
        // It used to exist only on a card with a machine, holding the one item
        // below. Every card has it now because Dismiss lives here: on a wide
        // board the cards stand in columns, a column is not a List, and only a
        // List can be swiped. The phone's list keeps its swipe as well.
        .contextMenu {
            if let host = session.host {
                // The focus control is explicit — the card tap stays history —
                // so it is also offered where a long press looks for it.
                focusMenuItem(host)
            }
            Button(role: .destructive) {
                Task { await store.dismiss(session) }
            } label: {
                // A plain x. The swipe's filled disc is left to the blocked
                // mark, which a held card may be showing right above it.
                Label("Dismiss", systemImage: "xmark")
            }
        }
    }

    private func card(now: Date) -> some View {
        let stale = isStale(at: now)
        return VStack(alignment: .leading, spacing: 0) {
            if stacked {
                // One thing to a line: the status, the text, the control
                // (`stacked`). The status is the first line of the content
                // column here (`content`), inside the card's element, so a
                // finger on it hears the card. A card changes arrangement only
                // when the text size or the board's width changes, never with
                // its content.
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    content(now: now, stale: stale)
                    if session.host != nil {
                        FocusControl(session: session)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            } else {
                // Content on the left, a rail on the right carrying the status and
                // the card's one control.
                //
                // The rail is the SHORTER column — badge plus a 44pt button is
                // ~66pt against ~94pt of name, message and metadata — so it never
                // sets the card's height. What it buys is the meta line, which used
                // to stand 44pt tall for no reason except that the button sat in
                // it; with the button gone that row collapses to its ~18pt of text.
                // Roughly 26pt off every card, a fifth of its height.
                //
                // The rail sits OUTSIDE the content's tap gesture on purpose. The
                // gesture covers the column it belongs to and nothing else, so it
                // cannot reach across and swallow the button's tap the way the old
                // full-card NavigationLink overlay did.
                HStack(alignment: .top, spacing: Theme.Space.sm) {
                    content(now: now, stale: stale)
                    rail(stale: stale)
                }
            }

            // The subagents, under the card's own line and across its full
            // width — the rows' states stand under the badge, in the rail's
            // column. Then the meta line, which moves down here whenever the
            // block shows, the count-only "12 done" included: machine, time
            // and spend close the card, under everything it says about its
            // work. Moving it takes it out of the content column's tap, and
            // VoiceOver still has every fact where it always does, as the
            // column's More Content (`content`), so the line itself is hidden,
            // not read twice. The rows' rule is the card's own edge, stale
            // included.
            //
            // A card with no subagents has no block, and is today's card.
            if let subtasks = session.subtasks {
                SubtaskBlock(session: session, subtasks: subtasks, rule: Theme.cardEdge(for: display, stale: stale),
                             stacked: stacked)
                metaLine(now: now, stale: stale)
                    .padding(.top, Theme.Space.xxs)
                    .accessibilityHidden(true)
            }

            // The outcome line: "Brought to front", or why the control is
            // disabled. Full width underneath rather than in the rail, because
            // it is prose — it changes length and would either squeeze the rail
            // or wrap to four words a line inside it. It takes no height when
            // there is nothing to say.
            FocusStatusLine(session: session, host: session.host, now: now)
        }
        .padding(.horizontal, Theme.Space.sm)
        .padding(.vertical, Theme.Space.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The whole surface carries the state, so the board can be sorted by
        // colour before a word is read. This replaces a 4pt coloured stripe
        // down the leading edge: that pattern is the most overused device in
        // dashboard UI and never reads as intentional, whatever colour or
        // corner radius it is given. A large tinted area also reads from much
        // further away than a 4pt sliver.
        //
        // Except on a stale card, which is drawn untinted, on the plain card
        // and its plain edge: the board can no longer vouch for the state the
        // tint would claim (Theme.cardSurface).
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.cardSurface(for: display, stale: stale))
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .strokeBorder(Theme.cardEdge(for: display, stale: stale))
        )
        // No glow. A lit halo is the trading-terminal tell, and it is exactly
        // wrong in a dark room at 1am — which is when this board is read.
        //
        // And nothing dims. A stale card was drawn whole at 0.62 opacity,
        // which took its message to 3.4:1 and its meta line to 2.6:1, under
        // WCAG AA on the card most worth a closer look, and told VoiceOver
        // nothing. It keeps every word at full strength now and says what it
        // is three other ways: the untinted surface, a "?" where its state's
        // glyph was, and "no update for 14m" where its time was. `done` was
        // once dimmed too, from when it meant "finished, nothing to see"; it
        // means the agent is waiting on YOU, the state the board most needs
        // to surface.
        //
        // Crossing into stale is the board's own clock passing a line, not
        // news from the agent, so it is drawn and never animated: whatever
        // animation the update arrived in is dropped.
        .transaction(value: stale) { $0.animation = nil }
    }

    private func isStale(at now: Date) -> Bool { Self.isStale(session, at: now) }

    /// The one stale rule, which the card and the history it opens both
    /// keep, so that the screen a stale card opens does not put back the
    /// tint the card has taken off, and shows the same "?". Never while a
    /// subagent runs (`Session.isStaleExempt`).
    static func isStale(_ session: Session, at now: Date) -> Bool {
        session.status.isActive && !session.isStaleExempt
            && now.timeIntervalSince(session.updatedDate) > staleAfter
    }

    /// Name, message and metadata — everything the card says, and the only part
    /// the whole-card tap belongs to.
    ///
    /// Built in four statements, not one chain, so that the compiler
    /// type-checks each on its own. As one expression it weighed the overloads
    /// of every accessibility modifier together, and checked the actions'
    /// closure again for each combination it tried, 4,608 times. The project's
    /// line in More Content, new in 1.7.0, doubled that work: over 11 s in
    /// Xcode 26.6, and in CI's Xcode 26.3 "unable to type-check this
    /// expression in reasonable time". The modifiers are the same, in the same
    /// order, so the view is the one the chain built. Add a modifier to one of
    /// the four: joined back into one chain, they fail CI's build.
    private func content(now: Date, stale: Bool) -> some View {
        let column = VStack(alignment: .leading, spacing: Theme.Space.xs) {
            if stacked {
                statusBadge(stale: stale)
            }
            nameAndMessage
                // The height its width needs, whatever height it is offered.
                // A card with a status line under it ("MacBook is offline")
                // stacks two children that can each give up a line, and the
                // card's stack shared its height out between them: in a
                // column the name came out as one cut line in a card sized
                // for two. Fixed vertically, the lines are kept and the card
                // grows around them.
                .fixedSize(horizontal: false, vertical: true)

            // Machine, when, how much — see `metaLine`. Under the subagents
            // instead, while the card has any — see `card`.
            if session.subtasks == nil {
                metaLine(now: now, stale: stale)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The tap covers this column and nothing else. It used to sit on a
        // subtree that spanned the full card, which is how it ended up
        // swallowing taps meant for the control. Opening history is the
        // harmless thing to do with a card; raising a window on another
        // machine is not, so only the harmless one is a whole-column gesture.
        .contentShape(Rectangle())
        .onTapGesture { openSession(SessionRoute(sessionId: session.id)) }

        // One element, built rather than combined, and read in the order the
        // card is read by eye: whose session and which (the label), then its
        // state — the card's one reading — and what it last said (the value).
        // Combined, it read every line of this column in turn, and the state,
        // drawn in the rail outside it, came after the name, the message and
        // the whole meta line: a jump landed on the half of the card
        // without it. The badge's word is hidden, so it is not read twice.
        let element = column
            .accessibilityElement(children: .ignore)
            // "Claude, Fix the login redirect"; a Codex Desktop session that
            // started at / is named after its agent, and is "Codex" once
            // (`Session.lead`).
            .accessibilityLabel(session.lead(agent: agentName))
            .accessibilityValue(spokenState(stale: stale, now: now))
            .accessibilityAddTraits(.isButton)
            // The tap, stated, so a double-tap opens history wherever the
            // element's centre happens to fall.
            .accessibilityAction { openSession(SessionRoute(sessionId: session.id)) }
            .accessibilityHint("Opens this session's history")
            .accessibilityFocused(jumpFocus, equals: .card(session.id))

        // The meta line is the lean-in, and waits where VoiceOver keeps one:
        // the More Content rotor. With the children ignored VoiceOver reads
        // nothing else in this column, so whatever is added to the column has
        // to be added here as well.
        let leanIn = element
            .accessibilityCustomContent(.machine, machineFact.map { Text($0) })
            .accessibilityCustomContent(.project, projectFact.map { Text($0) })
            .accessibilityCustomContent(.directory, directoryFact.map { Text($0) })
            .accessibilityCustomContent(.updated, Text(Self.spokenRelativeTime(from: session.updatedDate, to: now)))
            .accessibilityCustomContent(.tokens, session.tokensLabel.map { Text($0) })

        return leanIn
            // Voice Control: "Tap data-pipeline", with or without its agent.
            .accessibilityInputLabels(session.isNamed(for: agentName) ? [agentName]
                                      : [session.name, "\(agentName) \(session.name)"])
            .accessibilityActions {
                if let host = session.host, store.isMachineOnline(host.machine.id) {
                    Button("Bring to front on \(store.machineLabel(for: host))") {
                        send(.focus)
                    }
                    // Offered beside it once a session has ended, as the Resume
                    // button is.
                    if store.focus[session.id]?.resumeOffered == true {
                        Button("Resume on \(store.machineLabel(for: host))") {
                            send(.resume)
                        }
                    }
                }
                // The long-press menu is not something VoiceOver's rotor offers,
                // so where there is no swipe to stand in for it, Dismiss is an
                // action in its own right. In the list the swipe already puts one
                // there, and a second would read "Dismiss, Dismiss".
                if !swipesToDismiss {
                    Button("Dismiss") {
                        Task { await store.dismiss(session) }
                    }
                }
            }
    }

    /// Whose, machine, when, how much — four different facts. The agent's
    /// mark leads, always (`agentMark`), outside everything that gives way.
    /// The machine is the one the card never showed until 1.6; it was buried
    /// in the Focus control's label, so two sessions of the same project on
    /// two machines were indistinguishable at a glance.
    ///
    /// The agent's mark is back on the line because the sections are
    /// projects: Claude's and Codex's cards share them, and the mark is what
    /// tells them apart at a glance. A mark and not the CLAUDE chip 1.6.4
    /// drew, which was the loudest thing on the line saying the least.
    ///
    /// No spacing of its own. The optional facts carry the separator that
    /// FOLLOWS them, and the tokens figure the one before it, so whatever
    /// drops out takes its dot with it. After the mark the optional facts are
    /// first on the line, and a stack that spaced its children would leave a
    /// gap — and a leading "·" — in front of the time whenever they collapsed
    /// to nothing.
    ///
    /// Above the default text size the time and the tokens figure can outgrow
    /// a narrow card by themselves. Both are fixed, because a cut number reads
    /// as a different number, so in a 320pt window at xxxL they and the rail
    /// came to more than the card, and the dot between them was what got
    /// squeezed out. There the figure takes a line of its own under the time
    /// instead, whole, and so it does on a stacked card at the accessibility
    /// sizes, where the line is a phone's width less the card's. The first
    /// candidate is the one line as it always was, chosen whenever it fits,
    /// and at the default size and below this is not a cascade at all.
    private func metaLine(now: Date, stale: Bool) -> some View {
        // Top-aligned: the mark is a line of the same caption text, so its
        // baseline is the first line's whichever candidate is drawn.
        HStack(alignment: .top, spacing: 0) {
            agentMark
            factsLine(now: now, stale: stale)
        }
    }

    /// The agent's neutral mark: an asterisk for Claude, a hexagon for Codex,
    /// a diamond for any other (`Theme.agentSymbol`). Never a colour, and it
    /// never drops: it is outside the facts' cascade, the one thing on the
    /// line nothing else can push off it. In the facts' ink, a step brighter,
    /// so it reads as who before it reads as one more fact. Hidden from
    /// VoiceOver, which hears the agent first in the card's label.
    ///
    /// As wide as the widest of the three marks, whichever this one is: an
    /// asterisk, a hexagon and a diamond are three glyphs of three widths,
    /// and the facts after them start at one place on every card. Measured
    /// from the glyphs themselves rather than set as a number, which at the
    /// accessibility sizes cut the hexagon down to a "C".
    private var agentMark: some View {
        ZStack(alignment: .leading) {
            ForEach(Self.marks, id: \.self) { mark in
                Text(Image(systemName: mark)).hidden()
            }
            Text(Image(systemName: Theme.agentSymbol(for: session.source)))
                .foregroundStyle(Theme.textSecondary)
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .fixedSize()
        .padding(.trailing, markGap)
        .accessibilityHidden(true)
    }

    /// Every mark an agent can have (`Theme.agentSymbol`).
    private static let marks = ["claude", "codex", "other"].map(Theme.agentSymbol(for:))

    @ViewBuilder
    private func factsLine(now: Date, stale: Bool) -> some View {
        if typeSize > .large, let tokensLabel = session.tokensLabel {
            // Each candidate measures what it draws. A stale card's one-line
            // fallback is a candidate of its own: nested inside the first, it
            // was measured by its first option, the words, and so was never
            // chosen — the figure dropped to a second line where one line held.
            ViewThatFits(in: .horizontal) {
                if stale {
                    metaRow {
                        HStack(spacing: 0) { staleWords(now: now); metaSeparator; tokensFigure(tokensLabel) }
                            .fixedSize()
                    }
                    if stacked {
                        // A stacked card has the height, and its line the
                        // width of the card: the words keep their line and
                        // the figure takes the next, where the one-line
                        // fallback below gave the words up for "14m ago" from
                        // AX3, on the card that most needs them said.
                        VStack(alignment: .leading, spacing: 0) {
                            metaRow { staleWords(now: now) }
                            tokensFigure(tokensLabel)
                        }
                    }
                    metaRow {
                        HStack(spacing: 0) { timeText(now: now, stale: true); metaSeparator; tokensFigure(tokensLabel) }
                            .fixedSize()
                    }
                } else {
                    metaRow { timeAndTokens(now: now, stale: false, tokens: tokensLabel) }
                }
                VStack(alignment: .leading, spacing: 0) {
                    metaRow { time(now: now, stale: stale) }
                    tokensFigure(tokensLabel)
                }
            }
            .font(.caption)
            .lineLimit(1)
        } else if stale {
            HStack(spacing: 0) {
                metaLead
                // Offered the width before the facts: on a stale card the
                // words are the news, and the machine or the place is what
                // gives way to them.
                Group {
                    if let tokensLabel = session.tokensLabel {
                        timeAndTokens(now: now, stale: true, tokens: tokensLabel)
                    } else {
                        time(now: now, stale: true)
                    }
                }
                .layoutPriority(1)
                Spacer(minLength: 0)
            }
            .font(.caption)
            .lineLimit(1)
        } else {
            HStack(spacing: 0) {
                metaLead
                time(now: now, stale: false)
                // What this session has spent, and ONLY when the board has a
                // figure for it. An absent total means unknown — reporting
                // off, an agent that doesn't report, or nothing heard yet — so
                // there is no number, no dash and no placeholder, and a card
                // without one looks exactly as it did before this line existed.
                //
                // It rides the meta line instead of taking a row of its own.
                // The cards have been shortened twice on the owner's ask, and a
                // figure that is read on the lean-in has not earned 18pt off
                // the height of every card on the board.
                if let tokensLabel = session.tokensLabel {
                    metaSeparator
                    tokensFigure(tokensLabel)
                }
                Spacer(minLength: 0)
            }
            .font(.caption)
            .lineLimit(1)
        }
    }

    /// The optional facts, then `tail`, measured by `tail` alone.
    ///
    /// The facts propose no width of their own to ViewThatFits (an ideal width
    /// of zero, the device `nameAndMessage` uses for the message), so a
    /// candidate fits when what must be on its line fits, and the facts' own
    /// cascade takes whatever width is left. The tail is offered the width
    /// first, as on a stale card's single line.
    private func metaRow<Tail: View>(@ViewBuilder _ tail: () -> Tail) -> some View {
        HStack(spacing: 0) {
            metaLead.frame(minWidth: 0, idealWidth: 0)
            tail().layoutPriority(1)
            Spacer(minLength: 0)
        }
    }

    /// When the board last heard from the session: "just now", "12m ago".
    /// Short, and a truncated time is worse than no time, so it holds its
    /// width.
    ///
    /// On a stale card it is the news, so it says so — "no update for 14m",
    /// in the brighter secondary ink — and falls back to the plain "14m ago",
    /// still bright, only where the words do not fit. The "?" in the badge and
    /// the untinted surface say the rest, and VoiceOver hears the words
    /// whichever form is drawn (`spokenState`).
    @ViewBuilder
    private func time(now: Date, stale: Bool) -> some View {
        if stale {
            ViewThatFits(in: .horizontal) {
                staleWords(now: now)
                timeText(now: now, stale: true)
            }
        } else {
            timeText(now: now, stale: false)
        }
    }

    /// The time and the tokens figure on one line, as one piece: a stale
    /// card's words with the figure, or its plain time with the figure. Measured
    /// apart, a line that only just fitted squeezed the dot between them to
    /// nothing, so each candidate keeps its own.
    @ViewBuilder
    private func timeAndTokens(now: Date, stale: Bool, tokens: String) -> some View {
        if stale {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 0) { staleWords(now: now); metaSeparator; tokensFigure(tokens) }
                    .fixedSize()
                HStack(spacing: 0) { timeText(now: now, stale: true); metaSeparator; tokensFigure(tokens) }
                    .fixedSize()
            }
        } else {
            HStack(spacing: 0) { timeText(now: now, stale: false); metaSeparator; tokensFigure(tokens) }
                .fixedSize()
        }
    }

    private func timeText(now: Date, stale: Bool) -> some View {
        Text(Self.relativeTime(from: session.updatedDate, to: now))
            .monospacedDigit()
            .foregroundStyle(stale ? Theme.textSecondary : Theme.textTertiary)
            .fixedSize()
    }

    private func staleWords(now: Date) -> some View {
        Text("no update for \(Self.age(from: session.updatedDate, to: now))")
            .monospacedDigit()
            .foregroundStyle(Theme.textSecondary)
            .fixedSize()
    }

    /// What this session has spent. Tabular figures: it ticks in place as the
    /// hook reports, and proportional digits would make the whole line twitch
    /// sideways each time. Tertiary, like the rest of the line: colour here
    /// means state, and a token count is not one.
    ///
    /// Last on the line, after the time. A total first arrives on the hook's
    /// 15-minute throttle — minutes after the card itself — and appending it
    /// leaves everything already on the line where the eye left it. Fixed
    /// width, because "1.2…" reads as a bug: when the line is tight it is the
    /// project label that yields.
    private func tokensFigure(_ label: String) -> some View {
        Text(label)
            .monospacedDigit()
            .foregroundStyle(Theme.textTertiary)
            .fixedSize()
    }

    /// The name, and under it what the session last said.
    ///
    /// The name owns the top line by itself. It used to share the row with
    /// the status badge, pushing it right with a layout priority so a long
    /// name would not be the thing that truncates — the name is how you know
    /// WHICH card this is. With the badge in the rail that contest is gone:
    /// the name simply gets the width.
    ///
    /// And, when one line is not enough, a second. Names used to be folder
    /// names, some twenty characters, and one line held them; now a Claude
    /// session is named by its title, three to eight words, and one line cut
    /// "Fix listener reinstall leaving Focus stopped" to "Fix listener
    /// reinstall leaving…" — the words that say which session it is were the
    /// ones that went. A worktree slug lost its suffix the same way, so two
    /// sibling worktrees read as the same name. Two lines keep both: the
    /// title whole, the slug broken at a hyphen.
    ///
    /// The message gives a line back. A card whose name takes two lines keeps
    /// one line of message, so where the message would have run to two the
    /// card grows by about 6pt (a 24pt line of name for an 18pt line of
    /// message) rather than by a whole line — the cards have been shortened
    /// twice on the owner's ask, and a card that grew by a line for every
    /// title would undo that. A short message was one line anyway, and there
    /// the second line of name is simply added.
    ///
    /// Decided by fit, not by counting characters. The first candidate fits
    /// only when the name fits on one line: its message proposes no width of
    /// its own to ViewThatFits (an ideal width of zero), so the name alone is
    /// what is measured. Laid out, the message takes the full width and wraps
    /// to its two lines as before.
    ///
    /// At an accessibility size the name is never cut, and the message takes
    /// up to four lines; the rest is one tap away. There two lines of name held
    /// 23 characters of a 44-character title at AX4 on a 375pt phone, and the
    /// trade left the message one line: "Approve: …" on the blocked card whose
    /// message is the reason it needs you. A phone pins no heads at those
    /// sizes, so the list has the height.
    @ViewBuilder
    private var nameAndMessage: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                name(lines: nil)
                if !session.message.isEmpty { message(lines: 4) }
            }
        } else if session.message.isEmpty {
            name(lines: 2)
        } else {
            ViewThatFits(in: .horizontal) {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    name(lines: 1)
                    message(lines: 2)
                        .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    name(lines: 2)
                    message(lines: 1)
                }
            }
        }
    }

    private func name(lines: Int?) -> some View {
        Text(session.name)
            .font(.title3.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(lines)
    }

    private func message(lines: Int?) -> some View {
        Text(session.message)
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(lines)
    }

    /// The optional start of the meta line: the machine this session runs on,
    /// and where it is working when it has moved (`placeFact`).
    ///
    /// The two as ONE cascade rather than two independent decisions. They
    /// were separate once: the machine pinned with `.fixedSize()` and the
    /// directory wrapped in its own ViewThatFits. Neither could see the other,
    /// and between them and the timestamp every item on the row had become
    /// unshrinkable. A row that cannot shrink does not truncate — it
    /// overflows, and the card went past the edge of the screen.
    ///
    /// One cascade always has a fitting option, and its order is the
    /// priority, stated once, the same on every card: machine and place, then
    /// the machine, then the place, then nothing. Nothing here is ever cut to
    /// an ellipsis. It used to put the machine first under a title and the
    /// place first under a folder name, because a titled card always said
    /// "in <repo>" and that was the only place it said it. The project's
    /// label says it now, and the place is news only of a move, so the one
    /// order serves both. The machine is not lost when it goes: it is in the
    /// long-press menu's "Bring to front on …" and in the offline note.
    ///
    /// The last candidate is `FitsAsNothing`, not `EmptyView()` — see its
    /// note. With EmptyView last, the cascade fell back to the machine even
    /// where the machine did not fit, so "always has a fitting option" was
    /// not true. In a 340pt side that is the difference between a line that
    /// fits and a card that overflows its side into the other.
    ///
    /// Spelled out case by case rather than with an `if` inside the
    /// ViewThatFits: a false condition contributes no candidate at all, as
    /// EmptyView does not, so the cascade would have a different number of
    /// options depending on the data.
    @ViewBuilder
    private var metaLead: some View {
        let machine = machineFact
        let place = placeFact.map { "in \($0)" }
        switch (machine, place) {
        case let (machine?, place?):
            ViewThatFits(in: .horizontal) {
                metaFacts([machine, place])
                metaFacts([machine])
                metaFacts([place])
                FitsAsNothing()
            }
        case let (machine?, nil):
            ViewThatFits(in: .horizontal) {
                metaFacts([machine])
                FitsAsNothing()
            }
        case let (nil, place?):
            ViewThatFits(in: .horizontal) {
                metaFacts([place])
                FitsAsNothing()
            }
        case (nil, nil):
            EmptyView()
        }
    }

    /// Facts in a row, each followed by its separator.
    ///
    /// `.fixedSize()` here is what lets ViewThatFits measure a candidate at its
    /// full width; it binds this row only, not the line it sits in.
    private func metaFacts(_ facts: [String]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                Text(fact)
                    .lineLimit(1)
                    .foregroundStyle(Theme.textTertiary)
                metaSeparator
            }
        }
        .fixedSize()
    }

    /// The dot between two facts, with the 4pt either side that the line's
    /// own spacing used to supply. Punctuation, so it is not read out.
    ///
    /// textTertiary, the meta line's own ink, as the web board's `.meta-sep`
    /// has it. The hairline is a line colour, not a text one: on a tinted
    /// card it falls to about 1.5:1, and the line reads as one run of words.
    private var metaSeparator: some View {
        Text("·")
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, Theme.Space.xxs)
            .accessibilityHidden(true)
    }

    /// The right rail: what state this session is in, and the one thing you
    /// can do about it.
    ///
    /// Status on top because it is what you read; the control beneath it
    /// because it is what you do about what you read. Both trailing-aligned, so
    /// the rail keeps a clean edge whatever the length of the status word.
    private func rail(stale: Bool) -> some View {
        VStack(alignment: .trailing, spacing: Theme.Space.xs) {
            statusBadge(stale: stale)

            if session.host != nil {
                FocusControl(session: session)
            }
        }
        // The rail takes exactly the width it needs and hands the rest to the
        // content column. Letting it flex would take width from the name and
        // the message, which are the two things the card exists to show.
        //
        // The priority is not decoration. The content column carries
        // `maxWidth: .infinity`, and an HStack serves that greedily — it
        // offered the rail what was left, which was too little for the word
        // "Focus", and the button came out as a bare glyph. Sizing the rail
        // first and giving the remainder to the content is the correct order
        // here anyway: the rail's width is fixed by its longest status word,
        // while the content is the part that should absorb whatever is left.
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
    }

    /// What state the session is in: its glyph and its word, in the state's
    /// colour, the loudest thing on the card.
    ///
    /// A stale card keeps its last reading — the word, in its colour — and
    /// trades the glyph for a question: "? CODING", what the board last heard,
    /// which it can no longer vouch for. In the rail the "?" is drawn in the
    /// state glyph's own space, with the glyph kept but unseen, so the rail is
    /// exactly as wide as it was and nothing on the card re-wraps when the
    /// clock crosses the line. On a stacked card it simply replaces the
    /// glyph. Not a clock, which is idle's glyph, nor an exclamation mark,
    /// which is blocked's.
    ///
    /// Hidden from VoiceOver, which hears the state as the value of the card's
    /// own element, straight after its name (`content`). On a stacked card the
    /// badge sits inside that element, so touching it reads the card. In the
    /// rail it sits outside it, beside the Focus control, and a finger set on
    /// the word itself hears nothing: SwiftUI has no element that answers to
    /// touch but stays out of the swipe order, and a second stop that says the
    /// state again on every card would cost more than the gap.
    private func statusBadge(stale: Bool) -> some View {
        HStack(spacing: 3) {
            Group {
                if stale && stacked {
                    // On its own line nothing beside it can re-wrap, and the
                    // kept glyph's room would only push the "?" in from the
                    // edge the name starts at.
                    Image(systemName: "questionmark")
                } else {
                    Image(systemName: Theme.symbol(for: display))
                        .opacity(stale ? 0 : 1)
                        .overlay(alignment: .trailing) {
                            if stale { Image(systemName: "questionmark") }
                        }
                }
            }
            .font(.caption2.weight(.semibold))
            Text(display.label.uppercased())
                .font(.caption2.weight(.semibold))
                .kerning(0.5)
                // Stacked, the word is offered the card's width rather than
                // its own: it stays one word, a little smaller if it must —
                // "PLANNING" at AX5 is about 257pt of the 264 a 320pt window
                // leaves inside a card — and never "PLANNI…". Beside the text
                // the rail is sized to the word and these are the defaults.
                .lineLimit(stacked ? 1 : nil)
                .minimumScaleFactor(stacked ? 0.8 : 1)
        }
        .foregroundStyle(statusColor)
        .accessibilityHidden(true)
    }

    // MARK: - Focus

    @ViewBuilder
    private func focusMenuItem(_ host: Host) -> some View {
        Button {
            send(.focus)
        } label: {
            Label("Bring to front on \(store.machineLabel(for: host))",
                  systemImage: "macwindow.on.rectangle")
        }
        .disabled(!store.isMachineOnline(host.machine.id))
    }

    private func send(_ type: CommandType) {
        Task { await store.sendCommand(type, for: session) }
    }

    // MARK: - Status badge

    // The pulsing badge that used to live here is gone. It looped forever on
    // every active card, which is ambient animation: it reported nothing, it
    // never stopped, and on a board left open all day it cost battery to say
    // the same thing continuously. Motion on this board now means something
    // changed. The state is carried by the icon, the word and the card's own
    // tint instead — and on a stale card, which keeps only the word, by the
    // "?" and the untinted surface (`statusBadge`).

    // MARK: - Time

    static func relativeTime(from date: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<45:
            return "just now"
        case ..<3600:
            return "\(max(1, seconds / 60))m ago"
        case ..<86_400:
            return "\(seconds / 3600)h ago"
        default:
            return "\(seconds / 86_400)d ago"
        }
    }

    /// relativeTime's span without "ago": "14m", "2h", "3d" — what a stale
    /// card's "no update for" is followed by. Its first reading is "10m",
    /// which states the rule.
    static func age(from date: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<3600: return "\(max(1, seconds / 60))m"
        case ..<86_400: return "\(seconds / 3600)h"
        default: return "\(seconds / 86_400)d"
        }
    }

    /// relativeTime's steps said in words — "14 minutes", "2 hours", "3
    /// days". The face's "14m" is for the eye, and a speech engine may read
    /// it as a length.
    static func spokenAge(of date: Date, at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        let age: DateComponents
        switch seconds {
        case ..<3600: age = DateComponents(minute: max(1, seconds / 60))
        case ..<86_400: age = DateComponents(hour: seconds / 3600)
        default: age = DateComponents(day: seconds / 86_400)
        }
        return spokenUnits.string(from: age) ?? ""
    }

    /// "just now", "12 minutes ago": the meta line's time, spoken.
    static func spokenRelativeTime(from date: Date, to now: Date) -> String {
        now.timeIntervalSince(date) < 45 ? "just now" : "\(spokenAge(of: date, at: now)) ago"
    }

    static let spokenUnits: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = [.minute, .hour, .day]
        return formatter
    }()

    // MARK: - VoiceOver

    /// The machine this session runs on, as the board names it.
    private var machineFact: String? {
        session.host.map { store.machineLabel(for: $0) }
    }

    /// Where the session has moved to, when it has: its live folder, real
    /// and neither its project's nor its own name (`Session.movedTo`). The
    /// face says "in web"; under its project's label a card that has not
    /// moved says nothing, the label having said it for every card under it.
    private var placeFact: String? { session.movedTo }

    /// The project the card is grouped under, for More Content; nothing in
    /// No project, where there is no folder to name.
    private var projectFact: String? { session.projectKey.folder }

    /// The live folder, for More Content, only where it differs from the
    /// project — which, unlike the face's place, it says even when it is the
    /// card's own name (`Session.directory`).
    private var directoryFact: String? { session.directory }

    /// The card's one reading as VoiceOver says it: the state the badge draws;
    /// on a stale card, for how long nothing has been heard, in words, whether
    /// or not the words fitted on the face; then what the session last said.
    private func spokenState(stale: Bool, now: Date) -> String {
        var reading = display.label
        if stale {
            reading += ", no update for \(Self.spokenAge(of: session.updatedDate, at: now))"
        }
        if !session.message.isEmpty {
            reading += ". \(session.message)"
        }
        return reading
    }
}

/// The meta line's facts by name, in its order, for VoiceOver's More Content
/// rotor, the card's project among them now that its section says it rather
/// than its face. Computed rather than stored: the key type is not Sendable.
private extension AccessibilityCustomContentKey {
    static var machine: Self { Self("Machine", id: "machine") }
    static var project: Self { Self("Project", id: "project") }
    static var directory: Self { Self("Directory", id: "directory") }
    static var updated: Self { Self("Updated", id: "updated") }
    static var tokens: Self { Self("Tokens", id: "tokens") }
}

// MARK: - Focus

/// The card's one control, living in the rail beneath the status badge — or,
/// on a card stacked at an accessibility size, on a line of its own under the
/// text, where it does add a 44pt line.
///
/// Split out of the old FocusRow, a full-width footer behind a divider: cards
/// WITH a control stood visibly taller than cards without one, which made the
/// board look ragged. In the rail it costs no height at all, because the rail
/// is the shorter of the card's two columns and the content sets the height.
///
/// "Focus" rather than "Bring to front". The long label is the better sentence
/// but it is ~155pt wide, and in a rail that width comes straight out of the
/// name and the message — the two things you actually read. The verb alone
/// carries it, and the full phrasing survives in the accessibility label and
/// the context menu, where width is free.
private struct FocusControl: View {
    @Environment(SessionStore.self) private var store
    let session: Session

    private var host: Host? { session.host }
    private var online: Bool { host.map { store.isMachineOnline($0.machine.id) } ?? false }
    private var state: SessionStore.FocusState? { store.focus[session.id] }

    var body: some View {
        // Stacked, not side by side. The rail is one button wide; Resume
        // sitting next to Focus would double that width and take it from the
        // name. Resume is also the rare one — it is only offered once a
        // session has ended — so it goes above, out of the thumb's path.
        VStack(alignment: .trailing, spacing: Theme.Space.xxs) {
            // Both spelled out as an icon beside a Text rather than as a
            // `Label`. In a rail sized by its own content, SwiftUI resolved the
            // Label to its icon alone and the word silently vanished — the
            // button rendered as an unlabelled glyph. An HStack cannot be
            // re-styled away by the environment.
            if state?.resumeOffered == true {
                Button { send(.resume) } label: {
                    HStack(spacing: Theme.Space.xxs) {
                        Image(systemName: "play.circle.fill")
                        Text("Resume")
                    }
                }
                .buttonStyle(FocusButtonStyle())
                .disabled(!online)
                // The word on the button, and not the glyph's own name first.
                .accessibilityLabel("Resume")
            }
            Button { send(.focus) } label: {
                HStack(spacing: Theme.Space.xxs) {
                    Image(systemName: "macwindow.on.rectangle")
                    Text("Focus")
                }
            }
            .buttonStyle(FocusButtonStyle())
            .disabled(!online)
            // Starts with the word on the button (WCAG 2.5.3, label in name):
            // Voice Control's "Tap Focus" finds it, and a sighted VoiceOver
            // user hears what they see. The sentence after it says what the
            // word does.
            .accessibilityLabel(
                online && host != nil
                    ? "Focus, bring to front on \(store.machineLabel(for: host!))"
                    : "Focus, bring to front"
            )
            .accessibilityInputLabels(["Focus", "Bring to front"])
        }
        .fixedSize()
    }

    private func send(_ type: CommandType) {
        Task { await store.sendCommand(type, for: session) }
    }
}

/// What the last tap came back with, or why the control is disabled.
///
/// Its own line because it is prose, it changes length, and it is the one part
/// of the card a screen reader should announce as it updates.
private struct FocusStatusLine: View {
    @Environment(SessionStore.self) private var store
    let session: Session
    let host: Host?
    let now: Date

    private var name: String { host.map { store.machineLabel(for: $0) } ?? "" }
    private var online: Bool { host.map { store.isMachineOnline($0.machine.id) } ?? false }
    private var state: SessionStore.FocusState? { store.focus[session.id] }

    /// Why the control is disabled. A machine the board has never seen gets the
    /// hint about the listener; one it has seen says when it left.
    private var offlineNote: String? {
        guard let host, !online else { return nil }
        guard let machine = store.machines[host.machine.id] else {
            return "\(name) is offline — needs the AgStatus listener on that machine"
        }
        guard let lastSeen = machine.lastSeenDate else { return "\(name) is offline" }
        return "\(name) is offline (\(SessionCardView.relativeTime(from: lastSeen, to: now)))"
    }

    /// How long this session waited, once it has stopped waiting.
    private var beat: SessionStore.WaitBeat? { store.beats[session.id] }

    var body: some View {
        Group {
            if let state {
                Text(state.text).foregroundStyle(color(for: state.kind))
            } else if let offlineNote {
                Text(offlineNote).foregroundStyle(Theme.textTertiary)
                    .accessibilityLabel(spokenOfflineNote ?? offlineNote)
            } else if let beat {
                // Last in the order on purpose. A tap you are waiting on and a
                // machine that has gone offline are both things you might act
                // on; this is a fact about something already over, so it yields
                // to either. It is also the quietest thing this line can say —
                // tertiary, caption, no colour of its own. With beats lasting
                // until a card next changes, and `done` being the commonest
                // state, anything louder would be permanent furniture.
                Text(beatLabel(beat)).foregroundStyle(Theme.textTertiary)
                    .accessibilityLabel(spokenBeatLabel(beat))
            }
        }
        .font(.caption)
        .padding(.top, Theme.Space.xxs)
        .motion(.snappy, value: state)
        .motion(.snappy, value: beat)
        .accessibilityElement(children: .combine)
        // Said aloud as it lands. The cursor is on the Focus button, or on
        // the card for its Bring to front action, not on this line: the other
        // machine's answer arrived in silence, and a success clears itself in
        // 8 s. Outcomes only — "Sending…" and "Sent…" acknowledge the tap, and
        // a reader can swipe to them — and the not-connected receipt, which
        // is one. Never the clearing, and never on a row the List re-creates
        // (no `initial`). The line no longer asks VoiceOver to poll it
        // (`.updatesFrequently`): with the cursor on it, every outcome was
        // heard twice.
        .onChange(of: state) { old, new in
            guard let new, new.text != old?.text,
                  new.done || new.text.hasPrefix("Sent —") else { return }
            // "Not running on MacBook" puts a Resume button above Focus, where
            // the cursor is not: say the remedy with the failure.
            let spoken = new.resumeOffered && online ? "\(new.text). Resume is available" : new.text
            var line = AttributedString(spoken)
            line.accessibilitySpeechAnnouncementPriority = new.kind == .fail ? .high : .default
            AccessibilityNotification.Announcement(line).post()
        }
    }

    /// The offline note with its time said in words.
    private var spokenOfflineNote: String? {
        guard let host, !online, let lastSeen = store.machines[host.machine.id]?.lastSeenDate else { return nil }
        return "\(name) is offline, last seen \(SessionCardView.spokenRelativeTime(from: lastSeen, to: now))"
    }

    /// The beat with its duration said in words: "Waited 2 hours 14 minutes".
    private func spokenBeatLabel(_ beat: SessionStore.WaitBeat) -> String {
        let span = Self.spokenDuration.string(from: beat.waited.rounded()) ?? duration(beat.waited)
        switch beat.from {
        case .blocked: return "Waited \(span)"
        default: return "Unseen for \(span)"
        }
    }

    private static let spokenDuration: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = [.hour, .minute]
        return formatter
    }()

    /// `blocked` was waiting on a decision; `done` was not waiting at all — it
    /// finished and sat there. "Waited" would be wrong for the second, and the
    /// card's own status has already moved on by the time this appears, so the
    /// sentence has to carry its own context.
    private func beatLabel(_ beat: SessionStore.WaitBeat) -> String {
        switch beat.from {
        case .blocked: "Waited \(duration(beat.waited))"
        default: "Unseen for \(duration(beat.waited))"
        }
    }

    /// "2h 14m", "18m". Coarse on purpose: a wait reported to the second reads
    /// as precision nobody asked for, and this is a closing note, not a metric.
    private func duration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours >= 1 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(1, minutes))m"
    }

    private func color(for kind: SessionStore.FocusState.Kind) -> Color {
        switch kind {
        case .pending: Theme.textSecondary
        case .ok: Theme.color(for: .done)
        case .fail: Theme.color(for: .blocked)
        }
    }
}

/// It used to be bare text with an icon and no surface, which read as a label
/// someone had forgotten to style rather than something to press. Now that
/// Details has moved to the card tap, a card carries this one control — two
/// only in the moment a resume is on offer — so it can afford a real
/// affordance: its own raised surface, a hairline, and a tinted glyph.
///
/// Still neutral rather than accented. A control is not a state, and the accent
/// on this board means "ready for you" — spending it on a button that is
/// present on every card would make the one colour that matters ordinary.
///
/// 44pt because it is tapped one-handed, often while walking away from the
/// desk, and because the action reaches across to another machine and moves a
/// window: a mis-tap is not free.
private struct FocusButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(isEnabled ? Theme.textPrimary : Theme.textTertiary)
            // 12 rather than 16: every point of the rail's width is a point
            // taken off the name and the message beside it. The 44pt height is
            // what makes this a comfortable target, not the side padding.
            .padding(.horizontal, Theme.Space.sm)
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(configuration.isPressed ? Theme.cardBorder : Theme.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// Where a card sends the board: a session's screen and, when a subagent's
/// row was tapped rather than the card, the subagent to arrive at on it.
///
/// A value of its own for the same reason `UsageDetailRoute` is one: the
/// navigation path holds both, and two routes that were both Strings could
/// be mistaken for each other.
struct SessionRoute: Hashable {
    let sessionId: String
    var subtaskId: String? = nil
}

/// How a card asks the board to open a session's detail.
///
/// An action rather than a NavigationLink: a link inside a List draws its own
/// disclosure chevron and tints with the app accent, and it has to cover the
/// whole row — which is how it ended up swallowing taps meant for the control.
private struct OpenSessionKey: EnvironmentKey {
    static let defaultValue = BoardAction<SessionRoute>(name: "none") { _ in }
}

/// Something a card, a head or the needs-you bar asks the board to do with a
/// key — open a session's history or an agent's usage, which the board pushes
/// onto its own path; open a card's subagents in place; bring the blocked card
/// the bar names into view.
///
/// Equal to any action of the same name, whatever closure it carries. The
/// board makes a fresh one on every pass, and a closure is never equal to the
/// last: written into the environment as a bare closure it changed on every
/// hook event, so every card and head under the board ran its body again and
/// every card was measured again, for an event that was not theirs. Equal, the
/// environment has nothing to pass on, and a head or the bar has nothing new
/// to compare (`AgentHead`'s `==`, `NeedsYouSlot`). Every pass's closure does
/// the same thing, from what the board holds rather than from the pass that
/// made it — its path, or the board as last drawn — so the one a view
/// captured first does what the newest would.
///
/// Keyed by whatever the action is for: a session's route, an agent's source,
/// nothing at all for the bar.
struct BoardAction<Key>: Equatable {
    let name: String
    let run: (Key) -> Void

    func callAsFunction(_ key: Key) { run(key) }

    static func == (lhs: BoardAction, rhs: BoardAction) -> Bool { lhs.name == rhs.name }
}

/// Whether the board gives each card a whole column at the reader's text size
/// (`BoardArrangement.cardIsColumnWide`). The board has measured its width; a
/// card could only learn its own from a reader that decides a frame late.
/// Unknown means no: a card nobody vouches for stacks at an accessibility
/// size, which is the safe way to be wrong.
private struct CardIsColumnWideKey: EnvironmentKey {
    static let defaultValue = false
}

/// Whether the container a card sits in lets it be swiped away.
///
/// Only the phone's List does. The card asks so that it can offer VoiceOver a
/// Dismiss action exactly where the swipe is not already offering one.
private struct CardsSwipeToDismissKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var openSession: BoardAction<SessionRoute> {
        get { self[OpenSessionKey.self] }
        set { self[OpenSessionKey.self] = newValue }
    }

    var cardsSwipeToDismiss: Bool {
        get { self[CardsSwipeToDismissKey.self] }
        set { self[CardsSwipeToDismissKey.self] = newValue }
    }

    var cardIsColumnWide: Bool {
        get { self[CardIsColumnWideKey.self] }
        set { self[CardIsColumnWideKey.self] = newValue }
    }
}

// MARK: - SessionHistoryView

/// The timeline of one agent session: every status/message transition with
/// its timestamp, newest first, in the board's color scheme — and above it,
/// while the session runs subagents, every one of them.
struct SessionHistoryView: View {
    @Environment(SessionStore.self) private var store
    let sessionId: String
    /// The subagent whose row on the card was tapped, when it was a row that
    /// opened this screen: the screen arrives at it.
    var subtaskId: String? = nil

    @State private var events: [HistoryEvent] = []
    @State private var loaded = false
    /// How many answers have been asked for, and which of them is on screen
    /// (`load`).
    @State private var asked = 0
    @State private var shown = 0
    /// The name the screen opened with, kept if the session leaves the board
    /// while it is open. The title used to fall back to the raw session id,
    /// which VoiceOver reads a character at a time.
    @State private var title: String?
    /// The row lit on arrival, for its two seconds.
    @State private var litSubtask: String?
    /// Arrival happens once. Every frame redraws the Subtasks section, and a
    /// redraw must neither light the row again nor move the reader.
    @State private var arrived = false
    /// VoiceOver lands on the arrived row, not on the Back button.
    @AccessibilityFocusState private var focusedSubtask: String?
    /// The list's own minimum row height, handed back to it whenever there is
    /// no Subtasks section to space — see `timeline`.
    @Environment(\.defaultMinListRowHeight) private var inheritedRowHeight
    /// Where the subagents' state starts leading their rows, growing with the
    /// reader's text size — see `SubtaskScreenRow.wideFrom`.
    @ScaledMetric(relativeTo: .subheadline) private var wideFrom = SubtaskScreenRow.wideFrom

    /// The live session, if it is still on the board.
    private var session: Session? {
        store.sessions.first { $0.id == sessionId }
    }

    /// What the server records history for: the status and the line.
    private struct Reading: Equatable {
        let status: AgentStatus
        let message: String
    }

    private var reading: Reading? {
        session.map { Reading(status: $0.status, message: $0.message) }
    }

    var body: some View {
        // Measured, not a size class, as the board is: the state leads each
        // subagent from 600pt of list, so an iPhone in landscape gets it and
        // an iPad in Split View does not.
        GeometryReader { geo in
            Group {
                // The full-screen empty state only where there is nothing else
                // to show. With subagents running, an empty or failed history
                // is the timeline's business alone, and the section above it
                // is painted from the live session whatever the fetch did.
                if events.isEmpty && loaded && session?.subtasks == nil {
                    emptyState
                } else {
                    timeline(wide: geo.size.width - 2 * Theme.Space.md >= wideFrom)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(session?.name ?? title ?? "Session history")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        // Loaded on appear, and again whenever the session's reading changes:
        // its status or its line, which are all history records. Not on every
        // frame: subagents' posts move `updatedAt` all the time and change
        // neither, and refetching on each fetched the same timeline dozens of
        // times a minute. Once the first answer is in, a change waits 300 ms
        // and the next one replaces it, so a burst is one request. Answers are
        // put in order (`load`): each event used to start a task of its own,
        // and two in flight could land in either order.
        .task(id: reading) {
            if title == nil { title = session?.name }
            // Gone from the board, and its history with it on the server, by
            // design: what is on screen stays. Asked again, the server answers
            // with nothing, and the timeline being read turned into "No
            // history yet" under the session's name.
            if loaded && session == nil { return }
            if loaded {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            await load()
        }
        .onChange(of: session?.name) { _, name in if let name { title = name } }
        .refreshable { await load() }
    }

    private func load() async {
        if store.isDemo {
            if let session {
                events = DemoData.history(for: session)
            }
            loaded = true
            return
        }
        guard let board = store.board else {
            loaded = true
            return
        }
        asked += 1
        let answer = asked
        // Not cancelled with the task that asked for it. A session that posts
        // faster than one round trip — parallel tool calls, a slow tunnel —
        // would cancel every request before its answer came, and the screen
        // would stay blank for as long as the burst lasted.
        let fetched = await Task { try? await AgStatusAPI.history(of: sessionId, for: board) }.value
        // An answer older than the one on screen is dropped, never laid over
        // it. The pull to refresh is ordered the same way.
        guard answer > shown else { return }
        shown = answer
        if let fetched { events = fetched }
        loaded = true
    }

    // MARK: Timeline

    private func timeline(wide: Bool) -> some View {
        ScrollViewReader { scroller in
            List {
                if let session {
                    headerRow(session)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
                }
                if let subtasks = session?.subtasks {
                    subtaskSection(subtasks, wide: wide)
                }
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    HistoryRow(
                        event: event,
                        isFirst: index == 0,
                        isLast: index == events.count - 1
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            // The Subtasks section is spaced by its own rows' heights and
            // insets, as the design draws it, so the list's minimum row height
            // (52pt on iOS 26, read on 26.5 on a phone and an iPad alike) is
            // taken off while it shows: otherwise every short row in it, and
            // the header above it, is stood up to 52 and the section drifts
            // apart by a different amount on every OS. Without the section the
            // inherited value is passed straight back, and the screen is as it
            // was.
            .environment(\.defaultMinListRowHeight, session?.subtasks == nil ? inheritedRowHeight : 0)
            .motion(.snappy, value: events)
            .task { await arrive(using: scroller) }
        }
    }

    /// Every subagent, above the timeline: the section's name with its counts,
    /// a row for each, the done count, and then the timeline's own name —
    /// without which the timeline would read as more of the same list.
    ///
    /// The done line and the timeline's name share a row: on their own, each
    /// would be stood up to a list row's minimum height, and the gap between
    /// the subagents and the timeline would be drawn by the list rather than
    /// by this.
    @ViewBuilder
    private func subtaskSection(_ subtasks: Subtasks, wide: Bool) -> some View {
        SubtaskSectionLabel(title: SubtaskCopy.section,
                            detail: SubtaskCopy.counts(running: subtasks.running,
                                                       blocked: subtasks.blocked,
                                                       failed: subtasks.failed))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            // 22pt under the capsules, of which the row above brings its 4.
            .listRowInsets(EdgeInsets(top: 18, leading: 16, bottom: 6, trailing: 16))
        ForEach(SubtaskScreenRow.ordered(subtasks.items)) { item in
            SubtaskScreenRow(item: item, wide: wide, lit: litSubtask == item.id)
                .accessibilityFocused($focusedSubtask, equals: item.id)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                // 8 in from the edge, and the row's own 8 inside: its text
                // lines up with everything else, and its lit ground reaches
                // past the text on either side.
                .listRowInsets(EdgeInsets(top: 0, leading: Theme.Space.xs, bottom: 0, trailing: Theme.Space.xs))
        }
        VStack(alignment: .leading, spacing: 0) {
            if subtasks.done > 0 {
                Text(SubtaskCopy.doneThisTurn(subtasks.done))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, Theme.Space.xxs)
            }
            SubtaskSectionLabel(title: SubtaskCopy.timeline)
                .padding(.top, 22)
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 6, trailing: 16))
        if events.isEmpty && loaded {
            emptyState
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }

    /// Opened from a card's row: the row is brought to the centre, VoiceOver
    /// moves to it, and its ground is lit for two seconds, then goes out —
    /// faded, or at once with Reduce Motion. A subagent that has gone by the
    /// time the screen opens leaves it at the top, unlit.
    private func arrive(using scroller: ScrollViewProxy) async {
        guard !arrived else { return }
        arrived = true
        guard let subtaskId,
              session?.subtasks?.items.contains(where: { $0.id == subtaskId }) == true else { return }
        // A list asked to scroll before it has laid its rows out has nothing
        // to scroll, and the push is still sliding the screen in.
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        scroller.scrollTo(subtaskId, anchor: .center)
        litSubtask = subtaskId
        focusedSubtask = subtaskId
        #if DEBUG
        // A frozen demo is being photographed, and a light that goes out on
        // a timer turns the capture into a race — as `BoardView.fadeRing`.
        if DemoData.isFrozen { return }
        #endif
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else {
            litSubtask = nil
            return
        }
        withMotion(.easeOut(duration: 0.6)) { litSubtask = nil }
    }

    /// The state the session is in, drawn as the card that was tapped to get
    /// here draws it, and where it works, in the outlined box Android's
    /// history draws.
    ///
    /// It wore a pill: the state's word on the state's colour at 16%, with a
    /// 35% border, beside a filled chip. That is the status badge of the admin
    /// panels this board is not, it said what the row under it says, and on a
    /// stale session it put back the tint the card had taken off. Now it is
    /// the card's own badge — glyph and word in the state's colour, "?" for
    /// the glyph once the board can no longer vouch for it.
    ///
    /// One element, so VoiceOver does not open the screen on a bare folder
    /// name and then a bare word.
    ///
    /// One line while the box and the badge fit beside each other. Where they
    /// do not, the badge takes a line of its own above the box, as a stacked
    /// card puts its state first: squeezed beside the box its word broke in
    /// two, "COD-ING" at AX4 on an SE.
    ///
    /// What the session wears now, WORKING included, so the badge agrees
    /// with the card even where the newest event, which records the wire,
    /// still reads `testing · 2 subagents still running`.
    private func headerRow(_ session: Session) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let stale = SessionCardView.isStale(session, at: context.date)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Space.sm) {
                    projectBox(session)
                    Spacer(minLength: 0)
                    headerBadge(session, stale: stale, keepsGlyphWidth: true)
                }
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    headerBadge(session, stale: stale, keepsGlyphWidth: false)
                    projectBox(session)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(headerLabel(session, stale: stale, now: context.date))
        }
    }

    /// The directory, outlined. A long one wraps inside its box rather than
    /// being cut: it is the one place the screen says where the session works.
    @ViewBuilder
    private func projectBox(_ session: Session) -> some View {
        if !session.project.isEmpty {
            Text(session.project)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .strokeBorder(Theme.cardBorder)
                )
        }
    }

    /// The card's badge: glyph and word in the state's colour, "?" for the
    /// glyph once the board can no longer vouch for the state. One word,
    /// a little smaller if it must be, never broken.
    ///
    /// Beside the box the "?" is drawn in the glyph's own room, as the card's
    /// rail draws it: it is about 10pt narrower than the coding glyph, and the
    /// header chose between one line and two by that width, so crossing into
    /// stale moved the whole timeline 22pt. On a line of its own it replaces
    /// the glyph, as on a stacked card.
    private func headerBadge(_ session: Session, stale: Bool, keepsGlyphWidth: Bool) -> some View {
        HStack(spacing: 3) {
            Group {
                if stale && !keepsGlyphWidth {
                    Image(systemName: "questionmark")
                } else {
                    Image(systemName: Theme.symbol(for: session.displayStatus))
                        .opacity(stale ? 0 : 1)
                        .overlay(alignment: .trailing) {
                            if stale { Image(systemName: "questionmark") }
                        }
                }
            }
            Text(session.displayStatus.label.uppercased())
                .kerning(0.5)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(Theme.color(for: session.displayStatus))
    }

    /// "Directory acme-api. Coding", and on a stale session "Coding, no
    /// update for 14 minutes", as the card says it.
    private func headerLabel(_ session: Session, stale: Bool, now: Date) -> String {
        var state = session.displayStatus.label
        if stale {
            state += ", no update for \(SessionCardView.spokenAge(of: session.updatedDate, at: now))"
        }
        return session.project.isEmpty ? state : "Directory \(session.project). \(state)"
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
            Text("No history yet")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Events appear here as the agent works.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(32)
    }
}

// MARK: - HistoryRow

private struct HistoryRow: View {
    /// The line above the dot, grown with the status beside it so the dot
    /// stays level with its word: fixed at 10pt it floated above the word at
    /// the accessibility sizes, in the gap between two rows.
    @ScaledMetric(relativeTo: .subheadline) private var dotLead: CGFloat = 10
    let event: HistoryEvent
    let isFirst: Bool
    let isLast: Bool

    private var color: Color { Theme.color(for: event.status) }

    /// "18:42" for today, "Jul 26, 18:42" otherwise.
    private var timeText: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(event.date) {
            return event.date.formatted(date: .omitted, time: .shortened)
        }
        return event.date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Timeline gutter: colored dot on a continuous line.
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : Theme.cardBorder)
                    .frame(width: 2, height: dotLead)
                // No glow: the latest event is the top row, its message in
                // the primary ink, which says it without light.
                Circle()
                    .fill(color)
                    .frame(width: 9, height: 9)
                Rectangle()
                    .fill(isLast ? Color.clear : Theme.cardBorder)
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 12)

            VStack(alignment: .leading, spacing: 3) {
                // One line while the three fit. Where they do not, the times
                // go under the status instead of every word being squeezed
                // into a third of the row: at AX4 on a 375pt phone "Planning"
                // broke as "Plan|ning", and "5:49 PM" as "5:4|9".
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        statusText
                        Spacer(minLength: 8)
                        clockText
                        agoText
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        statusText
                        HStack(alignment: .firstTextBaseline, spacing: 8) { clockText; agoText }
                    }
                    VStack(alignment: .leading, spacing: 2) { statusText; clockText; agoText }
                }
                if !event.message.isEmpty {
                    Text(event.message)
                        .font(.subheadline)
                        .foregroundStyle(isFirst ? Theme.textPrimary : Theme.textSecondary)
                        // The history is where a message is read whole, so it
                        // takes the lines it needs. Three held most at the
                        // default size, but not the hook's 120-character
                        // prompts from xL on an SE or from xxL on a 6.1"
                        // phone: the larger the text, the less of the message
                        // there was, on the screen the card sends you to for
                        // the rest of it.
                        .lineLimit(nil)
                }
            }
            .padding(.vertical, 10)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([event.status.label, event.message, timeText].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    /// The state's glyph and its word. The row carried its state in the dot
    /// and in the word's colour, two carriers that are both hue; the glyph is
    /// the card's own, as the web's and Android's timelines draw it. Inline
    /// in the text, so it sits on the word's baseline and grows with it.
    ///
    /// One line, a little smaller if it must be, as a stacked card's badge
    /// is: with Bold Text at AX5 in a 320pt window "Planning" and its glyph
    /// come to 272pt of a 264pt column, and the glyph was left alone on a line
    /// above its word.
    private var statusText: some View {
        Text("\(Image(systemName: Theme.symbol(for: event.status))) \(event.status.label)")
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private var clockText: some View {
        Text(timeText)
            .font(.caption.monospacedDigit())
            .foregroundStyle(Theme.textSecondary)
    }

    /// One step under the clock time beside it, as a token: 5.88:1. It was
    /// the secondary ink at 60%, 3.68:1, under AA.
    private var agoText: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(SessionCardView.relativeTime(from: event.date, to: context.date))
                .font(.caption2)
                .foregroundStyle(Theme.textTertiary)
        }
    }
}
