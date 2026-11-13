// Bounty Truth Check: read a listing from a public source and normalize it.
// Only HTTP GET to an allow-list of public APIs, without credentials or tokens.
// Before the first contact with each origin, the consent gate asks the visitor.
// When a source does not allow browser access (no CORS), the check fails closed and
// asks the visitor to paste the listing text instead. It never uses a proxy.

/** Origins this site may contact, and why. Nothing else is ever fetched. */
export const ALLOWED_ORIGINS = Object.freeze({
  "https://api.github.com": "read the public issue, its comments, linked pull requests, the repository and its public payout history (GitHub REST API, no token)",
  "https://superteam.fun": "read the public listing details (Superteam Earn API)",
});

export class SourceError extends Error {
  /**
   * :param code: "consent_denied" | "blocked" | "rate_limited" | "not_found" | "http" | "not_allowed"
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Identify the kind of listing from a URL.
 *
 * :param raw: URL string.
 * :return: {kind, ...} where kind is github | superteam | devpost | algora | other | invalid
 */
export function parseListingUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { kind: "invalid" }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: "invalid" };
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 4 && (parts[2] === "issues" || parts[2] === "pull") && /^\d+$/.test(parts[3])) {
    return { kind: "github", owner: parts[0], repo: parts[1], number: Number(parts[3]), url: `https://github.com/${parts[0]}/${parts[1]}/issues/${parts[3]}` };
  }
  if (/(^|\.)superteam\.fun$/.test(host)) {
    const i = parts.indexOf("listing");
    const slug = i >= 0 ? parts[i + 1] : (parts[0] === "earn" ? parts[2] : null);
    if (slug && /^[a-z0-9-]+$/i.test(slug)) return { kind: "superteam", slug, url: u.href };
  }
  if (/(^|\.)devpost\.com$/.test(host)) return { kind: "devpost", url: u.href };
  if (/(^|\.)algora\.io$/.test(host)) return { kind: "algora", url: u.href };
  return { kind: "other", url: u.href };
}

/**
 * Create a fetcher that enforces the allow-list, GET-only, no credentials, consent and a timeout.
 *
 * :param fetchFn: The fetch implementation (window.fetch or a test double).
 * :param consent: async (origin, purpose) => boolean.
 * :param log: optional (entry) => void, records each contact for the activity log.
 */
