#!/usr/bin/env python3
"""
Create Print & Play PDF for Mongjin
Based on rules v0.3, A4 format, bilingual KO+EN
Uses Noto Sans CJK for proper Korean/Hanja rendering
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
import sys
import os

WIDTH, HEIGHT = A4  # 210mm x 297mm

# Register CJK fonts
CJK_FONT_PATHS = [
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf',
]

CJK_BOLD_FONT_PATHS = [
    '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
    '/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf',
]

def setup_fonts():
    """Register fonts for CJK support"""
    # Try to use Nanum Gothic (TrueType Korean font)
    for font_path in CJK_FONT_PATHS:
        if os.path.exists(font_path):
            try:
                pdfmetrics.registerFont(TTFont('NanumGothic', font_path))
                # Also register bold variant if available
                for bold_path in CJK_BOLD_FONT_PATHS:
                    if os.path.exists(bold_path):
                        try:
                            pdfmetrics.registerFont(TTFont('NanumGothic-Bold', bold_path))
                        except:
                            pass
                        break
                return 'NanumGothic'
            except Exception as e:
                print(f"Failed to load {font_path}: {e}")
                continue
    
    # Fallback: try to use built-in CID fonts
    try:
        pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
        return 'HeiseiMin-W3'
    except:
        pass
    
    # Last resort: use Helvetica (will show tofu but at least won't crash)
    print("WARNING: Could not load CJK fonts. CJK characters may not display correctly.")
    return 'Helvetica'

# Set up fonts
CJK_FONT = setup_fonts()
FALLBACK_FONT = 'Helvetica'


def draw_text(c, x, y, text, font_name=None, font_size=10):
    """Draw text with proper font selection"""
    if font_name is None:
        font_name = CJK_FONT
    c.setFont(font_name, font_size)
    c.drawString(x, y, text)


def draw_text_centered(c, x, y, text, font_name=None, font_size=10):
    """Draw centered text with proper font selection"""
    if font_name is None:
        font_name = CJK_FONT
    c.setFont(font_name, font_size)
    c.drawCentredString(x, y, text)


def draw_page1_cover(c):
    """Page 1: Cover and print instructions"""
    # Title - Hanja
    draw_text_centered(c, WIDTH/2, HEIGHT - 60*mm, "蒙塵", CJK_FONT, 24)
    
    # Korean title
    draw_text_centered(c, WIDTH/2, HEIGHT - 70*mm, "몽진", CJK_FONT, 18)
    
    # English subtitle
    c.setFont(FALLBACK_FONT, 14)
    c.drawCentredString(WIDTH/2, HEIGHT - 85*mm, "Mongjin")
    
    # Subtitle
    c.setFont(CJK_FONT, 11)
    c.drawCentredString(WIDTH/2, HEIGHT - 100*mm, "KO — 임금이 난리를 피해 도망을 떠나다. 왕의 피난.")
    c.setFont(FALLBACK_FONT, 11)
    c.drawCentredString(WIDTH/2, HEIGHT - 107*mm, "EN — The king's flight from the capital. Escort your king to an")
    c.drawCentredString(WIDTH/2, HEIGHT - 114*mm, "enemy goal before your opponent does.")
    
    # Game info
    y = HEIGHT - 135*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    c.drawString(30*mm, y, "Players")
    draw_text(c, 55*mm, y, "2 · 2인", CJK_FONT, 10)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    c.drawString(30*mm, y, "Type")
    draw_text(c, 55*mm, y, "Abstract strategy · 추상 전략", CJK_FONT, 10)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    c.drawString(30*mm, y, "Board")
    c.setFont(FALLBACK_FONT, 10)
    c.drawString(55*mm, y, "9×9")
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    c.drawString(30*mm, y, "Year")
    c.setFont(FALLBACK_FONT, 10)
    c.drawString(55*mm, y, "2026")
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    c.drawString(30*mm, y, "Designer")
    c.setFont(FALLBACK_FONT, 10)
    c.drawString(55*mm, y, "Oin Kwon")
    
    # Print instructions
    y = HEIGHT - 195*mm
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    draw_text(c, 30*mm, y, "What to print · 무엇을 인쇄할까", CJK_FONT, 11)
    
    y -= 8*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "• Page 3 — one 9×9 board")
    y -= 5*mm
    draw_text(c, 40*mm, y, "3쪽 — 9×9 보드 1장", CJK_FONT, 9)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "• Page 4 — 2 kings (")
    draw_text(c, 72*mm, y, "王", CJK_FONT, 9)
    c.drawString(77*mm, y, ") + 16 guards (")
    draw_text(c, 107*mm, y, "衛", CJK_FONT, 9)
    c.drawString(112*mm, y, ")")
    y -= 5*mm
    draw_text(c, 40*mm, y, "4쪽 — 왕 2 + 호위 16 (각 진영 왕 1, 호위 8)", CJK_FONT, 9)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "• Pages 1–2 — keep as reference")
    y -= 5*mm
    draw_text(c, 40*mm, y, "1–2쪽 — 조립 규칙 참고용", CJK_FONT, 9)
    
    # Assembly notes
    y -= 10*mm
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    draw_text(c, 30*mm, y, "How to assemble · 조립 방법", CJK_FONT, 11)
    
    y -= 8*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "1. Print pages 3 and 4 (and optionally 1–2).")
    y -= 5*mm
    draw_text(c, 40*mm, y, "3+4쪽을 인쇄합니다 (1–2쪽은 선택).", CJK_FONT, 9)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "2. Cut out the circular tokens along the dashed guides.")
    y -= 5*mm
    draw_text(c, 40*mm, y, "점선 가이드를 따라 원형 돌을 오립니다.", CJK_FONT, 9)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "3. Optional: glue tokens onto cardboard or bottle caps for")
    y -= 5*mm
    c.drawString(40*mm, y, "weight.")
    y -= 5*mm
    draw_text(c, 40*mm, y, "선택: 글루건이나 병뚜껑에 돌을 부착해 무게를 줍니다.", CJK_FONT, 9)
    
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "4. No scissors? Use two colors of coins/stones as kings &")
    y -= 5*mm
    c.drawString(40*mm, y, "guards.")
    y -= 5*mm
    draw_text(c, 40*mm, y, "가위가 없다면 돌을 바둑돌 두 색으로 대체 가능.", CJK_FONT, 9)
    
    # Web link
    y -= 12*mm
    c.setFont(FALLBACK_FONT + "-Bold", 10)
    draw_text(c, 30*mm, y, "Also play online · 온라인으로도 플레이하세요", CJK_FONT, 10)
    y -= 7*mm
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "Optional web client (not required for this physical game):")
    y -= 5*mm
    c.setFont(FALLBACK_FONT, 9)
    c.setFillColorRGB(0, 0, 0.8)
    c.drawString(35*mm, y, "https://kamilokwon.github.io/mongjin/")
    c.setFillColorRGB(0, 0, 0)
    y -= 5*mm
    draw_text(c, 35*mm, y, "이 PnP로만 플레이 가능하며, 웹 클라이언트는 선택 사항입니다.", CJK_FONT, 9)
    
    # Footer
    c.setFont(FALLBACK_FONT, 8)
    c.drawString(30*mm, 20*mm, "Mongjin print-and-play · Oin Kwon, 2026")
    c.drawRightString(WIDTH - 30*mm, 20*mm, "Rules v0.3")
    c.drawCentredString(WIDTH/2, 15*mm, "https://kamilokwon.github.io/mongjin/")


def draw_page2_rules(c):
    """Page 2: Rules v0.3 bilingual - CORRECTED goals positions"""
    c.setFont(FALLBACK_FONT + "-Bold", 14)
    draw_text(c, 30*mm, HEIGHT - 35*mm, "Rules · 규칙", CJK_FONT, 14)
    c.drawRightString(WIDTH - 30*mm, HEIGHT - 35*mm, "v0.3")
    
    y = HEIGHT - 50*mm
    
    # Setup - CORRECTED: Black goals d9/e9/f9, White goals d1/e1/f1
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    draw_text(c, 30*mm, y, "Setup · 초기 배치", CJK_FONT, 11)
    y -= 7*mm
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "EN — Pieces sit on squares (janggi-style). Black at bottom (rank 1), White at top")
    y -= 4*mm
    c.drawString(40*mm, y, "(rank 9). Black goals d9/e9/f9; White goals d1/e1/f1. Files a–i (left→right")
    y -= 4*mm
    c.drawString(40*mm, y, "from Black's view). Black king e1, White king e9. All 8 guards start in hand")
    y -= 4*mm
    c.drawString(40*mm, y, "(0 on board).")
    y -= 5*mm
    
    draw_text(c, 35*mm, y, "KO — 말은 칸 위(교점이 아닌 장기식). 흑은 아래(1단), 백은 위(9단). 흑 목적지", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 40*mm, y, "d9/e9/f9, 백 목적지 d1/e1/f1. 열은 a-i (흑 기준 왼→오). 초기 왕은 흑 e1,", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 40*mm, y, "백 e9. 호위 8개는 손에 들고 시작 (보드=0).", CJK_FONT, 9)
    
    y -= 8*mm
    
    # Turn
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    c.drawString(30*mm, y, "Turn")
    y -= 7*mm
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "Each turn, do exactly one: place one remaining guard, or move one of")
    y -= 4*mm
    c.drawString(35*mm, y, "your pieces — not both.")
    y -= 5*mm
    draw_text(c, 35*mm, y, "KO — 턴", CJK_FONT, 9)
    y -= 5*mm
    draw_text(c, 35*mm, y, "매 턴 하나만: 남은 호위 1개 두거나, 내 말 1개 옮기기. 둘 다 불가.", CJK_FONT, 9)
    y -= 8*mm
    
    # Movement
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    c.drawString(30*mm, y, "Movement")
    y -= 7*mm
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "• King ")
    draw_text(c, 52*mm, y, "王", CJK_FONT, 9)
    c.drawString(57*mm, y, ": one step orthogonally or diagonally (chess king). Cannot")
    y -= 4*mm
    c.drawString(37*mm, y, "capture squares.")
    y -= 4*mm
    c.drawString(35*mm, y, "• Guard ")
    draw_text(c, 54*mm, y, "衛", CJK_FONT, 9)
    c.drawString(59*mm, y, ": one step orthogonally. Captures by replacement: enemy")
    y -= 4*mm
    c.drawString(37*mm, y, "guards AND the enemy king (yes guards can take the king too).")
    y -= 4*mm
    c.drawString(35*mm, y, "• Guards cannot move onto goal squares, except when capturing a king")
    y -= 4*mm
    c.drawString(37*mm, y, "that is on a goal.")
    y -= 5*mm
    
    draw_text(c, 35*mm, y, "KO — 이동", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 왕 王: 8방향 (체스 킹식) 1칸. 잡지 못함.", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 호위 衛: 상하좌우 1칸. 상대 호위와 왕을 이동으로 잡음 (예: 호위는 왕을 잡을 수", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 37*mm, y, "있음).", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 호위는 목적지 칸에 들어갈 수 없지만 예외: 목적지 칸에 상대 왕이 있으면 잡을", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 37*mm, y, "수 있음.", CJK_FONT, 9)
    
    y -= 8*mm
    
    # Placement
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    c.drawString(30*mm, y, "Placement")
    y -= 7*mm
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "Empty square orthogonally adjacent to one of your pieces (including the")
    y -= 4*mm
    c.drawString(35*mm, y, "king). Guards cannot be placed on goal squares.")
    y -= 5*mm
    draw_text(c, 35*mm, y, "KO — 착수", CJK_FONT, 9)
    y -= 5*mm
    draw_text(c, 35*mm, y, "자기 말과 상하좌우로 맞닿은 빈 칸. 목적지 칸에는 호위를 둘 수 없음.", CJK_FONT, 9)
    y -= 8*mm
    
    # Winning & losing - CORRECTED: Black d9/e9/f9, White d1/e1/f1
    c.setFont(FALLBACK_FONT + "-Bold", 11)
    c.drawString(30*mm, y, "Winning & losing")
    y -= 7*mm
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawString(35*mm, y, "• Win: your king is on an enemy goal square at the end of your turn.")
    y -= 4*mm
    c.drawString(37*mm, y, "Black goals d9/e9/f9, White goals d1/e1/f1.")
    y -= 4*mm
    c.drawString(35*mm, y, "• Instant loss: your king is captured.")
    y -= 4*mm
    c.drawString(35*mm, y, "• Surround loss: if every orthogonal neighbor of your king is off-board")
    y -= 4*mm
    c.drawString(37*mm, y, "or occupied by an enemy piece, you lose (edge needs 3; corner needs")
    y -= 4*mm
    c.drawString(37*mm, y, "2).")
    y -= 4*mm
    c.drawString(35*mm, y, "• No moves: if you have no legal action on your turn, you lose.")
    y -= 4*mm
    c.drawString(35*mm, y, "• Guards cannot occupy goals — goals cannot be blocked by guards.")
    y -= 5*mm
    
    draw_text(c, 35*mm, y, "KO — 승패", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 승: 자기 턴 종료 시 왕이 상대 목적지 칸에 있을 때. 흑 목적지는 d9/e9/f9, 백", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 37*mm, y, "목적지는 d1/e1/f1.", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 즉시 패: 왕이 잡힘.", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 포위 패: 왕의 상하좌우가 모두 보드 밖이거나 상대 기물이 있으면 진다 (변은 3개,", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 37*mm, y, "구석은 2개).", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 수 없음 패: 합법적 행동이 없으면 패.", CJK_FONT, 9)
    y -= 4*mm
    draw_text(c, 35*mm, y, "• 호위는 목적지 칸에 들어갈 수 없음 — 목적지는 호위로 막지 못함.", CJK_FONT, 9)
    
    # Footer
    c.setFont(FALLBACK_FONT, 8)
    c.drawString(30*mm, 20*mm, "Mongjin / ")
    draw_text(c, 52*mm, 20*mm, "몽진 / 蒙塵", CJK_FONT, 8)
    c.drawString(75*mm, 20*mm, " · Designed by Oin Kwon, 2026")
    c.drawRightString(WIDTH - 30*mm, 20*mm, "https://kamilokwon.github.io/mongjin/")


def draw_page3_board(c):
    """Page 3: 9×9 board with goals and initial king positions"""
    # Title
    c.setFont(FALLBACK_FONT + "-Bold", 12)
    draw_text_centered(c, WIDTH/2, HEIGHT - 25*mm, "Board · 보드", CJK_FONT, 12)
    c.drawRightString(WIDTH - 30*mm, HEIGHT - 25*mm, "9×9")
    
    # Board dimensions
    board_size = 9
    cell_size = 18*mm
    board_width = board_size * cell_size
    board_height = board_size * cell_size
    
    # Center the board
    start_x = (WIDTH - board_width) / 2
    start_y = (HEIGHT - board_height) / 2 + 10*mm
    
    # Draw grid
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.5)
    
    for i in range(board_size + 1):
        # Vertical lines
        x = start_x + i * cell_size
        c.line(x, start_y, x, start_y + board_height)
        # Horizontal lines
        y = start_y + i * cell_size
        c.line(start_x, y, start_x + board_width, y)
    
    # Draw outer border thicker
    c.setLineWidth(2)
    c.rect(start_x, start_y, board_width, board_height)
    
    # Draw goal squares
    # Black goals (top): d9, e9, f9 (indices [8,3], [8,4], [8,5])
    # White goals (bottom): d1, e1, f1 (indices [0,3], [0,4], [0,5])
    c.setFillColorRGB(0.85, 0.85, 0.85)
    for col in [3, 4, 5]:
        # Black goals (top row)
        x = start_x + col * cell_size
        y = start_y + 8 * cell_size
        c.rect(x, y, cell_size, cell_size, fill=1, stroke=0)
        
        # White goals (bottom row)
        x = start_x + col * cell_size
        y = start_y
        c.rect(x, y, cell_size, cell_size, fill=1, stroke=0)
    
    # Re-draw grid lines over goals
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.5)
    for i in range(board_size + 1):
        x = start_x + i * cell_size
        c.line(x, start_y, x, start_y + board_height)
        y = start_y + i * cell_size
        c.line(start_x, y, start_x + board_width, y)
    
    # Draw king positions
    # White king at e1 (bottom, index [0,4])
    x = start_x + 4 * cell_size + cell_size/2
    y = start_y + cell_size/2 - 3*mm
    c.setFillColorRGB(0.9, 0.9, 0.9)
    c.circle(x, y, 6*mm, fill=1, stroke=1)
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.circle(x, y, 6*mm, fill=0, stroke=1)
    c.setFillColorRGB(0, 0, 0)
    draw_text_centered(c, x, y - 2.5*mm, "王", CJK_FONT, 16)
    
    # Black king at e9 (top, index [8,4])
    x = start_x + 4 * cell_size + cell_size/2
    y = start_y + 8 * cell_size + cell_size/2 - 3*mm
    c.setFillColorRGB(0.1, 0.1, 0.1)
    c.circle(x, y, 6*mm, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    draw_text_centered(c, x, y - 2.5*mm, "王", CJK_FONT, 16)
    
    # Labels
    c.setFillColorRGB(0, 0, 0)
    c.setFont(FALLBACK_FONT, 8)
    
    # File labels (a-i) at bottom
    for i, letter in enumerate('abcdefghi'):
        x = start_x + i * cell_size + cell_size/2
        c.drawCentredString(x, start_y - 6*mm, letter)
    
    # Rank labels (1-9) on left
    for i in range(board_size):
        y = start_y + i * cell_size + cell_size/2 - 1.5*mm
        c.drawRightString(start_x - 4*mm, y, str(i + 1))
    
    # Footer
    c.setFont(FALLBACK_FONT, 8)
    c.drawString(30*mm, 20*mm, "Black goals d9, e9, f9 · ")
    draw_text(c, 75*mm, 20*mm, "흑 목적지 d9/e9/f9", CJK_FONT, 8)
    c.drawRightString(WIDTH - 30*mm, 20*mm, "White goals d1, e1, f1 · ")
    draw_text(c, WIDTH - 85*mm, 20*mm, "백 목적지 d1/e1/f1", CJK_FONT, 8)
    c.drawCentredString(WIDTH/2, 15*mm, "Pieces on squares (not intersections) · ")
    draw_text(c, WIDTH/2 + 52*mm, 15*mm, "말은 교점이 아닌 칸 위.", CJK_FONT, 8)
    c.drawCentredString(WIDTH/2, 10*mm, "Print at 100% on A4.")


def draw_page4_pieces(c):
    """Page 4: Punch-out kings and guards"""
    c.setFont(FALLBACK_FONT + "-Bold", 12)
    draw_text_centered(c, WIDTH/2, HEIGHT - 25*mm, "Pieces · 말 펀치 아웃", CJK_FONT, 12)
    
    c.setFont(FALLBACK_FONT, 9)
    c.drawCentredString(WIDTH/2, HEIGHT - 32*mm, "Cut along dashed circles. Kings show ")
    draw_text(c, WIDTH/2 + 60*mm, HEIGHT - 32*mm, "王", CJK_FONT, 9)
    c.drawString(WIDTH/2 + 65*mm, HEIGHT - 32*mm, ", guards show ")
    draw_text(c, WIDTH/2 + 92*mm, HEIGHT - 32*mm, "衛", CJK_FONT, 9)
    c.drawString(WIDTH/2 + 97*mm, HEIGHT - 32*mm, ". · ")
    draw_text(c, WIDTH/2 + 103*mm, HEIGHT - 32*mm, "점선 원을 따라 잘라 주세요.", CJK_FONT, 9)
    
    # Piece radius
    piece_radius = 12*mm
    
    # Kings: 1 each
    y_kings = HEIGHT - 60*mm
    
    # Black king
    c.setFillColorRGB(0, 0, 0)
    c.circle(WIDTH/3, y_kings, piece_radius, fill=1, stroke=0)
    c.setStrokeColorRGB(0.5, 0.5, 0.5)
    c.setLineWidth(0.5)
    c.setDash(2, 2)
    c.circle(WIDTH/3, y_kings, piece_radius + 1*mm, fill=0, stroke=1)
    c.setDash()
    
    c.setFillColorRGB(1, 1, 1)
    draw_text_centered(c, WIDTH/3, y_kings - 7*mm, "王", CJK_FONT, 20)
    c.setFont(FALLBACK_FONT, 8)
    c.drawCentredString(WIDTH/3, y_kings - 15*mm, "BLACK")
    
    # White king
    c.setFillColorRGB(1, 1, 1)
    c.circle(2*WIDTH/3, y_kings, piece_radius, fill=1, stroke=1)
    c.setStrokeColorRGB(0.5, 0.5, 0.5)
    c.setLineWidth(0.5)
    c.setDash(2, 2)
    c.circle(2*WIDTH/3, y_kings, piece_radius + 1*mm, fill=0, stroke=1)
    c.setDash()
    
    c.setFillColorRGB(0, 0, 0)
    draw_text_centered(c, 2*WIDTH/3, y_kings - 7*mm, "王", CJK_FONT, 20)
    c.setFont(FALLBACK_FONT, 8)
    c.drawCentredString(2*WIDTH/3, y_kings - 15*mm, "WHITE")
    
    # Guards: 8 + 2 spares each
    y_start = HEIGHT - 110*mm
    x_spacing = 30*mm
    y_spacing = 30*mm
    
    # Black guards (8 + 2 spares)
    c.setFont(FALLBACK_FONT, 7)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(30*mm, HEIGHT - 95*mm, "Black guards · ")
    draw_text(c, 64*mm, HEIGHT - 95*mm, "흑 호위 (衛)", CJK_FONT, 7)
    c.drawString(93*mm, HEIGHT - 95*mm, " — 8 — 2 spares")
    
    for i in range(10):
        col = i % 5
        row = i // 5
        x = 40*mm + col * x_spacing
        y = y_start - row * y_spacing
        
        c.setFillColorRGB(0, 0, 0)
        c.circle(x, y, piece_radius, fill=1, stroke=0)
        c.setStrokeColorRGB(0.5, 0.5, 0.5)
        c.setLineWidth(0.5)
        c.setDash(2, 2)
        c.circle(x, y, piece_radius + 1*mm, fill=0, stroke=1)
        c.setDash()
        
        c.setFillColorRGB(1, 1, 1)
        draw_text_centered(c, x, y - 5*mm, "衛", CJK_FONT, 16)
        
        # Mark spares
        if i >= 8:
            c.setFont(FALLBACK_FONT, 6)
            c.drawCentredString(x, y - 12*mm, "spare")
    
    # White guards (8 + 2 spares)
    y_start_white = HEIGHT - 200*mm
    c.setFont(FALLBACK_FONT, 7)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(30*mm, HEIGHT - 185*mm, "White guards · ")
    draw_text(c, 64*mm, HEIGHT - 185*mm, "백 호위 (衛)", CJK_FONT, 7)
    c.drawString(93*mm, HEIGHT - 185*mm, " — 8 — 2 spares")
    
    for i in range(10):
        col = i % 5
        row = i // 5
        x = 40*mm + col * x_spacing
        y = y_start_white - row * y_spacing
        
        c.setFillColorRGB(1, 1, 1)
        c.circle(x, y, piece_radius, fill=1, stroke=1)
        c.setStrokeColorRGB(0.5, 0.5, 0.5)
        c.setLineWidth(0.5)
        c.setDash(2, 2)
        c.circle(x, y, piece_radius + 1*mm, fill=0, stroke=1)
        c.setDash()
        
        c.setFillColorRGB(0, 0, 0)
        draw_text_centered(c, x, y - 5*mm, "衛", CJK_FONT, 16)
        
        # Mark spares
        if i >= 8:
            c.setFont(FALLBACK_FONT, 6)
            c.drawCentredString(x, y - 12*mm, "spare")
    
    # Footer
    c.setFont(FALLBACK_FONT, 8)
    c.setFillColorRGB(0, 0, 0)
    c.drawString(30*mm, 20*mm, "Tip · ")
    draw_text(c, 40*mm, 20*mm, "팁", CJK_FONT, 8)
    c.drawString(45*mm, 20*mm, " — High-contrast tokens: filled black vs outlined white. If printing B&W only,")
    c.drawString(30*mm, 15*mm, "mark one side with a dot on the reverse. Optional mounts: cardboard, wood discs, or two")
    c.drawString(30*mm, 10*mm, "colors of go stones / coins. · ")
    draw_text(c, 82*mm, 10*mm, "선택 재료: 병뚜껑, 나무 말, 바둑돌, 동전 두 색.", CJK_FONT, 8)


def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else "mongjin-print-and-play.pdf"
    
    c = canvas.Canvas(output_path, pagesize=A4)
    
    # Page 1: Cover and print instructions
    draw_page1_cover(c)
    c.showPage()
    
    # Page 2: Rules v0.3
    draw_page2_rules(c)
    c.showPage()
    
    # Page 3: 9×9 board
    draw_page3_board(c)
    c.showPage()
    
    # Page 4: Pieces
    draw_page4_pieces(c)
    c.showPage()
    
    c.save()
    print(f"PDF created: {output_path}")
    file_size = os.path.getsize(output_path)
    print(f"File size: {file_size} bytes ({file_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
