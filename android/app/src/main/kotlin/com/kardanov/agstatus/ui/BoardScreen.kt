package com.kardanov.agstatus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TextButton
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.Board
import com.kardanov.agstatus.ProjectSection
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.rememberReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * The live board: one glanceable card per agent session, grouped by project
 * (docs/design/project-sections.md). [onOpenHistory] takes the session and,
 * from a subagent's row, the subagent to arrive at.
 *
 * Each project is a section: a label that sticks while its cards pass under
 * it, then its cards, in the store's stable order. Sections run in name order
 * (ProjectSections.ORDER) and never move because one got busy. The usage
 * bars stay pinned above the list, and while anything is blocked the
 * needs-you bar runs along the screen's bottom edge: the board's one alarm,
 * and the way to the card that needs you. A block that lands while the board
 * is open is also said aloud, for TalkBack ([SpokenLine]).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun BoardScreen(
    store: SessionStore,
    onOpenHistory: (sessionId: String, subtaskId: String?) -> Unit,
    onOpenUsage: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPair: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessions by store.sessions.collectAsState()
    val usage by store.usage.collectAsState()
    val connection by store.connection.collectAsState()
    val board by store.board.collectAsState()
    val machines by store.machines.collectAsState()
    val focus by store.focus.collectAsState()
    val subtaskSlots by store.subtaskSlots.collectAsState()

    val isDemo = connection == SessionStore.Connection.DEMO
    val boardGone = connection == SessionStore.Connection.BOARD_GONE
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // A card that moves has news: the list is keyed by session id, so a card
    // only animates when the board actually reordered. Nulling the specs is
    // how a device that asked for less motion gets the same reorder with no
    // travel. The bar's entrance and the jump follow it too.
    val reduceMotion = rememberReduceMotion()

    // Built on every frame from the flat list, never stored.
    val sections = remember(sessions) { ProjectSections.of(sessions) }
    val listState = rememberLazyListState()

    // The one move between sections, out of No project as a session's first
    // real folder arrives, is drawn, not animated: a card gliding the length
    // of the board would be news it does not have. These are the cards that
    // changed section since the board was last drawn, and the labels that
    // arrived with them, which arrive as their first card does.
    val drawn = remember { DrawnBoard() }
    val drawnInPlace = remember(sections) { drawn.moves(sections) }
    SideEffect { drawn.record(sections) }

    // The needs-you bar's walk: the card it last brought, which the store
    // holds and lets go of once nothing is blocked, whatever screen shows
    // then (SessionStore.brought). The card it brought takes the focus
    // requester, and wears the ring for two seconds.
    val shown by store.brought.collectAsState()
    var focusTarget by remember { mutableStateOf<String?>(null) }
    var ringed by remember { mutableStateOf<String?>(null) }
    val jumpFocus = remember { FocusRequester() }
    val labelHeight = remember { MeasuredHeight() }
    // What the board brings into view for focus, the bar's and a keyboard's
    // alike, is the room under the stuck label: a focused card is never left
    // with its top under a label. The ring is drawn inside the card, so the
    // room starts at the label's own edge.
    val underLabel = remember(listState) {
        UnderLabelBringIntoView(
            top = { labelHeight.px.toFloat() },
            backRoom = {
                if (listState.firstVisibleItemIndex == 0) {
                    listState.firstVisibleItemScrollOffset.toFloat()
                } else {
                    Float.POSITIVE_INFINITY
                }
            },
        )
    }
    // What the board says aloud: a block that lands while it is watching
    // (SessionStore.spoken), through a polite live region.
    val speaker = remember { Speaker() }
    LaunchedEffect(store) {
        store.spoken.collect { sentence -> speaker.say(sentence, scope) }
    }
    val reading = remember(sections, shown) {
        ProjectSections.barTarget(sections, shown)?.let { target ->
            BarReading(
                blocked = sections.sumOf { section -> section.sessions.count { it.isBlocked } },
                target = target,
                walks = ProjectSections.barWalks(sections, shown),
            )
        }
    }
    // The card the bar brought keeps input focus only while its ring says
    // why, and lets go on the next touch. In touch mode, which TalkBack is,
    // it was made focusable for the jump, and holding focus for good gave a
    // keyboard an extra stop on it, and the list a reason to scroll back to
    // it whenever its room shrank. Letting go takes away what made it
    // focusable, which drops input focus and leaves the screen's own; no
    // more is needed, and TalkBack's focus, its own, stays where it is.
    LaunchedEffect(ringed) {
        if (ringed == null) return@LaunchedEffect
        delay(RING_HOLD_MILLIS)
        ringed = null
        focusTarget = null
    }
    val letGo by rememberUpdatedState {
        if (focusTarget != null) focusTarget = null
    }

    // Only limits of agents that actually have sessions on the board — a
    // Claude-only evening doesn't need Codex bars. With no sessions there is
    // nothing to disambiguate, and the limits still matter between runs, so
    // everything is shown rather than nothing.
    val visibleUsage = remember(sessions, usage) {
        val active = sessions.mapTo(mutableSetOf()) { it.source }
        if (active.isEmpty()) usage else usage.filter { it.source in active }
    }

    // Where the usage blocks stand: pinned over the list while it keeps room
    // under them for a label and a card (leastListRoom), and otherwise the
    // list's first item, which scrolls away with it — upright at a reader's
    // larger text, and on a phone held sideways at any. Pinned there, they
    // and the bar left the list 63dp at 100% on a Pixel 7 held sideways and
    // none at 200%, where the bar cut the blocks through their text. They
    // are as tall in either place, so where they stand cannot flap.
    var usageHeight by remember { mutableIntStateOf(0) }
    var bodyHeight by remember { mutableIntStateOf(0) }
    val leastList = leastListRoom()
    val leastListPx = with(LocalDensity.current) { leastList.roundToPx() }
    val usageLeads = sessions.isNotEmpty() && !boardGone && visibleUsage.isNotEmpty() &&
        usageHeight > 0 && bodyHeight > 0 && bodyHeight - usageHeight < leastListPx
    val leadsNow by rememberUpdatedState(usageLeads)
    // The list keeps the card at its top in place when the blocks join it,
    // which would leave them above the screen; at the list's top, it shows
    // them.
    LaunchedEffect(usageLeads) {
        if (!usageLeads) return@LaunchedEffect
        withFrameNanos { }
        if (listState.firstVisibleItemIndex == 1 && listState.firstVisibleItemScrollOffset == 0) {
            listState.scrollToItem(0)
        }
    }

    // Tab's order, as the web board's page has it: the usage blocks, the
    // needs-you bar, then the cards. BoardBody places them so while the
    // blocks are pinned. Leading the list, the blocks are in it, before its
    // cards, and with the bar up Tab would reach the bar first, so these say
    // where Tab goes among the four, each only to what is composed.
    val tabsAround = usageLeads && reading != null
    val settingsFocus = remember { FocusRequester() }
    val usageFirst = remember { FocusRequester() }
    val usageLast = remember { FocusRequester() }
    val barFocus = remember { FocusRequester() }
    val firstCardFocus = remember { FocusRequester() }
    var usageComposed by remember { mutableStateOf(false) }
    var composedFirstCard by remember { mutableStateOf<String?>(null) }
    var barFocused by remember { mutableStateOf(false) }
    val firstCardId = sections.firstOrNull()?.sessions?.firstOrNull()?.id
    val firstCardComposed = firstCardId != null && composedFirstCard == firstCardId

    val currentSections by rememberUpdatedState(sections)
    // A press reads the board as last drawn: a card dismissed or unblocked
    // since the bar named it is passed over for the next.
    val pressBar: () -> Unit = press@{
        val drawnSections = currentSections
        val target = ProjectSections.barTarget(drawnSections, shown) ?: return@press
        val found = ProjectSections.listIndex(drawnSections, target.id)
        if (found < 0) return@press
        // One further down while the usage blocks lead the list.
        val index = found + if (leadsNow) 1 else 0
        store.bring(target.id)
        focusTarget = target.id
        ringed = null
        scope.launch {
            // Under its label: the label that sticks over a card in its
            // section's middle, or its own over a section's first card. The
            // ring is inside the card, so the card can sit flush under it.
            val offset = -labelHeight.px
            // It snaps with animations off, and while TalkBack runs, which
            // reads the card it lands on rather than the scroll.
            if (reduceMotion || touchExploration(context)) {
                listState.scrollToItem(index, offset)
            } else {
                listState.animateScrollToItem(index, offset)
            }
            ringed = target.id
            // The card is composed now: the scroll measured it. Moving focus
            // there takes TalkBack and a keyboard with it. Should the card not
            // take it, TalkBack is still told where the press went.
            withFrameNanos { }
            val focused = runCatching { jumpFocus.requestFocus() }.getOrDefault(false)
            if (!focused && touchExploration(context)) {
                speaker.say("${ProjectSections.cardLead(target)}, blocked", scope)
            }
        }
    }

    var refreshing by remember { mutableStateOf(false) }
    val refresh: () -> Unit = {
        if (!refreshing) {
            refreshing = true
            scope.launch {
                try {
                    store.refresh()
                } finally {
                    refreshing = false
                }
            }
        }
    }

    val pairs = board?.token != null && !boardGone
    val exitRoom = demoExitRoom(icons = if (pairs) 2 else 1)

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            CenterAlignedTopAppBar(
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = Theme.background,
                    scrolledContainerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                    actionIconContentColor = Theme.textPrimary,
                ),
                title = {
                    // The name whole, or not at all. At 200% text the badge
                    // and the exit left it less than its width, and it broke
                    // inside the word, "AgStatu" over "s". It is the app's
                    // name, not news, and the controls keep their room.
                    FirstThatFits {
                        Text(
                            text = "AgStatus",
                            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                            color = Theme.textPrimary,
                        )
                        Box(Modifier)
                    }
                },
                navigationIcon = {
                    Box(Modifier.padding(start = 16.dp)) {
                        if (isDemo) DemoBadge() else ConnectionDot(connection)
                    }
                },
                actions = {
                    // The demo badge says where you are; this says how you leave.
                    if (isDemo) ExitDemo(room = exitRoom, onExit = { store.stopDemo() })
                    if (pairs) {
                        IconButton(onClick = onOpenPair) {
                            Icon(
                                imageVector = Icons.Outlined.Laptop,
                                contentDescription = "Pair your computer",
                                tint = Theme.textPrimary,
                            )
                        }
                    }
                    IconButton(
                        onClick = onOpenSettings,
                        modifier = Modifier
                            .focusRequester(settingsFocus)
                            .focusProperties { if (tabsAround && usageComposed) next = usageFirst },
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Settings,
                            contentDescription = "Settings",
                            tint = Theme.textPrimary,
                        )
                    }
                },
            )
        },
    ) { padding ->
        val layoutDirection = LocalLayoutDirection.current
        // The board's sides keep clear of a system bar or cutout there, as the
        // Scaffold asks; the needs-you bar runs edge to edge and pads itself.
        val sides = Modifier.padding(
            start = padding.calculateStartPadding(layoutDirection),
            end = padding.calculateEndPadding(layoutDirection),
        )
        BoardBody(
            bottomInset = padding.calculateBottomPadding(),
            modifier = Modifier
                .padding(top = padding.calculateTopPadding())
                .fillMaxSize()
                .onSizeChanged { bodyHeight = it.height }
                // The next touch anywhere on the board, the bar included,
                // lets go of the focus a jump gave its card. Only watched:
                // nothing here takes the touch from the list or a card.
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            if (event.type == PointerEventType.Press) letGo()
                        }
                    }
                },
            usage = {
                if (visibleUsage.isNotEmpty() && !boardGone && !usageLeads) {
                    UsageBars(
                        usage = visibleUsage,
                        onOpenDetail = onOpenUsage,
                        modifier = Modifier
                            .onSizeChanged { usageHeight = it.height }
                            .then(sides)
                            .padding(horizontal = 16.dp)
                            .padding(top = 10.dp, bottom = 2.dp),
                    )
                }
            },
            bar = {
                NeedsYouBar(
                    reading = reading.takeUnless { boardGone },
                    reduceMotion = reduceMotion,
                    onPress = pressBar,
                    modifier = Modifier
                        .focusRequester(barFocus)
                        .onFocusChanged { barFocused = it.isFocused }
                        .focusProperties {
                            if (tabsAround) {
                                if (usageComposed) previous = usageLast
                                if (firstCardComposed) next = firstCardFocus
                            }
                        },
                )
            },
            spoken = { SpokenLine(speaker) },
        ) {
            Box(sides) {
                when {
                    boardGone -> BoardGoneState(onStartOver = store::disconnectBoard)

                    sessions.isEmpty() -> PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // "No agents yet" is only true when we're actually live —
                        // while (re)connecting, an empty list just means "unknown".
                        if (isDemo || connection == SessionStore.Connection.LIVE) {
                            EmptyState(board = board, onOpenPair = onOpenPair)
                        } else {
                            ConnectingState()
                        }
                    }

                    else -> PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        val now by rememberTickingClock(30_000L)
                        val touchMode = LocalInputModeManager.current.inputMode == InputMode.Touch
                        CompositionLocalProvider(LocalBringIntoViewSpec provides underLabel) {
                            LazyColumn(
                                modifier = Modifier.fillMaxSize(),
                                state = listState,
                                // No spacing of its own: each label and card
                                // carries its share (SectionChrome's spacing).
                                contentPadding = PaddingValues(horizontal = 16.dp),
                            ) {
                                if (usageLeads) {
                                    item(key = ProjectSections.USAGE_KEY, contentType = ProjectSections.USAGE_KEY) {
                                        DisposableEffect(Unit) {
                                            usageComposed = true
                                            onDispose { usageComposed = false }
                                        }
                                        UsageBars(
                                            usage = visibleUsage,
                                            onOpenDetail = onOpenUsage,
                                            modifier = Modifier
                                                .onSizeChanged { usageHeight = it.height }
                                                .padding(top = 10.dp, bottom = 2.dp)
                                                // From the bar, Tab goes on to
                                                // the cards. Where the first is
                                                // not composed, the blocks pass
                                                // it on, once it is in view.
                                                .focusProperties {
                                                    onEnter = {
                                                        if (tabsAround && barFocused &&
                                                            requestedFocusDirection == FocusDirection.Next
                                                        ) {
                                                            cancelFocusChange()
                                                            scope.launch {
                                                                listState.scrollToItem(2)
                                                                withFrameNanos { }
                                                                runCatching { firstCardFocus.requestFocus() }
                                                            }
                                                        }
                                                    }
                                                }
                                                .focusGroup(),
                                            firstBlock = Modifier
                                                .focusRequester(usageFirst)
                                                .focusProperties { if (tabsAround) previous = settingsFocus },
                                            lastBlock = Modifier
                                                .focusRequester(usageLast)
                                                .focusProperties { if (tabsAround) next = barFocus },
                                        )
                                    }
                                }
                                for (section in sections) {
                                    stickyHeader(key = section.key, contentType = "label") {
                                        ProjectLabel(
                                            section = section,
                                            // A label that goes takes no fade:
                                            // its last card has already gone, by a
                                            // swipe or to another section.
                                            modifier = Modifier
                                                .listMotion(
                                                    item = this,
                                                    moves = !reduceMotion && section.key !in drawnInPlace,
                                                    fadesOut = false,
                                                )
                                                .onSizeChanged { labelHeight.px = it.height },
                                        )
                                    }
                                    val last = section.sessions.last().id
                                    items(section.sessions, key = { it.id }, contentType = { "card" }) { session ->
                                        val current by rememberUpdatedState(session)
                                        val dismissState = rememberSwipeToDismissBoxState(
                                            confirmValueChange = { value ->
                                                if (value == SwipeToDismissBoxValue.EndToStart) {
                                                    scope.launch { store.dismiss(current) }
                                                    true
                                                } else {
                                                    false
                                                }
                                            },
                                        )
                                        // On at once, and gone at once if the card
                                        // is unblocked; it lets go of its own accord
                                        // with a fade, unless animations are off.
                                        val ringOn = ringed == session.id && session.isBlocked
                                        val ring by animateFloatAsState(
                                            targetValue = if (ringOn) 1f else 0f,
                                            animationSpec = if (ringOn || reduceMotion || ringed == session.id) {
                                                snap()
                                            } else {
                                                tween(RING_FADE_MILLIS)
                                            },
                                            label = "jumpRing",
                                        )
                                        // Only the card the bar brought takes focus
                                        // from code. A tap's card is focusable only
                                        // from a keyboard (clickable), so in touch
                                        // mode, which TalkBack is, it is made
                                        // focusable for the jump, until it lets go.
                                        val first = session.id == firstCardId
                                        if (first) {
                                            DisposableEffect(session.id) {
                                                composedFirstCard = session.id
                                                onDispose { if (composedFirstCard == session.id) composedFirstCard = null }
                                            }
                                        }
                                        val tabStop = if (first) {
                                            Modifier
                                                .focusRequester(firstCardFocus)
                                                .focusProperties { if (tabsAround) previous = barFocus }
                                        } else {
                                            Modifier
                                        }
                                        val takesFocus = if (session.id == focusTarget) {
                                            Modifier
                                                .focusRequester(jumpFocus)
                                                .then(if (touchMode) Modifier.focusable() else Modifier)
                                        } else {
                                            Modifier
                                        }
                                        SwipeToDismissBox(
                                            state = dismissState,
                                            modifier = Modifier
                                                .listMotion(item = this, moves = !reduceMotion && session.id !in drawnInPlace)
                                                .padding(bottom = if (session.id == last) SECTION_GAP else CARD_GAP),
                                            enableDismissFromStartToEnd = false,
                                            enableDismissFromEndToStart = true,
                                            backgroundContent = { DismissBackground(dismissState) },
                                        ) {
                                            SessionCard(
                                                session = session,
                                                nowMillis = now,
                                                machines = machines,
                                                focus = focus[session.id],
                                                subtaskLedger = subtaskSlots[session.id],
                                                onCommand = { type -> store.sendCommand(session.id, type) },
                                                onOpenHistory = { subtaskId -> onOpenHistory(session.id, subtaskId) },
                                                modifier = Modifier
                                                    .jumpRing { ring }
                                                    .then(takesFocus)
                                                    .then(tabStop)
                                                    .clickable {
                                                        onOpenHistory(session.id, null)
                                                    },
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The room the list keeps under pinned usage blocks, or they lead it: a
 * label, the shortest card whole — its name, a line of message and its meta
 * line, at the reader's text size — and the needs-you bar, counted whether or
 * not it shows, so a block landing never moves the usage blocks.
 */
@Composable
private fun leastListRoom(): Dp {
    val density = LocalDensity.current
    val line = textDp(24.sp)
    val label = textDp(20.sp) + LABEL_TOP + LABEL_TO_CARD
    val card = 14.dp + line + 8.dp + line + 8.dp + line + 14.dp
    // One line on a wide screen, two on a phone (NeedsYouBar), over its rule.
    val window = with(density) { LocalWindowInfo.current.containerSize.width.toDp() }
    val words = if (window - 32.dp >= 600.dp) textDp(20.sp) else textDp(20.sp) * 2 + 2.dp
    val inset = with(density) { WindowInsets.safeDrawing.getBottom(this).toDp() }
    val bar = 1.dp + maxOf(47.dp, words + 16.dp) + inset
    return label + card + bar
}

/**
 * The board under the top bar: the usage blocks pinned at the top, the list
 * under them, and the needs-you bar along the bottom edge while anything is
 * blocked, with the [spoken] line just above it.
 *
 * Placed in another order than drawn: the usage blocks, the bar, then the
 * list. Compose walks a keyboard's Tab through siblings in the order they are
 * placed, so Tab reaches the bar after the usage blocks and before the cards,
 * where it stands in the web board's page. As the Scaffold's bottom bar it
 * was placed after the top bar, and Tab went from Settings to the bar before
 * anything on the board. TalkBack goes by position, so it still hears the bar
 * last, after the cards.
 *
 * [bottomInset] is the system bar under the board: the list keeps above it
 * while no bar shows, and the bar, which runs to the bottom edge, pads itself.
 *
 * [usage] is empty while the usage blocks lead the list instead.
 */
@Composable
private fun BoardBody(
    bottomInset: Dp,
    usage: @Composable () -> Unit,
    bar: @Composable () -> Unit,
    spoken: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    board: @Composable () -> Unit,
) {
    Layout(contents = listOf(usage, bar, board, spoken), modifier = modifier) { slots, constraints ->
        val (usageSlot, barSlot, boardSlot, spokenSlot) = slots
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val loose = Constraints(maxWidth = width, maxHeight = height)
        val bars = barSlot.map { it.measure(loose) }
        // While the bar comes and goes, the list ends at its top or above the
        // system bar, whichever is higher, so it never jumps under the bar.
        val bottom = maxOf(bars.maxOfOrNull { it.height } ?: 0, bottomInset.roundToPx())
        // At their own height: where that leaves the list too little room,
        // the blocks move into it (BoardScreen's usageLeads), and they must
        // be measured whole to know.
        val usages = usageSlot.map { it.measure(loose.copy(maxHeight = Constraints.Infinity)) }
        val top = usages.sumOf { it.height }
        val boards = boardSlot.map { it.measure(Constraints.fixed(width, (height - top - bottom).coerceAtLeast(0))) }
        val lines = spokenSlot.map { it.measure(loose) }
        layout(width, height) {
            var y = 0
            for (placeable in usages) {
                placeable.place(0, y)
                y += placeable.height
            }
            for (placeable in bars) placeable.place(0, height - placeable.height)
            for (placeable in boards) placeable.place(0, top)
            for (placeable in lines) placeable.place(0, height - bottom - placeable.height)
        }
    }
}

// MARK: - Session list decoration

/**
 * A card's or a label's motion in the list: 1.6.5's springs, or none at all
 * where [moves] is false — animations off, or the one move between sections,
 * which is drawn. [fadesOut] false lets an item go at once.
 */
private fun Modifier.listMotion(item: LazyItemScope, moves: Boolean, fadesOut: Boolean = true): Modifier {
    val modifier = this
    return with(item) {
        if (moves) {
            modifier.animateItem(
                fadeInSpec = spring(stiffness = Spring.StiffnessMediumLow),
                placementSpec = spring(
                    stiffness = Spring.StiffnessMediumLow,
                    visibilityThreshold = IntOffset.VisibilityThreshold,
                ),
                fadeOutSpec = if (fadesOut) spring(stiffness = Spring.StiffnessMediumLow) else null,
            )
        } else {
            modifier.animateItem(fadeInSpec = null, placementSpec = null, fadeOutSpec = null)
        }
    }
}

/**
 * The section each card was in when the board was last drawn, so a card that
 * changed section can be drawn in its new place rather than glide there. A
 * plain holder: updating it must not recompose.
 */
private class DrawnBoard {
    private var sectionOf: Map<String, String> = emptyMap()
    private var labels: Set<String> = emptySet()

    /**
     * The keys of the cards whose section changed since the board was last
     * drawn, and of the labels that arrive with them: a label is new, and
     * every card under it is one that moved.
     */
    fun moves(sections: List<ProjectSection>): Set<String> {
        val moved = HashSet<String>()
        for (section in sections) {
            for (session in section.sessions) {
                val was = sectionOf[session.id]
                if (was != null && was != section.name) moved += session.id
            }
        }
        if (moved.isEmpty()) return emptySet()
        for (section in sections) {
            if (section.key !in labels && section.sessions.all { it.id in moved }) moved += section.key
        }
        return moved
    }

    fun record(sections: List<ProjectSection>) {
        sectionOf = sections.flatMap { section -> section.sessions.map { it.id to section.name } }.toMap()
        labels = sections.mapTo(HashSet()) { it.key }
    }
}

/**
 * Brings what takes focus into the room under the stuck label rather than
 * the whole list. The default brings a focused card wholly into view, so a
 * card taller than the room under the label was pushed up until its top and
 * the bar's ring went under the label. Here a card in that room stays where
 * it is, one taller than the room has its top just under the label, and one
 * above or below moves the least that brings it into the room.
 *
 * Never further back than the list can go, which [backRoom] says. A scroll
 * asked of the list and not given goes on up as if a finger had pulled, and
 * at the list's top the pull-to-refresh took it as a pull that no lifted
 * finger ever let go: focus on the first card, from the bar or a keyboard's
 * Tab, left the spinner stuck in view.
 */
private class UnderLabelBringIntoView(
    private val top: () -> Float,
    private val backRoom: () -> Float,
) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val start = top().coerceIn(0f, containerSize)
        val leading = offset - start
        val trailing = offset + size - containerSize
        val distance = when {
            leading >= 0f && trailing <= 0f -> 0f
            size > containerSize - start -> leading
            leading < 0f -> leading
            else -> trailing
        }
        return if (distance < 0f) distance.coerceAtLeast(-backRoom()) else distance
    }
}

/** A label's height, as last laid out, for a jump to land under it. Plain: reading it recomposes nothing. */
private class MeasuredHeight {
    var px = 0
}

/** TalkBack, or another service that explores by touch, is on. */
private fun touchExploration(context: Context): Boolean =
    (context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager)
        ?.isTouchExplorationEnabled == true

/** Drag distance at which the dismiss background reaches full opacity. */
private const val DISMISS_REVEAL_PX = 220f

/**
 * Faded in with the drag itself. The box draws this behind the card at all
 * times, and a done card is translucent, so a fixed-opacity background would
 * bleed red through every finished session.
 */
@Composable
private fun DismissBackground(state: SwipeToDismissBoxState) {
    val dragged = runCatching { abs(state.requireOffset()) }.getOrDefault(0f)
    val revealed = (dragged / DISMISS_REVEAL_PX).coerceIn(0f, 1f)
    Row(
        modifier = Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(16.dp))
            .alpha(revealed)
            .background(Theme.blocked)
            .padding(horizontal = 20.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Theme.background on the red, not white: white measures 3.15:1
        // against #F75E51 and the ground measures 6.12:1. Same reasoning as
        // Theme.onAccent, one surface over.
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = null,
            tint = Theme.background,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            text = "Dismiss",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.background,
        )
    }
}

// MARK: - Empty state

@Composable
private fun EmptyState(board: Board?, onOpenPair: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp)
            .padding(top = 64.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(
            imageVector = Icons.Outlined.Bedtime,
            contentDescription = null,
            tint = Theme.textSecondary,
            modifier = Modifier.size(44.dp),
        )
        Text(
            text = "No agents yet",
            style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.textPrimary,
        )
        Text(
            text = "Pair your computer and your coding agents will show up here " +
                "the moment they report in.",
            fontSize = 14.sp,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )

        if (board?.token != null) {
            Button(
                onClick = onOpenPair,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Theme.accent,
                    contentColor = Theme.onAccent,
                ),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Icon(
                    imageVector = Icons.Outlined.Laptop,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = "Pair your computer",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
            }
        }

        if (board != null) {
            Column(
                modifier = Modifier.padding(top = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Or send updates straight to the webhook:",
                    fontSize = 12.sp,
                    color = Theme.textSecondary,
                )
                WebhookRow(url = board.webhookUrl)
            }
        }
    }
}

@Composable
private fun WebhookRow(url: String) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }

    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .clip(shape)
            .background(Theme.card)
            .border(1.dp, Theme.cardBorder, shape)
            .clickable {
                val clipboard =
                    context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("AgStatus webhook", url))
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                copied = true
            }
            .semantics { contentDescription = "Copy webhook URL" }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = url,
            style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
            color = Theme.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(
            imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
            contentDescription = null,
            tint = if (copied) Theme.done else Theme.textSecondary,
            modifier = Modifier.size(16.dp),
        )
    }
}

