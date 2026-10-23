#!/usr/bin/env python3
"""Rebuild a read-only Supabase JSONB export from ordered CSV chunks."""

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    csv.field_size_limit(100_000_000)
    with args.csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    required = {"user_id", "updated_at", "total_chars", "part_no", "payload_chunk"}
    if not rows or not required.issubset(rows[0]):
        raise SystemExit("CSV 缺少预期的分块导出字段")

    rows.sort(key=lambda row: int(row["part_no"]))
    part_numbers = [int(row["part_no"]) for row in rows]
    expected_parts = list(range(1, len(rows) + 1))
    if part_numbers != expected_parts:
        raise SystemExit(f"分块序号不连续: {part_numbers[:5]} ... {part_numbers[-5:]}")

    user_ids = {row["user_id"] for row in rows}
    updated_values = {row["updated_at"] for row in rows}
    total_values = {int(row["total_chars"]) for row in rows}
    if len(user_ids) != 1 or len(updated_values) != 1 or len(total_values) != 1:
        raise SystemExit("分块元数据不一致")

    payload = "".join(row["payload_chunk"] for row in rows)
    expected_length = next(iter(total_values))
    if len(payload) != expected_length:
        raise SystemExit(f"JSON 文本长度不符: {len(payload)} != {expected_length}")

    document = json.loads(payload)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_path = output_dir / "cloud-workbench-data.raw.json"
    export_path = output_dir / "cloud-workbench-export.json"
    metadata_path = output_dir / "cloud-workbench-export.metadata.json"

    raw_bytes = payload.encode("utf-8")
    raw_path.write_bytes(raw_bytes)
    envelope = {
        "user_id": next(iter(user_ids)),
        "updated_at": next(iter(updated_values)),
        "data": document,
    }
    export_path.write_text(
        json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    metadata = {
        "source_csv": str(args.csv_path.resolve()),
        "source_csv_bytes": args.csv_path.stat().st_size,
        "source_csv_sha256": sha256_file(args.csv_path),
        "user_id": envelope["user_id"],
        "updated_at": envelope["updated_at"],
        "parts": len(rows),
        "json_text_chars": len(payload),
        "json_text_utf8_bytes": len(raw_bytes),
        "raw_json_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "raw_json_path": str(raw_path),
        "comparison_export_path": str(export_path),
    }
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
