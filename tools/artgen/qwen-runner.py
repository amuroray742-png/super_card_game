#!/usr/bin/env python
"""本地 qwen-image2.1 图标批量生成执行器。

替代云端 `mcode-tools connector call connector__matrix__generate_image`，
在本机 RTX 3070 上跑同一批提示词。

设计要点：
  - **一次加载、循环出图**：pipeline 加载约 20s、占 31GB 内存，
    逐张重载会浪费绝大部分时间，因此整个批次只加载一次。
  - **断点续跑**：产物已存在即跳过，中断后重跑不重复消耗时间。
  - **8GB 显存的活路**：`enable_sequential_cpu_offload()` 按子模块搬运权重，
    显存峰值约 1.2GB；**不要**在此前后调用 `pipe.to("cuda")`。
  - **确定性**：每张图的种子由 TS 侧按 id 哈希写进任务文件，
    同一 id 重跑得到同一张图（与工程 `hashSeed` 口径一致）。

用法：
    python qwen-runner.py --jobs <jobs.json> [--limit N] [--steps N]
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

# 本地权重缓存；未设置 HF_HOME 时兜底指向同一份缓存
os.environ.setdefault("HF_HOME", r"C:\AI\huggingfacemkdir")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch  # noqa: E402
from diffusers import QwenImage21Pipeline  # noqa: E402

_LOG_FH = None


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    if _LOG_FH is not None:
        _LOG_FH.write(line + "\n")
        _LOG_FH.flush()


def main() -> int:
    global _LOG_FH

    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True, help="任务 JSON 路径")
    ap.add_argument("--limit", type=int, default=0, help="本次最多生成多少张（0 = 全部）")
    ap.add_argument("--steps", type=int, default=0, help="覆盖任务里的推理步数")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="产物已存在也重生成（改提示词后要保持整组一致）")
    args = ap.parse_args()

    jobs_path = Path(args.jobs)
    log_path = jobs_path.parent / "runner.log"
    _LOG_FH = log_path.open("a", encoding="utf-8", buffering=1)

    with jobs_path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    items = payload["items"]
    if args.limit:
        items = items[: args.limit]

    # 先算出真正要跑的（产物已存在的默认跳过；--force 时全部重生成）
    todo = []
    for it in items:
        out = Path(it["out"])
        if not args.force and out.exists() and out.stat().st_size > 0:
            continue
        todo.append(it)

    log(f"任务 {len(items)} 张 · 待生成 {len(todo)} 张 · 跳过（已存在）{len(items) - len(todo)} 张")
    if not todo:
        log("全部已存在，无需生成。")
        _LOG_FH.close()
        return 0

    if not torch.cuda.is_available():
        log("未检测到 CUDA，无法生成。")
        _LOG_FH.close()
        return 1

    log(f"torch={torch.__version__} gpu={torch.cuda.get_device_name(0)}")

    t0 = time.time()
    pipe = QwenImage21Pipeline.from_pretrained(
        payload.get("model", "Qwen/Qwen-Image-2.1"),
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    log(f"pipeline 加载完成，用时 {time.time() - t0:.1f}s")

    pipe.enable_sequential_cpu_offload()
    pipe.vae.enable_tiling()
    log("已启用 sequential_cpu_offload + vae tiling")

    ok = 0
    failed = []
    for idx, it in enumerate(todo, start=1):
        out = Path(it["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        width = args.width or it.get("width", 512)
        height = args.height or it.get("height", 512)
        steps = args.steps or it.get("steps", 30)
        seed = it["seed"]

        label = f"{idx}/{len(todo)} {it['id']}"
        t1 = time.time()
        try:
            with torch.inference_mode():
                image = pipe(
                    prompt=it["prompt"],
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    generator=torch.Generator("cpu").manual_seed(seed),
                ).images[0]
            image.save(out)
            ok += 1
            log(f"✓ {label}  {width}x{height} {steps}步  {time.time() - t1:.0f}s  → {out.name}")
        except Exception as exc:  # noqa: BLE001
            failed.append((it["id"], str(exc)))
            log(f"✗ {label}  失败：{exc}")

    peak = torch.cuda.max_memory_allocated() / 1024**3
    log(f"完成：成功 {ok} · 失败 {len(failed)} · 显存峰值 {peak:.2f}GB")
    for fid, reason in failed:
        log(f"  ✗ {fid}：{reason[:200]}")
    _LOG_FH.close()
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
