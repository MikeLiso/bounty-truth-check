// Bounty Truth Check page: the human interface. It works without any LLM key: the four
// agents' deterministic checks run directly. The LLM assistant (site.js) uses the same
// service through website_* tools.

import { TruthCheckService } from "./pipeline.js";
import { getService, setService } from "./service.js";
import { SAMPLES } from "./samples.js";
import { registerWebMcp } from "./webmcp.js";

const AGENT_TITLES = {
  payer_verifier: ["Payer verifier", "Is there a real, funded payer with a payout record?"],
  already_done_detector: ["Already-done detector", "Is it still open, unpaid and winnable?"],
  trap_detector: ["Trap detector", "Stars, run-our-code, prompt exfiltration, fake escrow…"],
};

/** Asks the visitor before the first contact with each origin in this tab. */
export class ConsentGate {
  constructor(ask) {
    this.ask = ask;
    this.decisions = new Map();
    this.pending = new Map();
  }

  async allow(origin, purpose) {
    if (this.decisions.get(origin) === true) return true;
    if (!this.pending.has(origin)) {
      const p = Promise.resolve(this.ask(origin, purpose)).then((ok) => {
        this.pending.delete(origin);
        // Only an approval is remembered (for this tab). A denial asks again next time.
        if (ok) this.decisions.set(origin, true);
        return Boolean(ok);
      });
      this.pending.set(origin, p);
    }
    return this.pending.get(origin);
  }
}

/** Open the consent dialog and resolve with the visitor's choice. */
function askWithDialog(origin, purpose) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "consent";
    dialog.setAttribute("aria-labelledby", "consent-title");
    const h = document.createElement("h2");
    h.id = "consent-title";
    h.tabIndex = -1;
    h.autofocus = true;
    h.textContent = `Contact ${new URL(origin).host}?`;
    const p = document.createElement("p");
    p.textContent = `To ${purpose}, your browser will send public GET requests to ${origin}. No key, cookie or personal data is sent. You decide once per tab.`;
    const yes = document.createElement("button");
    yes.textContent = `Allow ${new URL(origin).host}`;
    yes.addEventListener("click", () => dialog.close("allow"));
    const no = document.createElement("button");
    no.className = "secondary";
    no.textContent = "Don't contact it";
    no.addEventListener("click", () => dialog.close("deny"));
    dialog.append(h, p, yes, no);
    dialog.addEventListener("close", () => { dialog.remove(); resolve(dialog.returnValue === "allow"); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

/** Only http(s) links from evidence become clickable. */
function safeLink(url, label) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") {
      return el("a", { href: u.href, target: "_blank", rel: "noopener noreferrer nofollow", text: label || u.href });
    }
  } catch { /* not a URL */ }
  return document.createTextNode(label || String(url));
}

function evidenceNode(ev) {
  if (!ev) return null;
  const box = el("div", { class: "evidence" });
  if (ev.quote) box.append(el("q", { text: ev.quote }));
  if (ev.label) box.append(el("code", { text: `label: ${ev.label}` }));
  if (ev.labels) box.append(el("code", { text: `labels: ${ev.labels.join(", ")}` }));
  if (ev.url) box.append(" ", safeLink(ev.url, "source"));
  return box.childNodes.length ? box : null;
}

function findingNode(f) {
  return el("li", { class: `finding sev-${f.severity}` },
    el("span", { class: "chip", text: f.severity }),
    el("span", { text: ` ${f.message}` }),
    evidenceNode(f.evidence));
}

/** The page object: state reader plus operations, shared by the form and the agents. */
export class Page {
  constructor(service) {
    this.service = service;
    this.shown = null;
    this.version = 0;
  }

  /** Plain JSON copy of what the page shows. */
  getState() {
    return {
      version: this.version,
      input: {
        url: document.querySelector("#listing-url").value,
        textChars: document.querySelector("#listing-text").value.length,
      },
      shownReport: this.shown ? JSON.parse(JSON.stringify(this.shown)) : null,
      contactedOrigins: [...new Set(this.service.contacts.map((c) => c.origin))],
      samples: SAMPLES.map((s) => ({ id: s.id, title: s.title })),
    };
  }

  /** Run a check and show it on the page. */
  async checkAndShow(input) {
    const report = await this.service.full(input);
    this.show(report);
    return report;
  }

  show(report) {
    this.shown = report;
    this.version += 1;
    renderReport(report);
    renderContacts(this.service.contacts);
  }
}

