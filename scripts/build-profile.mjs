// Builds the profile charts in assets/ and refreshes the auto-generated parts of README.md.
// Runs daily from .github/workflows/profile.yml; locally: GITHUB_TOKEN=$(gh auth token) node scripts/build-profile.mjs
//
// Only public repositories are named anywhere. Private work shows up as anonymous
// counts in the contribution calendar, the same way it does on the GitHub profile.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const USER = process.env.PROFILE_USER || "Talaljaber";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const ROOT = new URL("../", import.meta.url);
const ASSETS = new URL("assets/", ROOT);

// ---------------------------------------------------------------- data

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function fetchProfile() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    { login: USER },
  );
  return user;
}

async function fetchPullRequests() {
  const prs = [];
  let after = null;
  do {
    const { search } = await gql(
      `query($q: String!, $after: String) {
        search(query: $q, type: ISSUE, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest {
            title url state merged createdAt mergedAt
            repository { nameWithOwner isPrivate }
          } }
        }
      }`,
      { q: `author:${USER} is:pr is:public`, after },
    );
    prs.push(...search.nodes.filter((pr) => pr.repository && !pr.repository.isPrivate));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return prs;
}

// ---------------------------------------------------------------- metrics

function streaks(days) {
  const counts = days.map((d) => d.contributionCount);
  let longest = 0;
  let run = 0;
  for (const c of counts) {
    run = c > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // A streak is still alive if today has no contributions yet.
  let i = counts.length - 1;
  if (counts[i] === 0) i--;
  let current = 0;
  while (i >= 0 && counts[i] > 0) {
    current++;
    i--;
  }
  return { current, longest };
}

function monthly(days) {
  const months = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    months.set(key, (months.get(key) || 0) + d.contributionCount);
  }
  // The calendar starts mid-month a year back; keep the last 12 calendar months.
  return [...months.entries()].slice(-12).map(([key, total]) => ({ key, total }));
}

function byRepository(prs) {
  const repos = new Map();
  for (const pr of prs) {
    const name = pr.repository.nameWithOwner;
    const entry = repos.get(name) || { name, merged: 0, open: 0 };
    if (pr.merged) entry.merged++;
    else if (pr.state === "OPEN") entry.open++;
    repos.set(name, entry);
  }
  return [...repos.values()]
    .filter((r) => r.merged + r.open > 0)
    .sort((a, b) => b.merged + b.open - (a.merged + a.open))
    .slice(0, 6);
}

// "feat(google-sheets): ..." -> "google-sheets"
function scopes(prs) {
  return new Set(prs.map((pr) => /^\w+\(([^)]+)\)/.exec(pr.title)?.[1]?.toLowerCase()).filter(Boolean));
}

// ---------------------------------------------------------------- svg

