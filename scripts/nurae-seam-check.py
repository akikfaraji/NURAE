#!/usr/bin/env python3
"""NURAE loader v3 — seam identity check: mean pixel diff between two frames
of the same timeline position (seek(2.0) vs seek(14.0) — modulo maps to 2.0).
Grain is a wall-clock CSS animation, so a tiny diff is expected."""
import sys
from PIL import Image

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print(f'SIZE MISMATCH {a.size} vs {b.size}')
    sys.exit(1)
pa, pb = a.tobytes(), b.tobytes()
n = len(pa)
diff = sum(abs(pa[i] - pb[i]) for i in range(0, n, 7)) / (n / 7)
print(f'mean abs diff: {diff:.3f} / 255  ->  {"SEAM OK" if diff < 4 else "SEAM FAIL"}')
