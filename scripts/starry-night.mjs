#!/usr/bin/env node
// Renders the GitHub contribution calendar as an animated "starry night" SVG.
//
// Usage:
//   GITHUB_TOKEN=... node scripts/starry-night.mjs --user <login> --out-dark <dark.svg> --out-light <light.svg>
//   node scripts/starry-night.mjs --data <graphql-response.json> --out-dark <dark.svg> --out-light <light.svg>
//
// Both variants have a transparent background so they sit on the page.
//
// The SVG uses only CSS animations and inline styles, which GitHub renders
// inside <img> tags. Randomness is seeded from dates so a daily regeneration
// only changes what the data changed (plus the shooting-star layout).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// Layout
const PITCH = 14;
const TILE = 11;
const PAD_X = 19;
const PAD_TOP = 34;
const PAD_BOTTOM = 22;

// Official Catppuccin colors only (Mocha for dark, Latte for light). Tile
// levels 1-3 are mauve blended over the flavor's base, the way Catppuccin
// derives tints; every other value is a named palette color.
const THEMES = {
  dark: {
    // surface0, then mauve over base at 30% / 55% / 78%, then mauve.
    tiles: ["#313244", "#52476a", "#7d699d", "#a588cb", "#cba6f7"],
    // Low levels shimmer in mauve so they keep their saturation; a light wash
    // would make level 1 look as light as level 2.
    shineLow: "#cba6f7", // mauve
    shineHigh: "#cdd6f4", // text
    // Stars and shooting stars each take one of these tints, the way real
    // stars differ in color temperature: rosewater, lavender, sky, pink.
    accents: ["#f5e0dc", "#b4befe", "#89dceb", "#f5c2e7"],
    sparkle: (accent) => ({ fill: accent, glow: accent }),
    trail: (accent) => ["#cba6f7", accent, accent], // mauve tail into the tint
    meteorHead: "#f5e0dc", // rosewater
    caption: "#a6adc8", // subtext0
  },
  light: {
    // mantle, then mauve over base at 25% / 50% / 75%, then mauve.
    tiles: ["#e6e9ef", "#d5c3f4", "#bc95f2", "#a267f1", "#8839ef"],
    // On a light page a light wash would fade cells toward empty, so low levels
    // shimmer darker instead.
    shineLow: "#8839ef", // mauve
    shineHigh: "#eff1f5", // base
    // Same four tints in their Latte values: rosewater, lavender, sky, pink.
    accents: ["#dc8a78", "#7287fd", "#04a5e5", "#ea76cb"],
    // A light core reads as a star on a light page; the tint lives in the glow.
    sparkle: (accent) => ({ fill: "#eff1f5", glow: accent }), // base
    trail: (accent) => [accent, accent, "#8839ef"], // tinted tail into mauve
    meteorHead: "#8839ef", // mauve
    caption: "#6c6f85", // subtext0
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

async function fetchCalendar(login, token) {
  if (!token) throw new Error("GITHUB_TOKEN is required to fetch contributions");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "starry-night-svg" },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json;
}

function weeksFrom(json) {
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) throw new Error("No contribution calendar in response");
  return weeks;
}

// Deterministic PRNG.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const fmt = (n) => +n.toFixed(2);

