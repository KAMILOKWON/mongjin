#!/usr/bin/env python3
"""
Create Print & Play PDF for Mongjin - Rules v0.3
Rebuilt from scratch to match original quality
Uses Noto Serif KR for full CJK support (Hangul + Hanja)

CRITICAL FIXES:
- Page 3: Only faint empty circles at start positions (no filled kings)
- Movement: "Cannot capture — empty squares only"
- Footer spacing: Measured y-positions, no overlap
- Hanja rendering: 蒙塵, 王, 衛 all visible using Noto Serif KR

Designer: Oin Kwon, 2026
Public URL: https://kamilokwon.github.io/mongjin/
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import sys
import os

WIDTH, HEIGHT = A4  # 210mm x 297mm

# Register fonts - Noto Serif KR has full Hangul + Hanja coverage
FONT_PATH = '/tmp/fonts/NotoSerifKR.ttf'
if os.path.exists(FONT_PATH):
    pdfmetrics.registerFont(TTFont('CJKFont', FONT_PATH))
    CJK_FONT = 'CJKFont'
    print(f"✓ Loaded Noto Serif KR from {FONT_PATH}")
else:
    CJK_FONT = 'Helvetica'
    print(f"⚠ Warning: Noto Serif KR not found, using Helvetica")

LATIN_FONT = 'Helvetica'
LATIN_FONT_BOLD = 'Helvetica-Bold'


def draw_text(c, x, y, text, font=None, size=10):
    """Draw text with automatic font selection"""
    if font is None:
        # Use CJK font for any text containing CJK characters
        if any(ord(ch) > 127 for ch in text):
            font = CJK_FONT
        else:
            font = LATIN_FONT
    c.setFont(font, size)
    c.drawString(x, y, text)


def draw_text_centered(c, x, y, text, font=None, size=10):
    """Draw centered text"""
    if font is None:
        if any(ord(ch) > 127 for ch in text):
            font = CJK_FONT
        else:
            font = LATIN_FONT
    c.setFont(font, size)
    c.drawCentredString(x, y, text)


def draw_page1_cover(c):
    """Page 1: Cover - matching original layout"""
    
    # Title - Hanja (large, centered)
    c.setFont(CJK_FONT, 24)
    c.drawCentredString(WIDTH/2, HEIGHT - 50*mm, "蒙塵")
    
    # Korean title
    c.setFont(CJK_FONT, 18)
    c.drawCentredString(WIDTH/2, HEIGHT - 60*mm, "몽진")
    
    # English subtitle
    c.setFont(LATIN_FONT, 14)
    c.drawCentredString(WIDTH/2, HEIGHT - 72*mm, "Mongjin")
    
    # Description (bilingual)
    c.setFont(CJK_FONT, 10)
    c.drawCentredString(WIDTH/2, HEIGHT - 85*mm, "KO — 임금이 난리를 피해 도망을 떠나다. 왕의 피난.")
    c.setFont(LATIN_FONT, 10)
    c.drawCentredString(WIDTH/2, HEIGHT - 92*mm, "EN — The king's flight from the capital. Escort your king to an")
    c.drawCentredString(WIDTH/2, HEIGHT - 99*mm, "enemy goal before your opponent does.")
    
    # Game info box
    y = HEIGHT - 120*mm
    left_col = 35*mm
    right_col = 65*mm
    
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_col, y, "Players")
    c.setFont(CJK_FONT, 10)
    c.drawString(right_col, y, "2 · 2인")
    
    y -= 7*mm
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_col, y, "Type")
    c.setFont(CJK_FONT, 10)
    c.drawString(right_col, y, "Abstract strategy · 추상 전략")
    
    y -= 7*mm
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_col, y, "Board")
    c.setFont(LATIN_FONT, 10)
    c.drawString(right_col, y, "9×9")
    
    y -= 7*mm
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_col, y, "Year")
    c.setFont(LATIN_FONT, 10)
    c.drawString(right_col, y, "2026")
    
    y -= 7*mm
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_col, y, "Designer")
    c.setFont(LATIN_FONT, 10)
    c.drawString(right_col, y, "Oin Kwon")
    
    # What to print section
    y -= 15*mm
    c.setFont(LATIN_FONT_BOLD, 11)
    c.setFont(CJK_FONT, 11)
    c.drawString(left_col, y, "What to print · 무엇을 인쇄할까")
    
    y -= 8*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "• Page 3 — one 9×9 board")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 5*mm, y, "3쪽 — 9×9 보드 1장")
    
    y -= 7*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "• Page 4 — 2 kings (")
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 41*mm, y, "王")
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 45*mm, y, ") + 16 guards (")
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 74*mm, y, "衛")
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 78*mm, y, ")")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 5*mm, y, "4쪽 — 왕 2 + 호위 16 (각 진영 왕 1, 호위 8)")
    
    y -= 7*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "• Pages 1–2 — keep as reference")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 5*mm, y, "1–2쪽 — 조립 규칙 참고용")
    
    # How to assemble
    y -= 10*mm
    c.setFont(CJK_FONT, 11)
    c.drawString(left_col, y, "How to assemble · 조립 방법")
    
    y -= 8*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "1. Print pages 3 and 4 (and optionally 1–2).")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 7*mm, y, "3+4쪽을 인쇄합니다 (1–2쪽은 선택).")
    
    y -= 7*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "2. Cut out the circular tokens along the dashed")
    y -= 4.5*mm
    c.drawString(left_col + 7*mm, y, "guides.")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 7*mm, y, "점선 가이드를 따라 원형 돌을 오립니다.")
    
    y -= 7*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "3. Optional: glue tokens onto cardboard or bottle")
    y -= 4.5*mm
    c.drawString(left_col + 7*mm, y, "caps for weight.")
    y -= 4.5*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 7*mm, y, "선택: 글루건이나 병뚜껑에 돌을 부착해")
    y -= 4.5*mm
    c.drawString(left_col + 7*mm, y, "무게를 줍니다.")
    
    y -= 6*mm
    c.setFont(LATIN_FONT, 9)
    c.drawString(left_col + 3*mm, y, "4. No scissors? Use two colors of coins/")
    y -= 4.5*mm
    c.drawString(left_col + 7*mm, y, "stones as kings & guards.")
    y -= 4*mm
    c.setFont(CJK_FONT, 9)
    c.drawString(left_col + 7*mm, y, "가위가 없다면 돌을 바둑돌 두 색으로")
    y -= 4*mm
    c.drawString(left_col + 7*mm, y, "대체 가능.")
    
    # Also play online box - BELOW step 4 with 8mm empty space
    y -= 8*mm  # 8mm clearance
    c.setFont(CJK_FONT, 10)
    c.drawString(left_col, y, "Also play online · 온라인으로도 플레이하세요")
    y -= 5.5*mm
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_col + 3*mm, y, "Optional web client (not required):")
    y -= 4*mm
    c.setFillColorRGB(0, 0, 0.7)
    c.setFont(LATIN_FONT, 7)
    c.drawString(left_col + 3*mm, y, "https://studiozzg.com/mongjin")
    c.setFillColorRGB(0, 0, 0)
    
    # Footer - BELOW online box with 8mm empty space (calculated, not hardcoded)
    y -= 8*mm  # 8mm clearance from last online line
    footer_y = y
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, footer_y, "Mongjin print-and-play · Oin Kwon, 2026")
    c.drawRightString(WIDTH - 30*mm, footer_y, "Rules v0.3")
    c.setFont(LATIN_FONT, 6)
    c.drawCentredString(WIDTH/2, footer_y - 4*mm, "https://studiozzg.com/mongjin")


def draw_page2_rules(c):
    """Page 2: Rules v0.3"""
    # Header
    c.setFont(LATIN_FONT_BOLD, 14)
    c.setFont(CJK_FONT, 14)
    c.drawString(30*mm, HEIGHT - 30*mm, "Rules · 규칙")
    c.setFont(LATIN_FONT, 12)
    c.drawRightString(WIDTH - 30*mm, HEIGHT - 30*mm, "v0.3")
    
    y = HEIGHT - 45*mm
    left_margin = 30*mm
    
    # Setup
    c.setFont(LATIN_FONT_BOLD, 10)
    c.setFont(CJK_FONT, 10)
    c.drawString(left_margin, y, "Setup · 초기 배치")
    y -= 6*mm
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "EN — Pieces sit on squares (janggi-style). Black at bottom (rank 1), White at")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "top (rank 9). Black goals d9/e9/f9; White goals d1/e1/f1. Files a–i (left")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "→right from Black's view). Black king e1, White king e9. All 8 guards")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "start in hand (0 on board).")
    y -= 4*mm
    
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "KO — 말은 칸 위(교점 아님, 장기식). 흑 아래(1단), 백 위(9단). 흑 목적지")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "d9/e9/f9, 백 목적지 d1/e1/f1. 열 a-i (흑 기준 왼→오). 초기 왕은 흑 e1,")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "백 e9. 호위 8개는 손에 들고 시작 (보드=0).")
    
    y -= 7*mm
    
    # Turn
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_margin, y, "Turn")
    y -= 6*mm
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "Each turn, do exactly one: place one remaining guard, or move one of your")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "pieces — not both.")
    y -= 4*mm
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "KO — 턴")
    y -= 4*mm
    c.drawString(left_margin + 3*mm, y, "매 턴 하나만: 남은 호위 1개 두거나, 내 말 1개 옮기기. 둘 다 불가.")
    
    y -= 7*mm
    
    # Movement - CRITICAL FIX
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_margin, y, "Movement")
    y -= 6*mm
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "• King ")
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 16*mm, y, "王")
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 20*mm, y, ": one step orthogonally or diagonally (chess king).")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "Cannot capture — empty squares only.")
    y -= 3.5*mm
    
    c.drawString(left_margin + 3*mm, y, "• Guard ")
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 18*mm, y, "衛")
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 22*mm, y, ": one step orthogonally. Captures by replacement:")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "enemy guards AND the enemy king (yes guards can take the king).")
    y -= 3.5*mm
    
    c.drawString(left_margin + 3*mm, y, "• Guards cannot move onto goal squares, except when capturing a king")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "that is on a goal.")
    y -= 4*mm
    
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "KO — 이동")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 왕 王: 8방향 (체스 킹식) 1칸. 잡지 못함.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 호위 衛: 상하좌우 1칸. 상대 호위와 왕을 이동으로 잡음 (예: 호위는 왕")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "을 잡을 수 있음).")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 호위는 목적지 칸에 들어갈 수 없지만 예외: 목적지 칸에 상대 왕이 있")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "으면 잡을 수 있음.")
    
    y -= 7*mm
    
    # Placement
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_margin, y, "Placement")
    y -= 6*mm
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "Empty square orthogonally adjacent to one of your pieces (including the")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "king). Guards cannot be placed on goal squares.")
    y -= 4*mm
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "KO — 착수")
    y -= 4*mm
    c.drawString(left_margin + 3*mm, y, "자기 말과 상하좌우로 맞닿은 빈 칸. 목적지 칸에는 호위를 둘 수 없음.")
    
    y -= 7*mm
    
    # Winning & losing
    c.setFont(LATIN_FONT_BOLD, 10)
    c.drawString(left_margin, y, "Winning & losing")
    y -= 6*mm
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "• Win: your king is on an enemy goal square at the end of your turn.")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "Black goals d9/e9/f9, White goals d1/e1/f1.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• Instant loss: your king is captured.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• Surround loss: if every orthogonal neighbor of your king is off-board")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "or occupied by an enemy piece, you lose (edge needs 3; corner needs 2).")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• No moves: if you have no legal action on your turn, you lose.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• Guards cannot occupy goals — goals cannot be blocked by guards.")
    y -= 4*mm
    
    c.setFont(CJK_FONT, 8)
    c.drawString(left_margin + 3*mm, y, "KO — 승패")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 승: 자기 턴 종료 시 왕이 상대 목적지 칸에 있을 때. 흑 목적지는 d9/e9/f9,")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "백 목적지는 d1/e1/f1.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 즉시 패: 왕이 잡힘.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 포위 패: 왕의 상하좌우가 모두 보드 밖이거나 상대 기물이 있으면 진다")
    y -= 3.5*mm
    c.drawString(left_margin + 6*mm, y, "(변은 3개, 구석은 2개).")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 수 없음 패: 합법적 행동이 없으면 패.")
    y -= 3.5*mm
    c.drawString(left_margin + 3*mm, y, "• 호위는 목적지 칸에 들어갈 수 없음 — 목적지는 호위로 막지 못함.")
    
    # Footer - measured position, no overlap
    footer_y = 18*mm
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, footer_y, "Mongjin / ")
    c.setFont(CJK_FONT, 7)
    c.drawString(54*mm, footer_y, "몽진 / 蒙塵")
    c.setFont(LATIN_FONT, 7)
    c.drawString(82*mm, footer_y, " · Designed by Oin Kwon, 2026")
    c.setFont(LATIN_FONT, 6)
    c.drawRightString(WIDTH - 30*mm, footer_y, "https://studiozzg.com/mongjin")


def draw_page3_board(c):
    """Page 3: 9×9 board with goals and start marks - FIXED"""
    # Title
    c.setFont(LATIN_FONT_BOLD, 12)
    c.setFont(CJK_FONT, 12)
    c.drawCentredString(WIDTH/2, HEIGHT - 20*mm, "Board · 보드")
    c.setFont(LATIN_FONT, 10)
    c.drawRightString(WIDTH - 30*mm, HEIGHT - 20*mm, "9×9")
    
    # Board setup
    board_size = 9
    cell_size = 18*mm
    board_width = board_size * cell_size
    board_height = board_size * cell_size
    
    start_x = (WIDTH - board_width) / 2
    start_y = (HEIGHT - board_height) / 2 + 8*mm
    
    # Draw goal squares FIRST (before grid)
    c.setFillColorRGB(0.88, 0.88, 0.88)
    # Black goals (top): d9, e9, f9
    for col in [3, 4, 5]:
        x = start_x + col * cell_size
        y = start_y + 8 * cell_size
        c.rect(x, y, cell_size, cell_size, fill=1, stroke=0)
    
    c.setFillColorRGB(0.93, 0.93, 0.93)
    # White goals (bottom): d1, e1, f1
    for col in [3, 4, 5]:
        x = start_x + col * cell_size
        y = start_y
        c.rect(x, y, cell_size, cell_size, fill=1, stroke=0)
    
    # Draw grid
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.5)
    for i in range(board_size + 1):
        x = start_x + i * cell_size
        c.line(x, start_y, x, start_y + board_height)
        y = start_y + i * cell_size
        c.line(start_x, y, start_x + board_width, y)
    
    # Draw outer border thicker
    c.setLineWidth(2)
    c.rect(start_x, start_y, board_width, board_height)
    
    # Draw king start marks - ONLY faint empty circles, NO filled 王
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.setLineWidth(0.8)
    c.setFillColor(colors.white)
    
    # Black king starts at e1 (bottom, col=4, row=0)
    x = start_x + 4 * cell_size + cell_size/2
    y = start_y + cell_size/2
    c.circle(x, y, 5.5*mm, fill=0, stroke=1)
    
    # White king starts at e9 (top, col=4, row=8)
    x = start_x + 4 * cell_size + cell_size/2
    y = start_y + 8 * cell_size + cell_size/2
    c.circle(x, y, 5.5*mm, fill=0, stroke=1)
    
    # File labels (a-i) - TOP AND BOTTOM
    c.setFillColorRGB(0, 0, 0)
    c.setFont(LATIN_FONT, 8)
    for i, letter in enumerate('abcdefghi'):
        x = start_x + i * cell_size + cell_size/2
        c.drawCentredString(x, start_y - 5*mm, letter)  # bottom
        c.drawCentredString(x, start_y + board_height + 2*mm, letter)  # top
    
    # Rank labels (1-9) - LEFT AND RIGHT
    for i in range(board_size):
        y = start_y + i * cell_size + cell_size/2 - 1.5*mm
        c.drawRightString(start_x - 3*mm, y, str(i + 1))  # left
        c.drawString(start_x + board_width + 3*mm, y, str(i + 1))  # right
    
    # Legend - CLEAR, no garbled text
    footer_y = 20*mm
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, footer_y, "Black goals d9/e9/f9 (")
    c.setFont(CJK_FONT, 7)
    c.drawString(72*mm, footer_y, "흑 목적지")
    c.setFont(LATIN_FONT, 7)
    c.drawString(90*mm, footer_y, ") · White goals d1/e1/f1 (")
    c.setFont(CJK_FONT, 7)
    c.drawString(WIDTH - 60*mm, footer_y, "백 목적지")
    c.setFont(LATIN_FONT, 7)
    c.drawString(WIDTH - 42*mm, footer_y, ")")
    
    footer_y -= 4*mm
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, footer_y, "King starts: e1 (")
    c.setFont(CJK_FONT, 7)
    c.drawString(60*mm, footer_y, "흑")
    c.setFont(LATIN_FONT, 7)
    c.drawString(66*mm, footer_y, ") and e9 (")
    c.setFont(CJK_FONT, 7)
    c.drawString(88*mm, footer_y, "백")
    c.setFont(LATIN_FONT, 7)
    c.drawString(94*mm, footer_y, ") · Pieces on squares, not intersections")
    
    footer_y -= 4*mm
    c.setFont(LATIN_FONT, 7)
    c.drawCentredString(WIDTH/2, footer_y, "Print at 100% on A4. · A4 실제 크기 100% 인쇄.")


def draw_page4_pieces(c):
    """Page 4: Punch-out pieces with 王 and 衛"""
    # Header
    c.setFont(LATIN_FONT_BOLD, 11)
    c.setFont(CJK_FONT, 11)
    c.drawCentredString(WIDTH/2, HEIGHT - 22*mm, "Pieces · 말 펀치 아웃")
    
    c.setFont(LATIN_FONT, 8)
    c.drawString(35*mm, HEIGHT - 29*mm, "Cut along dashed circles. Kings show ")
    c.setFont(CJK_FONT, 8)
    c.drawString(108*mm, HEIGHT - 29*mm, "王")
    c.setFont(LATIN_FONT, 8)
    c.drawString(112*mm, HEIGHT - 29*mm, ", guards show ")
    c.setFont(CJK_FONT, 8)
    c.drawString(144*mm, HEIGHT - 29*mm, "衛")
    c.setFont(LATIN_FONT, 8)
    c.drawString(148*mm, HEIGHT - 29*mm, ".")
    c.setFont(CJK_FONT, 8)
    c.drawCentredString(WIDTH/2, HEIGHT - 34*mm, "점선 원을 따라 자르세요. 왕은 王를, 호위는 衛를 표시합니다.")
    
    piece_radius = 12*mm
    
    # Kings
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
    c.setFont(CJK_FONT, 20)
    c.drawCentredString(WIDTH/3, y_kings - 6*mm, "王")
    c.setFont(LATIN_FONT, 8)
    c.drawCentredString(WIDTH/3, y_kings - 16*mm, "BLACK")
    
    # White king
    c.setFillColorRGB(1, 1, 1)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(1)
    c.circle(2*WIDTH/3, y_kings, piece_radius, fill=1, stroke=1)
    c.setStrokeColorRGB(0.5, 0.5, 0.5)
    c.setLineWidth(0.5)
    c.setDash(2, 2)
    c.circle(2*WIDTH/3, y_kings, piece_radius + 1*mm, fill=0, stroke=1)
    c.setDash()
    
    c.setFillColorRGB(0, 0, 0)
    c.setFont(CJK_FONT, 20)
    c.drawCentredString(2*WIDTH/3, y_kings - 6*mm, "王")
    c.setFont(LATIN_FONT, 8)
    c.drawCentredString(2*WIDTH/3, y_kings - 16*mm, "WHITE")
    
    # Black guards
    y_start = HEIGHT - 105*mm
    x_spacing = 30*mm
    y_spacing = 30*mm
    
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, HEIGHT - 90*mm, "Black guards · ")
    c.setFont(CJK_FONT, 7)
    c.drawString(64*mm, HEIGHT - 90*mm, "흑 호위 (衛)")
    c.setFont(LATIN_FONT, 7)
    c.drawString(93*mm, HEIGHT - 90*mm, " — 8 — 2 spares")
    
    for i in range(10):  # 8 + 2 spares
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
        c.setFont(CJK_FONT, 16)
        c.drawCentredString(x, y - 5*mm, "衛")
        
        if i >= 8:
            c.setFont(LATIN_FONT, 6)
            c.drawCentredString(x, y - 13*mm, "spare")
    
    # White guards
    y_start_white = HEIGHT - 195*mm
    
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, HEIGHT - 180*mm, "White guards · ")
    c.setFont(CJK_FONT, 7)
    c.drawString(64*mm, HEIGHT - 180*mm, "백 호위 (衛)")
    c.setFont(LATIN_FONT, 7)
    c.drawString(93*mm, HEIGHT - 180*mm, " — 8 — 2 spares")
    
    for i in range(10):
        col = i % 5
        row = i // 5
        x = 40*mm + col * x_spacing
        y = y_start_white - row * y_spacing
        
        c.setFillColorRGB(1, 1, 1)
        c.setStrokeColorRGB(0, 0, 0)
        c.setLineWidth(1)
        c.circle(x, y, piece_radius, fill=1, stroke=1)
        c.setStrokeColorRGB(0.5, 0.5, 0.5)
        c.setLineWidth(0.5)
        c.setDash(2, 2)
        c.circle(x, y, piece_radius + 1*mm, fill=0, stroke=1)
        c.setDash()
        
        c.setFillColorRGB(0, 0, 0)
        c.setFont(CJK_FONT, 16)
        c.drawCentredString(x, y - 5*mm, "衛")
        
        if i >= 8:
            c.setFont(LATIN_FONT, 6)
            c.drawCentredString(x, y - 13*mm, "spare")
    
    # Footer
    footer_y = 20*mm
    c.setFont(LATIN_FONT, 7)
    c.drawString(30*mm, footer_y, "Tip · ")
    c.setFont(CJK_FONT, 7)
    c.drawString(40*mm, footer_y, "팁")
    c.setFont(LATIN_FONT, 7)
    c.drawString(45*mm, footer_y, " — High-contrast tokens: filled black vs outlined white.")
    footer_y -= 3.5*mm
    c.drawString(30*mm, footer_y, "If printing B&W, mark one side with a dot. Optional mounts: cardboard,")
    footer_y -= 3.5*mm
    c.drawString(30*mm, footer_y, "bottle caps, wood discs, or two colors of go stones / coins. · ")
    c.setFont(CJK_FONT, 7)
    c.drawString(125*mm, footer_y, "선택 재료: 병뚜껑, 나무, 바둑돌, 동전.")


def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else "mongjin-print-and-play.pdf"
    
    c = canvas.Canvas(output_path, pagesize=A4)
    
    print("Generating pages...")
    
    draw_page1_cover(c)
    c.showPage()
    print("  ✓ Page 1: Cover")
    
    draw_page2_rules(c)
    c.showPage()
    print("  ✓ Page 2: Rules")
    
    draw_page3_board(c)
    c.showPage()
    print("  ✓ Page 3: Board")
    
    draw_page4_pieces(c)
    c.showPage()
    print("  ✓ Page 4: Pieces")
    
    c.save()
    print(f"\n✓ PDF created: {output_path}")
    
    file_size = os.path.getsize(output_path)
    print(f"  File size: {file_size:,} bytes ({file_size / 1024:.1f} KB)")
    
    # Verify font
    print(f"  CJK font: {CJK_FONT}")


if __name__ == "__main__":
    main()
