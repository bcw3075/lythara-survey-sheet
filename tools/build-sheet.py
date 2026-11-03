#!/usr/bin/env python3
"""Paste the module's shared land code into the Survey Sheet page.

The sheet page keeps the block between /*SHARED-BEGIN*/ and /*SHARED-END*/ in step with
scripts/land.mjs, scripts/survey.mjs, scripts/story.mjs and paintGround from scripts/render.mjs,
so the sheet and the module draw the same land. Usage: build-sheet.py <sheet.html> [out.html]
"""
import re, sys, pathlib

here = pathlib.Path(__file__).resolve().parent.parent / "scripts"

def strip(src):
    src = re.sub(r"^import .*?;\n", "", src, flags=re.M)
    src = re.sub(r"^export (const|function|async function|let) ", r"\1 ", src, flags=re.M)
    return src

def main():
    page = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else page
    html = page.read_text(encoding="utf8")
    land = strip((here / "land.mjs").read_text(encoding="utf8"))
    survey = strip((here / "survey.mjs").read_text(encoding="utf8"))
    story = strip((here / "story.mjs").read_text(encoding="utf8"))
    render = (here / "render.mjs").read_text(encoding="utf8")
    i = render.index("const TBL"); j = render.index("/** Render a whole sheet")
    ground = strip(render[i:j])
    block = "/*SHARED-BEGIN*/\n/* Shared with the Foundry module. Rebuild with tools/build-sheet.py; do not edit here. */\n" + land + "\n" + survey + "\n" + story + "\n" + ground + "\n/*SHARED-END*/"
    a = html.index("/*SHARED-BEGIN*/"); b = html.index("/*SHARED-END*/") + len("/*SHARED-END*/")
    out.write_text(html[:a] + block + html[b:], encoding="utf8")
    print(f"wrote {out} ({len(block)} shared bytes)")

if __name__ == "__main__":
    main()
