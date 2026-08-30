from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OUT = ASSETS / "hero-continuity.gif"

W, H = 800, 450
SCALE = 2
SIZE = (W * SCALE, H * SCALE)

BG = "#f6f8fa"
PANEL = "#ffffff"
PANEL_2 = "#f4f8ff"
BORDER = "#d0d7de"
TEXT = "#1f2328"
MUTED = "#656d76"
TEAL = "#1f883d"
TEAL_DARK = "#dafbe1"
BLUE = "#0969da"
GREEN_BUBBLE = "#eaf5ee"
TOOL_BG = "#f7f3ff"
TOOL_BORDER = "#d8c7ff"
TOOL_TEXT = "#4c2889"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / name), size * SCALE)


F_TITLE = font(24, True)
F_HEADING = font(18, True)
F_BODY = font(14)
F_BODY_BOLD = font(14, True)
F_SMALL = font(11)
F_SMALL_BOLD = font(11, True)
F_TINY = font(9, True)


def xy(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return tuple(v * SCALE for v in box)


def point(p: tuple[int, int]) -> tuple[int, int]:
    return p[0] * SCALE, p[1] * SCALE


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(xy(box), radius=radius * SCALE, fill=fill, outline=outline, width=width * SCALE)


def text(draw: ImageDraw.ImageDraw, pos: tuple[int, int], value: str, f: ImageFont.FreeTypeFont, fill: str = TEXT, anchor: str | None = None) -> None:
    draw.text(point(pos), value, font=f, fill=fill, anchor=anchor)


def fit_crop(image: Image.Image, size: tuple[int, int], top_bias: float = 0.0) -> Image.Image:
    target_w, target_h = size
    source_ratio = image.width / image.height
    target_ratio = target_w / target_h
    if source_ratio > target_ratio:
        crop_w = int(image.height * target_ratio)
        left = (image.width - crop_w) // 2
        crop = (left, 0, left + crop_w, image.height)
    else:
        crop_h = int(image.width / target_ratio)
        max_top = image.height - crop_h
        top = int(max_top * top_bias)
        crop = (0, top, image.width, top + crop_h)
    return image.crop(crop).resize((target_w * SCALE, target_h * SCALE), Image.Resampling.LANCZOS)


def rounded_image(image: Image.Image, size: tuple[int, int], radius: int, top_bias: float = 0.0) -> Image.Image:
    fitted = fit_crop(image, size, top_bias)
    mask = Image.new("L", fitted.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, fitted.width, fitted.height), radius=radius * SCALE, fill=255)
    fitted.putalpha(mask)
    return fitted


TASK_LIST = Image.open(ASSETS / "demo-task-list.png").convert("RGB")
CONVERSATION = Image.open(ASSETS / "demo-conversation.png").convert("RGB")