// GitHub's own surfaces, so the cards sit flush on the profile page. Series colors
// are the validated categorical palette (light and dark steps of the same hues).
const THEMES = {
  dark: {
    surface: "#0d1117", border: "#30363d", grid: "#21262d",
    text: "#e6edf3", muted: "#9198a1",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"], other: "#6e7681",
  },
  light: {
    surface: "#ffffff", border: "#d0d7de", grid: "#eaeef2",
    text: "#1f2328", muted: "#59636e",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"], other: "#afb8c1",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const W = 880;

const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");
const delay = (ms) => ` style="animation-delay:${Math.round(ms)}ms"`;

// Entrance motion shared by every card: text rises in, bars grow from their axis.
// Browsers run CSS animations inside SVGs shown as <img>, which is how GitHub renders them.
const MOTION = `@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes growY{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes growX{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.in{animation:rise .6s ease-out both}
.gy,.gx{transform-box:fill-box;animation:growY .9s cubic-bezier(.2,.8,.2,1) both}
.gy{transform-origin:50% 100%}
.gx{transform-origin:0 50%;animation-name:growX}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

function card(t, height, title, body, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<style>text{font-family:${FONT};fill:${t.text}}.m{fill:${t.muted}}.h{font-size:15px;font-weight:600}.s{font-size:12px}.v{font-size:28px;font-weight:600}
${MOTION}</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="6" fill="${t.surface}" stroke="${t.border}"/>
<text x="24" y="36" class="h">${esc(title)}</text>
${body}
</svg>`;
}

// Bar with a 4px rounded data-end and a square base, so it reads as anchored to the axis.
function vbar(x, yBase, w, h, fill, ms = 0) {
  if (h <= 0) return "";
  const r = Math.min(4, h, w / 2);
  return `<path class="gy"${delay(ms)} d="M${x},${yBase}V${yBase - h + r}Q${x},${yBase - h} ${x + r},${yBase - h}H${x + w - r}Q${x + w},${yBase - h} ${x + w},${yBase - h + r}V${yBase}Z" fill="${fill}"/>`;
}

function hbar(x, y, w, h, fill, roundEnd, ms = 0) {
  if (w <= 0) return "";
  if (!roundEnd) return `<rect class="gx"${delay(ms)} x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const r = Math.min(4, w, h / 2);
  return `<path class="gx"${delay(ms)} d="M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z" fill="${fill}"/>`;
}

// Banner at the top of the README: name, role, a rotating line about current work,
// and a small agent-loop diagram (input -> model <-> tools -> output) with data moving through it.
const FOCUS = [
  "building AI actions and integrations at Activepieces",
  "founder & CTO of DineLink · AI ordering for restaurants",
  "maintaining VibeSafe · a safety scanner for AI-built apps",
  "taking products from first interview to production",
];

function headerSvg(t) {
  const H = 220;
  const accent = t.series[0];
  const cycle = FOCUS.length * 4; // seconds; each line holds for 4s
  const share = 100 / FOCUS.length;

  // Agent loop geometry: three nodes on one row, tools below the model.
  const node = (cx, cy, label, cls = "") =>
    `<g class="${cls}"><rect x="${cx - 34}" y="${cy - 16}" width="68" height="32" rx="6" fill="${t.surface}" stroke="${cls ? accent : t.border}"/>` +
    `<text x="${cx}" y="${cy + 4}" class="n" text-anchor="middle">${label}</text></g>`;
  const route = "M594,74 H696 V156 H720 V74 H822";

  const lines = FOCUS.map(
    (l, i) => `<text x="24" y="148" class="f r r${i}"${delay(i * 4000)}><tspan class="a">›</tspan> ${esc(l)}</text>`,
  ).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Talal Jaber, Software Engineer and AI Engineer</title>
<desc id="d">${esc(FOCUS.join(". "))}.</desc>
<style>
text{font-family:${FONT};fill:${t.text}}
.k{font-family:${MONO};font-size:12px;font-weight:600;letter-spacing:2px;fill:${accent}}
.name{font-size:42px;font-weight:700;letter-spacing:-.5px}
.f{font-family:${MONO};font-size:14.5px}
.a{fill:${accent};font-weight:700}
.m{fill:${t.muted};font-size:13px}
.n{font-family:${MONO};font-size:12px;fill:${t.text}}
.cap{font-family:${MONO};font-size:11px;fill:${t.muted}}
.edge{fill:none;stroke:${t.muted};stroke-opacity:.7;stroke-width:1.5;stroke-dasharray:3 5;animation:flow 1s linear infinite}
.r{opacity:0;animation:cycle ${cycle}s ease-in-out infinite both}
.pulse{animation:pulse 2.4s ease-in-out infinite}
${MOTION}
@keyframes flow{to{stroke-dashoffset:-16}}
@keyframes cycle{0%{opacity:0;transform:translateY(6px)}${share * 0.1}%{opacity:1;transform:none}${share * 0.85}%{opacity:1;transform:none}${share}%{opacity:0;transform:translateY(-6px)}100%{opacity:0}}
@keyframes pulse{0%,100%{stroke-opacity:.15}50%{stroke-opacity:.7}}
@media (prefers-reduced-motion:reduce){.r0{opacity:1}.dots{display:none}}
</style>
<defs>
  <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${t.border}"/></pattern>
  <linearGradient id="fade" x1="0" x2="1"><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
  <mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
  <radialGradient id="glow" cx="708" cy="110" r="220" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${accent}" stop-opacity=".14"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8Z" fill="${t.muted}"/></marker>
</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${t.surface}" stroke="${t.border}"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="6" fill="url(#grid)" mask="url(#m)"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="6" fill="url(#glow)"/>

<text x="24" y="58" class="k in">SOFTWARE ENGINEER · AI ENGINEER</text>
<text x="24" y="108" class="name in"${delay(120)}>Talal Jaber</text>
${lines}
<text x="24" y="188" class="m in"${delay(300)}>Amman, Jordan · Computer Engineering, GJU</text>

<path class="edge" d="M628,74 H672" marker-end="url(#arrow)"/>
<path class="edge" d="M742,74 H786" marker-end="url(#arrow)"/>
<path class="edge" d="M696,90 V138" marker-end="url(#arrow)"/>
<path class="edge" d="M720,140 V92" marker-end="url(#arrow)"/>
<text x="732" y="120" class="cap">agent loop</text>
<g class="dots">
  <circle r="3.5" fill="${accent}"><animateMotion dur="5s" repeatCount="indefinite" path="${route}"/></circle>
  <circle r="3.5" fill="${accent}" opacity=".6"><animateMotion dur="5s" begin="2.5s" repeatCount="indefinite" path="${route}"/></circle>
</g>
${node(594, 74, "input")}
<rect class="pulse" x="670" y="54" width="76" height="40" rx="9" fill="none" stroke="${accent}" stroke-width="2"/>
${node(708, 74, "model", "hl")}
${node(822, 74, "output")}
${node(708, 156, "tools")}
</svg>`;
}

function overviewSvg(t, d) {
  const tiles = [
    [fmt(d.total), "contributions"],
    [fmt(d.commits), "commits"],
    [fmt(d.merged), "PRs merged"],
    [`${d.current} day${d.current === 1 ? "" : "s"}`, "current streak"],
    [`${d.longest} day${d.longest === 1 ? "" : "s"}`, "longest streak"],
  ];
  const tileW = (W - 48) / tiles.length;
  let body = tiles
    .map(([v, l], i) => `<g class="in"${delay(i * 90)}><text x="${24 + i * tileW}" y="86" class="v">${esc(v)}</text><text x="${24 + i * tileW}" y="108" class="s m">${esc(l)}</text></g>`)
    .join("");

  // Monthly contributions: one series, so no legend; the title names it.
  const top = 160, base = 320, left = 24, right = W - 24;
  const max = Math.max(...d.months.map((m) => m.total), 1);
  const step = (right - left) / d.months.length;
  const barW = Math.min(36, step - 12);
  body += `<text x="24" y="146" class="s m">Contributions per month</text>`;
  body += `<line x1="${left}" y1="${base + 0.5}" x2="${right}" y2="${base + 0.5}" stroke="${t.border}"/>`;
  d.months.forEach((m, i) => {
    const cx = left + step * i + step / 2;
    const h = (m.total / max) * (base - top - 18);
    const ms = 400 + i * 60;
    body += vbar(cx - barW / 2, base, barW, h, t.series[0], ms);
    const label = new Date(`${m.key}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const partial = i === d.months.length - 1;
    body += `<text x="${cx}" y="${base + 20}" class="s m" text-anchor="middle">${label}${partial ? "*" : ""}</text>`;
    // Direct labels only where they matter: the big months and the latest one.
    if (m.total >= max * 0.3 || partial) body += `<text x="${cx}" y="${base - h - 6}" class="s in"${delay(ms + 700)} text-anchor="middle">${fmt(m.total)}</text>`;
  });
  body += `<text x="${right}" y="${base + 44}" class="s m" text-anchor="end">*month to date · includes private contributions · updated ${d.updated}</text>`;

  const desc = `${fmt(d.total)} contributions in the last year, ${fmt(d.commits)} commits, ${d.merged} pull requests merged, current streak ${d.current} days, longest ${d.longest} days.`;
  return card(t, 384, "Last 12 months on GitHub", body, desc);
}

function prsSvg(t, d) {
  const rows = d.repos;
  const rowH = 34, top = 92, labelW = 250, left = 24 + labelW, right = W - 150;
  const max = Math.max(...rows.map((r) => r.merged + r.open), 1);
  const scale = (right - left) / max;
  const [cMerged, cOpen] = t.series;

  let body = `<text x="24" y="58" class="s m">${d.merged} merged · ${d.open} open · ${d.reposCount} public repositories</text>`;
  // Legend: two series, both shown in the bars as well as here.
  body += `<rect x="${W - 210}" y="25" width="10" height="10" rx="2" fill="${cMerged}"/><text x="${W - 194}" y="34" class="s m">Merged</text>`;
  body += `<rect x="${W - 124}" y="25" width="10" height="10" rx="2" fill="${cOpen}"/><text x="${W - 108}" y="34" class="s m">Open</text>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const mw = r.merged * scale;
    const ow = r.open * scale;
    const gap = mw > 0 && ow > 0 ? 2 : 0;
    body += `<text x="24" y="${y + 14}" class="s">${esc(r.name)}</text>`;
    const ms = 200 + i * 90;
    body += hbar(left, y, mw, 18, cMerged, ow === 0, ms);
    body += hbar(left + mw + gap, y, Math.max(ow - gap, 0), 18, cOpen, true, ms + 500);
    const label = [r.merged && `${r.merged} merged`, r.open && `${r.open} open`].filter(Boolean).join(" · ");
    body += `<text x="${left + mw + ow + 8}" y="${y + 14}" class="s m in"${delay(ms + 700)}>${label}</text>`;
  });
  const height = top + rows.length * rowH + 14;
  const desc = rows.map((r) => `${r.name}: ${r.merged} merged, ${r.open} open`).join("; ");
  return card(t, height, "Pull requests by repository", body, desc);
}

// ---------------------------------------------------------------- readme

function recentPrsMarkdown(prs) {
  return prs
    .filter((pr) => pr.merged)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, 6)
    .map((pr) => {
      const repo = pr.repository.nameWithOwner.split("/")[1];
      const day = new Date(pr.mergedAt).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return `- [${pr.title.replace(/[[\]]/g, "")}](${pr.url}) <sub>${repo} · ${day}</sub>`;
    })
    .join("\n");
}

// Block markers put the content on its own lines; inline markers keep it inside a sentence.
function replaceBlock(readme, name, content, { inline = false } = {}) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`, "g");
  const sep = inline ? "" : "\n";
  return readme.replace(re, (_, start, end) => `${start}${sep}${content}${sep}${end}`);
}

// ---------------------------------------------------------------- main

const [profile, prs] = await Promise.all([fetchProfile(), fetchPullRequests()]);
const cc = profile.contributionsCollection;
const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
const { current, longest } = streaks(days);
const repos = byRepository(prs);
const merged = prs.filter((pr) => pr.merged);
const activepiecesMerged = merged.filter((pr) => pr.repository.nameWithOwner === "activepieces/activepieces");

const data = {
  total: cc.contributionCalendar.totalContributions,
  commits: cc.totalCommitContributions,
  merged: merged.length,
  open: prs.filter((pr) => pr.state === "OPEN").length,
  reposCount: new Set(prs.map((pr) => pr.repository.nameWithOwner)).size,
  current,
  longest,
  months: monthly(days),
  repos,
  updated: new Date().toISOString().slice(0, 10),
};

mkdirSync(ASSETS, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  writeFileSync(new URL(`header-${mode}.svg`, ASSETS), headerSvg(theme));
  writeFileSync(new URL(`overview-${mode}.svg`, ASSETS), overviewSvg(theme, data));
  writeFileSync(new URL(`prs-${mode}.svg`, ASSETS), prsSvg(theme, data));
}

const readmeUrl = new URL("README.md", ROOT);
let readme = readFileSync(readmeUrl, "utf8");
readme = replaceBlock(readme, "RECENT_PRS", recentPrsMarkdown(prs));
readme = replaceBlock(readme, "AP_MERGED", String(activepiecesMerged.length), { inline: true });
readme = replaceBlock(readme, "AP_PIECES", String(scopes(activepiecesMerged).size), { inline: true });
writeFileSync(readmeUrl, readme);

console.log({
  ...data,
  months: data.months.map((m) => `${m.key}:${m.total}`).join(" "),
  activepiecesMerged: activepiecesMerged.length,
  activepiecesPieces: scopes(activepiecesMerged).size,
});
