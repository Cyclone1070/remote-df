#!/usr/bin/env python3
import sys
import os
import json
from PIL import Image
import numpy as np

def compare_frames(host_path, client_path, diff_path=None):
    # Host frame may be raw RGBA bytes or PNG
    if host_path.endswith('.raw'):
        with open(host_path, 'rb') as f:
            raw_data = f.read()
        expected_len = 1280 * 720 * 4
        if len(raw_data) < expected_len:
            raise ValueError(f"Host raw frame {host_path} is incomplete: {len(raw_data)} < {expected_len}")
        host_arr = np.frombuffer(raw_data[:expected_len], dtype=np.uint8).reshape((720, 1280, 4))
    else:
        host_img = Image.open(host_path).convert('RGBA')
        host_arr = np.array(host_img)

    client_img = Image.open(client_path).convert('RGBA')
    client_arr = np.array(client_img)

    if host_arr.shape != client_arr.shape:
        raise ValueError(f"Shape mismatch: host={host_arr.shape}, client={client_arr.shape}")

    # Exact bit-level difference on RGB channels (alpha can be ignored if opaque or compared)
    # Compare RGB
    diff_rgb = np.abs(host_arr[:, :, :3].astype(np.int32) - client_arr[:, :, :3].astype(np.int32))
    max_delta_per_pixel = np.max(diff_rgb, axis=2)

    total_pixels = host_arr.shape[0] * host_arr.shape[1]
    mismatch_mask = max_delta_per_pixel > 0
    mismatch_count = int(np.sum(mismatch_mask))
    exact_match_pct = float((total_pixels - mismatch_count) / total_pixels * 100.0)
    max_delta = int(np.max(max_delta_per_pixel))
    mean_delta = float(np.mean(max_delta_per_pixel))

    if diff_path and mismatch_count > 0:
        os.makedirs(os.path.dirname(os.path.abspath(diff_path)), exist_ok=True)
        # Visual diff: black for matching, red/white amplified for mismatch
        vis_diff = np.zeros_like(host_arr)
        vis_diff[:, :, 0] = np.clip(max_delta_per_pixel * 10, 0, 255).astype(np.uint8)
        vis_diff[:, :, 1] = 0
        vis_diff[:, :, 2] = 0
        vis_diff[:, :, 3] = 255
        Image.fromarray(vis_diff).save(diff_path)

    result = {
        "width": int(host_arr.shape[1]),
        "height": int(host_arr.shape[0]),
        "total_pixels": total_pixels,
        "exact_match_pct": round(exact_match_pct, 5),
        "mismatch_count": mismatch_count,
        "max_delta": max_delta,
        "mean_delta": round(mean_delta, 5),
        "diff_path": diff_path if mismatch_count > 0 else None
    }
    return result

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: qa_frame_comparator.py <host_path> <client_path> [diff_path]")
        sys.exit(1)
    
    host_p = sys.argv[1]
    client_p = sys.argv[2]
    diff_p = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        res = compare_frames(host_p, client_p, diff_p)
        print(json.dumps(res, indent=2))
        sys.exit(0 if res["mismatch_count"] == 0 else 2)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
