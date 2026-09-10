/**
 * Width below which the board panes stack instead of splitting horizontally.
 *
 * En Croissant's shell is built for a desktop window: a resizable Mosaic splits the
 * board, the panels and the move list into columns. On a phone that leaves the board
 * around 180px wide, so below this width the panes are stacked and scrolled.
 *
 * Two clauses, because width alone gets tablets wrong. 48em is Mantine's `sm` and
 * catches phones even in landscape. The second clause is the general rule: portrait
 * stacks, landscape splits. A row split halves the width it is handed, so on a
 * 810x1080 tablet it yields a 328px board where stacking yields 738px. Every landscape
 * display, laptops included, fails both clauses and keeps the desktop layout untouched.
 */
export const STACKED_LAYOUT_QUERY = "(max-width: 48em), (max-aspect-ratio: 1/1)";

/**
 * The same threshold as a Mantine size key, for props that take one (AppShell's
 * `breakpoint`). Keep this and STACKED_LAYOUT_QUERY in agreement: `sm` is 48em.
 */
export const STACKED_LAYOUT_BREAKPOINT = "sm";

/**
 * Viewports where the app should not draw desktop window chrome.
 *
 * The web build reports itself as linux, so it renders its own title bar with
 * minimise/maximise/close buttons. Those do nothing in a browser tab, and the bar
 * costs 2.25rem of height. That is merely wasteful in portrait but actively harmful
 * in phone landscape, where height is the scarce axis and every row taken from the
 * board comes straight off the board's width too, since the board is square.
 */
export const COMPACT_CHROME_QUERY = "(max-width: 48em), (max-height: 30em)";
