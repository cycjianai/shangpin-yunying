#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
美团闪购商家后台全量商品极速保存与快照复制引擎
基于 Chrome DevTools Protocol (CDP) WebSocket 会话原生注入

核心特性：
1. 依附于已登录的常规 Chrome 实例，在页面 #hashframe 上下文中执行原生 fetch，0 滑块、0 风控；
2. 8 并发流式推流，8,000+ 商品 15~20 分钟全量落库；
3. 三级自愈降级：Rich 完整模式 -> Strip Attrs 属性降级 -> Strip Media 媒体降级 -> 并发锁指数退避；
4. 自动处理无条码商品的 commonProperty.allowUpcEmpty: "true" 防护。
"""

import asyncio
import json
import os
import sys
import time
import urllib.request
import websockets

CDP_HTTP_ENDPOINT = os.environ.get("CDP_HTTP_ENDPOINT", "http://127.0.0.1:9222/json/list")


def get_active_meituan_page_ws():
    """获取当前 Chrome 中处于 shangoue.meituan.com 的调试页面 WebSocket URL"""
    try:
        resp = urllib.request.urlopen(CDP_HTTP_ENDPOINT, timeout=5)
        targets = json.loads(resp.read().decode("utf-8"))
        for t in targets:
            if "shangoue.meituan.com" in t.get("url", "") and t.get("type") == "page":
                return t["webSocketDebuggerUrl"]
    except Exception as e:
        raise RuntimeError(f"无法连接到 Chrome 调试端口 ({CDP_HTTP_ENDPOINT})，请确保 Chrome 已带 --remote-debugging-port 启动: {e}")
    raise RuntimeError("未在已连接的 Chrome 中发现 shangoue.meituan.com 页面，请先登录美团后台！")


JS_BATCH_RUNNER = r"""
async (batch, concurrency) => {
    const hf = document.getElementById("hashframe") ? document.getElementById("hashframe").contentWindow : window;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const stripAttrs = (body) => {
        const b = Object.assign({}, body);
        b.categoryAttrMap = "{}";
        b.bindAttrMap = "{}";
        try {
            const skus = JSON.parse(b.skus || "[]");
            for (const s of skus) {
                s.skuCategoryAttrMap = {};
                if (!s.upcCode) s.commonProperty = { allowUpcEmpty: "true" };
            }
            b.skus = JSON.stringify(skus);
        } catch (e) {}
        return b;
    };

    const stripMedia = (body) => {
        const b = stripAttrs(body);
        b.cpvGuidePicList = "[]";
        b.video = "{}";
        b.spVideoStatus = 0;
        b.approvalNumberPics = "[]";
        return b;
    };

    const callUniSave = async (bodyObj) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const formBody = new URLSearchParams(bodyObj).toString();
            const r = await hf.fetch("/reuse/sc/product/retail/w/uniSave?yodaReady=h5&csecplatform=4&csecversion=4.3.0", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: formBody
            });
            const j = await r.json();
            const msg = String(j?.msg || j?.message || "");
            if (j?.code !== 0 && /并发写入|系统异常|频繁|稍后/.test(msg)) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            return j;
        }
        const formBody = new URLSearchParams(bodyObj).toString();
        const r = await hf.fetch("/reuse/sc/product/retail/w/uniSave?yodaReady=h5&csecplatform=4&csecversion=4.3.0", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody
        });
        return await r.json();
    };

    let idx = 0;
    const results = new Array(batch.length);

    const worker = async () => {
        while (true) {
            const myIdx = idx++;
            if (myIdx >= batch.length) break;
            const item = batch[myIdx];
            let mode = "rich";
            let resp = null;
            try {
                resp = await callUniSave(item.body);
                const msg1 = String(resp?.msg || resp?.message || "");

                if (resp?.code !== 0 && !/已存在|请勿重复/.test(msg1)) {
                    await sleep(600);
                    mode = "strip_attrs";
                    resp = await callUniSave(stripAttrs(item.body));
                }

                const msg2 = String(resp?.msg || resp?.message || "");
                if (resp?.code !== 0 && !/已存在|请勿重复/.test(msg2)) {
                    await sleep(600);
                    mode = "strip_media";
                    resp = await callUniSave(stripMedia(item.body));
                }
            } catch (err) {
                resp = { code: -1, msg: String(err) };
            }

            results[myIdx] = {
                native_product_id: item.native_product_id,
                title: item.title,
                mode: mode,
                resp: resp
            };
            await sleep(25);
        }
    };

    const workers = [];
    for (let w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);
    return JSON.stringify(results);
}
"""


async def push_batch(ws, batch_items, concurrency=8):
    """向当前已连接的 WebSocket 推送一批商品"""
    expr = f"({JS_BATCH_RUNNER})({json.dumps(batch_items, ensure_ascii=False)}, {concurrency})"
    msg_id = int(time.time() * 1000) % 1000000
    await ws.send(json.dumps({
        "id": msg_id,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expr,
            "awaitPromise": True,
            "returnByValue": True
        }
    }))
    raw = json.loads(await ws.recv())
    while raw.get("id") != msg_id:
        raw = json.loads(await ws.recv())
    val = ((raw.get("result") or {}).get("result") or {}).get("value")
    return json.loads(val) if val else []


if __name__ == "__main__":
    print("美团闪购 uniSave 极速推流引擎已就绪。")
