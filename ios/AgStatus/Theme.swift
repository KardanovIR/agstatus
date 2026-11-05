//
//  Theme.swift
//  AgStatus
//
//  The board's design tokens, ported from public/tokens.css. The reasoning
//  lives in .impeccable.md at the repo root; the short version is here, because
//  the *why* is what stops a palette drifting back into defaults.
//
//  WHY THESE VALUES. They are authored in OKLCH on the web, where lightness is
//  perceptually uniform and a tint can be derived from a base rather than typed
//  by hand. SwiftUI has no OKLCH, so each one is converted to sRGB once, here,
//  and the OKLCH original is written beside it: that is the source of truth, and
//  a change on either platform has to start from it.
//
//  WHY GREEN. An earlier pass was warm — amber accent, warm-tinted neutrals —
//  on the argument that aviation instruments are lit warm at night to protect
//  dark adaptation. The owner rejected it: amber IS the caution convention, and
//  the accent also coloured the most common state, so the board spent all day
//  implying a warning. Every neutral is now tinted toward hue 155 at chroma
//  under 0.012 — imperceptible as colour, but it stops the ground reading as
//  the cold blue-black of every other agent dashboard.
//

import SwiftUI
import UIKit

enum Theme {

    // MARK: - Surfaces
    //
    // Low-glare on purpose: the card sits at 20.5% lightness, not black. This
    // board is read in a dark room, late, and a bright card in a dark room is
    // the glare the design exists to avoid.

    /// oklch(16.5% 0.008 155)
    static let background = rgb(0x0C0F0D)
    /// oklch(20.5% 0.009 155)
    static let card = rgb(0x141815)
    /// oklch(24.5% 0.010 155) — raised: tracks, pressed states
    static let raised = rgb(0x1D221E)
    /// oklch(30% 0.011 155)
    static let cardBorder = rgb(0x2A302B)
    /// oklch(38% 0.012 155)
    /// Hairlines, emphatic: a RULE, never a glyph.
    ///
    /// 1.80:1 against a card. It was the "·" between the facts on a card's meta
    /// line until the web board's audit caught the same token failing there at
    /// 1.52:1 — a separator is text whatever job it is doing, and takes
    /// `textTertiary`.
    static let hairlineStrong = rgb(0x3E4440)

    // MARK: - Text
    //
    // All three clear WCAG AA on `card`, and on every state-tinted card. The
    // palette this replaces used a tertiary at 2.90:1 for the project name and
    // the timestamp — the two things you most need to read at a glance.

    /// oklch(94% 0.010 155)
    static let textPrimary = rgb(0xE6EDE8)
    /// oklch(74% 0.012 155)
    static let textSecondary = rgb(0xA5ADA7)
    /// oklch(64.5% 0.012 155) — lifted from 60% to survive the card tint below
    static let textTertiary = rgb(0x88908A)

    // MARK: - State
    //
    // Grouped by WHO IS WAITING, not by lifecycle stage — that is the only
    // question this board exists to answer.
    //
    //   YOUR TURN, carrying the chroma:
    //     blocked  the agent stopped and needs approval or input
    //     done     the agent finished its turn (the hook's `Stop`)
    //   THE AGENT IS WORKING, receding:
    //     planning / coding / testing — nothing is required of you
    //
    // `planning` was 0.075 chroma at hue 285 and measured 0.107 ΔE from `idle`
    // in OKLab: close enough that a planning card read as an idle one. It is
    // 0.169 away now, and still capped under `done`'s chroma so an
    // agent-is-working state can never out-shout a your-turn one.
    //
    // An earlier pass ranked these by stage, which put the brightest colour on
    // `coding` (the most COMMON state) and the dimmest on the states that
    // actually need you. Backwards for a board read at a glance: the accent
    // belongs on the important state, not the frequent one.
    //
    // `idle` is now rare — only SessionStart emits it — so it is quiet.

    static func color(for status: AgentStatus) -> Color {
        switch status {
        case .idle: rgb(0x89968D)      // oklch(66% 0.020 155)
        case .planning: rgb(0xD4A3DF)  // oklch(78% 0.100 320)
        case .coding: rgb(0x78B2DB)    // oklch(74% 0.085 240)
        case .testing: rgb(0x69BABF)   // oklch(74% 0.080 200)
        case .blocked: rgb(0xF75E51)   // oklch(68% 0.190 28)
        case .done: rgb(0x69C88E)      // oklch(76% 0.125 155) — the accent
        }
    }

