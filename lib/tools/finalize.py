"""Cosplay Studio post-processing: body makeup (P7b), de-oil, JPEG export, 2x2 preview, delivery copy.

Run with ComfyUI's own Python (Pillow + numpy are already installed there):
    python finalize.py <projectDir> [--report <path>] [--makeup 1] [--strength 0.35] [--leg-strength 0.85]

Reads <projectDir>/project.json, <projectDir>/raw/*.png and <projectDir>/base/*.png,
writes <projectDir>/final/*.jpg and <projectDir>/deliver/, then writes/prints one JSON
object {"finals": [...], "preview": "...", "notes": [...], "makeup": [...]} for the host.
"""

from __future__ import annotations

import json
import os
import shutil
import sys

from PIL import Image

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is part of the ComfyUI venv
    np = None

from skin_makeup import makeup as skin_makeup

CELL_W, CELL_H = 720, 1280
GAP = 32
MAX_BYTES = 1_950_000

# P7b defaults from the skill: light touch above the waist, strong on the legs.
DEFAULT_STRENGTH = 0.35
DEFAULT_LEG_STRENGTH = 0.85


def deoil(image: Image.Image) -> Image.Image:
    """Flatten oily/crushed highlights on skin: V>0.80 and S<0.45 -> V=0.72."""
    if np is None:
        return image
    arr = np.asarray(image.convert("RGB")).astype(np.float32) / 255.0
    maximum = arr.max(axis=2)
    minimum = arr.min(axis=2)
    saturation = np.where(maximum > 0, (maximum - minimum) / np.maximum(maximum, 1e-6), 0.0)
    mask = (maximum > 0.80) & (saturation < 0.45)
    factor = np.where(mask, 0.72 / np.maximum(maximum, 1e-6), 1.0)
    out = np.clip(arr * np.minimum(factor, 1.0)[..., None], 0.0, 1.0)
    return Image.fromarray((out * 255.0).astype("uint8"))