function cellSvg(theme, { level, cx, cy, dur, delay, variant, sparkleDur, sparkleDelay, sparkleVariant, accent }) {
  const TILE_FILL = theme.tiles;
  const anim = `style="animation-name:tw${variant};animation-duration:${dur}s;animation-delay:${delay}s"`;
  const x = fmt(cx - TILE / 2);
  const y = fmt(cy - TILE / 2);
  const rect = (attrs) => `<rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" rx="2.5" ${attrs}/>`;
  if (level === 0) return rect(`fill="${TILE_FILL[0]}"`);

  const parts = [];
  if (level >= 2) parts.push(rect(`class="tw g${level}" fill="${TILE_FILL[level]}" filter="url(#blur)" ${anim}`));
  parts.push(rect(`fill="${TILE_FILL[level]}"`));
  parts.push(rect(`class="tw s${level}" fill="${level <= 2 ? theme.shineLow : theme.shineHigh}" ${anim}`));

  if (level >= 3) {
    // Four-point star with concave sides; inner vertices sit on the diagonals.
    const r = level === 4 ? 9 : 6.5;
    const i = r * 0.3;
    const d =
      `M${cx} ${fmt(cy - r)}L${fmt(cx + i)} ${fmt(cy - i)}L${fmt(cx + r)} ${cy}L${fmt(cx + i)} ${fmt(cy + i)}` +
      `L${cx} ${fmt(cy + r)}L${fmt(cx - i)} ${fmt(cy + i)}L${fmt(cx - r)} ${cy}L${fmt(cx - i)} ${fmt(cy - i)}Z`;
    const star = theme.sparkle(theme.accents[accent]);
    const starAnim = `style="--glow:${star.glow};animation-name:glint${sparkleVariant};animation-duration:${sparkleDur}s;animation-delay:${sparkleDelay}s"`;
    parts.push(
      `<path class="sparkle" d="${d}" fill="${star.fill}" stroke="${star.fill}" stroke-width="0.6" stroke-linejoin="round" ${starAnim}/>`
    );
  }
  return parts.join("");
}

// Shooting stars. Each one cycles through several seeded launch points and
// angles (switched while it is invisible), and cycle lengths differ so the
// combined pattern rarely repeats visibly.
const METEOR_PASSES = 5;
function buildMeteors(theme, seedText, width, height) {
  const rand = mulberry32(seedOf(seedText));
  const cycles = [9.7, 13.3, 17.9, 23.1];
  return cycles.map((cycle, idx) => {
    const dist = 170 + rand() * 150;
    const len = 45 + rand() * 45;
    const visible = 0.9 + rand() * 0.6; // seconds on screen
    const delay = fmt(-(rand() * cycle));
    const p = (visible / cycle) * 100;
    const at = (f) => `${fmt(p * f)}%`;

    const stops = [];
    for (let k = 0; k < METEOR_PASSES; k++) {
      const x = width * (0.25 + rand() * 0.75);
      const y = -6 + rand() * height * 0.4;
      const angle = 146 + rand() * 26; // travel down-left
      stops.push(`${fmt((k / METEOR_PASSES) * 100)}% { transform: translate(${fmt(x)}px, ${fmt(y)}px) rotate(${fmt(angle)}deg); }`);
    }
    stops.push(`100% { ${stops[0].slice(stops[0].indexOf("transform"), -2)} }`);

    // The head decelerates along its path while it burns out; the tail
    // stretches behind it and then collapses into the head as it fades.
    const keyframes = `@keyframes mpos${idx} {
    ${stops.join("\n    ")}
  }
  @keyframes mfly${idx} {
    0% { opacity: 0; transform: translateX(0); }
    ${at(0.12)} { opacity: 1; }
    ${at(0.55)} { opacity: 1; }
    ${at(1)}, 100% { opacity: 0; transform: translateX(${fmt(dist)}px); }
  }
  @keyframes mtail${idx} {
    0% { transform: scaleX(0.15); }
    ${at(0.35)} { transform: scaleX(1); }
    ${at(0.6)} { transform: scaleX(1); }
    ${at(1)}, 100% { transform: scaleX(0.25); }
  }
  @keyframes mhead${idx} {
    0% { transform: scale(0.5); }
    ${at(0.2)} { transform: scale(1); }
    ${at(0.7)} { transform: scale(1.5); }
    ${at(1)}, 100% { transform: scale(0.3); }
  }`;
    // Tapered tail drawn along -x with the head at the origin.
    const w = 1.1;
    const tail =
      `M0 ${-w}C${fmt(-len * 0.25)} ${fmt(-w * 0.8)} ${fmt(-len * 0.65)} ${fmt(-w * 0.25)} ${fmt(-len)} 0` +
      `C${fmt(-len * 0.65)} ${fmt(w * 0.25)} ${fmt(-len * 0.25)} ${fmt(w * 0.8)} 0 ${w}Z`;
    const accent = theme.accents[idx % theme.accents.length];
    const [tailEnd, tailMid, tailHead] = theme.trail(accent);
    const defs = `<linearGradient id="trail${idx}" x1="0" x2="1">
    <stop offset="0" stop-color="${tailEnd}" stop-opacity="0"/>
    <stop offset="0.6" stop-color="${tailMid}" stop-opacity="0.45"/>
    <stop offset="1" stop-color="${tailHead}" stop-opacity="0.95"/>
  </linearGradient>`;
    const timing = (name, dur = cycle) => `style="animation-name:${name}${idx};animation-duration:${fmt(dur)}s;animation-delay:${delay}s"`;
    const svg = `<g class="mpos" ${timing("mpos", cycle * METEOR_PASSES)}><g class="meteor" ${timing("mfly")}>
    <g class="mpart" ${timing("mtail")}>
      <path d="${tail}" fill="url(#trail${idx})" transform="scale(1 2.6)" filter="url(#mblur)" opacity="0.5"/>
      <path d="${tail}" fill="url(#trail${idx})"/>
    </g>
    <g class="mpart" ${timing("mhead")}>
      <circle r="2.6" fill="${accent}" filter="url(#mblur)" opacity="0.8"/>
      <circle r="1.2" fill="${theme.meteorHead}"/>
    </g>
  </g></g>`;
    return { keyframes, svg, defs };
  });
}

