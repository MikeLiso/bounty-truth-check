// Bounty Truth Check: deterministic rules used by the three specialist agents and the judge.
// Pure functions, no DOM and no network, so the same code runs in the browser and in Node tests.
//
// Ported from the OGT validator (src/validator/validator.ts) and extended with the
// lessons of a manual review of 20 real "paid task" listings (see README, "Rule sources").
// Every finding carries evidence: the exact text, label, comment or API field it is based on.

/** Severity order: info < warn < risk < reject. */
export const SEVERITY = Object.freeze({ info: 0, ok: 0, warn: 1, risk: 2, reject: 3 });

export const VERDICTS = Object.freeze({
  VERIFIED: {
    label: "Looks real",
    advice: "Platform-held reward and a payer with a public payout record. Still read the terms before you start.",
  },
  UNVERIFIED: {
    label: "Unverified",
    advice: "No red flags found, but nothing proves the reward is funded. Ask the maintainer or sponsor before investing serious time.",
  },
  HIGH_RISK: {
    label: "High risk",
    advice: "Patterns typical of bait listings. Do not run their code or share anything; only proceed after independent confirmation.",
  },
  REJECTED: {
    label: "Do not work on this",
    advice: "Already paid, closed, dead, or a trap. Working on it will very likely not be paid.",
  },
  UNKNOWN: {
    label: "Not enough data",
    advice: "The listing could not be read. Paste its text, or allow the data source, and run the check again.",
  },
});

const DAY = 86_400_000;

/** Make a finding. */
export function finding(id, severity, message, evidence = null) {
  return { id, severity, message, evidence };
}

/** Return a short quote (max 160 chars) around the first regex match, or null. */
export function quote(text, re) {
  if (!text) return null;
  const m = re.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 50);
  const end = Math.min(text.length, m.index + m[0].length + 80);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

/** Strip the standard Algora bot footer, which always mentions a demo video and must not trigger rules. */
export function stripBoilerplate(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/provide a short demo video[^\n]*/gi, " ")
    .replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Trap detector rules (text + labels)
// ---------------------------------------------------------------------------

/**
 * Text patterns. `severity` is the default; `combo` rules below can raise it.
 * Patterns are deliberately specific to keep false alarms low on normal bounties.
 */
