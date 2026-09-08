"""
【业务说明书：多平台商品治理 - 全平台资源与标签页前置门测试】
建立时间：2026年
核心业务红线（不管系统怎么重构，以下逻辑绝对不能变）：
1. 所有平台默认单热页，writer 只允许 1→2→4，严禁一商品一标签或超过 4 个 writer。
2. 宿主内存余量、任务 RSS、页面归属或受管运行任一不满足时必须延后当前任务。
3. 临时引导页必须在真实 writer 启动前关闭，压力出现后只允许降为单 writer。
"""

from runtime_resource_policy import evaluate, load_policy


GIB = 1024**3
BASE = {
    "total_memory_bytes": 16 * GIB,
    "mem_available_bytes": 7 * GIB,
    "task_process_rss_bytes": 512 * 1024**2,
    "task_owned_live_pages": 3,
    "control_pages": 2,
    "writer_pages": 1,
    "bootstrap_pages": 0,
    "bounded_runtime": True,
    "runtime_pressure_observed": False,
}


policy = load_policy()
assert evaluate(BASE, policy)["admitted"] is True
too_many = {**BASE, "task_owned_live_pages": 7, "writer_pages": 5}
assert "writer_page_budget_exceeded" in evaluate(too_many, policy)["reasons"]
low_memory = {**BASE, "mem_available_bytes": GIB}
assert "host_memory_reserve_insufficient" in evaluate(low_memory, policy)["reasons"]
overlap = {**BASE, "task_owned_live_pages": 4, "bootstrap_pages": 1}
assert "bootstrap_and_writer_overlap" in evaluate(overlap, policy)["reasons"]
pressure = {**BASE, "task_owned_live_pages": 4, "writer_pages": 2, "runtime_pressure_observed": True}
assert "pressure_requires_single_writer" in evaluate(pressure, policy)["reasons"]
unbounded = {**BASE, "bounded_runtime": False}
assert "bounded_runtime_required" in evaluate(unbounded, policy)["reasons"]
assert evaluate({**BASE, "mem_available_bytes": 2 * GIB}, policy)["admitted"] is True
assert evaluate({**BASE, "total_memory_bytes": 0}, policy)["admitted"] is False
assert evaluate({**BASE, "mem_available_bytes": 17 * GIB}, policy)["admitted"] is False
assert evaluate({**BASE, "total_memory_bytes": 4 * GIB, "mem_available_bytes": GIB}, policy)["admitted"] is True
print('{"ok":true,"cases":10}')
