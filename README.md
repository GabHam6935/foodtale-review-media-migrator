# Foodtale Review Media WebP Migrator

Standalone migrator for converting old review image media to WebP while keeping each media item attached to the same existing review.

The migrator reads the configured review collection and `review_medias`, uploads WebP base plus `_small`, `_medium`, and `_large` variants to S3, then updates only the existing review `media_paths` entries and matching `review_medias.source_path` references after all image uploads for a review succeed.

It does not delete original JPEG/PNG files in v1.

## Setup

```bash
npm install
```

Create `.env` from `.env.example` and fill in the values.

Required values:

- `MONGO_DB_CONNECTION_STRING`
- `MONGO_DB_USERNAME`
- `MONGO_DB_PASSWORD`
- `MONGO_DB_NAME`
- `AWS_BUCKET_S3`
- `AWS_DEFAULT_REGION_S3`
- `AWS_ACCESS_KEY_ID_S3`
- `AWS_SECRET_ACCESS_KEY_S3`

Optional defaults:

- `IMAGE_WEBP_QUALITY=80`
- `MIGRATION_BATCH_SIZE=50`
- `MIGRATION_CONCURRENCY=3`
- `REVIEW_COLLECTION_NAME=reviews`
- `REVIEW_MEDIA_COLLECTION_NAME=review_medias`
- `AUDIT_COLLECTION_NAME=review_media_webp_migrations`

## Commands

Dry run without S3 uploads or DB writes:

```bash
npm run dry-run -- --limit=10
```

S3-only rehearsal. Uploads WebP objects and writes audit records, but does not update `reviews` or `review_medias`:

```bash
npm run migrate -- --limit=5 --skip-db-update
```

Run against a copied review collection such as `reviews_test`:

```bash
npm run migrate -- --review-collection=reviews_test --limit=50
```

Run one review end-to-end:

```bash
npm run migrate -- --review-id=<reviewId> --concurrency=1
```

Verify migrated references and S3 WebP objects:

```bash
npm run verify -- --review-id=<reviewId>
```

Use the same collection flags when verifying a non-default collection:

```bash
npm run verify -- --review-collection=reviews_test --limit=20
```

## Flags

- `--limit=1000` limits how many source reviews are scanned.
- `--batch-size=50` controls Mongo cursor batch size and local processing chunks.
- `--concurrency=3` controls parallel review processing.
- `--review-collection=reviews_test` overrides `REVIEW_COLLECTION_NAME`.
- `--review-media-collection=review_medias` overrides `REVIEW_MEDIA_COLLECTION_NAME`.
- `--audit-collection=review_media_webp_migrations` overrides `AUDIT_COLLECTION_NAME`.
- `--review-id=<mongoId>` only scans one review.
- `--since=2025-01-01` only scans reviews created on or after the given date.
- `--dry-run` logs intended work without S3 uploads or DB writes.
- `--skip-db-update` uploads WebP objects but skips `reviews` and `review_medias` updates.
- `--delete-originals=false` is accepted for explicit safety; `true` is rejected in v1.

## Behavior

The migrator processes only `media_paths` entries with image extensions `.jpg`, `.jpeg`, `.png`, `.heic`, or `.heif`. It skips videos, existing `.webp` paths, and unsupported image formats such as GIF.

For each convertible image, it creates:

- base `.webp`, max width `2048`
- `_small.webp`, width `300`
- `_medium.webp`, width `800`
- `_large.webp`, width `1200`

All resizing uses Sharp `rotate()` and `withoutEnlargement`, matching the backend upload convention.

## Safety

A review DB update happens only after every convertible image for that review has uploaded or already exists as valid WebP. If any image fails conversion/upload, the review references are left untouched.

The migrator does not create replacement review documents and does not delete original JPEG/PNG S3 objects. It preserves the review document and `media_paths` array shape, replacing only convertible image path values with their WebP path. Unsupported media, video paths, existing WebP paths, and other document fields remain unchanged.

Audit logs are written to:

```text
logs/review-media-webp-migration.jsonl
```

Mongo audit records are stored in `review_media_webp_migrations`, keyed by `review_id + old_path`.
