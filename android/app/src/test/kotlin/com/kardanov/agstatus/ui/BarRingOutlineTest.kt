package com.kardanov.agstatus.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

/**
 * Where the needs-you bar's focus ring stands ([barRingOutline]): 2dp in
 * from the bar's edges and from the insets beside and under it, and, where
 * a rounded bottom corner would reach the ring, moved in from it. In a Pixel
 * 7's pixels, 2.625 to the dp: 2dp is 5 px and the most a side may move,
 * 10dp, is 26. The display's own corners there are 48 px; the platform
 * reports them from Android 12.
 *
 * Which corners count ([ringCorners]): the display's, and the window's only
 * where the window itself is rounded. The reports here are the Pixel 7
 * emulator's own (Android 16), read from the app on it in each window.
 */
class BarRingOutlineTest {

    private val width = 1080f
    private val height = 184f
    private val gap = 5f
    private val room = 26f

    private fun outline(
        left: Float = 0f,
        right: Float = 0f,
        bottom: Float = 0f,
        bottomLeft: CornerCurve? = null,
        bottomRight: CornerCurve? = null,
    ) = barRingOutline(width, height, left, right, bottom, gap, room, RingCorners(displayLeft = bottomLeft, displayRight = bottomRight))

    /** A display corner of [radius] px at the bar's bottom corners, the bar running the display's width. */
    private fun corners(radius: Float) =
        CornerCurve(radius, height - radius, radius) to CornerCurve(width - radius, height - radius, radius)

    @Test
    fun `with nothing beside or under the bar, the ring stands 2dp in from every edge`() {
        assertEquals(Rect(5f, 5f, 1075f, 179f), outline())
    }

    @Test
    fun `it stands 2dp in from a cutout beside the bar and the navigation under it`() {
        // Sideways with gestures: the camera on the left, the handle along the bottom.
        assertEquals(Rect(141f, 5f, 1075f, 116f), outline(left = 136f, bottom = 63f))
        // Sideways with three buttons, on the right.
        assertEquals(Rect(141f, 5f, 949f, 179f), outline(left = 136f, right = 126f))
    }

    @Test
    fun `a rounded corner the ring does not reach leaves it where it was`() {
        val (bottomLeft, bottomRight) = corners(48f)
        // Upright with gestures: the handle keeps the ring above the curve.
        assertEquals(Rect(5f, 5f, 1075f, 116f), outline(bottom = 63f, bottomLeft = bottomLeft, bottomRight = bottomRight))
        // Beside a cutout and three buttons, the curve is under the insets.
        assertEquals(Rect(141f, 5f, 949f, 179f), outline(left = 136f, right = 126f, bottomLeft = bottomLeft, bottomRight = bottomRight))
    }

    @Test
    fun `where a rounded corner would cut the ring, that side moves in until the ring's corner is 2dp inside the curve`() {
        val (bottomLeft, bottomRight) = corners(120f)

        val ring = outline(bottom = 63f, bottomLeft = bottomLeft, bottomRight = bottomRight)

        assertEquals(Rect(18f, 5f, 1062f, 116f), ring)
        // Each corner of the ring is within the curve's radius less 2dp of its centre.
        assertTrue(hypot(bottomLeft.x - ring.left, ring.bottom - bottomLeft.y) <= bottomLeft.radius - gap)
        assertTrue(hypot(ring.right - bottomRight.x, ring.bottom - bottomRight.y) <= bottomRight.radius - gap)
    }

    @Test
    fun `a side moves in no further than 10dp, which keeps the ring 2dp from the words`() {
        // Nothing under the bar or beside it, where the display rounds both corners.
        val (bottomLeft, bottomRight) = corners(48f)

        assertEquals(Rect(31f, 5f, 1049f, 179f), outline(bottomLeft = bottomLeft, bottomRight = bottomRight))
    }

    @Test
    fun `the display's corner and the window's at one place move a side no further than either alone`() {
        // A window whose own corners are the display's, nothing beside or
        // under the bar: both are reported, and the 10dp counts from where
        // the side starts, not from where the first curve left it.
        val (bottomLeft, bottomRight) = corners(48f)
        val both = RingCorners(displayLeft = bottomLeft, displayRight = bottomRight, windowLeft = bottomLeft, windowRight = bottomRight)

        assertEquals(Rect(31f, 5f, 1049f, 179f), barRingOutline(width, height, 0f, 0f, 0f, gap, room, both))
    }

    /** What the platform reports, as the emulator reported it: each corner's centre and radius. */
    private fun reported(
        window: Pair<Float, Float>,
        windowLeft: Triple<Float, Float, Float>?,
        windowRight: Triple<Float, Float, Float>?,
        displayLeft: Triple<Float, Float, Float>? = null,
        displayRight: Triple<Float, Float, Float>? = null,
    ) = ReportedCorners(
        displayLeft = displayLeft?.let { CornerCurve(it.first, it.second, it.third) },
        displayRight = displayRight?.let { CornerCurve(it.first, it.second, it.third) },
        windowLeft = windowLeft?.let { CornerCurve(it.first, it.second, it.third) },
        windowRight = windowRight?.let { CornerCurve(it.first, it.second, it.third) },
        windowWidth = window.first,
        windowHeight = window.second,
    )

