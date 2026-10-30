"""Read-only product catalog audit and reversible SKU backfill helpers."""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from bson import json_util
from dotenv import load_dotenv
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / ".env.multicompany")

COMPANIES = {
    "superiqfoam": "SUPERIQFOAM",
    "iqfoam-manufactoring": "IQFOAM MANUFACTURING",
    "iqfoam-whole-sallers": "IQFOAM WHOLESALERS",
}
SKU_PREFIXES = {"superiqfoam": "SFO", "iqfoam-manufactoring": "MFG", "iqfoam-whole-sallers": "WHL"}
DIMENSIONS_PATTERN = re.compile(r"^\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?$", re.I)


def connection():
    uri = os.environ.get("MONGO_URL")
    name = os.environ.get("DB_NAME")
    if not uri or not name:
        raise RuntimeError("MONGO_URL and DB_NAME must be configured")
    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    return client, client[name]


def ean13_is_valid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{13}", value):
        return False
    checksum = sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(value[:12]))
    return (10 - checksum % 10) % 10 == int(value[-1])


def collect_audit(base_db):
    identities = list(base_db.product_identifications.find({}, {"_id": 0}))
    by_company = defaultdict(list)
    duplicate_values = defaultdict(lambda: defaultdict(list))
    for identity in identities:
        company_id = identity.get("company_id")
        by_company[company_id].append(identity)
        for field in ("product_id", "sku", "qr_payload", "ean13", "data_matrix_payload"):
            value = identity.get(field)
            if value:
                duplicate_values[field][value].append(identity)

    anomalies = []
    naming_variants = []
    dimension_variants = []
    repeated_product_candidates = []
    company_summary = {}
    for company_id, company_name in COMPANIES.items():
        database_name = (
            base_db.name if company_id == "superiqfoam"
            else f"{base_db.name}__{company_id}"
        )
        stock_records = list(base_db.client[database_name].stock.find({}, {"_id": 0}))
        stock_by_id = {item.get("id"): item for item in stock_records}
        company_identities = by_company.get(company_id, [])
        company_summary[company_id] = {
            "company": company_name,
            "products": len(stock_records),
            "identified_products": len(company_identities),
            "missing_sku": sum(not item.get("sku") for item in company_identities),
            "inactive_products": sum(item.get("active") is False for item in company_identities),
        }

        names = defaultdict(set)
        dimensions = defaultdict(set)
        repeated = defaultdict(list)
        for stock in stock_records:
            name = stock.get("product") or ""
            size = stock.get("size") or ""
            if name.strip():
                names[name.strip().casefold()].add(name.strip())
            if size.strip():
                dimensions[size.strip().casefold()].add(size.strip())
            if name.strip() and size.strip():
                repeated[(name.strip().casefold(), size.strip().casefold())].append(stock)
        for normalized, variants in names.items():
            if len(variants) > 1:
                naming_variants.append({
                    "company": company_name, "normalized_name": normalized,
                    "variants": sorted(variants),
                })
        for normalized, variants in dimensions.items():
            if len(variants) > 1:
                dimension_variants.append({
                    "company": company_name, "normalized_dimensions": normalized,
                    "variants": sorted(variants),
                })
        for key, records in repeated.items():
            if len(records) > 1:
                repeated_product_candidates.append({
                    "company": company_name,
                    "product": key[0],
                    "dimensions": key[1],
                    "stock_ids": sorted(record["id"] for record in records),
                    "product_ids": sorted(
                        record.get("product_id", "") for record in records if record.get("product_id")
                    ),
                    "review_only": True,
                })

        for identity in company_identities:
            stock = stock_by_id.get(identity.get("stock_id"))
            issues = []
            if not identity.get("product_id"):
                issues.append("missing_product_id")
            if not identity.get("qr_payload"):
                issues.append("missing_qr_payload")
            if not stock:
                issues.append("stock_record_missing")
            else:
                if not str(stock.get("product") or "").strip():
                    issues.append("missing_product_name")
                elif str(stock["product"]).strip().casefold() in {"test", "tst", "temp", "n/a"}:
                    issues.append("suspicious_product_name_review")
                if not str(stock.get("size") or "").strip():
                    issues.append("missing_dimensions")
                elif not DIMENSIONS_PATTERN.fullmatch(str(stock["size"]).strip()):
                    issues.append("nonstandard_dimensions_format")
                if stock.get("product_id") and stock["product_id"] != identity.get("product_id"):
                    issues.append("stock_product_id_mismatch")
            if identity.get("ean13") and not ean13_is_valid(identity["ean13"]):
                issues.append("invalid_ean13")
            if identity.get("qr_payload") and identity.get("product_id"):
                expected_qr = f"IQF1:{str(identity['product_id']).upper()}"
                if identity["qr_payload"] != expected_qr:
                    issues.append("nonstandard_qr_payload_review")
            if issues:
                anomalies.append({
                    "company": company_name,
                    "product_id": identity.get("product_id"),
                    "stock_id": identity.get("stock_id"),
                    "product": (stock or {}).get("product"),
                    "dimensions": (stock or {}).get("size"),
                    "issues": issues,
                })
        identified_stock_ids = {item.get("stock_id") for item in company_identities}
        for stock in stock_records:
            if stock.get("id") not in identified_stock_ids:
                anomalies.append({
                    "company": company_name,
                    "product_id": stock.get("product_id"),
                    "stock_id": stock.get("id"),
                    "product": stock.get("product"),
                    "dimensions": stock.get("size"),
                    "issues": ["product_identification_missing"],
                })

    for company_id, records in by_company.items():
        if company_id not in COMPANIES:
            for identity in records:
                anomalies.append({
                    "company": company_id,
                    "product_id": identity.get("product_id"),
                    "stock_id": identity.get("stock_id"),
                    "issues": ["invalid_company_owner"],
                })

    duplicates = {
        field: [
            {"value": value, "count": len(records),
             "product_ids": [item.get("product_id") for item in records],
             "companies": [item.get("company_id") for item in records]}
            for value, records in values.items() if len(records) > 1
        ]
        for field, values in duplicate_values.items()
    }
    duplicates = {field: values for field, values in duplicates.items() if values}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database": base_db.name,
        "summary": {
            "total_identifications": len(identities),
            "per_company": company_summary,
            "missing_product_names": sum("missing_product_name" in a["issues"] for a in anomalies),
            "missing_dimensions": sum("missing_dimensions" in a["issues"] for a in anomalies),
            "missing_qr_payloads": sum(not item.get("qr_payload") for item in identities),
            "missing_ean13": sum(not item.get("ean13") for item in identities),
            "missing_data_matrix": sum(not item.get("data_matrix_payload") for item in identities),
            "invalid_or_incomplete_records": len(anomalies),
            "inactive_products": sum(item.get("active") is False for item in identities),
            "duplicate_codes": duplicates,
            "repeated_name_dimension_candidates": len(repeated_product_candidates),
            "naming_variants": len(naming_variants),
            "dimension_format_variants": len(dimension_variants),
        },
        "anomalies": anomalies,
        "repeated_name_dimension_candidates": repeated_product_candidates,
        "naming_variants": naming_variants,
        "dimension_format_variants": dimension_variants,
    }


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json_util.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def product_sku(company_id, product_id):
    prefix = SKU_PREFIXES.get(company_id)
    suffix = re.sub(r"[^A-Z0-9]", "", str(product_id).upper().removeprefix("IQF"))
    if not prefix or not suffix:
        raise ValueError(f"Cannot create SKU for company={company_id!r}, product_id={product_id!r}")
    return f"{prefix}-{suffix}"


