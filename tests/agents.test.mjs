// Runs the agent network in the reference runtime with a scripted model (no LLM, offline)
// and checks that the agents call the site's tools and get real check results.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ActionRegistry } from "../site/runtime/actions.js";
import { AgentNetwork } from "../site/runtime/kernel.js";
import { buildToolTable, dispatchToolCall, runAgent } from "../site/runtime/runner.js";
import { TraceBus } from "../site/runtime/trace.js";
import { registerActions } from "../site/site-actions.js";
import { setService } from "../site/js/service.js";
import { TruthCheckService } from "../site/js/pipeline.js";
import { SAMPLES } from "../site/js/samples.js";
import { ScriptedModel } from "./scripted_model.mjs";
import { NOW, fakeFetch, urlOf } from "./fixtures/github.mjs";

const BASE = "http://localhost:8080";
const NAME = "bounty_truth_check";
const scope = { base: BASE, network: NAME };
const site = new URL("../site/", import.meta.url);

async function setup(model) {
  const config = JSON.parse(await readFile(new URL(`${NAME}.network.json`, site), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("agent-manifest.json", site), "utf8"));
  const network = new AgentNetwork(config, NAME);
  const registry = new ActionRegistry();
  await registerActions({ register: registry.register.bind(registry, scope) });
  const ctx = {
    network, manifest, actions: registry, baseOrigin: BASE, displayOrigin: "localhost:8080",
    trace: new TraceBus(), isTop: true, frontMan: network.findFrontMan(), history: [], llm: model,
    confirmWebsiteActions: async () => true,
  };
  return { ctx, network };
}

const published = [];
setService(new TruthCheckService({ fetchFn: fakeFetch(), consent: async () => true, now: () => NOW }));

test("front agent is offered the website tools and the three specialists", async () => {
  const model = new ScriptedModel([{ text: "ok" }]);
  const { ctx } = await setup(model);
  await runAgent(ctx, ctx.frontMan, "hello", null, []);
  const names = model.toolNames(0);
  for (const n of ["website_run_full_check", "website_check_payer", "website_scan_traps", "payer_verifier", "already_done_detector", "trap_detector"]) {
    assert.ok(names.some((x) => x.includes(n)), `${n} in ${names.join(",")}`);
  }
});

test("judge runs website_run_full_check on a GitHub issue and gets the real verdict", async (t) => {
  const model = new ScriptedModel([
    { tool: "website_run_full_check", arguments: { url: urlOf("awarded") } },
    { text: "Verdict: Do not work on this (REJECTED)" },
  ]);
  const { ctx } = await setup(model);
  const result = await runAgent(ctx, ctx.frontMan, `Is this real? ${urlOf("awarded")}`, null, []);
  const receipt = model.toolResults(1)[0];
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.verdict.status, "REJECTED");
  assert.ok(receipt.result.agents.already_done_detector.some((f) => f.id === "already_awarded"));
  assert.match(result.text, /REJECTED/);
  t.diagnostic(`system prompt ${model.calls[0].messages[0].content.length} chars, tools ${JSON.stringify(model.calls[0].tools).length} chars`);
});

test("judge delegates to the trap_detector agent, which calls website_scan_traps", async () => {
  const text = SAMPLES.find((s) => s.id === "sample-honeypot").text;
  const model = new ScriptedModel([
    { tool: "trap_detector", arguments: { request: text } },
    { tool: "website_scan_traps", arguments: { text } },
    { text: "reject: prompt_exfiltration" },
    { text: "Verdict: Do not work on this" },
  ]);
  const { ctx } = await setup(model);
  const toolName = model.steps[0].tool;
  const r = await runAgent(ctx, ctx.frontMan, "check this", null, []);
  const scan = model.toolResults(2)[0];
  assert.equal(scan.status, "succeeded", JSON.stringify(scan));
  assert.ok(scan.result.findings.some((f) => f.id === "prompt_exfiltration"));
  assert.match(r.text, /Do not work/);
  assert.equal(toolName, "trap_detector");
});

test("calling a tool without url or text is refused without contacting anything", async () => {
  const model = new ScriptedModel([]);
  const { ctx, network } = await setup(model);
  const table = await buildToolTable(ctx, network.getAgentSpec(ctx.frontMan), [], null);
  const entry = table.toolByName.get("website_run_full_check");
  const receipt = await dispatchToolCall(ctx, entry, {}, null, []);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.ok, false);
});

test("schema rejects unknown arguments (fail closed)", async () => {
  const { ctx, network } = await setup(new ScriptedModel([]));
  const table = await buildToolTable(ctx, network.getAgentSpec(ctx.frontMan), [], null);
  const entry = table.toolByName.get("website_scan_traps");
  await assert.rejects(dispatchToolCall(ctx, entry, { url: "x", run: "rm -rf /" }, null, []), /Unexpected arguments\.run/);
});
