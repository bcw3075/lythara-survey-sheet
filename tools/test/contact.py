"""Contact sheets of encounter maps across terrains.
   python3 contact.py seasons 0.02,0.3,0.55,0.8      -> every terrain x those year fractions
   python3 contact.py slider trees|brush|rocks|water|relief|decay   -> every terrain x -1/0/+1
   Spots come from spots.json ({"name": ["sheetA.json", x, y], ...}); find them with find.js."""
import json, subprocess, sys, os
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
spots = json.load(open(os.path.join(os.environ.get("TEST_DATA", os.path.join(HERE, "data")), "spots.json")))
mode, arg = sys.argv[1], sys.argv[2]
cols = [float(v) for v in arg.split(",")] if mode == "seasons" else [-1, 0, 1]
jobs = []
for name, (data, x, y) in spots.items():
    for v in cols:
        j = {"name": f"c_{name}_{v}".replace(" ", "_"), "data": data, "cx": x + .031, "cy": y + .027, "cols": 30, "rows": 30, "pxSq": 16, "style": "real",
             "yearFrac": v if mode == "seasons" else .55, "tune": {} if mode == "seasons" else {arg: v}}
        jobs.append(j)
subprocess.run(["node", os.path.join(HERE, "render.js"), json.dumps(jobs), OUT], check=True)
w = 480; names = list(spots)
o = Image.new("RGB", (150 + len(cols) * (w + 8), 50 + len(names) * (w + 8)), "white"); dr = ImageDraw.Draw(o)
for c, v in enumerate(cols): dr.text((150 + c * (w + 8) + 10, 10), f"{arg if mode == 'slider' else 'year'} {v}", fill="black", font_size=28)
for r, n in enumerate(names):
    dr.text((8, 50 + r * (w + 8) + w // 2), n, fill="black", font_size=24)
    for c, v in enumerate(cols): o.paste(Image.open(os.path.join(OUT, f"c_{n}_{v}".replace(" ", "_") + ".jpg")).resize((w, w)), (150 + c * (w + 8), 50 + r * (w + 8)))
o.save(os.path.join(OUT, f"contact_{mode}_{arg.replace(',', '_')}.jpg"), quality=82); print("saved", os.path.join(OUT, f"contact_{mode}_{arg.replace(',', '_')}.jpg"))