    /// The board's accent: the colour of "ready for you". An ink, for dark
    /// surfaces: never the fill behind a white label (`accentFill`).
    ///
    /// The asset catalogue's AccentColor is a copy of this value, typed by
    /// hand, which the system tints untinted controls with. Change one, change
    /// both.
    static let accent = color(for: .done)

    /// The fill of a prominent button — "Pair your computer", "Start over" —
    /// where iOS draws the label in white on the tint. White on `accent` is
    /// 2.05:1, the faintest words the app drew, on the one call to action
    /// each of those screens has. This is the accent's hue taken down to 52%,
    /// oklch(52% 0.125 155): white on it 5.19:1, and 3.71:1 against the page,
    /// so the button still reads as one. Dark rather than a dark label on the
    /// light green, which would be the brightest area on a dark screen: the
    /// glare this board is built to avoid.
    static let accentFill = rgb(0x0C7D48)

    /// The fill behind white words and glyphs that dismiss something — the
    /// list's swipe, where iOS draws the title in white on the tint. White on
    /// `blocked` itself is 3.15:1; this is the blocked hue taken down to 56%,
    /// oklch(56% 0.190 28): white on it 5.13:1.
    static let destructiveFill = rgb(0xCC342D)

    /// A card's own surface, tinted by its state.
    ///
    /// These are PRECOMPUTED from the web's `color-mix(in oklab, card 90%,
    /// state)` — 86% for blocked — rather than mixed here at run time.
    ///
    /// The first cut mixed in linear sRGB and looked nothing like the web: a
    /// bright colour dominates a linear blend, so "10%" landed three to four
    /// times heavier than intended and the cards came out as saturated slabs
    /// of blue, teal and red. `blocked` rendered 0x672A24, a strong red, where
    /// the web's own mix gives 0x30231D — a warmth you have to look for.
    /// Perceptual and linear blending are not interchangeable at these
    /// lightnesses, and the tint is subtle enough that being wrong by 3x is
    /// the difference between a design and a mess.
    ///
    /// Baking them also means the two platforms share one recipe: change a
    /// state colour and both tables are regenerated from the same oklab maths.
    /// No script does it, so the recipes written here are the only record of
    /// how; each hex below is that mix to within one unit.
    ///
    /// STALE — an active card that has heard nothing for ten minutes
    /// (`SessionCardView.staleAfter`) — is the same mix with the state's share
    /// at nothing, which is `card` itself, and is iOS's alone so far: the web
    /// still fades a stale card. No tint, because the board can no
    /// longer vouch for the state the tint would claim. Every text token
    /// clears AA on it, the meta line at 5.47:1 the lowest, where the 0.62
    /// fade this replaces left the message at 3.4:1 and the meta line at 2.6.
    /// It is also darker than every tinted surface (1.15:1 against coding's),
    /// which is what reads from across the room.
    static func cardSurface(for status: AgentStatus, stale: Bool = false) -> Color {
        if stale { return card }
        return switch status {
        case .idle: rgb(0x1E231F)
        case .planning: rgb(0x242426)
        case .coding: rgb(0x1D2525)
        case .testing: rgb(0x1C2623)
        case .blocked: rgb(0x30231D)
        case .done: rgb(0x1C271F)
        }
    }

    /// A card's border: `color-mix(in oklab, cardBorder 62%, state)`, the
    /// web's card edge (card.css). Not the surfaces' 90%, which would take
    /// the edges against the page from 2.5–3.0:1 to 1.6–1.7:1. Blocked keeps a
    /// brighter edge, the state at 42% alpha (the web's `--state-line`),
    /// because it is the one state that means a human is needed. A stale
    /// card's is `cardBorder` itself, for the reason its surface is `card`.
    static func cardEdge(for status: AgentStatus, stale: Bool = false) -> Color {
        if stale { return cardBorder }
        return switch status {
        case .idle: rgb(0x4C544E)
        case .planning: rgb(0x66596A)
        case .coding: rgb(0x475E69)
        case .testing: rgb(0x43615F)
        case .done: rgb(0x43664F)
        case .blocked: color(for: .blocked).opacity(0.42)
        }
    }