def apply_body_makeup(image: Image.Image, strength: float, leg_strength: float) -> Image.Image:
    """P7b: even out the face-to-feet skin tone (legs/feet are the usual drift)."""
    if np is None:
        return image
    try:
        arr = np.asarray(image.convert("RGB"), np.float32) / 255.0
        out, _mask = skin_makeup(arr, strength, leg_strength, verbose=False)
        return Image.fromarray((np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype("uint8"))
    except Exception as error:  # never lose a finished image to post-processing
        print(f"  !! 身体化妆失败，跳过：{error}", file=sys.stderr)
        return image


def save_jpeg(image: Image.Image, path: str, max_bytes: int = MAX_BYTES) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    quality = 92
    while quality >= 58:
        image.save(path, "JPEG", quality=quality, subsampling=1, optimize=True)
        size = os.path.getsize(path)
        if size <= max_bytes:
            return size
        quality -= 4
    return os.path.getsize(path)


def safe_name(text: str, fallback: str) -> str:
    cleaned = "".join(ch for ch in str(text or "") if ch not in '\\/:*?"<>|\r\n\t').strip()
    cleaned = cleaned.replace(" ", "_")
    return cleaned[:40] or fallback


def cover(image: Image.Image, width: int, height: int) -> Image.Image:
    """Center-crop to the target aspect ratio, then resize."""
    ratio = width / height
    w, h = image.size
    if w / h > ratio:
        new_w = int(round(h * ratio))
        left = (w - new_w) // 2
        image = image.crop((left, 0, left + new_w, h))
    else:
        new_h = int(round(w / ratio))
        top = (h - new_h) // 2
        image = image.crop((0, top, w, top + new_h))
    return image.resize((width, height), Image.LANCZOS)


def build_preview(paths: list[str], out_path: str) -> bool:
    cells = [cover(Image.open(path).convert("RGB"), CELL_W, CELL_H) for path in paths[:4]]
    if len(cells) == 0:
        return False
    while len(cells) < 4:
        cells.append(Image.new("RGB", (CELL_W, CELL_H), (255, 255, 255)))
    width = CELL_W * 2 + GAP * 3
    height = CELL_H * 2 + GAP * 3
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    for index, cell in enumerate(cells):
        row, col = divmod(index, 2)
        x = GAP + col * (CELL_W + GAP)
        y = GAP + row * (CELL_H + GAP)
        canvas.paste(cell, (x, y))
    save_jpeg(canvas, out_path, 3_600_000)
    return True


def write_copy(project: dict, finals: list[str], deliver_dir: str) -> None:
    character = project.get("character") or "角色"
    series = project.get("series") or ""
    details = project.get("details") or {}
    shots = project.get("shots") or []
    titles = [
        f"{character} 真人cos",
        f"把{character}拍进现实",
        f"{character}｜{series}" if series else f"{character} 全套成片",
    ]
    action_line = "、".join(shot.get("title", "") for shot in shots[:4] if shot.get("title"))
    body = (
        f"这次试着把 {character} 做成真人 cosplay。\n"
        f"一整套从角色卡开始，背景用她的配色做了纯色渐变，没有实景元素。\n"
        + (f"镜头包括：{action_line}。\n" if action_line else "")
        + "所有图同一张角色卡、同一套灯光，所以脸和服装是连贯的。"
    )
    tags = [
        f"#{character}", "#cosplay", "#真人cos", "#cosplay摄影",
        "#二次元走进现实", "#人像摄影", "#棚拍", "#角色扮演",
    ]
    if series:
        tags.insert(1, f"#{series}")
    lines = [
        "【标题备选】",
        *[f"- {title}" for title in titles],
        "",
        "【正文】",
        body,
        "",
        "【标签】",
        " ".join(tags),
        "",
        "【说明】",
        "- 人物为 AI 生成的虚构形象，18 岁以上成人设定。",
        "- 服装与配饰按角色设定还原，未使用实拍素材。",
    ]
    with open(os.path.join(deliver_dir, "文案.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: finalize.py <projectDir> [--report <path>] [--makeup 1] [--strength 0.35] [--leg-strength 0.85]", file=sys.stderr)
        return 2
    root = os.path.abspath(sys.argv[1])
    with open(os.path.join(root, "project.json"), "r", encoding="utf-8") as handle:
        project = json.load(handle)

    def option(flag: str, default: str) -> str:
        if flag not in sys.argv:
            return default
        index = sys.argv.index(flag)
        return sys.argv[index + 1] if index + 1 < len(sys.argv) else default

    makeup_on = option("--makeup", "1").lower() not in ("0", "false", "no")
    deoil_on = option("--deoil", "1").lower() not in ("0", "false", "no")
    strength = float(option("--strength", str(DEFAULT_STRENGTH)))
    leg_strength = float(option("--leg-strength", str(DEFAULT_LEG_STRENGTH)))

    final_dir = os.path.join(root, "final")
    deliver_dir = os.path.join(root, "deliver")
    os.makedirs(final_dir, exist_ok=True)
    os.makedirs(deliver_dir, exist_ok=True)

    notes: list[str] = []
    finals: list[str] = []
    made_up: list[str] = []

    # 1. Base image -> 00_基准角色_<角色>.jpg
    base_dir = os.path.join(root, "base")
    base_files = sorted(
        os.path.join(base_dir, name) for name in os.listdir(base_dir)
    ) if os.path.isdir(base_dir) else []
    if base_files:
        base_image = Image.open(base_files[-1]).convert("RGB")
        if deoil_on:
            base_image = deoil(base_image)
        base_name = f"00_基准角色_{safe_name(project.get('character'), '角色')}.jpg"
        save_jpeg(base_image, os.path.join(final_dir, base_name))
        notes.append(f"基准图：{base_name}")

    # 2. Shots -> 01_<动作名>.jpg (numbered in script order)
    shots = project.get("shots") or []
    raw_dir = os.path.join(root, "raw")
    raws = sorted(os.listdir(raw_dir)) if os.path.isdir(raw_dir) else []
    for index, name in enumerate(raws):
        if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        shot = shots[index] if index < len(shots) else {}
        title = safe_name(shot.get("title"), f"镜头{index + 1}")
        image = Image.open(os.path.join(raw_dir, name)).convert("RGB")
        # Skill order: P7 de-oil first, then P7b body makeup on the clean image.
        if deoil_on:
            image = deoil(image)
        if makeup_on:
            image = apply_body_makeup(image, strength, leg_strength)
            made_up.append(f"{index + 1:02d}_{title}")
        file_name = f"{index + 1:02d}_{title}.jpg"
        size = save_jpeg(image, os.path.join(final_dir, file_name))
        finals.append(file_name)
        if size > MAX_BYTES:
            notes.append(f"{file_name} 压缩后仍超过 1.95 MB（{size // 1024} KB）")
    if made_up:
        notes.append(f"P7b 身体化妆：{len(made_up)} 张（leg-strength {leg_strength:.2f}）")

    # 3. 2x2 preview 00_全套预览.jpg
    preview_name = ""
    if finals:
        first_four = [os.path.join(final_dir, name) for name in finals[:4]]
        preview_name = "00_全套预览.jpg"
        if build_preview(first_four, os.path.join(final_dir, preview_name)):
            notes.append("预览图：00_全套预览.jpg（2×2，单格 720×1280）")

    # 4. delivery folder
    for name in os.listdir(final_dir):
        shutil.copy2(os.path.join(final_dir, name), os.path.join(deliver_dir, name))
    write_copy(project, finals, deliver_dir)

    report = {"finals": finals, "preview": preview_name, "notes": notes, "makeup": made_up}
    out = json.dumps(report, ensure_ascii=False)
    # The host passes "--report <path>" so it can read the result without
    # relying on piped stdio (which can be blocked on Windows).
    if len(sys.argv) >= 4 and sys.argv[2] == "--report":
        try:
            with open(sys.argv[3], "w", encoding="utf-8") as handle:
                handle.write(out)
        except OSError:
            pass
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
