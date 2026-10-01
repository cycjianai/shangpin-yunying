#!/usr/bin/env node
/**
 * Recompute & Standardize MiniCheng Operations Table and Ledger
 * Fixes:
 * 1. Rule 35 Gifts: 100% negative/non-gift options ("不赠送", "不赠", "无", "普通包装")
 * 2. Non-Clothing Cotton: Fixes beer, socks, electronics mislabeled with "棉100%"
 * 3. Naked Units: Standardizes net content (g/ml), shelf life (天), wort (°P), alcohol (%vol), length (m)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, '../../../artifacts');
const JSON_FILE = path.join(ARTIFACTS_DIR, 'minicheng_operation_table.json');
const CSV_FILE = path.join(ARTIFACTS_DIR, 'minicheng_operation_table.csv');
const CSV_LATEST = path.join(ARTIFACTS_DIR, 'minicheng_operation_table_latest.csv');
const LEDGER_FILE = path.join(ARTIFACTS_DIR, 'minicheng_progress_ledger.jsonl');

function isClothingCategory(title) {
  return /服装|内衣|睡衣|外套|卫衣|裤|袜|T恤|裙|泳衣|保暖衣|文胸|毛衣|大衣|风衣|服饰|家纺|床单|被套|毛巾/i.test(title);
}

function extractNetContent(title) {
  const volMatch = title.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|L|升|g|克|kg|千克|斤)/i);
  if (volMatch) {
    let num = parseFloat(volMatch[1]);
    let unit = volMatch[2].toLowerCase();
    if (unit === 'l' || unit === '升') return `${num * 1000}ml`;
    if (unit === 'kg' || unit === '千克') return `${num * 1000}g`;
    if (unit === '斤') return `${num * 500}g`;
    if (unit === '毫升') return `${num}ml`;
    if (unit === '克') return `${num}g`;
    return `${num}${unit}`;
  }
  const countMatch = title.match(/(\d+)\s*(抽|片|支|粒|双|对|只|个|包|袋|盒|桶|罐|瓶|份)/);
  if (countMatch) {
    return `${countMatch[1]}${countMatch[2]}`;
  }
  return null;
}

function extractWort(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(°P|度|P)/i);
  if (m) return `${m[1]}°P`;
  return '8°P';
}

function extractAlcohol(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(%vol|度|%|vol)/i);
  if (m) {
    const num = parseFloat(m[1]);
    return `≥${num}%vol`;
  }
  return '≥4.3%vol';
}

function extractLength(title) {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(m|米)/i);
  if (m) {
    const val = parseFloat(m[1]);
    const clamped = Math.min(val, 5);
    return `${clamped}m`;
  }
  return '1.5m';
}

function extractDenier(title) {
  const m = title.match(/(\d+)\s*(d|D)/);
  if (m) return `${m[1]}D`;
  return '80D';
}

function extractDimensions(title) {
  const m = title.match(/(\d+)\s*[*×xX]\s*(\d+)\s*(cm|mm|m)?/);
  if (m) {
    const unit = m[3] || 'cm';
    return `${m[1]}${unit}*${m[2]}${unit}`;
  }
  return '150cm*200cm';
}

function sanitizeAttrPair(k, v, title) {
  let key = k.trim();
  let val = v.trim();

  // 1. Rule 35 Gifts: 100% negative/non-gift values
  if (/是否赠开瓶器/i.test(key)) {
    val = '不赠送';
  } else if (/是否赠杯子/i.test(key)) {
    val = '不赠杯子';
  } else if (/赠品|附赠|礼品/i.test(key)) {
    val = '无赠品';
  } else if (/吸管/i.test(key)) {
    val = '无吸管';
  } else if (/餐具/i.test(key)) {
    val = '无餐具';
  } else if (/礼袋|原厂礼袋/i.test(key)) {
    val = '无礼袋';
  } else if (/是否礼盒/i.test(key)) {
    val = '非礼盒装';
  } else if (/提供礼赠包装/i.test(key)) {
    val = '普通包装';
  } else if (/包装方式|包装形式/i.test(key)) {
    if (/礼盒|礼袋|定制/.test(val)) {
      if (/箱/.test(title)) val = '箱装';
      else if (/瓶/.test(title)) val = '瓶装';
      else if (/袋|包/.test(title)) val = '袋装';
      else if (/盒/.test(title)) val = '盒装';
      else if (/罐|听/.test(title)) val = '罐装';
      else val = '普通包装';
    }
  }

  // 2. Cotton / Fabric Corrections for Non-Clothing
  const isCloth = isClothingCategory(title);
  if (!isCloth) {
    if (/麦汁浓度/i.test(key)) {
      val = extractWort(title);
    } else if (/酒精度|酒精含量/i.test(key)) {
      val = extractAlcohol(title);
    } else if (/单规格容量|单件容量|主杯容量|^容量$/i.test(key)) {
      val = extractNetContent(title) || '500ml';
    } else if (/线长|电源线长|全长/i.test(key)) {
      val = extractLength(title);
    } else if (/丹尼数/i.test(key)) {
      val = extractDenier(title);
    } else if (/^尺寸$/i.test(key)) {
      val = extractDimensions(title);
    } else if (/面料成分|面料/i.test(key)) {
      val = '常规';
    } else if (/棉100%|棉/i.test(val)) {
      val = '常规';
    }
  }

  // 3. Units for Naked Numbers
  if (/净含量/i.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      const extracted = extractNetContent(title);
      if (extracted) {
        val = extracted;
      } else {
        const isLiquid = /水|饮|酒|汁|液|露|乳|油|洗|喷雾|瓶|听|罐/i.test(title);
        val = val + (isLiquid ? 'ml' : 'g');
      }
    }
  } else if (/保质期/i.test(key)) {
    if (/^\d+$/.test(val)) {
      val = `${val}天`;
    }
  } else if (/麦汁浓度/i.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      val = `${val}°P`;
    }
  } else if (/酒精度|酒精含量/i.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      val = `≥${val}%vol`;
    }
  } else if (/线长|电源线长|全长/i.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      val = `${val}m`;
    }
  } else if (/丹尼数/i.test(key)) {
    if (/^\d+$/.test(val)) {
      val = `${val}D`;
    }
  } else if (/容量/i.test(key) && !/存储/.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      const extracted = extractNetContent(title);
      val = extracted || `${val}ml`;
    }
  } else if (/重量/i.test(key)) {
    if (/^\d+(?:\.\d+)?$/.test(val)) {
      const extracted = extractNetContent(title);
      val = extracted || `${val}g`;
    }
  }

  return `${key}=${val}`;
}

function sanitizeSummary(rawSummary, title) {
  if (!rawSummary || rawSummary.startsWith('处理异常')) return rawSummary;

  // Pattern: "美团:[...] | 淘宝闪购:[...]"
  const parts = rawSummary.split(/\s*\|\s*/);
  const newParts = [];

  for (const part of parts) {
    const match = part.match(/^([^:：]+)[:：]\[(.*)\]$/);
    if (!match) {
      newParts.push(part);
      continue;
    }
    const platform = match[1];
    const attrsStr = match[2];
    if (!attrsStr) {
      newParts.push(`${platform}:无`);
      continue;
    }

    // Split pairs: key=value
    // Note: values might contain commas or other chars
    const rawPairs = attrsStr.split(/,\s*/);
    const sanitizedPairs = [];

    for (const p of rawPairs) {
      const eqIdx = p.indexOf('=');
      if (eqIdx === -1) {
        sanitizedPairs.push(p);
        continue;
      }
      const k = p.slice(0, eqIdx);
      const v = p.slice(eqIdx + 1);
      sanitizedPairs.push(sanitizeAttrPair(k, v, title));
    }

    newParts.push(`${platform}:[${sanitizedPairs.join(', ')}]`);
  }

  return newParts.join(' | ');
}