    // MARK: - Limits
    //
    // A plan meter is the one place a traffic light is right. It is not a
    // status — it is one measure travelling toward a hard stop, and the whole
    // reason to look at it is to catch it before it lands. Amber here is the
    // caution convention doing its actual job, which is why it belongs on a
    // limit even though it was wrong as the board's accent.
    //
    // Green and amber share a lightness (76%/78%) so amber reads as WARMER
    // rather than dimmer; red drops to 68% because it should also feel heavier.
    // All three clear AA on a card: 8.75, 8.82 and 5.70 to 1.

    /// oklch(78% 0.150 80)
    static let limitWarn = rgb(0xE9AB2B)

    /// A limit meter's empty track: the text ink at 6%.
    ///
    /// It was a hand-typed white at 6%, from the prototype, and the one colour
    /// on the board not built from a token. The ink keeps the neutrals' tint
    /// toward 155, and it lands within a step of the old value on a card. Not
    /// `raised`, which the web's meter uses: a head lifts to `raised` under a
    /// finger, and a track of the same colour would vanish for the press.
    static let meterTrack = textPrimary.opacity(0.06)

    // MARK: - Tiers
    //
    // The streak ladder's five metals. They are the ONLY colour on this board
    // that does not mean a state, which is why they are fenced off: they appear
    // on the pinned streak bar and nowhere else — never as a card tint, never
    // on a session card. Colour there means `blocked` or `done`, and a tier
    // borrowing chroma would compete with the two states that actually ask for
    // a human.
    //
    // Deliberately off the six state hues for the same reason. Wood and bronze
    // sit warm at 54-55, clear of `blocked` at 28; silver and platinum carry
    // almost no chroma at all; gold at 81 is the one with real saturation and
    // it is the tier most people will sit at longest.
    //
    // The ladder is also legible without colour: each tier shows a pip count,
    // one through five. Roughly one man in twelve cannot separate these by hue,
    // and the board's second design principle says state is never carried by
    // colour alone — a rank is no different.

    /// oklch(67.8% 0.024 54) — 6.13:1 on the card. Lifted from a darker wood
    /// that measured 3.7:1 and failed AA outright. It is the palest warm tone
    /// here rather than the darkest: legibility decides the lightness, and the
    /// hue plus the pip count carry the rank.
    static let tierWood = rgb(0xA4948A)
    /// oklch(66% 0.095 55) — 5.59:1 on the card. The hex used to be 0xA57453,
    /// which is oklch(60.1% 0.078 55): 4.46:1, under AA for the tier name it
    /// colours. The metals' notes had drifted from their hex values; the other
    /// four — wood above, the three below — now name what their hex values
    /// are, so the OKLCH beside each is the source again, as the top of this
    /// file says.
    static let tierBronze = rgb(0xBF8258)
    /// oklch(84.2% 0.007 269) — 11.05:1 on the card.
    static let tierSilver = rgb(0xC9CBD0)
    /// oklch(75.0% 0.133 81) — 7.96:1 on the card.
    static let tierGold = rgb(0xD9A43C)
    /// oklch(79.6% 0.017 245) — 9.50:1 on the card. Pulled down from a
    /// near-white, which was the brightest thing on the board: the top rung
    /// of an ambient counter out-shouting a `blocked` card is backwards.
    static let tierPlatinum = rgb(0xB4BEC7)

    /// The meter's colour at `percent` of its limit.
    static func limitColor(_ percent: Double) -> Color {
        if percent >= 85 { return color(for: .blocked) }
        if percent >= 60 { return limitWarn }
        return color(for: .done)
    }

    /// The agent behind a section.
    ///
    /// Simple geometry, deliberately NOT Anthropic's or OpenAI's logo: this
    /// board is open source and self-hosted by other people, and shipping
    /// someone else's trademark inside it is a different thing from naming
    /// their tool. The owner has since confirmed it as a decision, not a
    /// stopgap: the marks stay neutral. They sit beside the agent's name at
    /// the head of its section, and telling two sections apart by shape is all
    /// they need to do — never by a brand colour, because colour on this board
    /// means state.
    ///
    /// An agent this build has no mark for gets a diamond. It used to get
    /// Claude's asterisk, which was harmless while the mark was an 8pt glyph in
    /// a chip that also spelled the name out; at the head of a section it
    /// would be one agent wearing another's badge. Matched by prefix, so
    /// `claude-code` and `codex-cli` keep the marks they have always had.
    static func agentSymbol(for source: String) -> String {
        let source = source.lowercased()
        if source.hasPrefix("claude") { return "asterisk" }
        if source.hasPrefix("codex") { return "hexagon" }
        return "diamond"
    }