    @Test
    fun `a split screen's window above the divider is rounded itself, and the ring keeps clear of its corners`() {
        // AgStatus in the top half, 1080 by 1187, its bar 156 px tall at 1031
        // with nothing under it; the display's own corners are far below.
        val report = reported(
            window = 1080f to 1187f,
            windowLeft = Triple(48f, 1139f, 48f),
            windowRight = Triple(1032f, 1139f, 48f),
            displayLeft = Triple(48f, 2352f, 48f),
            displayRight = Triple(1032f, 2352f, 48f),
        )
        val corners = ringCorners(report, inWindow = Offset(0f, 1031f), onScreen = Offset(0f, 1031f))

        assertEquals(CornerCurve(48f, 108f, 48f), corners.windowLeft)
        assertEquals(CornerCurve(1032f, 108f, 48f), corners.windowRight)
        assertEquals(CornerCurve(48f, 1321f, 48f), corners.displayLeft)
        // Each side as far in as 10dp allows: the curve would ask for 43 px.
        val ring = barRingOutline(1080f, 156f, 0f, 0f, 0f, gap, room, corners)
        assertEquals(Rect(31f, 5f, 1049f, 151f), ring)
        // There the ring's corner is inside the curve, nearer it than 2dp.
        val fromCentre = hypot(48f - ring.left, ring.bottom - 108f)
        assertTrue("$fromCentre", fromCentre < 48f && fromCentre > 48f - gap)
    }

    @Test
    fun `beside the divider, the window's corner by it counts, and one reported at the navigation bar's edge does not`() {
        // Sideways, three buttons, AgStatus on the left, 1192 by 1080, the
        // camera's cutout on its left: its bottom right corner meets the
        // divider.
        val left = reported(
            window = 1192f to 1080f,
            windowLeft = Triple(47f, 1033f, 47f),
            windowRight = Triple(1144f, 1032f, 48f),
            displayLeft = Triple(47f, 1033f, 47f),
            displayRight = Triple(2352f, 1032f, 48f),
        )
        val onLeft = ringCorners(left, inWindow = Offset(0f, 924f), onScreen = Offset(0f, 924f))
        assertEquals(Rect(141f, 5f, 1161f, 151f), barRingOutline(1192f, 156f, 136f, 0f, 0f, gap, room, onLeft))

        // AgStatus on the right, 1182 by 1080 at 1218 on the display, the
        // navigation bar on its right: its bottom left corner meets the
        // divider; its bottom right is reported at the navigation bar's edge,
        // 126 px in, where nothing is drawn.
        val right = reported(
            window = 1182f to 1080f,
            windowLeft = Triple(47f, 1033f, 47f),
            windowRight = Triple(1008f, 1032f, 48f),
            displayLeft = Triple(47f, 1033f, 47f),
            displayRight = Triple(2352f, 1032f, 48f),
        )
        val onRight = ringCorners(right, inWindow = Offset(0f, 924f), onScreen = Offset(1218f, 924f))
        assertEquals(null, onRight.windowRight)
        assertEquals(CornerCurve(1134f, 108f, 48f), onRight.displayRight)
        assertEquals(Rect(31f, 5f, 1051f, 151f), barRingOutline(1182f, 156f, 0f, 126f, 0f, gap, room, onRight))
    }

    @Test
    fun `corners reported at a navigation bar's edge or a taskbar's are left out, wherever it stands`() {
        // Upright, three buttons, 126 px under the bar.
        val upright = reported(window = 1080f to 2400f, windowLeft = Triple(48f, 2226f, 48f), windowRight = Triple(1032f, 2226f, 48f))
        assertEquals(RingCorners.None, ringCorners(upright, Offset(0f, 2118f), Offset(0f, 2118f)))
        // Sideways, three buttons on the right: nothing under the bar, and
        // the corner on the window's bottom edge, but 126 px in from its
        // side. Followed, the ring's right side moved 10dp in.
        val sideways = reported(window = 2400f to 1080f, windowLeft = Triple(47f, 1033f, 47f), windowRight = Triple(2226f, 1032f, 48f))
        val corners = ringCorners(sideways, Offset(0f, 954f), Offset(0f, 954f))
        assertEquals(null, corners.windowRight)
        assertEquals(Rect(141f, 5f, 2269f, 121f), barRingOutline(2400f, 126f, 136f, 126f, 0f, gap, room, corners))
        // The other way round, the buttons on the left.
        val seascape = reported(window = 2400f to 1080f, windowLeft = Triple(174f, 1032f, 48f), windowRight = Triple(2353f, 1033f, 47f))
        assertEquals(null, ringCorners(seascape, Offset(0f, 954f), Offset(0f, 954f)).windowLeft)
        // A large screen's taskbar, 112 px, reported the same way.
        val taskbar = reported(window = 1600f to 2560f, windowLeft = Triple(51f, 2397f, 51f), windowRight = Triple(1549f, 2397f, 51f))
        assertEquals(RingCorners.None, ringCorners(taskbar, Offset(0f, 2352f), Offset(0f, 2352f)))
    }
}
