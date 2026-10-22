/**
 * Apollo brand mark.
 *
 * APOLLO_LOGO_ROWS is the single source of truth: plain-text segments with
 * optional per-segment colors. The renderer (BrandSplashHeader) applies the
 * colors at render time according to the terminal color mode, so the asset
 * itself never contains ANSI escapes.
 */
export interface LogoSegment {
	readonly text: string;
	/** Hex color; undefined means the segment uses the default text tone. */
	readonly color?: string;
}

export const APOLLO_LOGO_ROWS: readonly (readonly LogoSegment[])[] = [
	[
		{ text: "     " },
		{ text: "▒", color: "#f67c90" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#f67c90" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "░", color: "#f67c90" },
		{ text: "     " },
	],
	[
		{ text: "  " },
		{ text: "░", color: "#f96980" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "   " },
	],
	[
		{ text: " " },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "        " },
		{ text: "▒", color: "#f67c90" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "░", color: "#f67c90" },
		{ text: " " },
	],
	[
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "  " },
		{ text: "░", color: "#f38da0" },
		{ text: "▒", color: "#f67c90" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒▒", color: "#f96980" },
		{ text: "░", color: "#f67c90" },
		{ text: "  " },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#fe546f" },
	],
	[
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "  " },
		{ text: "▒", color: "#f67c90" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#f38da0" },
		{ text: "▒", color: "#f96980" },
		{ text: "░", color: "#f67c90" },
		{ text: "   " },
		{ text: "▒▒▒", color: "#fe546f" },
		{ text: " " },
	],
	[
		{ text: "▒▒▒", color: "#fe546f" },
		{ text: "  " },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "      " },
		{ text: "░", color: "#f67c90" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: " " },
	],
	[
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "░", color: "#e7adb6" },
		{ text: " " },
		{ text: "░", color: "#fe546f" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒", color: "#f67c90" },
		{ text: "▒", color: "#e7adb6" },
		{ text: " " },
		{ text: "▒", color: "#f38da0" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "  " },
	],
	[
		{ text: " " },
		{ text: "▒▒", color: "#f96980" },
		{ text: "   " },
		{ text: "░", color: "#f38da0" },
		{ text: "▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "▒▒▒▒▒", color: "#fe546f" },
		{ text: "▒", color: "#f96980" },
		{ text: "░", color: "#f67c90" },
		{ text: "   " },
	],
];

export const APOLLO_LOGO = APOLLO_LOGO_ROWS.map((row) => row.map((seg) => seg.text).join("")).join("\n");

export const APOLLO_COMPACT_LOGO = `      ▗▄▄▄▖
     ▗█▛▀▀▜█▖
    ▗█▛ ▗▄ ▜█
   ▗█▛ ▗█▌ ▐█▌
   ▀█▙▄█▛▘ ▐█▌
     ▀▀▀  ▗█▛
         ▗█▛
        ▗█▛
        ▀▀`;

export const PRIME_BUTTERFLY_LOGO = APOLLO_LOGO;
export const PRIME_COMPACT_BUTTERFLY_LOGO = APOLLO_COMPACT_LOGO;