    /// The SF Symbol for a status.
    ///
    /// Shape first, colour second: peripheral vision resolves form long before
    /// hue, and roughly 1 in 12 men cannot separate the red and green states by
    /// colour at all. These mirror the web board's icons exactly, and being SF
    /// Symbols they scale with Dynamic Type and carry their own accessibility
    /// descriptions, which hand-drawn shapes would not.
    static func symbol(for status: AgentStatus) -> String {
        switch status {
        case .idle: "clock"
        case .planning: "list.bullet"
        case .coding: "chevron.left.forwardslash.chevron.right"
        case .testing: "testtube.2"
        case .blocked: "exclamationmark.circle.fill"
        case .done: "checkmark.circle"
        }
    }

    // MARK: - Chart
    //
    // Token spend is not a state, so it takes the accent rather than borrowing
    // a status colour — an earlier version drew the chart in `planning` blue,
    // which made a chart of tokens look like a chart of planning.
    //
    // The plan-limit lines take the state colours in an order chosen so that
    // the first three — Claude reports three windows — are as far apart as
    // six state colours allow (in OKLab, with Machado 2009 for colour-blind
    // vision). The order used to be done, coding, testing: blue and teal are
    // 0.056 apart (0.044 for a deuteranope), so "week" and "week_fable" drew
    // as one blue line. Blue and lilac are 0.125 apart, the closest pair now
    // in the first three. Red, the alarm, comes last: a red limit line reads
    // as a limit in trouble, and only a sixth window ever draws one.
    //
    // Colour is still not enough on its own (the second principle): blue and
    // lilac collapse for a protanope (0.009), and blue and teal meet again from
    // a fourth window on. So each line also has its own pattern, below, and
    // blue's dashes sit beside lilac's dots and teal's dash-dot, where hue
    // cannot tell them apart. The two patterns most alike — dashed and long
    // dash, dash-dot and dash-dot-dot — fall on pairs that hue does separate.
    //
    // The web's chart (`LINE_COLORS` in public/app.js) still has the old
    // order and no patterns, so for now a window can be teal there and
    // lilac here.

    static let seriesColors: [Color] = [
        color(for: .done),
        color(for: .coding),
        color(for: .planning),
        color(for: .testing),
        color(for: .idle),
        color(for: .blocked),
    ]

    /// The nth series colour, wrapping around for boards with many windows.
    static func seriesColor(_ index: Int) -> Color {
        seriesColors[wrapped(index, seriesColors.count)]
    }

    /// A limit line's width, in the chart and in its key.
    static let seriesLineWidth: CGFloat = 1.75

    /// Each limit line's pattern, paired with `seriesColors` by position, so
    /// six windows give six lines that differ in shape as well as hue.
    ///
    /// Lengths are along the path. The round caps add half the line's width
    /// to each end of a mark, so a mark reads 1.75pt longer than written and a
    /// gap 1.75pt shorter, and a mark of zero length is a round dot. Every gap
    /// reads 3–3.5pt, the least that stays open on a 1.75pt line.
    private static let seriesDashes: [[CGFloat]] = [
        [],                                   // solid
        [4.25, 5.25],                         // dashed: 6pt marks
        [0, 4.5],                             // dotted
        [4.25, 4.75, 0, 4.75],                // dash, dot
        [9.25, 5.25],                         // long dash: 11pt marks
        [4.25, 4.75, 0, 4.75, 0, 4.75],       // dash, dot, dot
    ]

    /// How the nth limit line is stroked, in the chart and in its key.
    static func seriesStroke(_ index: Int) -> StrokeStyle {
        StrokeStyle(lineWidth: seriesLineWidth, lineCap: .round, lineJoin: .round,
                    dash: seriesDashes[wrapped(index, seriesDashes.count)])
    }

    private static func wrapped(_ index: Int, _ count: Int) -> Int {
        ((index % count) + count) % count
    }

