// Holds the one TruthCheckService of this page. The page (app.js) installs the browser
// service at startup; Node tests install one with a recorded fetch. The site actions and
// WebMCP tools read it from here, so every caller shares one cache and one consent record.
let current = null;

export function setService(service) {
  current = service;
  return service;
}

export function getService() {
  if (!current) throw new Error("Bounty Truth Check service is not ready yet.");
  return current;
}
