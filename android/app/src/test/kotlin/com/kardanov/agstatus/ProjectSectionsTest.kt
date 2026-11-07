package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board grouped by project (docs/design/project-sections.md): which
 * section a card is in, the order sections run in — the same vector the web
 * and iOS tests assert — the order of cards inside one, and the needs-you
 * bar's walk through the blocked cards.
 */
class ProjectSectionsTest {

    private fun session(
        id: String,
        project: String = "",
        homeProject: String = "",
        status: AgentStatus = AgentStatus.CODING,
        name: String = "",
        source: String = "claude",
        updatedAt: Long = 0,
    ) = Session(
        id = id,
        name = name,
        status = status,
        project = project,
        homeProject = homeProject,
        source = source,
        updatedAt = updatedAt,
    )

    private fun titles(sections: List<ProjectSection>) = sections.map { it.title }

    private fun ids(sessions: List<Session>) = sessions.map { it.id }

    // MARK: - The shared order

    @Test
    fun `sections run in the shared vector's order on a current server`() {
        val board = SHARED_VECTOR.mapIndexed { index, name -> session("s$index", project = name, homeProject = name) }

        assertEquals(SHARED_ORDER, titles(ProjectSections.of(board)))
    }

    @Test
    fun `a server too old to send homeProject sorts the live folders the same way`() {
        val board = SHARED_VECTOR.mapIndexed { index, name -> session("s$index", project = name) }

        assertEquals(SHARED_ORDER, titles(ProjectSections.of(board)))
    }

    @Test
    fun `the empty name and the UUID share No project, which is last`() {
        val board = SHARED_VECTOR.mapIndexed { index, name -> session("s$index", project = name, homeProject = name) }
        val noProject = ProjectSections.of(board).last()

        assertTrue(noProject.isNoProject)
        assertEquals(listOf("s1", "s7"), ids(noProject.sessions))
    }

    @Test
    fun `the order comparator ranks names alone the same way`() {
        val sorted = SHARED_VECTOR
            .map { if (ProjectSections.isRealFolder(it)) it else "" }
            .distinct()
            .sortedWith(ProjectSections.ORDER)

        assertEquals(listOf("AgStatus", "agstatus", "Alpha", "alpha", "beta", "zeta", ""), sorted)
    }

    @Test
    fun `order goes by code unit after case, never by a collator`() {
        // A collator puts "_" before "-"; a JavaScript `<` and this do not.
        val sorted = listOf("acme_web", "acme-api", "acme9", "Acme").sortedWith(ProjectSections.ORDER)

        assertEquals(listOf("Acme", "acme-api", "acme9", "acme_web"), sorted)
    }

    @Test
    fun `a busy card never moves its section`() {
        val quiet = listOf(session("a", homeProject = "alpha"), session("b", homeProject = "beta"))
        val busy = listOf(
            session("b", homeProject = "beta", status = AgentStatus.BLOCKED, updatedAt = 99),
            session("a", homeProject = "alpha"),
        )

        assertEquals(titles(ProjectSections.of(quiet)), titles(ProjectSections.of(busy)))
    }

    // MARK: - Which section

    @Test
    fun `the pinned folder names the section, so a cd never moves a card`() {
        val started = session("a", project = "acme-api", homeProject = "acme-api")
        val moved = started.copy(project = "web")

        assertEquals("acme-api", ProjectSections.nameOf(started))
        assertEquals("acme-api", ProjectSections.nameOf(moved))
    }

    @Test
    fun `without a pinned folder the live one names the section`() {
        assertEquals("web", ProjectSections.nameOf(session("a", project = "web")))
    }

    @Test
    fun `an empty or UUID-shaped folder is No project`() {
        assertEquals("", ProjectSections.nameOf(session("a")))
        assertEquals("", ProjectSections.nameOf(session("a", project = "0F3C2A1E-6B4D-4E8F-9A7B-1C2D3E4F5A6B")))
        assertEquals("", ProjectSections.nameOf(session("a", homeProject = UUID, project = "")))
    }

    @Test
    fun `a name that only looks like part of a UUID is a folder`() {
        assertTrue(ProjectSections.isRealFolder("0f3c2a1e"))
        assertTrue(ProjectSections.isRealFolder("$UUID-fork"))
    }

    // MARK: - Keys

    @Test
    fun `a label's key is project and its name, never a session id`() {
        val board = listOf(session("project", homeProject = "acme"), session("acme"), session("x", homeProject = "x"))
        val sections = ProjectSections.of(board)

        assertEquals(listOf("project/acme", "project/x", "project/"), sections.map { it.key })
        val cardKeys = board.map { it.id }.toSet()
        assertTrue(sections.none { it.key in cardKeys })
    }