    // MARK: - Space
    //
    // A 4pt scale with semantic names, matching the web's. 8pt is too coarse:
    // 12pt between two related values is a spacing you want often and cannot
    // express on an 8pt scale.

    enum Space {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
    }

    enum Radius {
        static let sm: CGFloat = 4
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        /// An agent's head: the prototype's 14, a little rounder than the
        /// cards standing under it.
        static let head: CGFloat = 14
    }

    // MARK: - Conversion

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
    }
}

// MARK: - Motion

// The third design principle is that motion means something changed. Its
// corollary is that someone who has asked the system for less motion gets none
// — which is the board's own rule, not a courtesy. public/board.css:232 honours
// prefers-reduced-motion on the web, and public/site.css:431 does the same for
// the landing, docs and privacy pages; until these existed the iOS app honoured
// it nowhere, in any view, while the principle claimed otherwise.
//
// Transitions need no separate treatment. A SwiftUI transition only plays
// inside an animated state change, so removing the animation removes the
// transition with it — which is why there is no `.motionTransition`.

/// `.animation(_:value:)` that yields to Reduce Motion.
private struct ReducibleAnimation<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

extension View {
    /// Animate `value` changes, unless the reader has asked for less motion.
    func motion<V: Equatable>(_ animation: Animation, value: V) -> some View {
        modifier(ReducibleAnimation(animation: animation, value: value))
    }
}

/// `withAnimation` that yields to Reduce Motion.
///
/// Reads `UIAccessibility` rather than `@Environment` because every call site is
/// inside a closure — a button action, a task, a timer callback — where there is
/// no view environment to read. The two report the same system setting.
@MainActor
func withMotion<Result>(
    _ animation: Animation = .default,
    _ body: () throws -> Result
) rethrows -> Result {
    try withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : animation, body)
}

/// The last option of a `ViewThatFits` that is allowed to show nothing.
///
/// A real view of no size, because `EmptyView()` is not one: a layout probe
/// showed ViewThatFits does not count EmptyView as a candidate at all. With it
/// last, a cascade falls back to the option before it even where that option
/// does not fit — so a cascade written to "always have a fitting option" did
/// not have one.
struct FitsAsNothing: View {
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
    }
}

/// Its content, measured once for each size it is offered, until the content
/// changes.
///
/// A card is a nest of stacks and `ViewThatFits` cascades, and a stack asks
/// each child for its size several times a pass, offering it different widths
/// to find out how far it gives. A cascade measures its candidates afresh each
/// time it is asked, so the asks multiply down the nest. In an iPad column,
/// which is not a lazy List, every card is asked again whenever any card
/// changes: twenty cards cost about 110 ms of main thread a hook event, fifty
/// 330, and a stale card's own time cascade added about 10 ms each. Here each
/// card answers from what it measured last, and only the card that changed is
/// measured again: about 25 ms for twenty, 32 for fifty, and 31 to 47 with the
/// thirteen of the twenty that can go stale gone stale (with `BoardAction`,
/// which stops the other cards being changed at all). Measured from the
/// card's own source in a macOS harness on an M4 Pro, not on an iPad.
///
/// The cache is SwiftUI's own (`Layout`), emptied whenever anything under it
/// changes — its text, its state, the environment, the text size; probes
/// confirmed each — so a card can never be laid out to a size it used to be.
/// It passes the offer through unchanged and places its content where it
/// stands, and a card lays out as it did: every capture of the board came out
/// pixel-identical. What it does not pass on is its content's layoutPriority
/// or an explicit leading, trailing, top or bottom alignment guide (baselines
/// and centres do pass), so those go outside it. One view: it measures and
/// places the first.
struct MeasuredOnce: Layout {
    struct Cache {
        var sizes: [(offer: ProposedViewSize, size: CGSize)] = []
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache.sizes.removeAll(keepingCapacity: true)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        if let known = cache.sizes.first(where: { $0.offer == proposal }) { return known.size }
        let size = subviews.first?.sizeThatFits(proposal) ?? .zero
        // A pass asks with a handful of offers; a rotation brings a new set.
        if cache.sizes.count >= 12 { cache.sizes.removeFirst() }
        cache.sizes.append((proposal, size))
        return size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        subviews.first?.place(at: bounds.origin, proposal: proposal)
    }
}