def desktop_panel(draw: ImageDraw.ImageDraw, phase: int, progress: float) -> None:
    rounded(draw, (36, 76, 510, 402), 20, PANEL, BORDER)
    draw.ellipse(xy((55, 94, 65, 104)), fill="#ff6b6b")
    draw.ellipse(xy((72, 94, 82, 104)), fill="#f6c453")
    draw.ellipse(xy((89, 94, 99, 104)), fill="#59d98e")
    text(draw, (116, 99), "CODEX DESKTOP", F_TINY, MUTED, "lm")
    text(draw, (58, 139), "Release readiness", F_HEADING)
    text(draw, (58, 163), "Demo workspace", F_SMALL, MUTED)

    rounded(draw, (58, 186, 474, 231), 13, GREEN_BUBBLE)
    text(draw, (76, 208), "Prepare the Android compatibility report.", F_BODY, TEXT, "lm")

    if phase == 0:
        rounded(draw, (58, 246, 474, 310), 13, PANEL_2, BORDER)
        text(draw, (76, 269), "Checking the project and mobile build…", F_BODY)
        spinner_x, spinner_y = 450, 268
        angle = progress * math.tau
        draw.arc(xy((spinner_x - 7, spinner_y - 7, spinner_x + 7, spinner_y + 7)),
                 start=int(math.degrees(angle)), end=int(math.degrees(angle) + 250),
                 fill=TEAL, width=2 * SCALE)
        rounded(draw, (58, 324, 474, 365), 12, TOOL_BG, TOOL_BORDER)
        text(draw, (76, 344), "4 tool activities", F_SMALL_BOLD, TOOL_TEXT, "lm")
        text(draw, (450, 344), "running", F_SMALL_BOLD, TEAL, "rm")
    elif phase == 1:
        rounded(draw, (58, 246, 474, 300), 13, GREEN_BUBBLE)
        text(draw, (76, 264), "YOU · FROM PHONE", F_TINY, TEAL)
        text(draw, (76, 285), "Also include the attached screenshot.", F_BODY)
        rounded(draw, (58, 315, 474, 365), 12, "#ffffff", "#8cceb0")
        rounded(draw, (73, 326, 103, 354), 7, TEAL_DARK)
        text(draw, (88, 340), "IMG", F_TINY, TEAL, "mm")
        text(draw, (115, 340), "android-layout.png", F_SMALL_BOLD, TEXT, "lm")
        text(draw, (450, 340), "received", F_SMALL, TEAL, "rm")
    else:
        rounded(draw, (58, 246, 474, 303), 13, PANEL_2, BORDER)
        text(draw, (76, 267), "Compatibility report complete.", F_BODY_BOLD)
        text(draw, (76, 289), "The appended screenshot was included.", F_SMALL, MUTED)
        artifact_card(draw, (58, 318, 474, 370), compact=False)

    rounded(draw, (58, 378, 474, 389), 5, "#eef1f4", None)


