from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path('/Volumes/Studio ZZG/mongjin')
OUT = ROOT / 'store' / 'screenshots'
GEN = Path('/Users/kwon-oin/.codex/generated_images/01a01bec-b9d4-7453-a8d8-6d1f9f559290')
W, H = 1284, 2778

DISPLAY = '/Users/kwon-oin/Library/Fonts/AppleSDGothicNeoH.ttf'
SANS = '/Users/kwon-oin/Library/Fonts/AppleSDGothicNeoH.ttf'
REGULAR = '/Users/kwon-oin/Library/Fonts/AppleSDGothicNeoR.ttf'

INK = '#202A33'
BLUE = '#315F89'
SOFT = '#647481'
PAPER = '#F1EEE8'
WOOD = '#D7C5A8'
WHITE = '#FBFAF7'


def font(path: str, size: int):
    return ImageFont.truetype(path, size)


def cover(image: Image.Image) -> Image.Image:
    scale = max(W / image.width, H / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - W) // 2
    top = (resized.height - H) // 2
    return resized.crop((left, top, left + W, top + H)).convert('RGBA')


def add_noise(image: Image.Image) -> Image.Image:
    return image


def rounded_card(base: Image.Image, source: Image.Image, box, radius=48, shadow=True, border=0):
    x, y, width, height = box
    card = source.convert('RGBA').resize((width, height), Image.Resampling.LANCZOS)
    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width, height), radius=radius, fill=255)
    if shadow:
        shadow_layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
        shadow_shape = Image.new('RGBA', (width + 32, height + 32), (0, 0, 0, 0))
        shadow_mask = Image.new('L', shadow_shape.size, 0)
        ImageDraw.Draw(shadow_mask).rounded_rectangle((16, 16, width + 16, height + 16), radius=radius, fill=100)
        shadow_shape.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(18)))
        shadow_layer.alpha_composite(shadow_shape, (x - 16, y - 16))
        base.alpha_composite(shadow_layer)
    card.putalpha(mask)
    base.alpha_composite(card, (x, y))
    if border:
        draw = ImageDraw.Draw(base)
        draw.rounded_rectangle((x, y, x + width, y + height), radius=radius, outline=WHITE, width=border)


def text(draw, xy, value, size, color=INK, display=False, spacing=12, anchor=None):
    draw.multiline_text(
        xy,
        value,
        font=font(DISPLAY if display else SANS, size),
        fill=color,
        spacing=spacing,
        anchor=anchor,
    )


def label(draw, xy, value):
    draw.text(xy, value, font=font(REGULAR, 28), fill=SOFT)


def base_page(background_path: Path) -> Image.Image:
    page = cover(Image.open(background_path))
    page.alpha_composite(Image.new('RGBA', (W, H), (255, 255, 255, 0)))
    return page


def save(page: Image.Image, name: str):
    OUT.mkdir(parents=True, exist_ok=True)
    page.convert('RGB').save(OUT / name, 'PNG', optimize=True)


def build_one():
    page = base_page(GEN / 'exec-e7bfc003-d8b4-4de9-b07e-58c0fc2f3c89.png')
    draw = ImageDraw.Draw(page)
    draw.rectangle((0, 0, W, 990), fill='#F1EEE8', outline=None)
    draw.rectangle((112, 145, 120, 372), fill=BLUE)
    text(draw, (150, 128), '몽진', 176, display=True)
    text(draw, (156, 360), '蒙塵  /  왕의 피난길', 54, BLUE)
    text(draw, (156, 492), '왕을 호위하며 목적지까지\n한 수 한 수, 길을 만든다', 48, INK, spacing=16)
    label(draw, (156, 742), 'MONGJIN  /  STRATEGY BOARD GAME')
    icon = Image.open(ROOT / 'apps/mobile/assets/icon.png').convert('RGBA').resize((156, 156), Image.Resampling.LANCZOS)
    rounded_card(page, icon, (1020, 145, 156, 156), radius=34, shadow=False)
    save(page, 'mongjin-appstore-01-king-flight-1284x2778.png')


def build_two():
    page = base_page(GEN / 'exec-10ade317-c5e4-4737-90c4-e342bad8f1c9.png')
    draw = ImageDraw.Draw(page)
    draw.rectangle((0, 0, W, 770), fill='#F1EEE8', outline=None)
    draw.rectangle((112, 145, 120, 332), fill=BLUE)
    text(draw, (150, 126), '왕을 지켜라', 132, display=True)
    text(draw, (156, 314), '놓고  /  막고  /  포위하라', 56, BLUE)
    text(draw, (156, 442), '호위와 수가 만드는 9×9 전략', 44, INK)
    draw.rectangle((156, 550, 1160, 556), fill=BLUE)
    label(draw, (156, 604), '모든 돌에는 왕을 위한 이유가 있습니다')
    tutorial = Image.open(ROOT / 'assets/tutorial/tutorial-protect.jpg')
    rounded_card(page, tutorial, (120, 1260, 1080, 720), radius=56, shadow=True, border=2)
    label(draw, (120, 2040), '위험을 읽고, 호위를 놓고, 왕의 길을 엽니다')
    save(page, 'mongjin-appstore-02-escort-strategy-1284x2778.png')


def build_three():
    page = base_page(GEN / 'exec-b1275e80-c059-49cc-ba3d-4cea7ef3b750.png')
    draw = ImageDraw.Draw(page)
    draw.rectangle((0, 0, W, 780), fill='#F1EEE8', outline=None)
    draw.rectangle((112, 145, 120, 318), fill=BLUE)
    text(draw, (150, 126), '짧지만 깊은 한 판', 116, display=True)
    text(draw, (156, 314), '컴퓨터  /  친구  /  온라인', 56, BLUE)
    text(draw, (156, 442), '몇 분 안에 시작하고, 오래 생각하게 됩니다', 42, INK)
    draw.rectangle((156, 550, 1160, 556), fill=BLUE)
    label(draw, (156, 604), '당신의 다음 수를 기다리는 대국')
    screenshot = Image.open(ROOT / 'store/screenshots/appintoss-crossplay-iphone.png')
    phone = screenshot.crop((420, 0, 860, 814))
    rounded_card(page, phone, (390, 1560, 540, 1000), radius=56, shadow=True, border=2)
    text(draw, (120, 2635), '실제 대국 화면', 30, INK)
    label(draw, (120, 2718), '흑과 백, 한 판마다 달라지는 왕의 피난길')
    save(page, 'mongjin-appstore-03-short-deep-match-1284x2778.png')


if __name__ == '__main__':
    build_one()
    build_two()
    build_three()