function renderSvg(weeks, theme) {
  const width = PAD_X * 2 + weeks.length * PITCH;
  const height = PAD_TOP + 7 * PITCH + PAD_BOTTOM;

  let total = 0;
  const cells = [];
  weeks.forEach((week, wi) => {
    for (const day of week.contributionDays) {
      total += day.contributionCount;
      const rand = mulberry32(seedOf(day.date));
      const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      cells.push({
        level: LEVEL[day.contributionLevel] ?? 0,
        cx: PAD_X + wi * PITCH + PITCH / 2,
        cy: PAD_TOP + dow * PITCH + PITCH / 2,
        // Full scintillation cycle; each holds a few uneven peaks.
        dur: fmt(3.2 + rand() * 3.6),
        delay: fmt(-rand() * 7),
        variant: Math.floor(rand() * 3),
        // Glints are brief and separated by long, uneven rests.
        sparkleDur: fmt(3.5 + rand() * 5.5),
        sparkleDelay: fmt(-rand() * 9),
        sparkleVariant: Math.floor(rand() * 2),
        accent: Math.floor(rand() * theme.accents.length),
      });
    }
  });

  const lastDate = weeks.at(-1).contributionDays.at(-1).date;
  const meteors = buildMeteors(theme, lastDate, width, height);
  const label = `${total.toLocaleString("en-US")} contributions in the last year`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}, drawn as a starry night">
<title>${label}</title>
<defs>
  ${meteors.map((m) => m.defs).join("\n  ")}
  <filter id="blur" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="3"/></filter>
  <filter id="mblur" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="1.4"/></filter>
  <clipPath id="bounds"><rect width="${width}" height="${height}"/></clipPath>
