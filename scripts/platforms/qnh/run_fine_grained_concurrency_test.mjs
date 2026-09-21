import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runFineGrainedLevel(tabs, concurrency, offset, limit, name) {
  console.log(`\n======================================================================`);
  console.log(`[CONTROLLED TEST] ${name} -> Tabs: ${tabs}, Concurrency: ${concurrency} (Sample: ${limit} SPUs)`);
  console.log(`======================================================================`);

  const scriptPath = path.resolve(__dirname, 'execute_mass_spu_cleaning.mjs');
  const args = [
    scriptPath,
    `--tabs=${tabs}`,
    `--concurrency=${concurrency}`,
    `--offset=${offset}`,
    `--limit=${limit}`,
    '--no-resume',
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

    return {
      name,
      tabs,
      concurrency,
      spus: limit,
      elapsedSec: elapsedSec.toFixed(1),
      rateSpuPerMin: rate,
      avgLatencyMs: avgLatency,
      errorCount,
      updatedCount: report.updated_count || 0,
      status: errorCount === 0 ? 'OK' : 'ERROR',
    };
  } catch (err) {
    console.error(`Failed ${name}:`, err.message);
    return {
      name,
      tabs,
      concurrency,
      spus: limit,
      errorCount: limit,
      status: 'FAILED',
      error: err.message.slice(0, 150),
    };
  }
}

async function main() {
  const sampleSize = 30;
  console.log(`Starting Fine-Grained Single-Variable Concurrency Probing (Sample: ${sampleSize} SPUs per level)...`);

  const configs = [
    // 组 1：固定 3 标签页，并发从 9 渐进到 12
    { tabs: 3, concurrency: 9, name: '【组1-基准】3 Tabs / 9 并发' },
    { tabs: 3, concurrency: 11, name: '【组1-微调】3 Tabs / 11 并发' },
    { tabs: 3, concurrency: 12, name: '【组1-微调】3 Tabs / 12 并发' },

    // 组 2：固定 9 并发，单加标签页（测试 3 Tabs vs 4 Tabs）
    { tabs: 4, concurrency: 9, name: '【组2-控并发加页】4 Tabs / 9 并发' },

    // 组 3：固定 4 标签页，细粒度测试 10, 11, 12, 14, 16 并发
    { tabs: 4, concurrency: 10, name: '【组3-4页微调】4 Tabs / 10 并发' },
    { tabs: 4, concurrency: 11, name: '【组3-4页微调】4 Tabs / 11 并发' },
    { tabs: 4, concurrency: 12, name: '【组3-4页微调】4 Tabs / 12 并发' },
    { tabs: 4, concurrency: 14, name: '【组3-4页微调】4 Tabs / 14 并发' },
  ];

  const results = [];
  let currentOffset = 4200; // start after current checkpoint

  for (const cfg of configs) {
    const res = await runFineGrainedLevel(cfg.tabs, cfg.concurrency, currentOffset, sampleSize, cfg.name);
    results.push(res);
    currentOffset += sampleSize;
  }

  console.log(`\n======================================================================`);
  console.log(`🔬 控制变量细粒度压测结果表 🔬`);
  console.log(`======================================================================`);
  console.table(results.map(r => ({
    测试组: r.name,
    标签页: r.tabs,
    并发: r.concurrency,
    '跑速(SPU/分)': r.rateSpuPerMin || 0,
    '平均延迟(ms)': r.avgLatencyMs || 'N/A',
    '耗时(秒)': r.elapsedSec || 'N/A',
    错误数: r.errorCount,
    状态: r.status,
  })));

  const runDir = path.resolve(__dirname, '../../../runs/qnh-run-1');
  const outPath = path.join(runDir, 'fine_grained_concurrency_results.json');
  await fs.writeFile(outPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`Detailed results saved to: ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error in fine-grained benchmark:', err);
    process.exit(1);
  });
