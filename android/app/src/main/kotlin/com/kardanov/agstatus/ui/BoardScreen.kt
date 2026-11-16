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
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.material3.SwipeToDismissBoxDefaults
import androidx.compose.material3.SwipeToDismissBoxState
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
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.traversalIndex
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
import com.kardanov.agstatus.agentHeads
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
 * blocks are pinned above the list where it keeps room under them, and lead
 * it otherwise. While anything is blocked the needs-you bar runs along the
 * screen's bottom edge: the board's one alarm, and the way to the card that
 * needs you. A block that lands while the app is in front is also said
 * aloud, for TalkBack, on whichever screen shows: the app's [speaker] says it
 * ([SpokenAlarm]), and the board's press uses it too, where its card could
 * not take focus.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun BoardScreen(
    store: SessionStore,
    speaker: Speaker,
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
    //
    // Except for the usage blocks where they lead the list. No label sticks
    // above the list's first item, and asked to put a block under one, the
    // list was asked for more than it had: from a card, Shift+Tab or the Up
    // arrow back into blocks the list had scrolled past asked for a label's
    // height more than its way back to its top, and with animations off the
    // pull-to-refresh took the rest as a pull no finger let go. Their room
    // starts where the list's top puts them, below their own top padding, so
    // the first row brought into view puts the list back at its top, as a
    // fresh board has it, and no block asks for more than that.
    val focusInBlocks = remember { FocusInBlocks() }
    val blocksTop = with(LocalDensity.current) { USAGE_TOP.toPx() }
    val underLabel = remember(listState, blocksTop) {
        UnderLabelBringIntoView(
            top = { if (focusInBlocks.held) blocksTop else labelHeight.px.toFloat() },
            backRoom = {
                if (listState.firstVisibleItemIndex == 0) {
                    listState.firstVisibleItemScrollOffset.toFloat()
                } else {
                    Float.POSITIVE_INFINITY
                }
            },
        )
    }
    // The card the bar names, which its next press brings, and the bar's own
    // words for it: only the words go to the bar, so an event that leaves
    // them as they were is not the bar's news.
    val barTarget = remember(sections, shown) { ProjectSections.barTarget(sections, shown) }
    val reading = remember(sections, shown, barTarget) {
        barTarget?.let { target ->
            BarReading.of(
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

    // A block for every agent with sessions, its limits or "No plan limits
    // reported" — a Claude-only evening doesn't need Codex bars — and with no
    // sessions every agent that reports limits, which still matter between
    // runs (agentHeads).
    val visibleUsage = remember(sessions, usage) { agentHeads(sessions, usage) }
    // How many sessions each agent has on the board, done included, for its
    // usage block. The same map while the counts stay the same, so a message
    // is no block's news.
    val counted = sessions.groupingBy { it.source }.eachCount()
    val sessionCounts = remember(counted) { counted }

    // Where the usage blocks stand: pinned over the list while it keeps room
    // under them for a label and a card (leastListRoom), and otherwise the
    // list's first item, which scrolls away with it — upright at a reader's
    // larger text, and on a phone held sideways at any. Pinned there, they
    // and the bar left the list 63dp at 100% on a Pixel 7 held sideways and
    // none at 200%, where the bar cut the blocks through their text. They
    // are as tall in either place, so where they stand cannot flap.
    //
    // They are measured wherever they stand, out of view too: pinned; in
    // the list while its item for them is composed; and otherwise, with the
    // reader further down, unplaced over the list ([BoardBody]), where
    // nothing draws them, TalkBack never hears them and focus never reaches
    // them. So a turn or a fresh board puts them where they now fit, however
    // far down the list stands. Measured only where they were drawn, they
    // stayed in the list once it had scrolled past them, out of view on a
    // phone turned upright, until the reader went back to its very top.
    //
    // Where they stood as the board was last drawn is saved with the list's
    // place, which is saved by item and counts the blocks as its first item
    // where they led it ([UsageJoin]). A board drawn afresh, back from a
    // card's history or made again at another text size, keeps them there
    // until it has measured them, so that place is read as it was counted;
    // measured, they go where they now fit, and the list keeps the card at
    // its top as they join it or leave it. Measured afresh with nothing
    // saved, they joined a frame late and the list started one card on.
    // Their heights saved instead, heights from one text size placed them
    // for another: a small phone turned up to 200% started one card back.
    var usageHeight by remember { mutableIntStateOf(0) }
    var bodyHeight by remember { mutableIntStateOf(0) }
    val leastList = leastListRoom()
    val leastListPx = with(LocalDensity.current) { leastList.roundToPx() }
    val joining = rememberSaveable(saver = remember(listState) { UsageJoin.saver(listState) }) { UsageJoin() }
    val usageLeads = sessions.isNotEmpty() && !boardGone && visibleUsage.isNotEmpty() &&
        if (usageHeight > 0 && bodyHeight > 0) bodyHeight - usageHeight < leastListPx else joining.leads
    val leadsNow by rememberUpdatedState(usageLeads)
    // The blocks join the list as its first item. The list keeps the item at
    // its top where it was, which would leave them above the screen, and
    // where what follows them is shorter than the list it scrolls back only
    // part of the way: one card sideways showed 38dp of a 127dp block. So a
    // list that stood at its top when they joined is put back at its top,
    // the blocks whole, whatever it would have made of the insertion. Read
    // here, after the blocks join the list and before it lays them out, the
    // list's place is still where it stood; a list scrolled down keeps it.
    //
    // Leaving it, they take with them the first item the list would keep
    // its place by, and it kept how far down that item it stood instead: a
    // list stopped partway into them, turned upright, began that far into
    // its first section, the first card's top under the label. Made again
    // at a smaller text size, how far down them it stood was counted in the
    // larger size's pixels, and it began a section or more further on. So
    // a list whose first item was the blocks, as last drawn or as saved,
    // starts at its top as they leave it, as a board drawn afresh with them
    // pinned does. As saved, because a board made again can be drawn twice
    // over, and the second drawing finds the list already past them.
    SideEffect {
        val blocksFirst = listState.firstVisibleItemIndex == 0
        if (usageLeads && !joining.leads && blocksFirst && listState.firstVisibleItemScrollOffset == 0) {
            listState.requestScrollToItem(0)
        }
        if (!usageLeads && joining.leads && (blocksFirst || joining.inBlocks)) {
            listState.requestScrollToItem(0)
        }
        if (usageHeight > 0 && bodyHeight > 0) joining.inBlocks = false
        joining.leads = usageLeads
    }

    // Tab's order, as the web board's page has it: the usage blocks, the
    // needs-you bar, then the cards. BoardBody places them so while the
    // blocks are pinned. Leading the list, the blocks are in it, before its
    // cards, and with the bar up Tab would reach the bar first, so these say
    // where Tab goes among the four, each only to what is composed; Shift+Tab
    // from the bar brings the blocks back to be composed first (the bar's
    // key handler).
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

    // When the bar leaves while it has a keyboard's focus, the focus goes on
    // to the card the bar last named, where that card is in view, else to
    // the first card in view: never to the top app bar, where the platform
    // put it, the reader's place on the board lost and a stray Enter opening
    // Settings or leaving the demo. With no card in view, as where the usage
    // blocks fill a phone held sideways at large text, it goes to the first
    // block, which is. It goes as the bar starts to leave, while the bar
    // still holds it, or, with animations off, the moment the bar has gone.
    // What takes it is brought into view as any focus in the list is
    // (underLabel): nothing moves where it shows whole under the stuck
    // label, and otherwise the list moves the least way that shows it, so a
    // card partly under the label comes down to just under it. TalkBack
    // keeps a focus of its own, and a press has already sent the keyboard's
    // to the card it brought.
    val lastNamed = remember { LastNamed() }
    SideEffect { barTarget?.let { lastNamed.id = it.id } }
    val readingNow by rememberUpdatedState(reading)
    val handFocusOn: () -> Unit = handOn@{
        if (lastNamed.handedOn) return@handOn
        lastNamed.handedOn = true
        val to = focusAfterBar(listState.layoutInfo, lastNamed.id, labelHeight.px)
        if (to != null) focusTarget = to
        scope.launch {
            withFrameNanos { }
            runCatching { if (to != null) jumpFocus.requestFocus() else usageFirst.requestFocus() }
        }
    }
    LaunchedEffect(reading == null) {
        if (reading != null) {
            lastNamed.handedOn = false
        } else if (barFocused) {
            handFocusOn()
        }
    }

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
                speaker.say("${ProjectSections.cardLead(target)}, blocked")
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
            usagePinned = !usageLeads,
            usage = {
                // Pinned; or, while they lead the list and its item for them
                // is not composed, only measured here, so where they stand
                // follows the room they need now. Measured only, they carry
                // nothing a reader or a test could find, and no requester.
                if (visibleUsage.isNotEmpty() && !boardGone && (!usageLeads || !usageComposed)) {
                    UsageBars(
                        usage = visibleUsage,
                        onOpenDetail = onOpenUsage,
                        sessionCounts = sessionCounts,
                        modifier = Modifier
                            .onSizeChanged { usageHeight = it.height }
                            .then(if (usageLeads) Modifier.clearAndSetSemantics {} else Modifier)
                            .then(sides)
                            .padding(horizontal = 16.dp)
                            .padding(top = USAGE_TOP, bottom = 2.dp),
                        // Where the focus goes when the bar leaves with no card in view.
                        firstBlock = if (usageLeads) Modifier else Modifier.focusRequester(usageFirst),
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
                        .onFocusChanged { state ->
                            val lost = barFocused && !state.isFocused
                            barFocused = state.isFocused
                            // Gone at once, animations off: it lost the focus going.
                            if (lost && readingNow == null) handFocusOn()
                        }
                        // Back from the bar, Shift+Tab goes to the last usage
                        // block, in view. Leading the list, the blocks are its
                        // first item, which the list composes only near its
                        // top, so from a list Tabbed on into its cards the
                        // search found none of them: the focus went to the top
                        // bar's Settings, past every block, or, on a device, to
                        // the last block laid out beyond the list's bounds and
                        // never brought into view, where Enter opened a usage
                        // screen the reader could not see. So the list goes
                        // back to its top, as a fresh board has it, and the
                        // last block takes the focus there (FocusInBlocks), as
                        // the blocks hand Tab on to the first card the other
                        // way. Not from the bar's focusProperties, which focus
                        // search reads more than once a move.
                        .onPreviewKeyEvent { event ->
                            if (tabsAround && event.type == KeyEventType.KeyDown && event.isBackTab()) {
                                scope.launch {
                                    listState.scrollToItem(0)
                                    withFrameNanos { }
                                    runCatching { usageLast.requestFocus() }
                                }
                                true
                            } else {
                                false
                            }
                        }
                        .focusProperties {
                            if (tabsAround && firstCardComposed) next = firstCardFocus
                        },
                )
            },
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
                                            onDispose {
                                                usageComposed = false
                                                focusInBlocks.held = false
                                            }
                                        }
                                        UsageBars(
                                            usage = visibleUsage,
                                            onOpenDetail = onOpenUsage,
                                            sessionCounts = sessionCounts,
                                            modifier = Modifier
                                                .onSizeChanged { usageHeight = it.height }
                                                .padding(top = USAGE_TOP, bottom = 2.dp)
                                                // Read by the room focus is brought
                                                // into (underLabel), before the list
                                                // is asked to bring a block in.
                                                .onFocusChanged { focusInBlocks.held = it.hasFocus }
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
                                            title = section.title,
                                            isNoProject = section.isNoProject,
                                            count = section.sessions.size,
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
                                    items(section.sessions, key = { it.id }, contentType = { CARD_TYPE }) { session ->
                                        val current by rememberUpdatedState(session)
                                        // A fresh swipe for each life of a card. The
                                        // swipe was saved with the list, by session
                                        // id, so a card swiped away came back, when
                                        // its session posted again and the server
                                        // filed it under its home, as the red Dismiss
                                        // slab with the card off the screen, until the
                                        // app restarted. Not saved now, and new with
                                        // each card the server makes (its createdAt).
                                        val threshold = SwipeToDismissBoxDefaults.positionalThreshold
                                        val dismissState = remember(session.createdAt) {
                                            SwipeToDismissBoxState(SwipeToDismissBoxValue.Settled, threshold)
                                        }
                                        // On at once, and gone at once if the card
                                        // is unblocked; it lets go of its own accord
                                        // with a fade, unless animations are off.
                                        val ringOn = ringed == session.id && session.isBlocked
                                        val ring = animateFloatAsState(
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
                                            onDismiss = { direction ->
                                                if (direction == SwipeToDismissBoxValue.EndToStart) {
                                                    scope.launch {
                                                        store.dismiss(current)
                                                        // Still on the board: the dismiss
                                                        // failed and the store put the card
                                                        // back where it was. Whole, not as
                                                        // the slab it was swiped to.
                                                        if (store.sessions.value.any { it.id == current.id }) {
                                                            dismissState.snapTo(SwipeToDismissBoxValue.Settled)
                                                        }
                                                    }
                                                }
                                            },
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
                                                    .jumpRing(ring)
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
 * blocked.
 *
 * Placed in another order than drawn: the usage blocks, the bar, then the
 * list. Compose walks a keyboard's Tab through siblings in the order they are
 * placed, so Tab reaches the bar after the usage blocks and before the cards,
 * where it stands in the web board's page. As the Scaffold's bottom bar it
 * was placed after the top bar, and Tab went from Settings to the bar before
 * anything on the board.
 *
 * TalkBack is given the same order ([ReadInTurn]). It goes by position where
 * nothing says otherwise, and heard the board's one alarm last, after every
 * label and card on the board. Where the usage blocks lead the list they are
 * its first item, inside the list, so TalkBack hears the bar just before
 * them, as VoiceOver does on iOS; Tab still reaches it after them.
 *
 * [bottomInset] is the system bar under the board: the list keeps above it
 * while no bar shows, and the bar, which runs to the bottom edge, pads itself.
 *
 * [usage] is placed over the list while [usagePinned]. While the usage blocks
 * lead the list instead it is empty, or, while the list's item for them is
 * not composed, the blocks measured and never placed: Compose leaves an
 * unplaced node out of what TalkBack reads and out of focus search, and the
 * list keeps its whole height.
 */
@Composable
private fun BoardBody(
    bottomInset: Dp,
    usagePinned: Boolean,
    usage: @Composable () -> Unit,
    bar: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    board: @Composable () -> Unit,
) {
    Layout(
        contents = listOf(
            { ReadInTurn(turn = 0f, content = usage) },
            { ReadInTurn(turn = 1f, content = bar) },
            { ReadInTurn(turn = 2f, content = board) },
        ),
        modifier = modifier.semantics { isTraversalGroup = true },
    ) { slots, constraints ->
        val (usageSlot, barSlot, boardSlot) = slots
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
        val top = if (usagePinned) usages.sumOf { it.height } else 0
        val boards = boardSlot.map { it.measure(Constraints.fixed(width, (height - top - bottom).coerceAtLeast(0))) }
        layout(width, height) {
            if (usagePinned) {
                var y = 0
                for (placeable in usages) {
                    placeable.place(0, y)
                    y += placeable.height
                }
            }
            for (placeable in bars) placeable.place(0, height - placeable.height)
            for (placeable in boards) placeable.place(0, top)
        }
    }
}

/**
 * One of [BoardBody]'s parts, which TalkBack reads whole, in its [turn]
 * among the others, wherever it is drawn. Measured as its content would be
 * on its own, so the board lays out as it did.
 */
@Composable
private fun ReadInTurn(turn: Float, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.semantics {
            isTraversalGroup = true
            traversalIndex = turn
        },
        propagateMinConstraints = true,
    ) {
        content()
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
 * Never further back than the list can go. A scroll asked of the list and
 * not given goes on up as if a finger had pulled, and at the list's top the
 * pull-to-refresh took it as a pull that no lifted finger ever let go: focus
 * on the first card, from the bar or a keyboard's Tab, left the spinner stuck
 * in view. While the list's first item is the first in view, [backRoom]
 * says exactly how far back it can go. Further on, the list cannot say: the
 * first item is laid out beyond its bounds when focus goes there, and is not
 * among the items it reports. So nothing focusable sits nearer the list's top
 * than where its room starts ([top]): a card is a label's height down at
 * least, and the usage blocks, where they lead the list, start their room at
 * their own top padding rather than under a label, while focus is in them
 * ([FocusInBlocks]).
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

/**
 * Whether a keyboard's focus is in the usage blocks where they lead the list.
 * Plain: the room focus is brought into reads it ([UnderLabelBringIntoView]),
 * and nothing is drawn from it.
 */
private class FocusInBlocks {
    var held = false
}

/** The usage blocks' top padding, pinned or leading the list: where the list's top puts them. */
private val USAGE_TOP = 10.dp

/**
 * Whether the usage blocks led the list when the board was last drawn
 * ([leads]), and, on a board drawn afresh until it has measured them again,
 * whether the list's saved place was in them, its first item ([inBlocks]).
 * Plain: updating it must not recompose. Saved with the list's place, which
 * counted them by it.
 */
private class UsageJoin(var leads: Boolean = false, var inBlocks: Boolean = false) {
    companion object {
        /** Reads the place of [list] as it saves: in the blocks where they lead it and it stands in its first item. */
        fun saver(list: LazyListState) = listSaver<UsageJoin, Boolean>(
            save = { listOf(it.leads, it.inBlocks || (it.leads && list.firstVisibleItemIndex == 0)) },
            restore = { UsageJoin(leads = it[0], inBlocks = it[1]) },
        )
    }
}

/** A card's content type in the board's list. */
private const val CARD_TYPE = "card"

/**
 * The card the needs-you bar last named, and whether the focus has been
 * handed on to a card since it left. Plain: updating it must not recompose.
 */
private class LastNamed {
    var id: String? = null
    var handedOn = false
}

/**
 * Where a keyboard's focus goes when the needs-you bar leaves while it has
 * it: the card the bar last [named], where it is at least partly in view
 * under the stuck label ([labelPx] tall), else the first card that is. Null
 * with no card in view, where the board gives it to the first usage block.
 */
internal fun focusAfterBar(layout: LazyListLayoutInfo, named: String?, labelPx: Int): String? {
    val inView = layout.visibleItemsInfo.filter { item ->
        item.contentType == CARD_TYPE && item.offset + item.size > labelPx && item.offset < layout.viewportEndOffset
    }
    return (inView.firstOrNull { it.key == named } ?: inView.firstOrNull())?.key as? String
}

/** Shift+Tab, or a keyboard's own key for the control before: a step back in Tab's order. */
private fun KeyEvent.isBackTab(): Boolean = key == Key.NavigatePrevious || (key == Key.Tab && isShiftPressed)

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
