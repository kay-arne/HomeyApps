#!/usr/bin/env python3
"""Regenerates assets/icon.svg and every drivers/*/assets/icon.svg (the
monochrome, transparent-background icons Homey shows in device tiles, Flow
cards, pairing, etc. - see https://apps.developer.homey.app/app-store/guidelines
section 1.5/1.6).

Geometry below is adapted from Fortinet's own official icon library
(https://icons.fortinet.com, icons "FortiGate"/"FortiSwitch"/"FortiAP"),
scaled from their 192x192 viewBox to Homey's required 960x960 canvas and
flattened to a single flat color per Homey's "no filled illustrations /
gradients" rule for icons. The FortiGate icon simplifies Fortinet's brick
wall to a plain rounded square (a brick-divider-line version was tried but
looked off at real render sizes) with the circle + flame cut out via
evenodd.

This script only produces the monochrome icon.svg files - not the branded
PNGs in assets/images/ and drivers/*/assets/images/. Those need actual SVG
rasterization, which this environment has no working native library for
(cairosvg/svglib both require libcairo, not installed, and Homebrew
installs are out of scope for this script). They were produced instead by
loading color_*.svg variants (same shapes, Fortinet's real red #DA291C /
dark gray #464646 fill colors) into a browser and rendering via
<canvas>.drawImage + toDataURL('image/png'), white background, icon
occupying ~78% of the canvas (see git history / README for the exact
recipe if you need to redo this by hand).
"""
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent

# FortiGate / app icon: brick-wall square with divider gaps, a circular
# cutout, and Fortinet's real flame path (extracted from their FortiGate.svg,
# first <path>, which already contains the flame's inner flicker detail).
GATE_FLAME_D = (
    "m122.13,117.7c-.73,2.43-1.78,4.53-3.01,6.34-5.7,8.3-15.31,10.49-15.31,10.49,0,0,5.93-4.74,8.8-12.81"
    ".45-1.25.83-2.59,1.09-4.01.28-1.5.44-3.07.44-4.73,0-7.9-3.65-17.54-15.28-28.25,0,0,5.21,19.54-.11,32.01"
    "-.14.33-.28.66-.44.97-.28.59-.59,1.16-.94,1.72-.91,1.45-3.15,1.2-3.68-.42-.09-.28-.2-.72-.37-1.3"
    "-.08-.28-.16-.58-.23-.91-.59-2.28-1.45-5.79-2.48-9.05-1.17-3.75-2.54-7.18-3.89-8.15-.7,7.8-6.16,11.31-6.87,18.1"
    "-.03.31-.06.64-.06.97-.03,1,.03,1.93.16,2.84,1.06,8.1,7.27,12.52,7.27,12.52,0,0-9.07-2.22-14.48-9.94"
    "-1.26-1.81-2.33-3.93-3.03-6.38-.58-2.01-.91-4.26-.91-6.76,0-1.39.11-2.87.33-4.42,2.11-12.2,11.92-20.62,17.39-32.21"
    "v-.02c2.31-4.87,3.82-10.3,3.68-16.82,0,0,8.54,6.4,17.03,16.82.02,0,.02.02.02.02,6.2,7.58,12.33,17.29,15.15,28.25"
    "1.25,6.09.95,11.08-.27,15.14Z"
)


def _circle_path(cx, cy, r, steps=48):
    import math
    pts = [(cx + r * math.cos(2 * math.pi * i / steps), cy + r * math.sin(2 * math.pi * i / steps)) for i in range(steps + 1)]
    return f"M{pts[0][0]:.2f},{pts[0][1]:.2f} " + " ".join(f"L{x:.2f},{y:.2f}" for x, y in pts[1:]) + " Z"


def gate_wall_d():
    # Plain rounded-square wall with just the circle cut out - no brick
    # divider lines. An earlier version added divider-line holes to mimic
    # Fortinet's brick texture, but at real render sizes the approximated
    # grid looked off, so it's dropped in favor of a cleaner silhouette.
    wall = "M14,39 Q14,27 26,27 L166,27 Q178,27 178,39 L178,154 Q178,166 166,166 L26,166 Q14,166 14,154 Z"
    circle = _circle_path(96, 96.5, 45)
    return wall + " " + circle