function main() {
  console.log(`=== MiniCheng Operations Table Offline Recomputation & Standardization ===`);

  if (!fs.existsSync(JSON_FILE)) {
    console.error(`Operation table file not found: ${JSON_FILE}`);
    process.exit(1);
  }

  const table = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
  console.log(`Loaded ${table.length} rows from ${JSON_FILE}`);

  function auditTable(tbl) {
    let gifts = 0, cotton = 0, nakedNet = 0, nakedShelf = 0;
    for (const r of tbl) {
      const t = r['填入内容'] || '';
      const pairs = t.match(/[^,\s\[\]:]+=[^,\s\[\]]+/g) || [];
      for (const p of pairs) {
        const [k, v] = p.split('=');
        if (/赠|送|附赠|开瓶器|杯子|吸管|餐具|封口夹|礼袋|礼盒|赠品|礼赠/.test(k)) {
          if (!/非礼盒|不赠|无|普通|常规|否/.test(v)) {
            if (/^(?:是|有|赠送|赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|带吸管|带餐具|带杯套|礼盒包装|礼盒装|定制礼盒装|礼盒|礼袋装)$/.test(v) ||
                /(?:赠开瓶器|赠一次性纸杯|赠封口夹|赠礼袋|^礼盒装$|定制礼盒装|礼袋装)/.test(v)) {
              gifts++;
            }
          }
        }
        if (/棉100%/.test(v) && !isClothingCategory(r['商品名称'])) {
          cotton++;
        }
        if (/净含量|容量|重量/.test(k) && !/存储/.test(k)) {
          if (/^\d+(?:\.\d+)?$/.test(v)) {
            nakedNet++;
          }
        }
        if (/保质期/.test(k)) {
          if (/^\d+$/.test(v)) {
            nakedShelf++;
          }
        }
      }
    }
    return { gifts, cotton, nakedNet, nakedShelf };
  }

  // Pre-audit counts
  const pre = auditTable(table);
  console.log(`Pre-audit counts:`);
  console.log(`  - Affirmative Gift violations: ${pre.gifts}`);
  console.log(`  - Misassigned cotton: ${pre.cotton}`);
  console.log(`  - Naked net content / capacity / weight: ${pre.nakedNet}`);
  console.log(`  - Naked shelf life: ${pre.nakedShelf}`);

  // Recompute
  const updatedTable = [];
  const ledgerMap = new Map();

  for (const row of table) {
    const title = row['商品名称'];
    const spu = row['spu'];
    const status = row['状态'];
    const rawContent = row['填入内容'];

    const sanitizedContent = sanitizeSummary(rawContent, title);

    const updatedRow = {
      ...row,
      '填入内容': sanitizedContent
    };
    updatedTable.push(updatedRow);

    // Save to ledger map
    ledgerMap.set(String(spu), {
      商品名称: title,
      spu,
      填入内容: sanitizedContent,
      状态: status,
      skuId: spu,
      updatedAt: new Date().toISOString()
    });
  }

  // Post-audit counts
  const post = auditTable(updatedTable);
  console.log(`\nPost-audit counts:`);
  console.log(`  - Affirmative Gift violations: ${post.gifts}`);
  console.log(`  - Misassigned cotton: ${post.cotton}`);
  console.log(`  - Naked net content / capacity / weight: ${post.nakedNet}`);
  console.log(`  - Naked shelf life: ${post.nakedShelf}`);

  // Export JSON
  fs.writeFileSync(JSON_FILE, JSON.stringify(updatedTable, null, 2), 'utf-8');
  console.log(`\n[Export] Updated JSON: ${JSON_FILE}`);

  // Export CSV
  const csvHeaders = ['商品名称', 'spu', '填入内容', '状态'];
  const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
  const csvLines = [
    '\uFEFF' + csvHeaders.map(escapeCsv).join(','),
    ...updatedTable.map(r => [
      escapeCsv(r['商品名称']),
      escapeCsv(r['spu']),
      escapeCsv(r['填入内容']),
      escapeCsv(r['状态'])
    ].join(','))
  ];

  try {
    fs.writeFileSync(CSV_FILE, csvLines.join('\r\n'), 'utf-8');
    console.log(`[Export] Updated CSV: ${CSV_FILE}`);
  } catch (e) {
    console.warn(`Could not overwrite ${CSV_FILE} (${e.message}), writing latest...`);
  }
  fs.writeFileSync(CSV_LATEST, csvLines.join('\r\n'), 'utf-8');
  console.log(`[Export] Updated Latest CSV: ${CSV_LATEST}`);

  // Export Ledger
  if (fs.existsSync(LEDGER_FILE)) {
    const ledgerLines = Array.from(ledgerMap.values()).map(x => JSON.stringify(x));
    fs.writeFileSync(LEDGER_FILE, ledgerLines.join('\n') + '\n', 'utf-8');
    console.log(`[Export] Synchronized progress ledger: ${LEDGER_FILE}`);
  }

  console.log(`\n=== Recomputation Successfully Completed! ===`);
}

main();