</defs>
<style>
  .caption { font: 600 11px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${theme.caption}; letter-spacing: 0.04em; }
  .tw { animation-timing-function: cubic-bezier(0.37, 0, 0.63, 1); animation-iteration-count: infinite; opacity: var(--a); }
  .s1 { --a: 0; --d: 0.15; } .s2 { --a: 0.05; --d: 0.4; }
  .s3 { --a: 0.05; --d: 0.45; } .s4 { --a: 0.1; --d: 0.5; }
  .g2 { --a: 0.1; --d: 0.6; } .g3 { --a: 0.25; --d: 0.7; } .g4 { --a: 0.45; --d: 0.55; }
  .sparkle { animation-timing-function: cubic-bezier(0.37, 0, 0.63, 1); animation-iteration-count: infinite; opacity: 0; transform-box: fill-box; transform-origin: center; filter: drop-shadow(0 0 2px var(--glow)); }
  .mpos { animation-timing-function: step-end; animation-iteration-count: infinite; }
  .meteor, .mpart { animation-timing-function: cubic-bezier(0.61, 1, 0.88, 1); animation-iteration-count: infinite; }
  .meteor { opacity: 0; }
  /* Uneven scintillation: --a is the resting opacity, --d the swing. */
  @keyframes tw0 {
    0%, 100% { opacity: var(--a); }
    13% { opacity: calc(var(--a) + var(--d)); }
    29% { opacity: calc(var(--a) + var(--d) * 0.3); }
    46% { opacity: calc(var(--a) + var(--d) * 0.85); }
    64% { opacity: calc(var(--a) + var(--d) * 0.1); }
    83% { opacity: calc(var(--a) + var(--d) * 0.6); }
  }
  @keyframes tw1 {
    0%, 100% { opacity: calc(var(--a) + var(--d) * 0.2); }
    17% { opacity: calc(var(--a) + var(--d) * 0.7); }
    31% { opacity: var(--a); }
    52% { opacity: calc(var(--a) + var(--d)); }
    71% { opacity: calc(var(--a) + var(--d) * 0.45); }
    88% { opacity: calc(var(--a) + var(--d) * 0.9); }
  }
  @keyframes tw2 {
    0%, 100% { opacity: calc(var(--a) + var(--d) * 0.5); }
    11% { opacity: var(--a); }
    34% { opacity: calc(var(--a) + var(--d) * 0.9); }
    49% { opacity: calc(var(--a) + var(--d) * 0.35); }
    67% { opacity: calc(var(--a) + var(--d)); }
    86% { opacity: calc(var(--a) + var(--d) * 0.15); }
  }
  /* Glints flare in quickly, settle, and fade slower than they arrived. */
  @keyframes glint0 {
    0%   { opacity: 0; transform: scale(0.5) rotate(-12deg); }
    9%   { opacity: 1; transform: scale(1.08) rotate(0deg); }
    15%  { opacity: 0.9; transform: scale(0.96) rotate(3deg); }
    32%, 100% { opacity: 0; transform: scale(0.6) rotate(12deg); }
  }
  @keyframes glint1 {
    0%   { opacity: 0; transform: scale(0.5) rotate(-10deg); }
    8%   { opacity: 1; transform: scale(1.05) rotate(0deg); }
    14%  { opacity: 0.55; transform: scale(0.85) rotate(3deg); }
    21%  { opacity: 1; transform: scale(1) rotate(5deg); }
    40%, 100% { opacity: 0; transform: scale(0.6) rotate(14deg); }
  }
  ${meteors.map((m) => m.keyframes).join("\n  ")}
  @media (prefers-reduced-motion: reduce) {
    .tw, .sparkle, .mpos, .meteor, .mpart { animation: none !important; }
  }
</style>
<g clip-path="url(#bounds)">
  <text class="caption" x="${PAD_X + 2}" y="21">${label.toUpperCase()}</text>
  ${cells.map((cell) => cellSvg(theme, cell)).join("\n  ")}
  ${meteors.map((m) => m.svg).join("\n  ")}
</g>
</svg>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["out-dark"] || !args["out-light"]) throw new Error("--out-dark and --out-light are required");
  const json = args.data
    ? JSON.parse(readFileSync(args.data, "utf8"))
    : await fetchCalendar(args.user ?? process.env.GITHUB_USER, process.env.GITHUB_TOKEN);
  const weeks = weeksFrom(json);
  for (const [name, theme] of Object.entries(THEMES)) {
    const out = args[`out-${name}`];
    const svg = renderSvg(weeks, theme);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, svg);
    console.log(`Wrote ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