    @Test
    fun `the jump's list index counts each label before its cards`() {
        val sections = ProjectSections.of(
            listOf(
                session("a1", homeProject = "alpha"),
                session("b1", homeProject = "beta"),
                session("a2", homeProject = "alpha"),
                session("n1"),
            ),
        )
        // 0 alpha, 1 a1, 2 a2, 3 beta, 4 b1, 5 No project, 6 n1.
        assertEquals(1, ProjectSections.listIndex(sections, "a1"))
        assertEquals(2, ProjectSections.listIndex(sections, "a2"))
        assertEquals(4, ProjectSections.listIndex(sections, "b1"))
        assertEquals(6, ProjectSections.listIndex(sections, "n1"))
        assertEquals(-1, ProjectSections.listIndex(sections, "gone"))
    }

    // MARK: - Card order inside a section

    @Test
    fun `cards keep the board's order inside their section`() {
        val board = listOf(
            session("c", homeProject = "alpha", updatedAt = 1),
            session("x", homeProject = "beta", updatedAt = 9),
            session("a", homeProject = "alpha", updatedAt = 5),
            session("b", homeProject = "alpha", updatedAt = 3),
        )

        assertEquals(listOf("c", "a", "b"), ids(ProjectSections.of(board).first().sessions))
    }

    @Test
    fun `a new session goes on top of its section and the others keep their place`() {
        val before = listOf(
            session("a", homeProject = "alpha", updatedAt = 5),
            session("x", homeProject = "beta", updatedAt = 4),
            session("b", homeProject = "alpha", updatedAt = 3),
        )
        val incoming = before.map { it.copy(updatedAt = it.updatedAt + 100) } +
            session("new", homeProject = "alpha", updatedAt = 50)

        val after = ProjectSections.of(SessionStore.stableOrder(before, incoming))

        assertEquals(listOf("new", "a", "b"), ids(after.first { it.name == "alpha" }.sessions))
        assertEquals(listOf("x"), ids(after.first { it.name == "beta" }.sessions))
    }

    @Test
    fun `a card that is blocked keeps its place`() {
        val before = listOf(session("a", homeProject = "alpha"), session("b", homeProject = "alpha"))
        val incoming = listOf(before[0], before[1].copy(status = AgentStatus.BLOCKED, updatedAt = 99))

        assertEquals(listOf("a", "b"), ids(ProjectSections.of(SessionStore.stableOrder(before, incoming)).single().sessions))
    }

    @Test
    fun `a session's first real folder moves it out of No project once`() {
        val waiting = session("a")
        val arrived = waiting.copy(project = "acme-api", homeProject = "acme-api")
        val moved = arrived.copy(project = "web")

        assertEquals("", ProjectSections.nameOf(waiting))
        assertEquals("acme-api", ProjectSections.nameOf(arrived))
        assertEquals("acme-api", ProjectSections.nameOf(moved))
    }

    // MARK: - The place

    @Test
    fun `a card says where it is only once it has moved`() {
        assertNull(ProjectSections.place(session("a", project = "acme-api", homeProject = "acme-api", name = "Fix it")))
        assertEquals("web", ProjectSections.place(session("a", project = "web", homeProject = "acme-api", name = "Fix it")))
    }

    @Test
    fun `no place where the folder is the card's own name, or not a folder`() {
        assertNull(ProjectSections.place(session("a", project = "web", homeProject = "acme-api", name = "web")))
        assertNull(ProjectSections.place(session("a", project = UUID, homeProject = "acme-api", name = "Fix it")))
        assertNull(ProjectSections.place(session("a", project = "", homeProject = "acme-api", name = "Fix it")))
    }

    @Test
    fun `a worktree card under its repository says nothing the label does not`() {
        // A Claude worktree root reports its repository as the project, and
        // the worktree's own folder as the name.
        val worktree = session("a", project = "my-repo", homeProject = "my-repo", name = "feature-x")

        assertEquals("my-repo", ProjectSections.nameOf(worktree))
        assertNull(ProjectSections.place(worktree))
    }

    @Test
    fun `an old server's card is in its live folder, so it has no place to add`() {
        assertNull(ProjectSections.place(session("a", project = "web", name = "Fix it")))
    }

    // MARK: - The needs-you bar

