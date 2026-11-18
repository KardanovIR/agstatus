package com.kardanov.agstatus.ui

import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

/**
 * Where the needs-you bar's focus ring stands ([barRingOutline]): 2dp in
 * from the bar's edges and from the insets beside and under it, and, where
 * the display rounds a bottom corner the ring would reach, moved in from it.
 * In a Pixel 7's pixels, 2.625 to the dp: 2dp is 5 px and the most a side
 * may move, 10dp, is 26. The display's own corners there are 48 px; the
 * platform reports them from Android 12.
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
        bottomLeft: DisplayCorner? = null,
        bottomRight: DisplayCorner? = null,
    ) = barRingOutline(width, height, left, right, bottom, gap, room, bottomLeft, bottomRight)

    /** A display corner of [radius] px at the bar's bottom corners, the bar running the display's width. */
    private fun corners(radius: Float) =
        DisplayCorner(radius, height - radius, radius) to DisplayCorner(width - radius, height - radius, radius)

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
}
