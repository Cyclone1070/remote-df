#!/usr/bin/env python3
import sys
import json
import numpy as np
from PIL import Image

def compare(host_path, client_path, diff_out_path, tolerance=2):
    host_img = Image.open(host_path).convert("RGB")
    client_img = Image.open(client_path).convert("RGB")

    # Resize host if needed (should already be 1280x720)
    if host_img.size != client_img.size:
        host_img = host_img.resize(client_img.size, Image.Resampling.NEAREST)

    h_arr = np.array(host_img, dtype=np.int16)
    c_arr = np.array(client_img, dtype=np.int16)

    diff = np.abs(h_arr - c_arr)
    max_delta = int(np.max(diff))
    mean_delta = float(np.mean(diff))

    exact_mismatches = np.any(diff > 0, axis=2)
    tol_mismatches = np.any(diff > tolerance, axis=2)

    total_pixels = h_arr.shape[0] * h_arr.shape[1]
    exact_mismatch_count = int(np.sum(exact_mismatches))
    tol_mismatch_count = int(np.sum(tol_mismatches))

    exact_match_pct = (1.0 - exact_mismatch_count / total_pixels) * 100.0
    tol_match_pct = (1.0 - tol_mismatch_count / total_pixels) * 100.0

    # Generate visual diff image: client image dimmed + neon magenta (#FF00FF) on mismatches
    diff_vis = (c_arr // 3).astype(np.uint8)
    diff_vis[tol_mismatches] = [255, 0, 255]
    Image.fromarray(diff_vis).save(diff_out_path)

    result = {
        "width": h_arr.shape[1],
        "height": h_arr.shape[0],
        "total_pixels": total_pixels,
        "exact_match_pct": round(exact_match_pct, 3),
        "tol_match_pct": round(tol_match_pct, 3),
        "exact_mismatch_count": exact_mismatch_count,
        "tol_mismatch_count": tol_mismatch_count,
        "max_delta": max_delta,
        "mean_delta": round(mean_delta, 4),
        "diff_path": diff_out_path
    }
    print(json.dumps(result))

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: qa_pixel_comparator.py <host.png> <client.png> <diff.png> [tolerance]")
        sys.exit(1)
    tol = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    compare(sys.argv[1], sys.argv[2], sys.argv[3], tol)
