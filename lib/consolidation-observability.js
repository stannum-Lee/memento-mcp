let lastConsolidation = null;
let lastConsolidateRun = null;

export function recordConsolidationResult(result = {}) {
  const timestamp = new Date().toISOString();
  lastConsolidation = { timestamp, ...result };
  lastConsolidateRun = timestamp;
  return lastConsolidation;
}

export function recordConsolidateRun(timestamp = new Date().toISOString()) {
  lastConsolidateRun = timestamp;
  return lastConsolidateRun;
}

export function getLastConsolidation() {
  return lastConsolidation;
}

export function getLastConsolidateRun() {
  return lastConsolidateRun;
}