function renderReport(r) {
  const out = document.querySelector("#report");
  out.replaceChildren();
  out.hidden = false;
  const v = r.verdict;
  const head = el("div", { class: `verdict v-${v.status}` },
    el("div", { class: "verdict-label", text: v.label }),
    el("div", { class: "verdict-meta", text: `${v.status}${v.trustScore != null ? ` · trust ${v.trustScore}` : ""} · checked ${r.checkedAt.slice(0, 16).replace("T", " ")} UTC` }),
    el("p", { text: v.advice }));
  out.append(head);
  if (!r.sourceStatus.ok) {
    out.append(el("p", { class: "source-error", role: "alert", text: `Could not read the listing: ${r.sourceStatus.message}` }));
  } else if (r.sourceStatus.note) {
    out.append(el("p", { class: "source-note", text: `Used the pasted text. ${r.sourceStatus.note}` }));
  }
  if (r.listing) {
    const l = r.listing;
    const facts = el("dl", { class: "facts" });
    const add = (k, val) => { if (val != null && val !== "") facts.append(el("dt", { text: k }), el("dd", {}, val)); };
    add("Listing", l.url ? safeLink(l.url, l.title || l.url) : document.createTextNode(l.title || "(pasted text)"));
    add("Read from", document.createTextNode(r.sourceStatus.source));
    add("Reward", document.createTextNode(l.rewardUsd != null ? `$${l.rewardUsd}` : l.topPrize || "unknown"));
    if (l.repo) add("Repository", document.createTextNode(`${l.repo.fullName} · ${l.repo.stars}★`));
    if (l.sponsor) add("Sponsor", document.createTextNode(`${l.sponsor.name}${l.sponsor.verified ? " (verified)" : " (not verified)"}`));
    out.append(facts);
  }
  if (v.decisive?.length && (v.status === "REJECTED" || v.status === "HIGH_RISK")) {
    out.append(el("h3", { text: "Why" }), el("ul", { class: "findings" }, ...v.decisive.slice(0, 5).map(findingNode)));
  }
  const grid = el("div", { class: "agents-grid" });
  for (const [name, [title, sub]] of Object.entries(AGENT_TITLES)) {
    const fs = r.agents[name] || [];
    grid.append(el("section", { class: "agent-card", "aria-label": title },
      el("h3", { text: title }), el("p", { class: "muted", text: sub }),
      fs.length ? el("ul", { class: "findings" }, ...fs.map(findingNode)) : el("p", { class: "muted", text: "No findings." })));
  }
  out.append(grid);
  const json = JSON.stringify(r, null, 2);
  const copy = el("button", { type: "button", class: "secondary", text: "Copy JSON report" });
  copy.addEventListener("click", () => navigator.clipboard?.writeText(json).then(() => { copy.textContent = "Copied"; }));
  const raw = el("details", {}, el("summary", { text: "Machine-readable report (JSON)" }), el("pre", { text: json }));
  out.append(copy, raw);
  const machine = document.querySelector("#report-json");
  if (machine) machine.textContent = json;
  out.focus();
}

function renderContacts(contacts) {
  const ul = document.querySelector("#contacts");
  if (!ul) return;
  ul.replaceChildren(...contacts.slice(-12).map((c) => el("li", { text: `${c.at.slice(11, 19)} GET ${c.url.replace(/^https:\/\//, "").slice(0, 90)} → ${c.outcome}` })));
}

export class App {
  static page = null;

  static start() {
    const consent = new ConsentGate(askWithDialog);
    const service = setService(new TruthCheckService({
      fetchFn: (...a) => window.fetch(...a),
      consent: (o, p) => consent.allow(o, p),
    }));
    App.page = new Page(service);
    service.onReport((r) => App.page.show(r));
    service.readPage = () => App.page.getState();
    const form = document.querySelector("#check-form");
    const status = document.querySelector("#check-status");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = document.querySelector("#listing-url").value.trim();
      const text = document.querySelector("#listing-text").value;
      if (!url && !text.trim()) { status.textContent = "Give a listing URL or paste its text."; return; }
      status.textContent = "Checking… payer, already-done and trap checks are reading the listing.";
      form.querySelector("button[type=submit]").disabled = true;
      try {
        const r = await App.page.checkAndShow({ url: url || undefined, text: text || undefined });
        status.textContent = `Verdict: ${r.verdict.label}.`;
      } catch (error) {
        status.textContent = `The check failed: ${error.message}`;
        console.error(error);
      } finally {
        form.querySelector("button[type=submit]").disabled = false;
      }
    });
    const samples = document.querySelector("#samples");
    for (const s of SAMPLES) {
      const b = el("button", { type: "button", class: "secondary", text: s.title });
      b.addEventListener("click", () => {
        document.querySelector("#listing-url").value = "";
        document.querySelector("#listing-text").value = s.text;
        form.requestSubmit();
      });
      samples.append(b);
    }
    const netUrl = document.querySelector("#network-url");
    if (netUrl) netUrl.textContent = new URL("bounty_truth_check", new URL("../", import.meta.url)).href;
    const params = new URLSearchParams(location.search);
    if (params.get("url")) {
      document.querySelector("#listing-url").value = params.get("url");
      form.requestSubmit();
    }
    registerWebMcp(getService);
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.querySelector("#check-form")) {
  App.start();
}