def gate_svg():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960">\n'
        '  <g transform="scale(5)">\n'
        f'    <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="{gate_wall_d()}"/>\n'
        f'    <path fill="#000000" d="{GATE_FLAME_D}"/>\n'
        "  </g>\n</svg>\n"
    )


# FortiSwitch icon: two crossing double-headed arrows (Fortinet's real
# FortiSwitch.svg geometry, both fill colors flattened to black).
SWITCH_BODY = """<path fill="#000000" d="M160,144.1h-17.7c-0.5,0-1-0.2-1.4-0.6L49.2,51.9H31.9c-1.1,0-2-0.9-2-2s0.9-2,2-2h18.1c0.5,0,1,0.2,1.4,0.6
\tl91.7,91.7H160c1.1,0,2,0.9,2,2S161.1,144.1,160,144.1z"/>
<path fill="#000000" d="M50.1,144.1H31.9c-1.1,0-2-0.9-2-2s0.9-2,2-2h17.3l91.7-91.7c0.4-0.4,0.9-0.6,1.4-0.6H160c1.1,0,2,0.9,2,2
\ts-0.9,2-2,2h-16.9l-91.7,91.7C51.1,143.9,50.6,144.1,50.1,144.1L50.1,144.1z"/>
<path fill="#000000" d="M31.9,62.3c-0.4,0-0.7-0.1-1-0.3l-18-10.4c-0.6-0.4-1-1-1-1.7s0.4-1.4,1-1.7l18-10.4c0.6-0.4,1.4-0.4,2,0
\ts1,1,1,1.7v20.8c0,0.7-0.4,1.4-1,1.7C32.6,62.2,32.3,62.2,31.9,62.3L31.9,62.3z M17.9,49.9l12,6.9V42.9L17.9,49.9L17.9,49.9z"/>
<path fill="#000000" d="M160,154.5c-0.4,0-0.7-0.1-1-0.3c-0.6-0.4-1-1-1-1.7v-20.8c0-0.7,0.4-1.4,1-1.7s1.4-0.4,2,0l18,10.4
\tc0.6,0.4,1,1,1,1.7s-0.4,1.4-1,1.7l-18,10.4C160.7,154.5,160.4,154.5,160,154.5L160,154.5z M162,135.2v13.9l12-6.9L162,135.2
\tL162,135.2z"/>
<path fill="#000000" d="M160,62.3c-0.4,0-0.7-0.1-1-0.3c-0.6-0.4-1-1-1-1.7V39.5c0-0.7,0.4-1.4,1-1.7s1.4-0.4,2,0l18,10.4
\tc0.6,0.4,1,1,1,1.7s-0.4,1.4-1,1.7L161,62C160.7,62.2,160.4,62.3,160,62.3L160,62.3z M162,42.9v13.9l12-6.9L162,42.9L162,42.9z"/>
<path fill="#000000" d="M31.9,154.5c-0.4,0-0.7-0.1-1-0.3l-18-10.4c-0.6-0.4-1-1-1-1.7s0.4-1.4,1-1.7l18-10.4c0.6-0.4,1.4-0.4,2,0
\ts1,1,1,1.7v20.8c0,0.7-0.4,1.4-1,1.7C32.6,154.4,32.3,154.5,31.9,154.5L31.9,154.5z M17.9,142.1l12,6.9v-13.9L17.9,142.1L17.9,142.1
\tz"/>"""


def switch_svg():
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960">\n  <g transform="scale(5)">\n{SWITCH_BODY}\n  </g>\n</svg>\n'


