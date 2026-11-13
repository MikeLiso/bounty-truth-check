// Checks the public files against the Open Agentic Web MVP spec (sections 2, 3.3, 4)
// with the reference runtime's own parser and validator. Offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { parseHocon } from "../site/runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../site/runtime/kernel.js";
import { ActionRegistry } from "../site/runtime/actions.js";
import { registerActions } from "../site/site-actions.js";

const site = new URL("../site/", import.meta.url);
const readJson = async (p) => JSON.parse(await readFile(new URL(p, site), "utf8"));

test("manifest names the network, its front agent and the resolved JSON definition", async () => {
  const m = await readJson("agent-manifest.json");
  assert.equal(m.networks.length, 1);
  const n = m.networks[0];
  assert.equal(n.name, "bounty_truth_check");
  assert.equal(n.front_man, "bounty_truth_judge");
  assert.equal(n.hocon, "./bounty_truth_check.network.json");
  assert.equal(m.deployment.mode, "static");
  assert.equal(m.peer_policy.mode, "closed");
  assert.match(m.llm_router.base_url, /^https:\/\//);
  assert.equal(m.llm_router.mock, false);
});

test("network JSON is data-only, valid for the reference runtime, and has >= 2 agents", async () => {
  const cfg = await readJson("bounty_truth_check.network.json");
  const net = new AgentNetwork(cfg, "bounty_truth_check");
  assert.deepEqual(validateNetwork(net).errors, []);
  assert.equal(net.findFrontMan(), "bounty_truth_judge");
  assert.equal(cfg.tools.length, 4);
  for (const a of cfg.tools) {
    assert.ok(a.name && a.function?.description && a.instructions, a.name);
    assert.equal(a.function.parameters.type, "object");
    assert.ok(Array.isArray(a.tools));
  }
  const text = JSON.stringify(cfg);
  assert.ok(!/\$\{|include\s*"|"class"\s*:|toolbox|demo_mode/.test(text), "no substitutions, includes, coded tools or demo mode");
});

test("published JSON is exactly what the .hocon source builds (build --check passes)", () => {
  execFileSync(process.execPath, [
    new URL("../tools/build_network.mjs", import.meta.url).pathname,
    new URL("bounty_truth_check.hocon", site).pathname,
    "--manifest", new URL("agent-manifest.json", site).pathname,
    "--runtime", new URL("runtime", site).pathname,
    "--check",
  ], { stdio: "pipe" });
});

test("hocon source parses with the runtime's own HOCON parser", async () => {
  const parsed = parseHocon(await readFile(new URL("bounty_truth_check.hocon", site), "utf8"));
  assert.equal(parsed.tools[0].name, "bounty_truth_judge");
});

test("links.json and discovery files are present and consistent", async () => {
  const links = await readJson("links.json");
  assert.equal(links.version, 1);
  assert.ok(links.networks.bounty_truth_check);
  const wk = await readJson(".well-known/nsdeploy.json");
  assert.ok(JSON.stringify(wk).includes("bounty_truth_check"));
  const mcp = await readJson("agent-mcp.json");
  assert.equal(mcp.available, false);
});

test("every agentTools action is registered; none is irreversible; only one write", async () => {
  const m = await readJson("agent-manifest.json");
  const reg = new ActionRegistry();
  const scope = { base: "http://localhost:8080", network: "bounty_truth_check" };
  await registerActions({ register: reg.register.bind(reg, scope) });
  const cat = reg.catalog(scope);
  const names = cat.map((e) => e.name);
  for (const t of m.actions.agentTools) assert.ok(names.includes(t), t);
  assert.deepEqual(cat.filter((e) => e.effect !== "read").map((e) => e.name), ["show_report_on_page"]);
  assert.ok(cat.every((e) => e.effect !== "irreversible"));
});

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const p = new URL(name, dir);
    if ((await stat(p)).isDirectory()) yield* walk(new URL(`${name}/`, dir));
    else yield p;
  }
}

test("no secrets or keys in any published file", async () => {
  const bad = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|xox[bp]-|-----BEGIN [A-Z ]*PRIVATE KEY)/;
  for await (const f of walk(site)) {
    const t = await readFile(f, "utf8").catch(() => "");
    assert.ok(!bad.test(t), f.pathname);
  }
});

test("index.html has the runtime mount slots, a key-free checker and loads modules", async () => {
  const html = await readFile(new URL("index.html", site), "utf8");
  for (const s of ['data-ns-slot="header"', 'data-ns-slot="chat"', 'data-ns-slot="agents"', 'data-ns-slot="settings"', 'id="check-form"', 'src="site.js"', 'src="js/app.js"']) assert.ok(html.includes(s), s);
  assert.ok(!/<script(?![^>]*type="(module|application\/json|application\/ld\+json)")[^>]*>/.test(html), "only module, JSON or JSON-LD scripts");
});