export const TRAP_RULES = [
  {
    id: "prompt_exfiltration",
    severity: "reject",
    re: /(\bgeneration[_ ]context\b|\binitial[_ ]directives\b|_meta\.json|\bgeneration_meta\b|\b(paste|include|attach|copy|share|send|dump|submit|add)\b[^.\n]{0,60}\b(your|the agent'?s?|its) (own |full |complete |entire |unmodified |original )*(system prompt|initial instructions|startup instructions|instructions and context|context and instructions|prompt)\b|\b(paste|include|attach|copy) (everything|all) (your|the) (platform|agent|tool)[^.\n]{0,40}(provided|gave|received))/i,
    message: "Asks the worker (or its AI agent) to hand over its own instructions or context. This is prompt and secret exfiltration.",
  },
  {
    id: "secret_request",
    severity: "reject",
    re: /\b((send|share|provide|enter|paste|submit|give|upload|dm)\b[^.\n]{0,40}\b(seed phrase|recovery phrase|private key|mnemonic|secret key)|(seed phrase|recovery phrase|private key|mnemonic)\b[^.\n]{0,30}\b(to (claim|receive|verify|get paid))|connect (your )?wallet and sign|sign (this|the) (message|transaction) to (claim|receive))\b/i,
    message: "Asks for wallet secrets or a signature. Legitimate bounties never need this.",
  },
  {
    id: "engagement_farming",
    severity: "reject",
    re: /\b(star (the|this|our) (repo|repository|project)|give (us|it) a star|(must|please) (star|fork)\b[^.\n]{0,40}\b(repo|repository)|create (a|another|more|new) (github )?issues?\b[^.\n]{0,40}\b(template|formula|format|bounty)|issues? (focused on|about) creating (more )?issues|(follow|retweet|like) (us|and)\b[^.\n]{0,60}\b(win|chance|reward))\b/i,
    message: "The 'work' is starring, following or creating more issues. That is engagement farming, not a paid task.",
  },
  {
    id: "pipe_to_shell",
    severity: "risk",
    re: /(curl [^\n|]*\|\s*(sudo )?(ba|z)?sh|wget [^\n|]*\|\s*(sudo )?(ba)?sh|iwr [^\n|]*\|\s*iex)/i,
    message: "Asks you to pipe a download straight into a shell.",
  },
  {
    id: "run_untrusted_code",
    severity: "warn",
    re: /(docker run|ghcr\.io\/|\b(run|execute)\s+(python3?|node|bash|sh|zsh|pwsh|powershell|ruby|perl|deno|bun)\s+[\w./-]+|\.\/[\w.-]+\.(sh|py|bin)\b|curl [^\n|]*\|\s*(ba|z)?sh|wget [^\n|]*\|\s*(ba)?sh|npx [a-z0-9@/._-]+|(run|execute) (the )?(provided |included |attached )?(`?[\w./-]+\.(py|sh|js|exe|ps1)`?|build script|installer|binary))/i,
    message: "Asks you to run the poster's code, image or script. Normal for development work; dangerous combined with the patterns below.",
  },
  {
    id: "attach_generated_artifact",
    severity: "risk",
    re: /\b(include|attach|upload|add|commit) (the )?(generated|resulting|produced|diagnostic)[^.\n]{0,40}\b(artifact|file|log|logd|report|bundle)\b|\.logd\b/i,
    message: "Asks you to attach a file generated on your machine. Opaque artifacts can carry your environment data out.",
  },
  {
    id: "revenue_or_cashback",
    severity: "risk",
    re: /\b(cashback|revenue share|generate[sd]? (at least )?\$?\d+[^.\n]{0,30}(revenue|income)|paid (only )?after[^.\n]{0,40}(revenue|sales|earn))\b/i,
    message: "Payment depends on you generating revenue for the poster. That is distribution, not a task.",
  },
  {
    id: "humans_excluded",
    severity: "risk",
    re: /\b(no humans|ai[- ]only|(ai|llm) agents? only|only (ai|llm) agents? (allowed|may|can)|human (engineers?|prs?|contributions?|submissions?)[^.\n]{0,30}(are|will) not (be )?reviewed|only (ai )?agents?[^.\n]{0,20}(prs?|submissions?)[^.\n]{0,10}(are )?reviewed)\b/i,
    message: "Says humans are excluded or not reviewed. Real maintainers rarely say this; bait listings for AI agents often do.",
  },
  {
    id: "deposit_or_stake",
    severity: "risk",
    re: /\b((make|send|pay|requires?|need to|must) (a |an |the )?(small |refundable |security )?(deposit|stake|collateral)|stake \$?\d|(refundable|activation|registration|application|entry) fee|pay (a|the) fee)\b/i,
    message: "Asks you to deposit, stake or pay first.",
  },
  {
    id: "token_promo",
    severity: "risk",
    re: /\b(airdrop|presale|buy (the |our )?token|mint (an? )?nft)\b/i,
    message: "Token promotion or airdrop instead of paid work.",
  },
  {
    id: "onchain_payment_required",
    severity: "warn",
    re: /\b(solscan|etherscan|basescan)\b[^.\n]{0,60}\b(link|tx|transaction)\b|\b(make|perform|send) (a )?(real |paid |live )?(on-?chain )?(transaction|payment|paid call)\b|\bx402\b/i,
    message: "Requires a real crypto transaction or paid API call. You spend money to qualify.",
  },
  {
    id: "ai_banned",
    severity: "warn",
    re: /\b(no (ai|llm|chatgpt|bots?)\b|ai[- ]generated (content|code|submissions?) (will be|are|is) (rejected|disqualified|not allowed)|human[- ]written only)\b/i,
    message: "Bans AI-generated work. Fine for a person, disqualifying for an AI agent.",
  },
  {
    id: "kyc",
    severity: "info",
    re: /\b(kyc|identity verification|passport|government[- ]issued id)\b/i,
    message: "Payout needs identity verification (KYC). Normal on real platforms, but plan for it.",
  },
  {
    id: "geo_restricted",
    severity: "info",
    re: /\b(only (for )?(residents|citizens) of|must be (based|located) in|(us|india|nigeria|eu)[- ]only|restricted to (residents|citizens))\b/i,
    message: "Possible country restriction. Check you are eligible before starting.",
  },
  {
    id: "video_required",
    severity: "info",
    re: /\b(loom|demo video|video (walkthrough|demo|recording)|record a video)\b/i,
    message: "Acceptance needs a video recording.",
  },
];

/** Label rules (GitHub labels and similar tags). */
export const LABEL_RULES = [
  { id: "label_humans_excluded", severity: "risk", re: /(no humans|ai[- ]only|(ai|llm) agents? only)/i, message: "Label says humans are excluded." },
  { id: "label_on_hold", severity: "reject", re: /^(on[- ]?hold|blocked|wontfix|won't fix|invalid|duplicate)$/i, message: "Label marks the task as on hold, blocked or invalid." },
  { id: "label_epic", severity: "risk", re: /^epic$/i, message: "Label 'epic': a whole programme of work behind a single small reward." },
];

/** Escrow claims that cannot be checked. */
const ESCROW_RE = /\bescrow(ed)?\b/i;
const AUTO_RELEASE_RE = /\b(released|paid) automatically\b|\bquorum\b/i;
const PLATFORM_NAMES_RE = /\b(algora|polar|opire|gitcoin|bountysource|issuehunt)\b/gi;

/**
 * Trap detector: scan text and labels for bait patterns.
 *
 * :param listing: A normalized listing.
 * :return: {findings}
 */
export function detectTraps(listing) {
  const findings = [];
  const text = stripBoilerplate(`${listing.title || ""}\n${listing.body || ""}`);
  for (const rule of TRAP_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      findings.push(finding(rule.id, rule.severity, rule.message, { quote: quote(text, new RegExp(rule.re.source, "i")) }));
    }
  }
  for (const label of listing.labels || []) {
    for (const rule of LABEL_RULES) {
      if (rule.re.test(label)) findings.push(finding(rule.id, rule.severity, rule.message, { label }));
    }
  }
  // Fake escrow: escrow claimed, but not held by a platform we can check.
  if (ESCROW_RE.test(text) && listing.fundingClaim !== "platform") {
    const platforms = new Set((text.match(PLATFORM_NAMES_RE) || []).map((s) => s.toLowerCase()));
    const reasons = [];
    if (platforms.size >= 2) reasons.push(`names ${platforms.size} payment platforms at once (${[...platforms].join(", ")})`);
    if (AUTO_RELEASE_RE.test(text)) reasons.push("promises automatic release");
    if (!listing.platformBounty) reasons.push("no platform record of the bounty was found");
    findings.push(finding(
      "unverifiable_escrow",
      reasons.length >= 3 ? "reject" : reasons.length === 2 ? "risk" : "warn",
      `Claims the reward is in escrow, but ${reasons.join("; ") || "the escrow cannot be verified"}.`,
      { quote: quote(text, ESCROW_RE) },
    ));
  }
  // Combination: humans excluded + any other risk => reject (classic AI-agent honeypot).
  const has = (id) => findings.some((f) => f.id === id || f.id === `label_${id}`);
  if (has("humans_excluded") && findings.some((f) => SEVERITY[f.severity] >= SEVERITY.risk && !/humans_excluded/.test(f.id))) {
    findings.push(finding("honeypot_combo", "reject", "Humans are excluded AND another risk pattern is present: the typical shape of a honeypot for AI agents."));
  }
  if ((has("run_untrusted_code") || has("pipe_to_shell")) && has("revenue_or_cashback")) {
    findings.push(finding("distribution_combo", "reject", "Run our image/code and get paid only from revenue it generates: paid software distribution, not work."));
  }
  if ((has("run_untrusted_code") || has("pipe_to_shell")) && has("attach_generated_artifact")) {
    findings.push(finding("exfiltration_combo", "reject", "Run our script and attach what it generates: a data-exfiltration pattern."));
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// Payer verifier
// ---------------------------------------------------------------------------

const NON_CASH_RE = /\b(site credits?|platform credits?|points only|reputation only|no bounty|unpaid|swag only)\b/i;

/**
 * Payer verifier: is there a real, funded payer with a payout record?
 *
 * :param listing: A normalized listing (see sources.js).
 * :param now: The current Date.
 * :return: {findings, trustDelta, fundingClaim}
 */
export function verifyPayer(listing, now = new Date()) {
  const findings = [];
  let trust = 0;
  const text = stripBoilerplate(`${listing.title || ""}\n${listing.body || ""}`);
  const ev = (extra) => ({ url: listing.url, ...extra });

  // Funding claim.
  switch (listing.fundingClaim) {
    case "platform":
      trust += 0.15;
      findings.push(finding("funding_platform", "ok", `Reward is recorded by a platform (${listing.platform || listing.source}).`, listing.platformEvidence || ev()));
      break;
    case "escrow":
      trust += 0.1;
      findings.push(finding("funding_escrow_claim", "warn", "Reward is described as escrowed; verify the escrow contract or platform yourself."));
      break;
    case "label_only":
      trust -= 0.1;
      findings.push(finding("funding_label_only", "warn", "Only a label or title says 'bounty'. No platform record confirms the money exists.", listing.labels?.length ? { labels: listing.labels } : null));
      break;
    default:
      findings.push(finding("funding_unknown", "warn", "How the reward is funded is unknown."));
  }

  // Reward amount sanity.
  if (listing.rewardUsd == null) {
    trust -= 0.1;
    findings.push(finding("reward_unknown", "warn", "Reward amount could not be determined."));
  } else if (listing.rewardUsd >= 3000 && listing.fundingClaim === "label_only") {
    findings.push(finding("big_reward_label_only", "risk", `A large reward ($${listing.rewardUsd}) backed only by a label or title.`));
  }
  if (Array.isArray(listing.rewardAmountsSeen) && new Set(listing.rewardAmountsSeen).size >= 2) {
    findings.push(finding("conflicting_amounts", "risk", `Conflicting reward amounts in labels/title: ${[...new Set(listing.rewardAmountsSeen)].map((a) => "$" + a).join(", ")}.`));
  }
  if (NON_CASH_RE.test(text)) {
    trust -= 0.15;
    findings.push(finding("non_cash", "warn", "Reward is not cash (credits, points or reputation).", { quote: quote(text, NON_CASH_RE) }));
  }
  if (listing.rewardToken && listing.rewardUsd == null) {
    trust -= 0.05;
    findings.push(finding("token_unpriced", "warn", `Paid in ${listing.rewardToken} with no USD value: price risk.`));
  }
  if (listing.totalPool && listing.topPrize && listing.totalPool !== listing.topPrize) {
    findings.push(finding("pool_split", "info", `The ${listing.totalPool} pool is split; first place gets ${listing.topPrize}.`));
  }

  // Sponsor verification (Superteam and similar).
  if (listing.sponsor?.verified === true) {
    trust += 0.15;
    findings.push(finding("sponsor_verified", "ok", `Sponsor "${listing.sponsor.name}" is verified by the platform.`));
  } else if (listing.sponsor?.verified === false) {
    trust -= 0.05;
    findings.push(finding("sponsor_unverified", "warn", `Sponsor "${listing.sponsor.name}" is NOT verified by the platform.`));
  }

  // Payout history (GitHub + Algora bot comments, counted with GitHub search).
  const h = listing.payerHistory;
  if (h && h.awardedCount != null) {
    const scope = h.scope || "this repository";
    if (h.awardedCount === 0) {
      trust -= 0.15;
      const sev = (h.bountiesSeen ?? 0) >= 10 ? "risk" : "warn";
      findings.push(finding("no_payouts", sev, `No public payout ("has been awarded") found in ${scope}${h.bountiesSeen ? ` despite ${h.bountiesSeen} bounty mentions` : ""}.`, h.searchUrl ? { url: h.searchUrl } : null));
    } else {
      const ageDays = h.lastAwardAt ? (now - Date.parse(h.lastAwardAt)) / DAY : null;
      if (ageDays != null && ageDays > 365) {
        trust -= 0.15;
        findings.push(finding("payouts_stale", "warn", `${h.awardedCount} issue(s) with a payout comment in ${scope}, but none active since ${h.lastAwardAt.slice(0, 10)} (over a year).`, h.lastAwardUrl ? { url: h.lastAwardUrl } : null));
      } else {
        trust += ageDays != null && ageDays < 183 ? 0.15 : 0.1;
        findings.push(finding("payouts_found", "ok", `${h.awardedCount} issue(s) with a public payout comment in ${scope}${h.lastAwardAt ? `; most recent activity on one ${h.lastAwardAt.slice(0, 10)}` : ""}.`, h.lastAwardUrl ? { url: h.lastAwardUrl } : null));
      }
    }
  } else if (listing.source === "github") {
    findings.push(finding("payouts_unknown", "warn", "Payout history could not be read (GitHub search unavailable or rate limited)."));
  }

  // Repository reputation.
  const r = listing.repo;
  if (r) {
    const created = Date.parse(r.createdAt);
    const ageDays = Number.isFinite(created) ? (now - created) / DAY : null;
    const repoUrl = `https://github.com/${r.fullName}`;
    if (r.archived) findings.push(finding("repo_archived", "reject", "Repository is archived.", { url: repoUrl }));
    if (r.pushedAt && (now - Date.parse(r.pushedAt)) / DAY > 180) {
      findings.push(finding("repo_abandoned", "reject", `Repository abandoned: last push ${r.pushedAt.slice(0, 10)}.`, { url: repoUrl }));
    }
    if (ageDays != null && ageDays < 90 && r.stars < 20) {
      findings.push(finding("repo_new_unknown", "risk", `Brand-new repository (${Math.round(ageDays)} days, ${r.stars}★): a typical bait pattern.`, { url: repoUrl }));
    } else if (r.stars >= 200) {
      trust += 0.1;
      findings.push(finding("repo_established", "ok", `Established repository (${r.stars}★${r.createdAt ? `, created ${String(r.createdAt).slice(0, 10)}` : ""}).`, { url: repoUrl }));
    } else if (r.stars < 5) {
      trust -= 0.1;
      findings.push(finding("repo_low_reputation", "warn", `Low-reputation repository (${r.stars}★).`, { url: repoUrl }));
    }
  }
  const pr = listing.recentClosedPRs;
  if (pr && pr.total >= 10 && pr.merged === 0) {
    findings.push(finding("no_merges", "reject", `None of the last ${pr.total} closed pull requests was merged: nobody is accepting work here.`, r ? { url: `https://github.com/${r.fullName}/pulls?q=is%3Apr+is%3Aclosed` } : null));
  }

  // Maintainer activity in the thread.
  const m = listing.maintainerLastActivity;
  if (listing.source === "github" && Array.isArray(listing.comments)) {
    if (!m) {
      findings.push(finding("maintainer_silent", "warn", "No comment from a maintainer (owner/member/collaborator) in the thread."));
    } else if ((now - Date.parse(m)) / DAY > 365) {
      trust -= 0.15;
      findings.push(finding("maintainer_inactive", "warn", `Maintainers last commented on ${m.slice(0, 10)} (over a year ago).`));
    }
  }

  // Mass-produced bounties without a platform.
  if ((listing.bountiesInRepo ?? 0) >= 10 && listing.fundingClaim !== "platform") {
    findings.push(finding("mass_bounties", "risk", `${listing.bountiesInRepo} 'bounties' from one repository without a payment platform.`));
  }

  return { findings, trustDelta: trust };
}

// ---------------------------------------------------------------------------
// Already-done / already-paid detector
// ---------------------------------------------------------------------------

/**
 * Already-done detector: is the task still open and winnable?
 *
 * :param listing: A normalized listing.
 * :param now: The current Date.
 * :return: {findings, trustDelta}
 */
export function detectAlreadyDone(listing, now = new Date()) {
  const findings = [];
  let trust = 0;
  if (listing.state === "closed") {
    findings.push(finding("closed", "reject", "The listing is closed.", { url: listing.url }));
  }
  if (listing.awarded) {
    findings.push(finding("already_awarded", "reject", "The reward was already awarded, paid or cancelled; the listing only stayed open.", listing.awarded));
  }
  if (listing.winnersAnnounced) {
    findings.push(finding("winners_announced", "reject", "Winners were already announced."));
  }
  const merged = (listing.linkedPRs || []).filter((p) => p.merged);
  if (merged.length) {
    const p = merged[0];
    findings.push(finding("delivered_by_merged_pr", "reject", `Already delivered: pull request #${p.number} referencing this issue was merged${p.mergedAt ? ` on ${p.mergedAt.slice(0, 10)}` : ""}.`, { url: p.url }));
  }
  if (listing.assignees?.length) {
    findings.push(finding("assigned", "reject", `Assigned to ${listing.assignees.join(", ")}.`));
  }
  if (listing.deadline) {
    const days = (Date.parse(listing.deadline) - now) / DAY;
    if (days < 0) findings.push(finding("deadline_passed", "reject", `Deadline passed (${listing.deadline.slice(0, 10)}).`));
    else if (days < 1) { trust -= 0.05; findings.push(finding("deadline_soon", "warn", "Less than 24 hours to the deadline.")); }
  }
  if (listing.status && listing.status !== "OPEN" && listing.source !== "github") {
    findings.push(finding("not_open", "reject", `Platform status is ${listing.status}.`));
  }
  // Competition.
  const open = (listing.linkedPRs || []).filter((p) => !p.merged);
  const n = Math.max(open.length, listing.claimCount ?? 0);
  if (n >= 20 && (listing.rewardUsd ?? 0) < 300) {
    findings.push(finding("crowded", "reject", `${n} competing pull requests/claims for a reward under $300.`));
  } else if (n >= 10) {
    trust -= 0.15;
    findings.push(finding("competition_high", "warn", `${n} competing pull requests/claims already.`));
  } else if (n >= 1) {
    trust -= 0.05;
    findings.push(finding("competition", "info", `${n} pull request(s)/claim(s) already submitted.`));
  }
  if (listing.competitors != null && listing.competitors >= 100) {
    findings.push(finding("many_submissions", "info", `${listing.competitors} submissions/participants so far.`));
  }
  const staleClosed = (listing.linkedPRs || []).filter((p) => p.state === "closed" && !p.merged).length;
  if (staleClosed >= 3 && !listing.maintainerLastActivity) {
    findings.push(finding("review_path_dead", "risk", `${staleClosed} attempts were closed without merge and no maintainer replied: the review path looks dead.`));
  }
  if (listing.createdAt && (now - Date.parse(listing.createdAt)) / DAY > 365) {
    trust -= 0.1;
    findings.push(finding("old_listing", "warn", `Listing is over a year old (${listing.createdAt.slice(0, 10)}).`));
  }
  for (const part of listing.incomplete || []) {
    findings.push(finding(`incomplete_${part}`, "warn", `Could not read the ${part} (rate limit or network). The already-paid/delivered check is incomplete, so this cannot be called safe.`));
  }
  if (!findings.some((f) => SEVERITY[f.severity] >= SEVERITY.warn)) {
    findings.push(listing.state === "unknown"
      ? finding("no_done_signal_in_text", "info", "Nothing in the pasted text says it was already delivered or paid. Its open/closed state cannot be checked from text alone.")
      : finding("looks_open", "ok", "Open, unassigned, and no sign it was already delivered or paid."));
  }
  return { findings, trustDelta: trust };
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

/** Highest severity in a findings list. */
export function maxSeverity(findings) {
  return findings.reduce((m, f) => Math.max(m, SEVERITY[f.severity] ?? 0), 0);
}

/**
 * Judge: combine the three reports into one verdict with evidence.
 * The judge can only use what the specialists found; it never invents positive evidence.
 *
 * :param listing: The normalized listing (or null when it could not be read).
 * :param reports: {payer, done, traps} results.
 * :return: {status, label, advice, trustScore, decisive, evidence}
 */
export function judge(listing, reports) {
  if (!listing || listing.unreadable) {
    return { status: "UNKNOWN", ...VERDICTS.UNKNOWN, trustScore: null, decisive: [], counts: {} };
  }
  const all = [
    ...reports.payer.findings.map((f) => ({ ...f, agent: "payer_verifier" })),
    ...reports.done.findings.map((f) => ({ ...f, agent: "already_done_detector" })),
    ...reports.traps.findings.map((f) => ({ ...f, agent: "trap_detector" })),
  ];
  let trust = 0.3 + (reports.payer.trustDelta || 0) + (reports.done.trustDelta || 0);
  if (listing.agentAccess === "AGENT_ALLOWED" || listing.agentAccess === "AGENT_ONLY") trust += 0.05;
  trust = Math.max(0, Math.min(1, trust));
  const top = maxSeverity(all);
  let status;
  if (top >= SEVERITY.reject) status = "REJECTED";
  else if (top >= SEVERITY.risk) status = "HIGH_RISK";
  else if (
    trust >= 0.6
    && !(listing.incomplete || []).length
    && listing.fundingClaim === "platform"
    && (listing.sponsor?.verified === true || (listing.payerHistory?.awardedCount ?? 0) > 0)
  ) status = "VERIFIED";
  else status = "UNVERIFIED";
  const order = (f) => -(SEVERITY[f.severity] ?? 0);
  const decisive = all
    .filter((f) => (status === "VERIFIED" || status === "UNVERIFIED") ? true : SEVERITY[f.severity] >= SEVERITY[status === "REJECTED" ? "reject" : "risk"])
    .sort((a, b) => order(a) - order(b));
  const counts = {};
  for (const f of all) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return { status, ...VERDICTS[status], trustScore: Number(trust.toFixed(2)), decisive, counts };
}
