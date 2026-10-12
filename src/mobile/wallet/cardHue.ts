/**
 * The bAvatar art is gold (hue ~45°). The stored look is a hue turn (-180..180) from that, but the Hue slider shows
 * the standard red-to-red spectrum and its value is the colour you get, so the thumb sits on gold by default.
 */
const ART_HUE = 45;
export const shownHueFor = (turn: number) => (((ART_HUE + turn) % 360) + 360) % 360;
export const hueTurnFor = (shown: number) => ((((shown - ART_HUE + 180) % 360) + 360) % 360) - 180;
