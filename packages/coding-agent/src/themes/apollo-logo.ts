/**
 * Apollo brand mark.
 *
 * APOLLO_LOGO_ROWS is generated from assets/brand/prime-butterfly.svg as a
 * 22-column half-block butterfly with a left-to-right rainbow hue ramp.
 * Regenerate with `node scripts/generate-splash-logo.mjs --width 22` and
 * replace the constant. Plain-text segments with optional per-segment
 * colors; the renderer (BrandSplashHeader) applies the colors at render
 * time, so the asset itself never contains ANSI escapes.
 */
export interface LogoSegment {
	readonly text: string;
	/** Hex color; undefined means the segment uses the default text tone. */
	readonly color?: string;
}

export const APOLLO_LOGO_ROWS: readonly (readonly LogoSegment[])[] = [
	[
		{ text: "                 " },
		{ text: "▄", color: "#2e2efa" },
		{ text: "▄", color: "#612efa" },
		{ text: "█", color: "#942efa" },
		{ text: "█", color: "#c72efa" },
		{ text: "▀", color: "#fa2efa" },
	],
	[
		{ text: "   " },
		{ text: "█", color: "#fac72e" },
		{ text: "█", color: "#fafa2e" },
		{ text: "█", color: "#c7fa2e" },
		{ text: "▄", color: "#94fa2e" },
		{ text: "       " },
		{ text: "▄", color: "#2ec7fa" },
		{ text: "▄", color: "#2e94fa" },
		{ text: "█", color: "#2e61fa" },
		{ text: "█", color: "#2e2efa" },
		{ text: "█", color: "#612efa" },
		{ text: "▀", color: "#942efa" },
		{ text: "  " },
	],
	[
		{ text: "  " },
		{ text: "▄", color: "#fa942e" },
		{ text: "█", color: "#fac72e" },
		{ text: "█", color: "#fafa2e" },
		{ text: "█", color: "#c7fa2e" },
		{ text: "█", color: "#94fa2e" },
		{ text: "█", color: "#61fa2e" },
		{ text: "   " },
		{ text: "▄", color: "#2efa94" },
		{ text: "▄", color: "#2efac7" },
		{ text: "█", color: "#2efafa" },
		{ text: "▀", color: "#2ec7fa" },
		{ text: "▄", color: "#2e94fa" },
		{ text: "█", color: "#2e61fa" },
		{ text: "▀", color: "#2e2efa" },
		{ text: "    " },
	],
	[
		{ text: " " },
		{ text: "▄", color: "#fa612e" },
		{ text: "█", color: "#fa942e" },
		{ text: "█", color: "#fac72e" },
		{ text: " " },
		{ text: "█", color: "#c7fa2e" },
		{ text: "█", color: "#94fa2e" },
		{ text: "█", color: "#61fa2e" },
		{ text: "█", color: "#2efa2e" },
		{ text: "▄", color: "#2efa61" },
		{ text: "██", color: "#2efa94" },
		{ text: "█", color: "#2efac7" },
		{ text: "▄", color: "#2efafa" },
		{ text: "█", color: "#2ec7fa" },
		{ text: "█", color: "#2e94fa" },
		{ text: "      " },
	],
	[
		{ text: " " },
		{ text: "▄", color: "#fa612e" },
		{ text: "█", color: "#fa942e" },
		{ text: "▄", color: "#fac72e" },
		{ text: " " },
		{ text: "▀", color: "#c7fa2e" },
		{ text: "█", color: "#94fa2e" },
		{ text: "█", color: "#61fa2e" },
		{ text: "█", color: "#2efa2e" },
		{ text: "█", color: "#2efa61" },
		{ text: "▀", color: "#2efa94" },
		{ text: "▄", color: "#2efa94" },
		{ text: "▄", color: "#2efac7" },
		{ text: "█", color: "#2efafa" },
		{ text: "▄", color: "#2ec7fa" },
		{ text: "       " },
	],
	[
		{ text: "▄", color: "#fa2e2e" },
		{ text: "█", color: "#fa612e" },
		{ text: "█", color: "#fa942e" },
		{ text: "█", color: "#fac72e" },
		{ text: "▄", color: "#fafa2e" },
		{ text: "  " },
		{ text: "█", color: "#61fa2e" },
		{ text: "█", color: "#2efa2e" },
		{ text: "█", color: "#2efa61" },
		{ text: "██", color: "#2efa94" },
		{ text: "█", color: "#2efac7" },
		{ text: "▀", color: "#2efafa" },
		{ text: "        " },
	],
	[
		{ text: "▀", color: "#fa2e2e" },
		{ text: "█", color: "#fa612e" },
		{ text: "█", color: "#fa942e" },
		{ text: "▀", color: "#fac72e" },
		{ text: "▀", color: "#fafa2e" },
		{ text: "  " },
		{ text: "█", color: "#61fa2e" },
		{ text: "█", color: "#2efa2e" },
		{ text: "█", color: "#2efa61" },
		{ text: "▀▀", color: "#2efa94" },
		{ text: "          " },
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