// MARK: - Connecting

@Composable
private fun ConnectingState() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = 160.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        CircularProgressIndicator(color = Theme.textSecondary)
        Text(
            text = "Connecting to your board…",
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Medium),
            color = Theme.textSecondary,
        )
        Text(
            text = "Pull down to retry.",
            fontSize = 12.sp,
            color = Theme.textSecondary.copy(alpha = 0.7f),
        )
    }
}

// MARK: - Board gone

@Composable
private fun BoardGoneState(onStartOver: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Icon(
            imageVector = Icons.Outlined.HelpOutline,
            contentDescription = null,
            tint = Theme.blocked,
            modifier = Modifier.size(44.dp),
        )
        Text(
            text = "This board no longer exists",
            style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "It was probably deleted. Your device is fine — just set up a new one.",
            fontSize = 14.sp,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = onStartOver,
            colors = ButtonDefaults.buttonColors(
                containerColor = Theme.accent,
                contentColor = Theme.onAccent,
            ),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        ) {
            Text(
                text = "Start over",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            )
        }
    }
}

// MARK: - Toolbar bits

@Composable
private fun ConnectionDot(connection: SessionStore.Connection) {
    val color = when (connection) {
        SessionStore.Connection.LIVE -> Theme.colorFor(AgentStatus.DONE)
        SessionStore.Connection.CONNECTING,
        SessionStore.Connection.RECONNECTING -> Theme.colorFor(AgentStatus.TESTING)
        SessionStore.Connection.BOARD_GONE -> Theme.colorFor(AgentStatus.BLOCKED)
        SessionStore.Connection.IDLE,
        SessionStore.Connection.DEMO -> Theme.colorFor(AgentStatus.IDLE)
    }
    val description = when (connection) {
        SessionStore.Connection.LIVE -> "Connected"
        SessionStore.Connection.CONNECTING -> "Connecting"
        SessionStore.Connection.RECONNECTING -> "Reconnecting"
        SessionStore.Connection.BOARD_GONE -> "Board not found"
        SessionStore.Connection.IDLE -> "Not connected"
        SessionStore.Connection.DEMO -> "Demo"
    }
    // No glow. It carried a 3dp coloured shadow, which is the one decorative
    // light left in the app once the card's halo went.
    Box(
        modifier = Modifier
            .size(9.dp)
            .background(color, CircleShape)
            .semantics { contentDescription = description },
    )
}

