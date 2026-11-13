// Offline tests for listing reading: allow-list, consent, GET-only, fail-closed, normalizers.
import assert from "node:assert/strict";
import test from "node:test";
import { createFetcher, parseListingUrl, readListing } from "../site/js/sources.js";
import { TruthCheckService } from "../site/js/pipeline.js";
import { NOW, SCENARIOS, fakeFetch, urlOf } from "./fixtures/github.mjs";

const allow = async () => true;
const service = (opts = {}) => new TruthCheckService({ fetchFn: fakeFetch(opts.requests), consent: opts.consent || allow, now: () => NOW });

test("parseListingUrl recognizes sources", () => {
  assert.equal(parseListingUrl("https://github.com/a/b/issues/3").kind, "github");
  assert.equal(parseListingUrl("https://github.com/a/b/pull/3").kind, "github");
  assert.equal(parseListingUrl("https://superteam.fun/earn/listing/some-slug/").slug, "some-slug");
  assert.equal(parseListingUrl("https://x.devpost.com/").kind, "devpost");
  assert.equal(parseListingUrl("javascript:alert(1)").kind, "invalid");
  assert.equal(parseListingUrl("not a url").kind, "invalid");
});

test("fetcher refuses origins outside the allow-list without asking or fetching", async () => {
  const requests = [];
  let asked = 0;
  const get = createFetcher({ fetchFn: fakeFetch(requests), consent: async () => { asked++; return true; } });
  await assert.rejects(get("https://evil.example/x"), (e) => e.code === "not_allowed");
  assert.equal(asked, 0);
  assert.equal(requests.length, 0);
});

test("denied consent fails closed: no request, UNKNOWN verdict, visible reason", async () => {
  const requests = [];
  const s = service({ requests, consent: async () => false });
  const r = await s.full({ url: urlOf("healthy") });
  assert.equal(requests.length, 0);
  assert.equal(r.verdict.status, "UNKNOWN");
  assert.equal(r.sourceStatus.ok, false);
  assert.equal(r.sourceStatus.code, "consent_denied");
});

test("requests are GET, without credentials or referrer", async () => {
  const requests = [];
  await service({ requests }).full({ url: urlOf("healthy") });
  assert.ok(requests.length >= 5);
  for (const r of requests) {
    assert.equal(r.init.method, "GET");
    assert.equal(r.init.credentials, "omit");
    assert.equal(r.init.referrerPolicy, "no-referrer");
    assert.ok(!JSON.stringify(r.init.headers).toLowerCase().includes("authorization"));
  }
});

test("one read per listing is shared by all agents (cache)", async () => {
  const requests = [];
  const s = service({ requests });
  const input = { url: urlOf("healthy") };
  await s.specialist("payer_verifier", input);
  const n = requests.length;
  await s.specialist("already_done_detector", input);
  await s.specialist("trap_detector", input);
  await s.full(input);
  assert.equal(requests.length, n);
});

test("GitHub scenarios get the expected verdicts", async () => {
  const s = service();
  const expect = { healthy: "VERIFIED", awarded: "REJECTED", delivered: "REJECTED", bait: "REJECTED" };
  for (const [name, status] of Object.entries(expect)) {
    const r = await s.full({ url: urlOf(name) });
    assert.equal(r.verdict.status, status, `${name}: ${JSON.stringify(r.verdict.decisive.map((f) => f.id))}`);
  }
});

test("merged PR must resolve the issue in the same repo; a mention from a fork does not count", async () => {
  const r = await service().full({ url: urlOf("delivered") });
  const merged = r.agents.already_done_detector.filter((f) => f.id === "delivered_by_merged_pr");
  assert.equal(merged.length, 1);
  assert.match(merged[0].evidence.url, /example-org\/docs-site\/pull\/1082/);
});

test("bait scenario: evidence for each agent", async () => {
  const r = await service().full({ url: urlOf("bait") });
  const all = Object.values(r.agents).flat().map((f) => f.id);
  for (const id of ["prompt_exfiltration", "label_humans_excluded", "repo_new_unknown", "no_merges", "funding_label_only"]) assert.ok(all.includes(id), id);
});

test("Devpost and unknown sources without text ask for pasted text (no proxy)", async () => {
  const r = await readListing({ url: "https://some.devpost.com/" }, async () => { throw new Error("must not fetch"); });
  assert.equal(r.sourceStatus.ok, false);
  assert.equal(r.sourceStatus.code, "unsupported_source");
});

test("Superteam blocked by CORS falls back to pasted text with a note", async () => {
  const s = service();
  const r = await s.full({ url: "https://superteam.fun/earn/listing/abc/", text: "$500 bounty: write docs" });
  assert.equal(r.sourceStatus.ok, true);
  const r2 = await s.full({ url: "https://superteam.fun/earn/listing/abc/" });
  assert.equal(r2.sourceStatus.ok, false);
  assert.equal(r2.sourceStatus.code, "blocked");
});

test("fixtures are marked as synthetic", () => {
  for (const s of Object.values(SCENARIOS)) assert.match(s.owner, /example/);
});

test("failed comment/timeline reads are visible and block a positive verdict (no fail-open)", async () => {
  const base = fakeFetch();
  const flaky = async (url, init) => (/\/(comments|timeline)/.test(url) ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) } : base(url, init));
  const s = new TruthCheckService({ fetchFn: flaky, consent: allow, now: () => NOW });
  const r = await s.full({ url: urlOf("healthy") });
  const ids = r.agents.already_done_detector.map((f) => f.id);
  assert.ok(ids.includes("incomplete_comments") && ids.includes("incomplete_linked pull requests"), ids.join());
  assert.ok(!ids.includes("looks_open"));
  assert.notEqual(r.verdict.status, "VERIFIED");
  assert.ok(!r.agents.payer_verifier.some((f) => f.id === "maintainer_silent"));
});
