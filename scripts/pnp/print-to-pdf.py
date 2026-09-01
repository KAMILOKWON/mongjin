#!/usr/bin/env python3
"""
Print mongjin-print-and-play.html to PDF using Playwright/Chromium
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

async def print_to_pdf():
    html_path = Path(__file__).parent / "mongjin-print-and-play.html"
    pdf_path = Path(__file__).parent.parent.parent / "public" / "mongjin-print-and-play.pdf"
    
    print(f"📄 HTML input: {html_path}")
    print(f"📦 PDF output: {pdf_path}")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        
        # Load HTML
        await page.goto(f"file://{html_path.resolve()}")
        
        # Wait for fonts to load
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(2000)  # Extra wait for web fonts
        
        # Print to PDF
        await page.pdf(
            path=str(pdf_path),
            format="A4",
            print_background=True,
            margin={
                "top": "0mm",
                "right": "0mm",
                "bottom": "0mm",
                "left": "0mm"
            }
        )
        
        await browser.close()
    
    # Check file size
    size = pdf_path.stat().st_size
    print(f"✅ PDF created: {size:,} bytes ({size / 1024:.1f} KB)")
    return pdf_path

if __name__ == "__main__":
    asyncio.run(print_to_pdf())