    private val walkBoard = ProjectSections.of(
        listOf(
            session("a1", homeProject = "alpha", status = AgentStatus.CODING),
            session("a2", homeProject = "alpha", status = AgentStatus.BLOCKED),
            session("b1", homeProject = "beta", status = AgentStatus.DONE),
            session("n1", status = AgentStatus.BLOCKED),
            session("a3", homeProject = "alpha", status = AgentStatus.BLOCKED),
        ),
    )

    @Test
    fun `the bar names the first blocked card in reading order`() {
        // Reading order is alpha (a1, a2, a3), beta (b1), No project (n1).
        assertEquals("a2", ProjectSections.barTarget(walkBoard, shown = null)?.id)
        assertFalse(ProjectSections.barWalks(walkBoard, shown = null))
    }

    @Test
    fun `after a press it names the next, round to the first`() {
        assertEquals("a3", ProjectSections.barTarget(walkBoard, shown = "a2")?.id)
        assertEquals("n1", ProjectSections.barTarget(walkBoard, shown = "a3")?.id)
        assertEquals("a2", ProjectSections.barTarget(walkBoard, shown = "n1")?.id)
        assertTrue(ProjectSections.barWalks(walkBoard, shown = "a2"))
    }

    @Test
    fun `a card unblocked since it was shown is walked on from`() {
        val board = ProjectSections.of(
            listOf(
                session("a1", homeProject = "alpha", status = AgentStatus.CODING),
                session("a2", homeProject = "alpha", status = AgentStatus.BLOCKED),
                session("b1", homeProject = "beta", status = AgentStatus.BLOCKED),
            ),
        )

        assertEquals("a2", ProjectSections.barTarget(board, shown = "a1")?.id)
    }

    @Test
    fun `a card dismissed since it was shown starts the walk over`() {
        assertEquals("a2", ProjectSections.barTarget(walkBoard, shown = "gone")?.id)
        assertFalse(ProjectSections.barWalks(walkBoard, shown = "gone"))
    }

    @Test
    fun `one blocked card is shown again, and the verb stays Show`() {
        val board = ProjectSections.of(listOf(session("a", homeProject = "alpha", status = AgentStatus.BLOCKED)))

        assertEquals("a", ProjectSections.barTarget(board, shown = "a")?.id)
        assertFalse(ProjectSections.barWalks(board, shown = "a"))
    }

    @Test
    fun `no bar while nothing is blocked, and done is never counted`() {
        val board = ProjectSections.of(
            listOf(session("a", status = AgentStatus.DONE), session("b", status = AgentStatus.IDLE)),
        )

        assertNull(ProjectSections.barTarget(board, shown = null))
        assertNull(ProjectSections.barTarget(board, shown = "a"))
    }

    // MARK: - Copy

    @Test
    fun `a label says its name and its count`() {
        val sections = ProjectSections.of(
            listOf(session("a", homeProject = "acme-api"), session("b", homeProject = "acme-api"), session("c")),
        )

        assertEquals("acme-api, 2 sessions", ProjectSections.labelDescription(sections[0]))
        assertEquals("No project, 1 session", ProjectSections.labelDescription(sections[1]))
    }

    @Test
    fun `the bar says how many, which and where`() {
        val target = session("a", homeProject = "acme-api", name = "Fix the login redirect", status = AgentStatus.BLOCKED)

        assertEquals("in acme-api", ProjectSections.barWhere(target))
        assertEquals("2 blocked: Fix the login redirect, in acme-api", ProjectSections.barDescription(2, target))
    }

    @Test
    fun `a session in No project is placed by its agent's name instead`() {
        val titled = session("a", name = "Reading the brief", source = "codex", status = AgentStatus.BLOCKED)
        val untitled = session("b", name = "Codex", source = "codex", status = AgentStatus.BLOCKED)

        assertEquals("1 blocked: Reading the brief, Codex", ProjectSections.barDescription(1, titled))
        // Not "Codex, Codex".
        assertNull(ProjectSections.barWhere(untitled))
        assertEquals("1 blocked: Codex", ProjectSections.barDescription(1, untitled))
    }

    @Test
    fun `a card says its agent first`() {
        assertEquals("Codex, docs-site", ProjectSections.cardLead(session("a", name = "docs-site", source = "codex")))
        assertEquals("Claude, s1", ProjectSections.cardLead(session("s1")))
    }

    private companion object {
        const val UUID = "0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b"

        /** docs/design/project-sections.md, "Shared test vector": every client asserts this order. */
        val SHARED_VECTOR = listOf("zeta", "", "Alpha", "alpha", "beta", "AgStatus", "agstatus", UUID)
        val SHARED_ORDER = listOf("AgStatus", "agstatus", "Alpha", "alpha", "beta", "zeta", ProjectSection.NO_PROJECT)
    }
}
