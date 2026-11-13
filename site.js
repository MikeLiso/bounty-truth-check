// Mounts the LLM assistant (the agent network) in the page, with the visitor's own
// router and key (BYOK). The page's own checker works without it.
// This site has no irreversible actions, so the runtime's own dialog is never needed;
// every website_* tool only reads public data, except show_report_on_page, which only
// replaces the report panel the visitor can see.
export class AssistantMount {
  static GREETING = "Paste a bounty or paid-task link (or its text) and I'll ask my three specialist agents, the payer verifier, the already-done detector and the trap detector, then give you a verdict with evidence.";

  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      const needsKey = !booted.engine.mockLLM && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "The agent chat needs your own LLM key: open “BYOK / router settings” below. The checker above works without a key."
        : "Agent network connected. Your key stays in this browser and goes only to the router you chose.";
      if (!needsKey) {
        const first = document.querySelector("#ns-msgs .ns-msg.bot");
        if (first) first.textContent = AssistantMount.GREETING;
      }
      return booted.engine;
    } catch (error) {
      status.textContent = "The agent chat could not load. The checker above still works.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }
}

if (typeof window !== "undefined") {
  await AssistantMount.start();
}
