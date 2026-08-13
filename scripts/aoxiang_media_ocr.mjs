#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    output[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return output;
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`);
  return args[name];
}

function extensionFor(url, contentType = "") {
  const pathname = new URL(url).pathname;
  const fromPath = path.extname(pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(fromPath)) return fromPath;
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  return ".jpg";
}

async function exists(filename) {
  try {
    return (await stat(filename)).size > 0;
  } catch {
    return false;
  }
}

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

async function downloadImage(entry, imagesDir) {
  const hash = createHash("sha256").update(entry.url).digest("hex");
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const candidate = path.join(imagesDir, `${hash}${ext}`);
    if (await exists(candidate)) return { ...entry, path: candidate, cached: true };
  }
  const response = await fetch(entry.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download ${response.status}: ${entry.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ext = extensionFor(entry.url, response.headers.get("content-type") || "");
  const filename = path.join(imagesDir, `${hash}${ext}`);
  await writeFile(filename, bytes);
  return { ...entry, path: filename, cached: false, bytes: bytes.length };
}

function runOCR(binary, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, paths, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ocr exit ${code}: ${stderr.trim()}`));
      const records = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      resolve(records);
    });
  });
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

const args = parseArgs(process.argv.slice(2));
const mediaPath = requireArg(args, "media-json");
const checkpointPath = requireArg(args, "checkpoint");
const outDir = requireArg(args, "out-dir");
const ocrBinary = requireArg(args, "ocr-bin");
const fieldPattern = new RegExp(args.fields || "许可证|备案|注册证|酒精度|麦汁浓度");
const downloadConcurrency = Math.max(1, Number(args["download-concurrency"] || 16));
const ocrConcurrency = Math.max(1, Number(args["ocr-concurrency"] || 3));
const chunkSize = Math.max(1, Number(args["ocr-chunk-size"] || 12));

await mkdir(outDir, { recursive: true });
const imagesDir = path.join(outDir, "images");
await mkdir(imagesDir, { recursive: true });

const media = JSON.parse(await readFile(mediaPath, "utf8"));
const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
const selectedSkus = Object.entries(checkpoint.items || {})
  .filter(([, item]) => (item.blockers || []).some((blocker) => fieldPattern.test(blocker.field || "")))
  .map(([skuCode]) => skuCode);

const entries = selectedSkus.flatMap((skuCode) =>
  (media.results?.[skuCode]?.media || []).map((url, mediaIndex) => ({ skuCode, mediaIndex, url })),
);

const downloadErrors = [];
const downloaded = (await mapConcurrent(entries, downloadConcurrency, async (entry) => {
  try {
    return await downloadImage(entry, imagesDir);
  } catch (error) {
    downloadErrors.push({ ...entry, error: String(error?.message || error) });
    return null;
  }
})).filter(Boolean);

let reusedByUrl = {};
if (args["reuse-ocr"]) {
  const previous = JSON.parse(await readFile(args["reuse-ocr"], "utf8"));
  reusedByUrl = Object.fromEntries((previous.records || []).map((record) => [record.url, record]));
}
const pendingDownloaded = downloaded.filter((entry) => !reusedByUrl[entry.url]);
const ocrErrors = [];
const ocrGroups = chunks(pendingDownloaded.map((entry) => entry.path), chunkSize);
const ocrRecords = (await mapConcurrent(ocrGroups, ocrConcurrency, async (group) => {
  try {
    return await runOCR(ocrBinary, group);
  } catch (error) {
    ocrErrors.push({ paths: group, error: String(error?.message || error) });
    return [];
  }
})).flat();
const freshByPath = Object.fromEntries(ocrRecords.map((record) => [record.path, record]));
const combinedRecords = downloaded.map((entry) => {
  const record = reusedByUrl[entry.url] || freshByPath[entry.path] || { observations: [], error: "ocr_record_missing" };
  return {
    ...entry,
    observations: record.observations || [],
    error: record.error || null,
  };
});

const output = {
  schema: "aoxiang-same-product-media-ocr-v1",
  generatedAt: new Date().toISOString(),
  fieldPattern: fieldPattern.source,
  selectedSkus,
  counts: {
    selectedSkus: selectedSkus.length,
    media: entries.length,
    downloaded: downloaded.length,
    downloadErrors: downloadErrors.length,
    ocrRecords: combinedRecords.length,
    reusedOcrRecords: downloaded.length - pendingDownloaded.length,
    freshOcrRecords: ocrRecords.length,
    ocrErrors: ocrErrors.length,
  },
  downloadErrors,
  ocrErrors,
  records: combinedRecords,
};

await writeFile(path.join(outDir, "ocr-evidence.json"), JSON.stringify(output, null, 2));
await writeFile(path.join(outDir, "media-index.json"), JSON.stringify(downloaded, null, 2));
process.stdout.write(`${JSON.stringify(output.counts)}\n`);
