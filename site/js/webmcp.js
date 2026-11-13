// WebMCP: lets a browser-based AI agent (one that supports the proposed
// navigator.modelContext API) call this page's check as a tool, without an LLM key on
// this site. Feature-detected: when the browser has no WebMCP, nothing happens.
// The same consent dialog guards every contact with a data source.

export const WEBMCP_TOOL = {
  name: "check_bounty_listing",
  description: "Check whether a 'paid task' listing (GitHub/Algora issue, Superteam listing, or pasted text) is real, open and safe. Returns a verdict (VERIFIED, UNVERIFIED, HIGH_RISK, REJECTED, UNKNOWN) with evidence from three agents: payer verifier, already-done detector and trap detector.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Listing URL, e.g. https://github.com/<owner>/<repo>/issues/<n>" },
      text: { type: "string", description: "Listing text, when the source cannot be read from the browser." },
    },
    additionalProperties: false,
  },
};

/** Register the tool when the browser supports WebMCP. Returns true when registered. */
export function registerWebMcp(getService) {
  const mc = typeof navigator !== "undefined" ? navigator.modelContext : undefined;
  if (!mc || typeof mc.registerTool !== "function") return false;
  try {
    mc.registerTool({
      ...WEBMCP_TOOL,
      annotations: { readOnlyHint: true },
      async execute(args) {
        // Read-only: the report is returned, the page is not changed.
        const report = await getService().full({ url: args?.url, text: args?.text });
        return { content: [{ type: "text", text: JSON.stringify({ verdict: report.verdict, sourceStatus: report.sourceStatus, agents: report.agents }) }] };
      },
    });
    return true;
  } catch (error) {
    console.warn("WebMCP registration failed", error);
    return false;
  }
}