export function createFetcher({ fetchFn, consent, log = () => {}, timeoutMs = 15000 }) {
  return async function getJson(url) {
    const origin = new URL(url).origin;
    if (!Object.hasOwn(ALLOWED_ORIGINS, origin)) throw new SourceError("not_allowed", `Contact with ${origin} is not allowed by this site.`);
    const ok = await consent(origin, ALLOWED_ORIGINS[origin]);
    if (!ok) {
      log({ origin, url, outcome: "denied" });
      throw new SourceError("consent_denied", `You did not allow contact with ${origin}.`, { origin });
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let resp;
    try {
      resp = await fetchFn(url, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json" },
        signal: ctrl?.signal,
      });
    } catch (error) {
      log({ origin, url, outcome: "blocked" });
      throw new SourceError("blocked", `${origin} could not be reached from the browser (offline, timeout, or the source does not allow browser access).`, { origin, cause: String(error) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    log({ origin, url, outcome: String(resp.status) });
    if (resp.status === 404) throw new SourceError("not_found", `Not found: ${url}`);
    if (resp.status === 403 || resp.status === 429) {
      const reset = resp.headers?.get?.("x-ratelimit-reset");
      throw new SourceError("rate_limited", `${origin} rate limit reached${reset ? `; try again after ${new Date(Number(reset) * 1000).toISOString().slice(11, 16)} UTC` : ""}.`, { origin });
    }
    if (!resp.ok) throw new SourceError("http", `${origin} answered HTTP ${resp.status}.`);
    return resp.json();
  };
}

// ---------------------------------------------------------------------------
// GitHub (+ Algora bot comments)
// ---------------------------------------------------------------------------

const MAINTAINER = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ALGORA_BOT_RE = /algora/i;
const ALGORA_BOUNTY_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*(k)?\s*bounty/i;
const AWARDED_RE = /(has been awarded|was awarded|been rewarded|bounty (has been |was )?(cancel+ed|removed|closed))/i;
const CLAIM_RE = /(claims? the bounty|\/claim\s+#?\d+|\/attempt\b)/i;

/** Extract dollar amounts from a string ("$1,200", "$1.2k", "💎 $500"). */
export function dollarAmounts(s) {
  const out = [];
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s*(k)?\b/gi;
  let m;
  while ((m = re.exec(String(s || "")))) {
    let v = Number(m[1].replace(/,/g, ""));
    if (m[2]) v *= 1000;
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

/**
 * Normalize GitHub API responses into a listing. Pure: tests pass recorded fixtures.
 *
 * :param ref: Result of parseListingUrl (kind github).
 * :param data: {issue, comments, timeline, repo, pulls, awardedSearch, bountySearch}; any may be null.
 */
export function normalizeGithub(ref, data) {
  const { issue, comments, timeline, repo, pulls, awardedSearch, bountySearch } = data;
  const incomplete = [];
  if (!Array.isArray(comments)) incomplete.push("comments");
  if (!Array.isArray(timeline)) incomplete.push("linked pull requests");
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const cs = (comments || []).map((c) => ({
    author: c.user?.login || "",
    isBot: c.user?.type === "Bot" || /\[bot\]$/.test(c.user?.login || ""),
    association: c.author_association || "NONE",
    body: String(c.body || ""),
    createdAt: c.created_at,
    url: c.html_url,
  }));
  const algora = cs.filter((c) => c.isBot && ALGORA_BOT_RE.test(c.author));
  const bountyComment = algora.find((c) => ALGORA_BOUNTY_RE.test(c.body));
  const awardComment = algora.find((c) => AWARDED_RE.test(c.body));
  const claimCount = cs.filter((c) => CLAIM_RE.test(c.body)).length;
  const maint = cs.filter((c) => !c.isBot && MAINTAINER.has(c.association)).map((c) => c.createdAt);
  if (MAINTAINER.has(issue.author_association)) maint.push(issue.created_at);
  maint.sort();

  const labelAmounts = labels.flatMap(dollarAmounts);
  const titleAmounts = dollarAmounts(issue.title);
  let rewardUsd = null;
  if (bountyComment) {
    const m = ALGORA_BOUNTY_RE.exec(bountyComment.body);
    rewardUsd = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  } else if (labelAmounts.length || titleAmounts.length) {
    rewardUsd = Math.max(...labelAmounts, ...titleAmounts);
  }
  const hasBountyWord = /bounty|reward|\$\d/i.test(`${issue.title} ${labels.join(" ")}`);

  const linkedPRs = [];
  const seen = new Set();
  for (const ev of timeline || []) {
    const src = ev?.source?.issue;
    if (ev?.event !== "cross-referenced" || !src?.pull_request || seen.has(src.html_url)) continue;
    seen.add(src.html_url);
    const sameRepo = String(src.repository_url || "").toLowerCase().endsWith(`/repos/${ref.owner}/${ref.repo}`.toLowerCase());
    const refRe = new RegExp(`(close[sd]?|fix(e[sd])?|resolve[sd]?|/claim)\\s*:?\\s*(${ref.owner}/${ref.repo})?#${ref.number}\\b`, "i");
    const resolves = sameRepo && (refRe.test(String(src.body || "")) || new RegExp(`#${ref.number}\\b`).test(String(src.title || "")));
    const merged = Boolean(src.pull_request.merged_at) && resolves;
    linkedPRs.push({
      number: src.number,
      url: src.html_url,
      state: src.state,
      merged,
      mergedAt: merged ? src.pull_request.merged_at : null,
    });
  }

  let payerHistory = null;
  if (awardedSearch && typeof awardedSearch.total_count === "number") {
    const last = awardedSearch.items?.[0];
    payerHistory = {
      scope: `${ref.owner}/${ref.repo}`,
      awardedCount: awardedSearch.total_count,
      lastAwardAt: last?.updated_at || null,
      lastAwardUrl: last?.html_url || null,
      bountiesSeen: bountySearch?.total_count ?? null,
      searchUrl: `https://github.com/search?type=issues&q=${encodeURIComponent(`repo:${ref.owner}/${ref.repo} "has been awarded" in:comments`)}`,
    };
  }

  return {
    source: "github",
    platform: bountyComment ? "Algora" : null,
    url: issue.html_url || ref.url,
    title: issue.title || "",
    body: String(issue.body || ""),
    labels,
    state: issue.state === "closed" ? "closed" : "open",
    assignees: (issue.assignees || []).map((a) => a.login),
    createdAt: issue.created_at || null,
    deadline: null,
    rewardUsd,
    rewardToken: null,
    rewardAmountsSeen: [...labelAmounts, ...titleAmounts],
    fundingClaim: bountyComment ? "platform" : hasBountyWord ? "label_only" : "unknown",
    platformBounty: Boolean(bountyComment),
    platformEvidence: bountyComment ? { url: bountyComment.url, quote: bountyComment.body.slice(0, 120) } : null,
    awarded: awardComment ? { url: awardComment.url, quote: awardComment.body.slice(0, 160) } : null,
    claimCount,
    linkedPRs,
    comments: Array.isArray(comments) ? cs.map(({ author, association, createdAt }) => ({ author, association, createdAt })) : null,
    incomplete,
    maintainerLastActivity: maint.length ? maint[maint.length - 1] : null,
    repo: repo ? { fullName: repo.full_name, stars: repo.stargazers_count, createdAt: repo.created_at, pushedAt: repo.pushed_at, archived: Boolean(repo.archived) } : null,
    recentClosedPRs: Array.isArray(pulls) ? { total: pulls.length, merged: pulls.filter((p) => p.merged_at).length } : null,
    payerHistory,
    sponsor: null,
    agentAccess: "UNKNOWN",
  };
}

/** Fetch everything the three agents need for a GitHub issue. Optional parts fail soft. */
export async function fetchGithub(ref, getJson) {
  const api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const issue = await getJson(`${api}/issues/${ref.number}`);
  const soft = async (url) => {
    try { return await getJson(url); } catch (error) { if (error.code === "consent_denied") throw error; return null; }
  };
  const q = (s) => `https://api.github.com/search/issues?per_page=1&sort=updated&order=desc&q=${encodeURIComponent(s)}`;
  const lastPage = Math.max(1, Math.ceil((issue.comments || 0) / 100));
  const commentsUrl = (page) => `${api}/issues/${ref.number}/comments?per_page=100&page=${page}`;
  const firstComments = await soft(commentsUrl(1));
  // Payout and claim comments come late in long threads: also read the last page.
  const lastComments = lastPage > 1 && firstComments ? await soft(commentsUrl(lastPage)) : [];
  const [comments, timeline, repo, pulls, awardedSearch, bountySearch] = [
    firstComments ? [...firstComments, ...(lastComments || [])] : null,
    await soft(`${api}/issues/${ref.number}/timeline?per_page=100`),
    await soft(api),
    await soft(`${api}/pulls?state=closed&per_page=30`),
    await soft(q(`repo:${ref.owner}/${ref.repo} "has been awarded" in:comments`)),
    await soft(q(`repo:${ref.owner}/${ref.repo} algora bounty in:comments`)),
  ];
  return normalizeGithub(ref, { issue, comments, timeline, repo, pulls, awardedSearch, bountySearch });
}

// ---------------------------------------------------------------------------
// Superteam Earn (JSON from the public details API, fetched or pasted)
// ---------------------------------------------------------------------------

/** Normalize a Superteam listing details object. */
export function normalizeSuperteam(d, url = null) {
  const rewards = d.rewards && typeof d.rewards === "object" ? Object.values(d.rewards).map(Number).filter(Number.isFinite) : [];
  const stable = /^(usdc|usdt|usd)$/i.test(d.token || "");
  const total = d.rewardAmount ?? (rewards.length ? rewards.reduce((a, b) => a + b, 0) : null);
  const top = d.rewards?.["1"] != null ? Number(d.rewards["1"]) : total;
  return {
    source: "superteam",
    platform: "Superteam Earn",
    url: url || (d.slug ? `https://superteam.fun/earn/listing/${d.slug}` : null),
    title: d.title || "",
    body: String(d.description || "").replace(/<[^>]+>/g, " "),
    labels: (d.skills || []).flatMap((s) => (typeof s === "string" ? [s] : [s.skills, ...(s.subskills || [])])).filter(Boolean),
    state: d.status === "OPEN" ? "open" : d.status ? "closed" : "unknown",
    status: d.status || null,
    assignees: [],
    createdAt: d.publishedAt || null,
    deadline: d.deadline || null,
    rewardUsd: stable ? top : null,
    rewardToken: d.token || null,
    totalPool: total != null ? `${total} ${d.token || ""}`.trim() : null,
    topPrize: top != null ? `${top} ${d.token || ""}`.trim() : null,
    fundingClaim: "platform",
    platformBounty: true,
    platformEvidence: { url: url || null, quote: "Listed on Superteam Earn" },
    awarded: null,
    winnersAnnounced: Boolean(d.isWinnersAnnounced),
    claimCount: 0,
    competitors: d._count?.Submission ?? null,
    linkedPRs: [],
    sponsor: d.sponsor ? { name: d.sponsor.name, verified: d.sponsor.isVerified === true } : null,
    agentAccess: d.agentAccess || "UNKNOWN",
    region: d.region || null,
  };
}

// ---------------------------------------------------------------------------
// Pasted text (any source, including Devpost and sources without browser access)
// ---------------------------------------------------------------------------

/** Normalize free text. If the text is Superteam details JSON, use that normalizer. */
export function normalizeText(text, url = null) {
  const t = String(text || "").trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (j && (j.sponsor || j.rewards || j.rewardAmount != null)) return normalizeSuperteam(j, url);
    } catch { /* plain text */ }
  }
  const firstLine = t.split("\n").find((l) => l.trim()) || "";
  const amounts = dollarAmounts(t);
  const deadlineMatch = /\b(deadline|due|ends?|closes?)\b[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/i.exec(t);
  return {
    source: "text",
    platform: null,
    url,
    title: firstLine.slice(0, 200),
    body: t,
    labels: [],
    state: "unknown",
    assignees: [],
    createdAt: null,
    deadline: deadlineMatch && Number.isFinite(Date.parse(deadlineMatch[2])) ? new Date(deadlineMatch[2]).toISOString() : null,
    rewardUsd: amounts.length ? Math.max(...amounts) : null,
    rewardToken: null,
    fundingClaim: /\bescrow/i.test(t) ? "escrow" : amounts.length || /bounty|reward|prize/i.test(t) ? "label_only" : "unknown",
    platformBounty: false,
    awarded: null,
    claimCount: 0,
    linkedPRs: [],
    sponsor: null,
    agentAccess: "UNKNOWN",
  };
}

/**
 * Read a listing from a URL and/or pasted text.
 *
 * :return: {listing, sourceStatus: {ok, code?, message?}}
 */
export async function readListing({ url, text }, getJson) {
  const hasText = typeof text === "string" && text.trim().length > 0;
  const ref = url ? parseListingUrl(url) : { kind: "none" };
  try {
    if (ref.kind === "github") return { listing: await fetchGithub(ref, getJson), sourceStatus: { ok: true, source: "GitHub REST API" } };
    if (ref.kind === "superteam" && !hasText) {
      const d = await getJson(`https://superteam.fun/api/listings/details/${encodeURIComponent(ref.slug)}`);
      return { listing: normalizeSuperteam(d, ref.url), sourceStatus: { ok: true, source: "Superteam Earn API" } };
    }
  } catch (error) {
    if (!hasText) {
      return {
        listing: { unreadable: true, url: ref.url || url || null },
        sourceStatus: { ok: false, code: error.code || "error", message: error.message },
      };
    }
    // Fall through to pasted text, but keep the reason.
    return { listing: normalizeText(text, ref.url || url || null), sourceStatus: { ok: true, source: "pasted text", note: error.message } };
  }
  if (hasText) return { listing: normalizeText(text, ref.url || url || null), sourceStatus: { ok: true, source: "pasted text" } };
  const why = {
    devpost: "Devpost does not allow browser access to its data. Paste the hackathon's rules or overview text.",
    algora: "Open the GitHub issue that the Algora bounty belongs to and check that URL, or paste the bounty text.",
    other: "This source has no public API this site may read. Paste the listing text.",
    invalid: "That is not a valid http(s) URL.",
    none: "Give a listing URL or paste its text.",
  }[ref.kind];
  return { listing: { unreadable: true, url: ref.url || url || null }, sourceStatus: { ok: false, code: "unsupported_source", message: why } };
}
