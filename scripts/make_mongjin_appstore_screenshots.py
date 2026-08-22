from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path('/Volumes/Studio ZZG/mongjin')
OUT = ROOT / 'store' / 'screenshots'
CAPTURES = ROOT / 'artifacts' / 'review'
W, H = 1284, 2778

DISPLAY = '/Users/kwon-oin/Library/Fonts/AppleSDGothicNeoH.ttf'
REGULAR = '/Users/kwon-oin/Library/Fonts/AppleSDGothicNeoR.ttf'

INK = '#202A33'
BLUE = '#315F89'
SOFT = '#647481'
PAPER = '#F1EEE8'
LINE = '#D9D4CA'


def font(path: str, size: int):
    return ImageFont.truetype(path, size)


def text(draw, xy, value, size, color=INK, display=False, spacing=12):
    draw.multiline_text(
        xy,
        value,
        font=font(DISPLAY if display else REGULAR, size),
        fill=color,
        spacing=spacing,
    )


def rounded_screen(base: Image.Image, source: Image.Image, x: int, y: int, max_width: int, max_bottom: int):
    scale = min(max_width / source.width, (max_bottom - y) / source.height)
    width = round(source.width * scale)
    height = round(source.height * scale)
    x = x + (max_width - width) // 2
    screen = source.resize((width, height), Image.Resampling.LANCZOS).convert('RGBA')

    shadow = Image.new('RGBA', base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (x + 10, y + 18, x + width + 10, y + height + 18),
        radius=42,
        fill=(28, 39, 48, 48),
    )
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))

    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width, height), radius=42, fill=255)
    screen.putalpha(mask)
    base.alpha_composite(screen, (x, y))
    ImageDraw.Draw(base).rounded_rectangle(
        (x, y, x + width, y + height),
        radius=42,
        outline=LINE,
        width=3,
    )


def build_page(title: str, subtitle: str, source_name: str, crop, output_name: str):
    page = Image.new('RGBA', (W, H), PAPER)
    draw = ImageDraw.Draw(page)

    draw.rectangle((92, 112, 101, 420), fill=BLUE)
    text(draw, (132, 108), 'MONGJIN  /  실제 앱 화면', 28, SOFT)
    text(draw, (132, 176), title, 82, INK, display=True, spacing=8)
    text(draw, (136, 408), subtitle, 32, BLUE)
    draw.rectangle((132, 492, 1152, 497), fill=BLUE)

    source = Image.open(CAPTURES / source_name).convert('RGB').crop(crop)
    rounded_screen(page, source, x=82, y=566, max_width=1120, max_bottom=2640)

    text(draw, (102, 2692), '몽진 / 왕의 피난길을 만드는 9×9 전략', 25, SOFT)
    OUT.mkdir(parents=True, exist_ok=True)
    page.convert('RGB').save(OUT / output_name, 'PNG', optimize=True)


def build_all():
    build_page(
        '원하는 방식으로\n바로 시작',
        '빠른 대전 / 친구 / 컴퓨터 / 같이 두기',
        'mongjin-103-home-native.png',
        (0, 190, 1206, 2220),
        'mongjin-appstore-01-king-flight-1284x2778.png',
    )
    build_page(
        '처음이어도\n한 수씩 배우기',
        '실제 대국판에서 익히는 5단계 튜토리얼',
        'mongjin-103-tutorial-native.png',
        (0, 180, 1206, 2200),
        'mongjin-appstore-02-escort-strategy-1284x2778.png',
    )
    build_page(
        '왕의 길을 만드는\n깊은 한 판',
        '호위하고 / 막고 / 전진하는 실제 대국',
        'mongjin-103-game-mid-native.png',
        (0, 180, 1206, 2250),
        'mongjin-appstore-03-short-deep-match-1284x2778.png',
    )


if __name__ == '__main__':
    build_all()