# FortiAP icon: center dot + radiating arcs left & right (Fortinet's real
# FortiAP.svg geometry, both fill colors flattened to black).
AP_BODY = """<path fill="#000000" d="M95.9,117.1c-11.6,0-21-9.2-21-20.6c0-12,9.2-21.4,21-21.4s21,9.4,21,21.4S107.5,117.1,95.9,117.1z M95.9,79.1
\tc-9.5,0-17,7.6-17,17.4c0,9.2,7.6,16.6,17,16.6s17-7.4,17-16.6C112.9,86.7,105.5,79.1,95.9,79.1z"/>
<path fill="#000000" d="M153.7,157c-0.5,0-1-0.2-1.4-0.6c-0.8-0.8-0.8-2.1,0-2.8c15.3-15.4,23.8-35.8,23.8-57.5s-8.5-42.3-24-57.7
\tc-0.8-0.8-0.8-2,0-2.8c0.8-0.8,2.1-0.8,2.8,0c16.2,16.1,25.2,37.6,25.2,60.5s-8.9,44.2-25,60.3C154.7,156.8,154.2,157,153.7,157
\tL153.7,157z"/>
<path fill="#000000" d="M38.3,157c-0.5,0-1-0.2-1.4-0.6c-16.1-16.1-25-37.6-25-60.3s8.9-44.2,25-60.3c0.8-0.8,2-0.8,2.8,0s0.8,2,0,2.8
\tC24.4,53.9,15.9,74.4,15.9,96.1s8.5,42.2,23.8,57.5c0.8,0.8,0.8,2.1,0,2.8C39.4,156.8,38.9,157,38.3,157L38.3,157z"/>
<path fill="#000000" d="M52,137.9c-0.5,0-1-0.2-1.4-0.6c-11-11-17.1-25.7-17.1-41.2s6.1-30.2,17.1-41.2c0.8-0.8,2-0.8,2.8,0
\tc0.8,0.8,0.8,2,0,2.8C43.2,67.9,37.6,81.5,37.6,96s5.7,28.2,15.9,38.4c0.8,0.8,0.8,2.1,0,2.8C53.1,137.7,52.6,137.9,52,137.9
\tL52,137.9z"/>
<path fill="#000000" d="M66.2,120.7c-0.5,0-1-0.2-1.4-0.6c-6.4-6.4-10-15-10-24.1s3.5-17.7,10-24.1c0.8-0.8,2.1-0.8,2.8,0
\ts0.8,2.1,0,2.8C61.9,80.4,58.8,88,58.8,96s3.1,15.6,8.8,21.3c0.8,0.8,0.8,2.1,0,2.8C67.2,120.5,66.7,120.7,66.2,120.7L66.2,120.7z
\t"/>
<path fill="#000000" d="M125.8,120.7c-0.5,0-1-0.2-1.4-0.6c-0.8-0.8-0.8-2.1,0-2.8c5.7-5.7,8.8-13.2,8.8-21.3s-3.1-15.6-8.8-21.3
\tc-0.8-0.8-0.8-2.1,0-2.8s2.1-0.8,2.8,0c6.4,6.4,10,15,10,24.1s-3.6,17.7-10,24.1C126.9,120.5,126.4,120.7,125.8,120.7L125.8,120.7z
\t"/>
<path fill="#000000" d="M139.9,137.9c-0.5,0-1-0.2-1.4-0.6c-0.8-0.8-0.8-2.1,0-2.8c10.3-10.3,15.9-23.9,15.9-38.4s-5.6-28.2-15.9-38.4
\tc-0.8-0.8-0.8-2,0-2.8c0.8-0.8,2.1-0.8,2.8,0c11,11,17.1,25.7,17.1,41.2s-6.1,30.2-17.1,41.2C140.9,137.7,140.4,137.9,139.9,137.9
\tL139.9,137.9z"/>
<path fill="#000000" d="M114.9,96.5c0,10.4-8.8,18.6-19,18.6s-19-8.2-19-18.6c0-11.2,8.8-19.4,19-19.4S114.9,85.3,114.9,96.5z"/>"""


def ap_svg():
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960">\n  <g transform="scale(5)">\n{AP_BODY}\n  </g>\n</svg>\n'


def main():
    (BASE / "assets/icon.svg").write_text(gate_svg())
    (BASE / "drivers/fortigate/assets/icon.svg").write_text(gate_svg())
    (BASE / "drivers/fortiswitch/assets/icon.svg").write_text(switch_svg())
    (BASE / "drivers/fortiap/assets/icon.svg").write_text(ap_svg())
    print("icon.svg files regenerated. See this file's docstring for how the")
    print("branded PNGs in assets/images/ and drivers/*/assets/images/ were made.")


if __name__ == "__main__":
    main()
