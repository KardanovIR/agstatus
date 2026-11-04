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
    /// Whose session this is, spelled as its section's head spells it.
    ///
    /// The card no longer shows it. It used to carry the agent in a chip on
    /// its meta line, and now says it by where it sits — under that agent's
    /// head, in that agent's column — which a screen reader cannot see. So the
    /// name is still handed in, and goes into the card's label and nowhere on
    /// its face.
    let agentName: String
    /// Set by the board when an alarm brings this card into view, so that
    /// VoiceOver lands on the card and not on the alarm that was pressed.
    let jumpFocus: AccessibilityFocusState<JumpTarget?>.Binding

    /// An active card that has heard nothing for this long is stale: most
    /// likely a dead agent — killed mid-turn, an interrupted turn, which fires
    /// no Stop, a machine gone to sleep — or one very long tool call. The
    /// board cannot tell which, but it knows exactly how long it has heard
    /// nothing, and the card says so (`card`).
    static let staleAfter: TimeInterval = 10 * 60

    private var statusColor: Color { Theme.color(for: session.status) }

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
    /// The step the board takes too: from an accessibility size a phone pins
    /// the agent line (`BoardArrangement.headsScroll`); below it, beside the
    /// text fits every phone with room over. Where the board gives the card a
    /// column at the reader's size — an iPad's columns, its full width, and a
    /// phone held sideways at the smaller accessibility sizes — the rail fits
    /// beside the text, and stays there (`cardIsColumnWide`).
    private var stacked: Bool { typeSize.isAccessibilitySize && !columnWide }

    var body: some View {
        // One shared clock: refreshes the relative timestamp and re-evaluates
        // staleness every 30 s.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            card(now: context.date)
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
                .fill(Theme.cardSurface(for: session.status, stale: stale))
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .strokeBorder(Theme.cardEdge(for: session.status, stale: stale))
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

    private func isStale(at now: Date) -> Bool {
        session.status.isActive && now.timeIntervalSince(session.updatedDate) > Self.staleAfter
    }

    /// Name, message and metadata — everything the card says, and the only part
    /// the whole-card tap belongs to.
    private func content(now: Date, stale: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
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

            // Machine, when, how much — see `metaLine`.
            metaLine(now: now, stale: stale)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The tap covers this column and nothing else. It used to sit on a
        // subtree that spanned the full card, which is how it ended up
        // swallowing taps meant for the control. Opening history is the
        // harmless thing to do with a card; raising a window on another
        // machine is not, so only the harmless one is a whole-column gesture.
        .contentShape(Rectangle())
        .onTapGesture { openSession(session.id) }
        // One element, built rather than combined, and read in the order the
        // card is read by eye: whose session and which (the label), then its
        // state — the card's one reading — and what it last said (the value).
        // Combined, it read every line of this column in turn, and the state,
        // drawn in the rail outside it, came after the name, the message and
        // the whole meta line: an alarm's jump landed on the half of the card
        // without it. The badge's word is hidden, so it is not read twice.
        //
        // The meta line is the lean-in, and waits where VoiceOver keeps one:
        // the More Content rotor. With the children ignored VoiceOver reads
        // nothing else in this column, so whatever is added to the column has
        // to be added here as well.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.name.isEmpty ? agentName : "\(agentName), \(session.name)")
        .accessibilityValue(spokenState(stale: stale, now: now))
        .accessibilityAddTraits(.isButton)
        // The tap, stated, so a double-tap opens history wherever the
        // element's centre happens to fall.
        .accessibilityAction { openSession(session.id) }
        .accessibilityHint("Opens this session's history")
        .accessibilityFocused(jumpFocus, equals: .card(session.id))
        .accessibilityCustomContent(.machine, machineFact.map { Text($0) })
        .accessibilityCustomContent(.directory, directoryFact.map { Text($0) })
        .accessibilityCustomContent(.updated, Text(Self.spokenRelativeTime(from: session.updatedDate, to: now)))
        .accessibilityCustomContent(.tokens, session.tokensLabel.map { Text($0) })
        // Voice Control: "Tap data-pipeline", with or without its agent.
        .accessibilityInputLabels(session.name.isEmpty ? [agentName] : [session.name, "\(agentName) \(session.name)"])
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

    /// Machine, when, how much — three different facts. The machine is the
    /// one the card never showed; it was buried in the Focus control's label,
    /// so two sessions of the same project on two machines were
    /// indistinguishable at a glance.
    ///
    /// The agent used to lead this line, in a chip. It is gone: the card now
    /// sits under its agent's head, and a chip repeating the section's title
    /// on every card in the section was the loudest thing on the line saying
    /// the least.
    ///
    /// No spacing of its own. The optional facts carry the separator that
    /// FOLLOWS them, and the tokens figure the one before it, so whatever
    /// drops out takes its dot with it. With the chip gone the optional facts
    /// are first on the line, and a stack that spaced its children would
    /// leave a gap — and the old leading "·" — in front of the time whenever
    /// they collapsed to nothing.
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
    @ViewBuilder
    private func metaLine(now: Date, stale: Bool) -> some View {
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
    /// message is the reason it needs you. The agent line is what a phone pins
    /// at those sizes, so the list has the height.
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

    /// Whether the name is a title the agent gave the session, rather than
    /// the folder it started in.
    ///
    /// No field says so — the board sends one `name` either way — so this
    /// goes by what each looks like: a title is words, and a folder name or a
    /// worktree slug is one. Codex sessions are never titled, and nor is a
    /// Claude CLI session until somebody runs `/rename`.
    private var isTitled: Bool { session.name.contains(" ") }

    /// The optional start of the meta line: the machine this session runs on,
    /// and the working directory when it has diverged from the card's name.
    ///
    /// The two as ONE cascade rather than two independent decisions. They
    /// were separate once: the machine pinned with `.fixedSize()` and the
    /// directory wrapped in its own ViewThatFits. Neither could see the other,
    /// and between them and the timestamp every item on the row had become
    /// unshrinkable. A row that cannot shrink does not truncate — it
    /// overflows, and the card went past the edge of the screen.
    ///
    /// One cascade always has a fitting option, and its order is the
    /// priority, stated once, and nothing here is ever cut to an ellipsis.
    ///
    /// Which of the two goes first depends on what the name is. Under a
    /// folder name the directory goes first: it is where an untitled session
    /// has moved to, usually the same repo the name already says, and the
    /// name still tells you which card this is. Under a title it is the
    /// machine that goes first. A title says what the session is doing and
    /// not where, and "in <repo>" was added to the line for exactly that —
    /// yet with the directory dropped first, whether a phone showed the repo
    /// came down to how long the machine's name was: "Mac" left room for it,
    /// "MacBook Pro" did not. The machine is not lost when it goes: it is in
    /// the long-press menu's "Bring to front on …" and in the offline note.
    ///
    /// The last candidate is `FitsAsNothing`, not `EmptyView()` — see its
    /// note. With EmptyView last, the cascade fell back to the machine even
    /// where the machine did not fit, so "always has a fitting option" was
    /// not true. In a 340pt column that is the difference between a line that
    /// fits and a card that overflows its column into the next agent's.
    ///
    /// Spelled out case by case rather than with an `if` inside the
    /// ViewThatFits: a false condition contributes no candidate at all, as
    /// EmptyView does not, so the cascade would have a different number of
    /// options depending on the data.
    @ViewBuilder
    private var metaLead: some View {
        let machine = machineFact
        // The directory appears whenever it says something the name does not.
        // The name is the session's title when the agent has one (the Claude
        // app titles every session, `/rename` titles one in the CLI) and the
        // folder it started in otherwise, held for the session's life;
        // `project` follows the live directory, with a Claude worktree root
        // reported as its repository rather than the folder name the app made
        // up. So a titled card reads "in <repo>" — where that work is
        // happening, which a title does not say — a card at a worktree root
        // reads "feature-x · in my-repo" from its first event, and any other
        // untitled card shows the directory only once the session has moved.
        // Either way it is context, never identity.
        let place = directoryFact.map { "in \($0)" }
        switch (machine, place) {
        case let (machine?, place?):
            if isTitled {
                ViewThatFits(in: .horizontal) {
                    metaFacts([machine, place])
                    metaFacts([place])
                    metaFacts([machine])
                    FitsAsNothing()
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    metaFacts([machine, place])
                    metaFacts([machine])
                    FitsAsNothing()
                }
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
                    Image(systemName: Theme.symbol(for: session.status))
                        .opacity(stale ? 0 : 1)
                        .overlay(alignment: .trailing) {
                            if stale { Image(systemName: "questionmark") }
                        }
                }
            }
            .font(.caption2.weight(.semibold))
            Text(session.status.label.uppercased())
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

    /// The working directory, when it says something the name does not (see
    /// `metaLead`).
    private var directoryFact: String? {
        !session.project.isEmpty && session.project != session.name ? session.project : nil
    }

    /// The card's one reading as VoiceOver says it: the state the badge draws;
    /// on a stale card, for how long nothing has been heard, in words, whether
    /// or not the words fitted on the face; then what the session last said.
    private func spokenState(stale: Bool, now: Date) -> String {
        var reading = session.status.label
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
/// rotor. Computed rather than stored: the key type is not Sendable.
private extension AccessibilityCustomContentKey {
    static var machine: Self { Self("Machine", id: "machine") }
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

/// How a card asks the board to open a session's detail.
///
/// A closure rather than a NavigationLink: a link inside a List draws its own
/// disclosure chevron and tints with the app accent, and it has to cover the
/// whole row — which is how it ended up swallowing taps meant for the control.
private struct OpenSessionKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
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
    var openSession: (String) -> Void {
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
/// its timestamp, newest first, in the board's color scheme.
struct SessionHistoryView: View {
    @Environment(SessionStore.self) private var store
    let sessionId: String

    @State private var events: [HistoryEvent] = []
    @State private var loaded = false

    /// The live session, if it is still on the board.
    private var session: Session? {
        store.sessions.first { $0.id == sessionId }
    }

    var body: some View {
        Group {
            if events.isEmpty && loaded {
                emptyState
            } else {
                timeline
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(session?.name ?? sessionId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
        // Live: any update to this session (new SSE event) refreshes the list.
        .onChange(of: session?.updatedAt) {
            Task { await load() }
        }
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
        if let fetched = try? await AgStatusAPI.history(of: sessionId, for: board) {
            events = fetched
        }
        loaded = true
    }

    // MARK: Timeline

    private var timeline: some View {
        List {
            if let session {
                headerRow(session)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
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
        .motion(.snappy, value: events)
    }

    private func headerRow(_ session: Session) -> some View {
        HStack(spacing: 10) {
            if !session.project.isEmpty {
                Text(session.project)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Theme.cardBorder))
            }
            Spacer()
            Text(session.status.label)
                .font(.system(.caption, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.color(for: session.status))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(Theme.color(for: session.status).opacity(0.16)))
                .overlay(Capsule().strokeBorder(Theme.color(for: session.status).opacity(0.35)))
        }
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
                    .frame(width: 2, height: 10)
                Circle()
                    .fill(color)
                    .frame(width: 9, height: 9)
                    .shadow(color: color.opacity(isFirst ? 0.6 : 0), radius: 3)
                Rectangle()
                    .fill(isLast ? Color.clear : Theme.cardBorder)
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 12)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(event.status.label)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(color)
                    Spacer(minLength: 8)
                    Text(timeText)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(SessionCardView.relativeTime(from: event.date, to: context.date))
                            .font(.caption2)
                            .foregroundStyle(Theme.textSecondary.opacity(0.6))
                    }
                }
                if !event.message.isEmpty {
                    Text(event.message)
                        .font(.subheadline)
                        .foregroundStyle(isFirst ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(3)
                }
            }
            .padding(.vertical, 10)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(event.status.label), \(event.message), \(timeText)")
    }
}