def artifact_card(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], compact: bool) -> None:
    x1, y1, x2, y2 = box
    rounded(draw, box, 11, "#ffffff", BORDER)
    badge_w = 34 if compact else 38
    rounded(draw, (x1 + 10, y1 + 9, x1 + 10 + badge_w, y2 - 9), 7, TEAL_DARK)
    text(draw, (x1 + 10 + badge_w // 2, (y1 + y2) // 2), "PDF", F_TINY, TEAL, "mm")
    text(draw, (x1 + 20 + badge_w, (y1 + y2) // 2 - 6), "compatibility-report.pdf", F_SMALL_BOLD, TEXT, "lm")
    text(draw, (x1 + 20 + badge_w, (y1 + y2) // 2 + 11), "184 KB", F_TINY, MUTED, "lm")
    if not compact:
        rounded(draw, (x2 - 78, y1 + 9, x2 - 10, y2 - 9), 7, TEAL, "#1a7f37")
        text(draw, (x2 - 44, (y1 + y2) // 2), "Preview", F_TINY, "#ffffff", "mm")


def phone_panel(base: Image.Image, phase: int, transition: float) -> None:
    x, y, width, height = 553, 49, 214, 368
    shadow = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(xy((x - 5, y - 5, x + width + 5, y + height + 5)), radius=30 * SCALE, fill=(31, 35, 40, 42))
    base.alpha_composite(shadow)
    draw = ImageDraw.Draw(base)
    rounded(draw, (x - 3, y - 3, x + width + 3, y + height + 3), 27, "#ffffff", "#afb8c1", 2)

    if phase == 0:
        screen = rounded_image(TASK_LIST, (width, height), 24, 0.0)
    else:
        screen = rounded_image(CONVERSATION, (width, height), 24, 0.0)
    base.alpha_composite(screen, point((x, y)))

    overlay = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    if phase == 0:
        pulse = 7 + int(5 * (0.5 + 0.5 * math.sin(transition * math.tau)))
        od.ellipse(xy((x + 175 - pulse, y + 67 - pulse, x + 175 + pulse, y + 67 + pulse)), outline=TEAL, width=2 * SCALE)
    elif phase == 1:
        rounded(od, (x + 12, y + 260, x + width - 12, y + 323), 13, GREEN_BUBBLE, "#8cceb0")
        text(od, (x + 26, y + 276), "YOU · FROM PHONE", F_TINY, TEAL)
        text(od, (x + 26, y + 296), "Also include this screenshot.", F_SMALL, TEXT)
        rounded(od, (x + 26, y + 305, x + 111, y + 317), 5, TEAL_DARK)
        text(od, (x + 68, y + 311), "image attached", F_TINY, TEAL, "mm")
    else:
        rounded(od, (x + 10, y + 270, x + width - 10, y + 336), 13, PANEL, BORDER)
        text(od, (x + 24, y + 285), "RESULT READY", F_TINY, TEAL)
        rounded(od, (x + 22, y + 299, x + width - 22, y + 326), 7, "#ffffff", BORDER)
        text(od, (x + 33, y + 312), "PDF", F_TINY, TEAL, "lm")
        text(od, (x + 67, y + 312), "Preview report", F_TINY, TEXT, "lm")
    base.alpha_composite(overlay)


def bridge(draw: ImageDraw.ImageDraw, phase: int, progress: float) -> None:
    y = 238
    draw.line((510 * SCALE, y * SCALE, 553 * SCALE, y * SCALE), fill="#8cceb0", width=4 * SCALE)
    direction = progress if phase != 1 else 1 - progress
    dot_x = 514 + int(35 * direction)
    draw.ellipse(xy((dot_x - 4, y - 4, dot_x + 4, y + 4)), fill=TEAL)
    rounded(draw, (509, 205, 555, 224), 9, TEAL_DARK, "#8cceb0")
    text(draw, (532, 214), "BRIDGE", F_TINY, TEAL, "mm")


def frame(phase: int, progress: float) -> Image.Image:
    image = Image.new("RGBA", SIZE, BG)
    draw = ImageDraw.Draw(image)

    if phase == 0:
        title, accent = "START ON DESKTOP", "Live task appears on your phone"
    elif phase == 1:
        title, accent = "CONTINUE FROM YOUR PHONE", "Follow-up reaches the same running task"
    else:
        title, accent = "RESULTS, WHEREVER YOU ARE", "Preview the artifact without returning to your desk"

    text(draw, (36, 28), title, F_TITLE)
    text(draw, (764, 31), accent, F_SMALL, MUTED, "ra")
    desktop_panel(draw, phase, progress)
    phone_panel(image, phase, progress)
    bridge(draw, phase, progress)
    text(draw, (36, 430), "Codex-WebBridge", F_SMALL_BOLD, TEAL, "lm")
    text(draw, (764, 430), "Same task. Same Codex.", F_SMALL_BOLD, TEXT, "rm")
    return image.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)


def transition(a: Image.Image, b: Image.Image, steps: int) -> list[Image.Image]:
    return [Image.blend(a, b, i / steps) for i in range(1, steps + 1)]


def build() -> None:
    frames: list[Image.Image] = []
    durations: list[int] = []

    phases: list[list[Image.Image]] = []
    for phase in range(3):
        phase_frames = [frame(phase, i / 9) for i in range(10)]
        phases.append(phase_frames)

    for phase_index, phase_frames in enumerate(phases):
        frames.extend(phase_frames)
        durations.extend([110] * len(phase_frames))
        frames.append(phase_frames[-1])
        durations.append(950 if phase_index < 2 else 1_350)
        if phase_index < 2:
            blended = transition(phase_frames[-1], phases[phase_index + 1][0], 5)
            frames.extend(blended)
            durations.extend([90] * len(blended))

    # Build one shared palette to avoid per-frame color flicker and keep the GIF small.
    thumbs = [item.resize((160, 90), Image.Resampling.BILINEAR) for item in frames]
    sheet = Image.new("RGB", (160 * len(thumbs), 90), BG)
    for index, item in enumerate(thumbs):
        sheet.paste(item, (160 * index, 0))
    palette = sheet.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
    encoded = [item.quantize(palette=palette, dither=Image.Dither.NONE) for item in frames]

    encoded[0].save(
        OUT,
        save_all=True,
        append_images=encoded[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"{OUT} ({OUT.stat().st_size / 1024 / 1024:.2f} MiB, {sum(durations) / 1000:.1f}s)")


if __name__ == "__main__":
    build()
