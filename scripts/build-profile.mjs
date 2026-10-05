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
        repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
          nodes { languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
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

function languages(repos) {
  const bytes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) || 0) + size);
    }
  }
  const sum = [...bytes.values()].reduce((a, b) => a + b, 0);
  const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([name, size]) => ({ name, share: size / sum }));
  const rest = sorted.slice(5).reduce((a, [, size]) => a + size, 0);
  if (rest > 0) top.push({ name: "Other", share: rest / sum, other: true });
  return top;
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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");

function card(t, height, title, body, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<style>text{font-family:${FONT};fill:${t.text}}.m{fill:${t.muted}}.h{font-size:15px;font-weight:600}.s{font-size:12px}.v{font-size:28px;font-weight:600}</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="6" fill="${t.surface}" stroke="${t.border}"/>
<text x="24" y="36" class="h">${esc(title)}</text>
${body}
</svg>`;
}

// Bar with a 4px rounded data-end and a square base, so it reads as anchored to the axis.
function vbar(x, yBase, w, h, fill) {
  if (h <= 0) return "";
  const r = Math.min(4, h, w / 2);
  return `<path d="M${x},${yBase}V${yBase - h + r}Q${x},${yBase - h} ${x + r},${yBase - h}H${x + w - r}Q${x + w},${yBase - h} ${x + w},${yBase - h + r}V${yBase}Z" fill="${fill}"/>`;
}

function hbar(x, y, w, h, fill, roundEnd) {
  if (w <= 0) return "";
  if (!roundEnd) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z" fill="${fill}"/>`;
}

function overviewSvg(t, d) {
  const tiles = [
    [fmt(d.total), "contributions"],
    [fmt(d.commits), "commits"],
    [fmt(d.merged), "PRs merged"],
    [`${d.current} days`, "current streak"],
    [`${d.longest} days`, "longest streak"],
  ];
  const tileW = (W - 48) / tiles.length;
  let body = tiles
    .map(([v, l], i) => `<text x="${24 + i * tileW}" y="86" class="v">${esc(v)}</text><text x="${24 + i * tileW}" y="108" class="s m">${esc(l)}</text>`)
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
    body += vbar(cx - barW / 2, base, barW, h, t.series[0]);
    const label = new Date(`${m.key}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const partial = i === d.months.length - 1;
    body += `<text x="${cx}" y="${base + 20}" class="s m" text-anchor="middle">${label}${partial ? "*" : ""}</text>`;
    // Direct labels only where they matter: the big months and the latest one.
    if (m.total >= max * 0.3 || partial) body += `<text x="${cx}" y="${base - h - 6}" class="s" text-anchor="middle">${fmt(m.total)}</text>`;
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
    body += hbar(left, y, mw, 18, cMerged, ow === 0);
    body += hbar(left + mw + gap, y, Math.max(ow - gap, 0), 18, cOpen, true);
    const label = [r.merged && `${r.merged} merged`, r.open && `${r.open} open`].filter(Boolean).join(" · ");
    body += `<text x="${left + mw + ow + 8}" y="${y + 14}" class="s m">${label}</text>`;
  });
  const height = top + rows.length * rowH + 14;
  const desc = rows.map((r) => `${r.name}: ${r.merged} merged, ${r.open} open`).join("; ");
  return card(t, height, "Pull requests by repository", body, desc);
}

function languagesSvg(t, d) {
  const left = 24, right = W - 24, y = 60, h = 14;
  const colorOf = (l, i) => (l.other ? t.other : t.series[i]);
  let x = left;
  let body = "";
  const usable = right - left - 2 * (d.langs.length - 1);
  d.langs.forEach((l, i) => {
    const w = Math.max(l.share * usable, 2);
    const first = i === 0, last = i === d.langs.length - 1;
    const r = 4;
    // Round only the outer ends of the stacked bar; 2px surface gap between segments.
    if (first && last) body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${colorOf(l, i)}"/>`;
    else if (first) body += `<path d="M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z" fill="${colorOf(l, i)}"/>`;
    else if (last) body += `<path d="M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z" fill="${colorOf(l, i)}"/>`;
    else body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colorOf(l, i)}"/>`;
    x += w + 2;
  });
  // Legend doubles as the direct labels: every segment gets its name and share in text.
  const colW = (right - left) / d.langs.length;
  d.langs.forEach((l, i) => {
    const lx = left + i * colW;
    body += `<rect x="${lx}" y="${y + 34}" width="10" height="10" rx="2" fill="${colorOf(l, i)}"/>`;
    body += `<text x="${lx + 16}" y="${y + 43}" class="s">${esc(l.name)} <tspan class="m">${(l.share * 100).toFixed(1)}%</tspan></text>`;
  });
  const desc = d.langs.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(", ");
  return card(t, 132, "Languages across my public repositories", body, desc);
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
  langs: languages(profile.repositories.nodes),
  updated: new Date().toISOString().slice(0, 10),
};

mkdirSync(ASSETS, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  writeFileSync(new URL(`overview-${mode}.svg`, ASSETS), overviewSvg(theme, data));
  writeFileSync(new URL(`prs-${mode}.svg`, ASSETS), prsSvg(theme, data));
  writeFileSync(new URL(`languages-${mode}.svg`, ASSETS), languagesSvg(theme, data));
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
  langs: data.langs.map((l) => `${l.name}:${(l.share * 100).toFixed(1)}`).join(" "),
  activepiecesMerged: activepiecesMerged.length,
  activepiecesPieces: scopes(activepiecesMerged).size,
});
