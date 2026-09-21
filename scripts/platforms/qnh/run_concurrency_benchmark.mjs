import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest(tabs, concurrency, offset, limit) {
  console.log(`\n==================================================`);
  console.log(`[BENCHMARK] Testing configuration: ${tabs} Tabs, ${concurrency} Concurrency (${limit} SPUs)`);
  console.log(`==================================================`);

  const scriptPath = path.resolve(__dirname, 'execute_mass_spu_cleaning.mjs');
  const args = [
    scriptPath,
    `--tabs=${tabs}`,
    `--concurrency=${concurrency}`,
    `--offset=${offset}`,
    `--limit=${limit}`,
    '--no-resume', // Do not use global checkpoint for benchmark slices
  ];

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const elapsedSec = (Date.now() - startTime) / 1000;

    // Read generated report
    const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
    const reportFile = path.join(runDir, 'mass_cleaning_report.json');
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));

    const rate = Math.round((limit / elapsedSec) * 60);
    const avgLatency = report.avg_latency_ms || Math.round((elapsedSec / limit) * 1000);
    const errorCount = report.fail_count || 0;

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
    };
  } catch (err) {
    console.error(`Benchmark failed for ${tabs} tabs / ${concurrency} concurrency:`, err.message);
    return {
      tabs,
      concurrency,
      spus: limit,
      error: err.message,
    };
  }
}

async function main() {
  const sliceSize = 30;
  console.log(`Starting Golden Speed Concurrency Benchmark (Canary size: ${sliceSize} SPUs per test)...`);

  const results = [];

  // Config 1: 1 Tab, 3 Concurrency (Baseline)
  const res1 = await runTest(1, 3, 0, sliceSize);
  results.push(res1);

  // Config 2: 2 Tabs, 6 Concurrency
  const res2 = await runTest(2, 6, sliceSize, sliceSize);
  results.push(res2);

  // Config 3: 3 Tabs, 9 Concurrency
  const res3 = await runTest(3, 9, sliceSize * 2, sliceSize);
  results.push(res3);

  console.log(`\n==================================================`);
  console.log(`🏆 CONCURRENCY BENCHMARK RESULTS SUMMARY 🏆`);
  console.log(`==================================================`);
  console.table(results);

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  const benchReportPath = path.join(runDir, 'concurrency_benchmark_results.json');
  await fs.writeFile(benchReportPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`Benchmark results saved to: ${benchReportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error in benchmark:', err);
    process.exit(1);
  });
