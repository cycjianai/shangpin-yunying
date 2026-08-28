from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("task_contract.py")


def run(*args: str, expected: int = 0):
    result = subprocess.run([sys.executable, str(SCRIPT), *args], text=True, capture_output=True)
    assert result.returncode == expected, result.stdout + result.stderr
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory(prefix="meituan-contract-") as raw:
    root = Path(raw)
    manifest = root / "manifest.json"
    identity = root / "session_identity.json"
    manifest.write_text(json.dumps({
        "platform_adapter": "meituan", "task_mode": "unavailable_one_pass",
        "wm_poi_id": "123456", "unique_spu_count": 2,
        "platform_record_count": 3, "spu_set_sha256": "abc",
    }), encoding="utf-8")
    identity.write_text(json.dumps({
        "platform_adapter": "meituan", "wm_poi_id": "123456",
        "browser_transport": "chrome_extension_current_tab",
    }), encoding="utf-8")
    created = run("create", "--run-dir", str(root), "--manifest", str(manifest), "--identity", str(identity))
    assert created["source_unique_spu"] == 2
    verified = run("verify", "--contract", str(root / "task-contract.json"))
    assert verified["contract_fingerprint_sha256"] == created["contract_fingerprint_sha256"]
    receipt = root / "receipt.json"
    receipt.write_text('{"ok":true}', encoding="utf-8")
    entry = run("record", "--contract", str(root / "task-contract.json"), "--action", "session_preflight", "--outcome", "succeeded", "--receipt", str(receipt))
    assert entry["outcome"] == "succeeded"

print(json.dumps({"ok": True, "tests": 4}))
