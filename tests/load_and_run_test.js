/**
 * Simple load harness:
 *  - spawns `bgConcurrency` background HTTP workers that repeatedly GET BACKGROUND_PATH for `durationSec`
 *  - spawns `testParallel` child processes that run `integration_test_with_timings.js` concurrently
 *
 * Usage:
 *  node load_and_run_test.js --bgConcurrency 30 --durationSec 60 --testParallel 2
 *
 * Requires: integration_test_with_timings.js to be in same directory and node (>=14)
 */

import { fork } from "child_process";
import fetch from "node-fetch";
import { performance } from "perf_hooks";
import { argv } from "process";

function parseArgs() {
  const out = {};
  for (let i=2;i<argv.length;i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i+1] && !argv[i+1].startsWith("--") ? argv[i+1] : true;
    out[key] = val;
    if (val !== true) i++;
  }
  return out;
}

const args = parseArgs();
const BG_CONCURRENCY = parseInt(args.bgConcurrency || args.bgConcurrency === 0 ? args.bgConcurrency : 20, 10);
const DURATION_SEC = parseInt(args.durationSec || 60, 10);
const BACKGROUND_PATH = args.backgroundPath || "/";
const TEST_PARALLEL = parseInt(args.testParallel || 1, 10);
const SERVER = process.env.SERVER_URL || "http://localhost:3001";

console.log(`Harness config:
  SERVER=${SERVER}
  bgConcurrency=${BG_CONCURRENCY}
  durationSec=${DURATION_SEC}
  backgroundPath=${BACKGROUND_PATH}
  testParallel=${TEST_PARALLEL}
`);

async function bgWorker(id, stopAt, results) {
  // simple loop: GET BACKGROUND_PATH until time up
  while (performance.now() < stopAt) {
    const url = SERVER + BACKGROUND_PATH;
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method: "GET" });
      // read minimal body to avoid leaking connections
      await res.text().catch(()=>{});
      const t1 = performance.now();
      results.push(t1 - t0);
    } catch (e) {
      // treat error as very high latency
      const t1 = performance.now();
      results.push(t1 - t0);
    }
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a,b)=>a-b);
  const idx = Math.ceil((p/100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length-1, idx))];
}

async function runBackgroundTraffic() {
  const results = [];
  const stopAt = performance.now() + DURATION_SEC * 1000;
  console.log(`Starting ${BG_CONCURRENCY} background workers for ${DURATION_SEC}s hitting ${BACKGROUND_PATH}`);
  const workers = [];
  for (let i=0;i<BG_CONCURRENCY;i++) {
    workers.push(bgWorker(i, stopAt, results));
  }
  await Promise.all(workers);
  // compile stats
  const total = results.length;
  const sum = results.reduce((a,b)=>a+b, 0);
  const mean = total ? sum/total : 0;
  const p50 = percentile(results, 50);
  const p90 = percentile(results, 90);
  const p99 = percentile(results, 99);
  return { total, mean, p50, p90, p99, raw: results };
}

function runIntegrationTestsParallel(parallel) {
  // returns array of summaries (parsed METRICS_JSON)
  const promises = [];
  for (let i=0;i<parallel;i++) {
    promises.push(new Promise((resolve) => {
      const child = fork('./integration_test_with_timings.js', [], { env: process.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] , execArgv: [] });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => {
        const s = b.toString();
        process.stdout.write(`[test-${i}] ${s}`);
        out += s;
        // try parse METRICS_JSON line in stream
        const m = out.match(/METRICS_JSON:\s*(\{.*\})/s);
        if (m) {
          try {
            const json = JSON.parse(m[1]);
            // leave process running until it exits; but resolve with json
            resolve({ index: i, json, exitCode: null });
          } catch(e) {
            // ignore parse error for now
          }
        }
      });
      child.stderr.on('data', (b) => {
        const s = b.toString();
        process.stderr.write(`[test-${i}][err] ${s}`);
        err += s;
      });
      child.on('exit', (code) => {
        // if we already resolved with json, return that; else try to parse remaining out
        const m = out.match(/METRICS_JSON:\s*(\{.*\})/s);
        let summary = null;
        if (m) {
          try { summary = JSON.parse(m[1]); } catch(e){}
        }
        resolve({ index: i, json: summary || { ok: false, parseError: true, out: out.slice(0,1000), err: err.slice(0,1000) }, exitCode: code });
      });
    }));
  }
  return Promise.all(promises);
}

(async () => {
  const start = performance.now();

  // start background traffic (run in background promise)
  const bgPromise = runBackgroundTraffic();

  // small delay so background traffic begins before integration tests start
  await new Promise(r=>setTimeout(r, 500));

  // start integration tests in parallel (they will run concurrently with bg traffic)
  const testPromise = runIntegrationTestsParallel(TEST_PARALLEL);

  // wait both
  const [bgStats, testResults] = await Promise.all([bgPromise, testPromise]);

  const end = performance.now();

  console.log("\n===== BACKGROUND TRAFFIC SUMMARY =====");
  console.log(`Requests made: ${bgStats.total}`);
  console.log(`Mean latency ms: ${bgStats.mean.toFixed(2)}`);
  console.log(`p50: ${bgStats.p50.toFixed(2)} ms; p90: ${bgStats.p90.toFixed(2)} ms; p99: ${bgStats.p99.toFixed(2)} ms`);
  console.log(`Wall time: ${(end-start)/1000}s`);

  console.log("\n===== INTEGRATION TEST RESULTS =====");
  testResults.forEach(tr => {
    console.log(`-- test #${tr.index} exitCode=${tr.exitCode}`);
    console.log(JSON.stringify(tr.json, null, 2));
  });

  // aggregate some integration metrics if available
  const successful = testResults.filter(t => t.json && t.json.ok);
  if (successful.length) {
    const totals = successful.map(t => t.json.totalMs);
    const avgTotal = totals.reduce((a,b)=>a+b,0) / totals.length;
    console.log(`\n${successful.length}/${testResults.length} tests succeeded. avg integration test duration: ${avgTotal.toFixed(1)} ms`);
  }

  console.log("\nDone.");
  process.exit(0);
})();