def migrate_skus(base_db, backup_dir):
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / "product-identifications.before-sku-migration.json"
    manifest_path = backup_dir / "sku-migration-manifest.json"
    if backup_path.exists() or manifest_path.exists():
        raise FileExistsError("Backup or migration manifest already exists; choose an empty backup directory")

    collection = base_db.product_identifications
    before = list(collection.find({}))
    planned = []
    existing_skus = set()
    existing_sku_count = 0
    for identity in before:
        sku = identity.get("sku")
        if sku:
            existing_sku_count += 1
            existing_skus.add(sku)
    if len(existing_skus) != existing_sku_count:
        raise RuntimeError("Existing duplicate SKUs must be manually reviewed before migration")
    for identity in before:
        if "sku" in identity:
            continue
        candidate = product_sku(identity.get("company_id"), identity.get("product_id"))
        if candidate in existing_skus:
            raise RuntimeError(f"Generated SKU conflicts with an existing code: {candidate}")
        existing_skus.add(candidate)
        planned.append({"id": identity["id"], "sku": candidate})

    write_json(backup_path, before)
    if len(list(json_util.loads(backup_path.read_text(encoding="utf-8")))) != len(before):
        raise RuntimeError("Product identification backup verification failed")

    manifest = {
        "database": base_db.name,
        "collection": "product_identifications",
        "backup_file": backup_path.name,
        "record_count_before": len(before),
        "status": "applying",
        "assignments": planned,
        "applied": [],
    }
    write_json(manifest_path, manifest)
    for assignment in planned:
        result = collection.update_one(
            {"id": assignment["id"], "sku": {"$exists": False}},
            {"$set": {"sku": assignment["sku"]}},
        )
        if result.modified_count != 1:
            raise RuntimeError(
                f"SKU migration stopped at {assignment['id']}; backup and manifest permit a safe rollback"
            )
        manifest["applied"].append(assignment)
        write_json(manifest_path, manifest)
    manifest["status"] = "complete"
    write_json(manifest_path, manifest)
    return {"updated": len(manifest["applied"]), "total_before": len(before), "backup": str(backup_path)}