@Composable
private fun DemoBadge() {
    // Quiet, and in no state colour at all. It used to borrow `coding` purple
    // and sit in a tinted pill, which made the toolbar look like a session in
    // progress. Demo mode is chrome — where you are, not what an agent is
    // doing — and the accent "Exit demo" button beside it does the pointing.
    Text(
        text = "DEMO",
        style = DemoBadgeStyle,
        color = Theme.textSecondary,
        maxLines = 1,
        modifier = Modifier
            .border(1.dp, Theme.cardBorder, CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp)
            .semantics { contentDescription = "Demo mode" },
    )
}

/** The DEMO pill's type, which [demoExitRoom] measures too. */
private val DemoBadgeStyle = TextStyle(
    fontSize = 10.sp,
    fontWeight = FontWeight.Bold,
    letterSpacing = 1.sp,
)

/**
 * The width the exit may take in the bar: the window's, less the badge's
 * side (the bar's 4dp inset, our 16 and the pill), the [icons] after the
 * exit, the bar's 4dp end inset, and a gap of 8.
 */
@Composable
private fun demoExitRoom(icons: Int): Dp {
    val density = LocalDensity.current
    val bar = with(density) { LocalWindowInfo.current.containerSize.width.toDp() }
    val measurer = rememberTextMeasurer()
    val pill = remember(density, measurer) {
        with(density) { measurer.measure("DEMO", DemoBadgeStyle).size.width.toDp() }
    } + 16.dp
    return (bar - (4.dp + 16.dp + pill) - (48.dp * icons + 4.dp) - 8.dp).coerceAtLeast(0.dp)
}

/**
 * "Exit demo", or "Exit" where the bar cannot hold both words beside the
 * badge: at 200% text on a 240dp window they ran over the DEMO pill. Beside
 * the pill "Exit" still says what it leaves, and TalkBack hears "Exit demo"
 * either way.
 */
@Composable
private fun ExitDemo(room: Dp, onExit: () -> Unit) {
    FirstThatFits(Modifier.widthIn(max = room)) {
        ExitDemoButton("Exit demo", onExit)
        ExitDemoButton("Exit", onExit, Modifier.semantics { contentDescription = "Exit demo" })
    }
}

@Composable
private fun ExitDemoButton(label: String, onExit: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(onClick = onExit, modifier = modifier) {
        Text(
            text = label,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.accent,
        )
    }
}

/** A clock that ticks on a fixed period so cards can restate "5m ago". */
@Composable
private fun rememberTickingClock(periodMillis: Long): State<Long> {
    val clock = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMillis) {
        while (true) {
            delay(periodMillis)
            clock.longValue = System.currentTimeMillis()
        }
    }
    return clock
}
