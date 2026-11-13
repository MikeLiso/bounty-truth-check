// Registers Bounty Truth Check's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". The names in
// "actions.agentTools" become model tools called website_<name>.
// Every action wraps the page's own check service (js/pipeline.js), so the agents, the
// page form and WebMCP share one set of rules, one cache and one consent record.
// All data access is read-only HTTP GET to public APIs, after the visitor's consent.
import { getService } from "./js/service.js";

const LISTING_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      maxLength: 2000,
      description: "Listing URL from the visitor, such as a GitHub issue, Algora-linked issue or Superteam listing.",
    },
    text: {
      type: "string",
      maxLength: 20000,
      description: "Listing text or Superteam details JSON the visitor pasted. Use when the source cannot be read from the browser.",
    },
  },
};

/** Refuse a call with neither url nor text, without contacting anything. */
function missingInput(args) {
  if (!args.url && !(args.text || "").trim()) {
    return { ok: false, reason: "Give the listing URL or its pasted text.", field: "url" };
  }
  return null;
}

class SiteActions {
  static registerActions(actions) {
    for (const def of SiteActions.definitions()) actions.register(def);
  }

  static specialistAction(name, agent, description) {
    return {
      name,
      description,
      effect: "read",
      inputSchema: LISTING_INPUT,
      async execute(args) {
        return missingInput(args) || { ok: true, ...(await getService().specialist(agent, args)) };
      },
    };
  }

  static definitions() {
    return [
      {
        name: "get_page_state",
        description: "Read what the Bounty Truth Check page shows: the URL in the form, the report on screen (verdict, findings), contacted origins and the sample listings. Changes nothing.",
        effect: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute() {
          const s = getService();
          return s.readPage ? s.readPage() : { shownReport: s.lastReport, note: "No page attached." };
        },
      },
      SiteActions.specialistAction(
        "check_payer",
        "payer_verifier",
        "Payer verifier evidence: how the reward is funded (platform record vs label only), sponsor verification, public payout history ('has been awarded' comments), repository age/stars/activity and maintainer activity. Read-only; reads public APIs after the visitor's consent. Returns findings with severity and evidence.",
      ),
      SiteActions.specialistAction(
        "check_already_done",
        "already_done_detector",
        "Already-done detector evidence: closed or assigned, reward already awarded, merged pull request that resolves it, deadline, competing pull requests/claims, dead review path. Read-only. Returns findings with severity and evidence.",
      ),
      SiteActions.specialistAction(
        "scan_traps",
        "trap_detector",
        "Trap detector evidence: star/follow farming, run-our-code or attach-generated-artifact, prompt or secret exfiltration, fake or unverifiable escrow, humans-excluded honeypots, deposits, token promos, required crypto payments. Read-only. Returns findings with severity and quotes.",
      ),
      {
        name: "run_full_check",
        description: "Run all three checks and the deterministic judge. Returns verdict.status (VERIFIED, UNVERIFIED, HIGH_RISK, REJECTED, UNKNOWN), trustScore, decisive findings and every agent's findings. Read-only; does not change the page.",
        effect: "read",
        inputSchema: LISTING_INPUT,
        async execute(args) {
          return missingInput(args) || { ok: true, ...(await getService().full(args)) };
        },
      },
      {
        name: "show_report_on_page",
        description: "Show the full check report for a listing in the page's report panel, replacing the report shown now. Call only when the visitor asks to see it on the page. Returns the verdict.",
        effect: "write",
        inputSchema: LISTING_INPUT,
        async execute(args) {
          const missing = missingInput(args);
          if (missing) return missing;
          const s = getService();
          const report = await s.full(args);
          const shown = s.publish(report);
          return { ok: true, shown, verdict: { status: report.verdict.status, label: report.verdict.label } };
        },
      },
    ];
  }
}

export const registerActions = SiteActions.registerActions;
export const definitions = SiteActions.definitions;