def rollback_skus(base_db, backup_dir):
    backup_dir = Path(backup_dir)
    manifest_path = backup_dir / "sku-migration-manifest.json"
    manifest = json_util.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("database") != base_db.name or manifest.get("collection") != "product_identifications":
        raise RuntimeError("Backup manifest does not match the configured product database")
    collection = base_db.product_identifications
    conflicts = []
    assignments_to_remove = []
    for assignment in manifest.get("applied", []):
        current = collection.find_one({"id": assignment["id"]}, {"_id": 0, "sku": 1})
        if not current:
            conflicts.append(assignment["id"])
        elif current.get("sku") == assignment["sku"]:
            assignments_to_remove.append(assignment)
        elif "sku" not in current:
            continue
        else:
            conflicts.append(assignment["id"])
    if conflicts:
        raise RuntimeError(
            f"Rollback made no changes; {len(conflicts)} records changed since migration and need manual review"
        )
    removed = 0
    for assignment in assignments_to_remove:
        result = collection.update_one(
            {"id": assignment["id"], "sku": assignment["sku"]},
            {"$unset": {"sku": ""}},
        )
        if result.modified_count != 1:
            raise RuntimeError(
                f"Rollback stopped at {assignment['id']}; a concurrent edit requires manual review"
            )
        removed += 1
    manifest["status"] = "rolled_back"
    write_json(manifest_path, manifest)
    return {"removed": removed, "status": manifest["status"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    audit_parser = subparsers.add_parser("audit", help="Run a read-only product quality audit")
    audit_parser.add_argument("--output", required=True)
    migrate_parser = subparsers.add_parser("migrate-sku", help="Backfill stable SKUs after a verified backup")
    migrate_parser.add_argument("--backup-dir", required=True)
    rollback_parser = subparsers.add_parser("rollback-sku", help="Remove only SKUs created by the recorded migration")
    rollback_parser.add_argument("--backup-dir", required=True)
    args = parser.parse_args()

    client, base_db = connection()
    try:
        if args.command == "audit":
            report = collect_audit(base_db)
            write_json(args.output, report)
            print(json.dumps(report["summary"], indent=2))
            print(f"Report written to {args.output}")
        elif args.command == "migrate-sku":
            print(json.dumps(migrate_skus(base_db, args.backup_dir), indent=2))
        else:
            print(json.dumps(rollback_skus(base_db, args.backup_dir), indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Product catalog maintenance failed: {error}", file=sys.stderr)
        raise
