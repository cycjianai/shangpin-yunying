import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTestLevel(tabs, concurrency, offset, limit) {
  console.log(`\n======================================================================`);
  console.log(`[STRESS TEST] Probing: ${tabs} Tabs, ${concurrency} Concurrency (Sample: ${limit} SPUs)`);
  console.log(`======================================================================`);

  const scriptPath = path.resolve(__dirname, 'execute_mass_spu_cleaning.mjs');
  const args = [
    scriptPath,
    `--tabs=${tabs}`,
    `--concurrency=${concurrency}`,
    `--offset=${offset}`,
    `--limit=${limit}`,
    '--no-resume', // Do not pollute or use the main checkpoint
  ];

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    const elapsedSec = (Date.now() - startTime) / 1000;

    const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
    const reportFile = path.join(runDir, 'mass_cleaning_report.json');
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));

    const rate = Math.round((limit / elapsedSec) * 60);
    const avgLatency = report.avg_latency_ms || Math.round((elapsedSec / limit) * 1000);
    const errorCount = report.fail_count || 0;
    const failures = report.failures || [];

    return {
      tabs,
      concurrency,
      spus: limit,
      elapsedSec: elapsedSec.toFixed(1),
      rateSpuPerMin: rate,
      avgLatencyMs: avgLatency,
      errorCount,
      successCount: report.success_count || 0,
      updatedCount: report.updated_count || 0,
      failures: failures.slice(0, 3).map(f => `${f.spuId}: ${f.error}`),
      status: errorCount === 0 ? 'STABLE' : 'UNSTABLE',
    };
  } catch (err) {
    console.error(`Crash/Error under ${tabs} tabs / ${concurrency} concurrency:`, err.message);
    return {
      tabs,
      concurrency,
      spus: limit,
      errorCount: limit,
      status: 'CRASHED',
      error: err.message.slice(0, 200),
    };
  }
}

async function main() {
  const sampleSize = 40;
  console.log(`Starting Extreme Concurrency & Tab Stress Test (Sample size: ${sampleSize} SPUs per level)...`);

  const testConfigs = [
    { tabs: 4, concurrency: 16 },
    { tabs: 5, concurrency: 20 },
    { tabs: 6, concurrency: 24 },
    { tabs: 6, concurrency: 30 },
  ];

  const results = [];
  let baseOffset = 3000; // start from 3000 to avoid overlap with recent items

  for (const cfg of testConfigs) {
    const res = await runTestLevel(cfg.tabs, cfg.concurrency, baseOffset, sampleSize);
    results.push(res);
    baseOffset += sampleSize;

    // If crashed or error rate > 20%, stop escalating further to protect platform account
    if (res.status === 'CRASHED' || res.errorCount > 8) {
      console.warn(`\n[ALERT] Breaking point reached at ${cfg.tabs} Tabs / ${cfg.concurrency} Concurrency! Halting escalation.`);
      break;
    }
  }

  console.log(`\n======================================================================`);
  console.log(`🏁 EXTREME CONCURRENCY STRESS TEST RESULTS 🏁`);
  console.log(`======================================================================`);
  console.table(results.map(r => ({
    tabs: r.tabs,
    concurrency: r.concurrency,
    rateSpuPerMin: r.rateSpuPerMin || 0,
    avgLatencyMs: r.avgLatencyMs || 'N/A',
    errorCount: r.errorCount,
    status: r.status
  })));

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  const outPath = path.join(runDir, 'extreme_stress_test_results.json');
  await fs.writeFile(outPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`Stress test results saved to: ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error in stress test:', err);
    process.exit(1);
  });
