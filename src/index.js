require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const { DEFAULT_COLLECTIONS, createModels } = require("./models");
const { createS3ClientFromEnv, uploadWebpSet } = require("./s3Webp");
const {
  buildReviewQuery,
  getS3KeyFromPath,
  isConvertibleImagePath,
  isVideoPath,
  isWebpPath,
  parseBoolean,
  parseDate,
  parsePositiveInt,
  serializeError,
} = require("./utils");

const REQUIRED_ENV = [
  "MONGO_DB_CONNECTION_STRING",
  "MONGO_DB_USERNAME",
  "MONGO_DB_PASSWORD",
  "MONGO_DB_NAME",
  "AWS_BUCKET_S3",
  "AWS_DEFAULT_REGION_S3",
  "AWS_ACCESS_KEY_ID_S3",
  "AWS_SECRET_ACCESS_KEY_S3",
];

let MigrationAudit;
let Review;
let ReviewMedia;
let collectionNames;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipDbUpdate: false,
    deleteOriginals: false,
    limit: null,
    batchSize: parsePositiveInt(process.env.MIGRATION_BATCH_SIZE, 50),
    concurrency: parsePositiveInt(process.env.MIGRATION_CONCURRENCY, 3),
    webpQuality: parsePositiveInt(process.env.IMAGE_WEBP_QUALITY, 80),
    reviewCollectionName:
      process.env.REVIEW_COLLECTION_NAME || DEFAULT_COLLECTIONS.review,
    reviewMediaCollectionName:
      process.env.REVIEW_MEDIA_COLLECTION_NAME || DEFAULT_COLLECTIONS.reviewMedia,
    auditCollectionName:
      process.env.AUDIT_COLLECTION_NAME || DEFAULT_COLLECTIONS.audit,
    reviewId: null,
    since: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--skip-db-update") {
      args.skipDbUpdate = true;
      continue;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument format: ${arg}`);

    const [, key, value] = match;
    switch (key) {
      case "limit":
        args.limit = parsePositiveInt(value, null, "--limit");
        break;
      case "batch-size":
        args.batchSize = parsePositiveInt(value, null, "--batch-size");
        break;
      case "concurrency":
        args.concurrency = parsePositiveInt(value, null, "--concurrency");
        break;
      case "review-collection":
        args.reviewCollectionName = value;
        break;
      case "review-media-collection":
        args.reviewMediaCollectionName = value;
        break;
      case "audit-collection":
        args.auditCollectionName = value;
        break;
      case "review-id":
        args.reviewId = value;
        break;
      case "since":
        args.since = parseDate(value, "--since");
        break;
      case "dry-run":
        args.dryRun = parseBoolean(value, true);
        break;
      case "skip-db-update":
        args.skipDbUpdate = parseBoolean(value, true);
        break;
      case "delete-originals":
        args.deleteOriginals = parseBoolean(value, false);
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (args.deleteOriginals) {
    throw new Error("--delete-originals=true is intentionally unsupported in v1");
  }
  if (args.webpQuality > 100) {
    throw new Error("IMAGE_WEBP_QUALITY must be between 1 and 100");
  }

  return args;
}

function validateEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
}

async function connectMongo() {
  await mongoose.connect(process.env.MONGO_DB_CONNECTION_STRING, {
    user: process.env.MONGO_DB_USERNAME,
    pass: process.env.MONGO_DB_PASSWORD,
    dbName: process.env.MONGO_DB_NAME,
  });
}

function createStats() {
  return {
    scannedReviews: 0,
    candidateReviews: 0,
    convertedImages: 0,
    existingWebpSets: 0,
    skippedWebp: 0,
    skippedVideos: 0,
    skippedUnsupportedImages: 0,
    dbUpdatedReviews: 0,
    s3OnlyReviews: 0,
    failedConversions: 0,
    failedDbUpdates: 0,
  };
}

async function appendAuditLog(entry) {
  const logsDir = path.join(process.cwd(), "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "review-media-webp-migration.jsonl");
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function upsertAudit(entry, args) {
  const now = new Date();
  const auditEntry = {
    ...entry,
    dry_run: args.dryRun,
    skip_db_update: args.skipDbUpdate,
    review_collection: collectionNames.review,
    review_media_collection: collectionNames.reviewMedia,
    updated_at: now,
  };

  await appendAuditLog({ ...auditEntry, at: now.toISOString() });

  if (args.dryRun) return;

  await MigrationAudit.updateOne(
    { review_id: entry.review_id, old_path: entry.old_path },
    {
      $set: auditEntry,
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );
}

function classifyMediaPath(mediaPath) {
  if (isVideoPath(mediaPath)) return "video";
  if (isWebpPath(mediaPath)) return "webp";
  if (isConvertibleImagePath(mediaPath)) return "convertible";
  return "unsupported";
}

function collectReviewMediaWork(review, stats) {
  const mediaPaths = Array.isArray(review.media_paths) ? review.media_paths : [];
  const work = [];

  for (const mediaPath of mediaPaths) {
    const kind = classifyMediaPath(mediaPath);
    if (kind === "convertible") work.push(mediaPath);
    else if (kind === "webp") stats.skippedWebp += 1;
    else if (kind === "video") stats.skippedVideos += 1;
    else stats.skippedUnsupportedImages += 1;
  }

  return work;
}

function applyPathMapping(mediaPaths, mapping) {
  return mediaPaths.map((mediaPath) => mapping.get(mediaPath) || mediaPath);
}

async function updateReviewReferences(review, mapping) {
  const newMediaPaths = applyPathMapping(review.media_paths, mapping);
  await Review.updateOne(
    { _id: review._id },
    { $set: { media_paths: newMediaPaths } },
  );

  const writes = [...mapping.entries()].map(([oldPath, newPath]) => ({
    updateOne: {
      filter: {
        review_id: review._id,
        source_path: oldPath,
        type: "image",
      },
      update: { $set: { source_path: newPath } },
    },
  }));

  if (writes.length > 0) {
    await ReviewMedia.bulkWrite(writes, { ordered: false });
  }
}

async function processReview(review, context) {
  const { args, s3Client, stats } = context;
  stats.scannedReviews += 1;

  const work = collectReviewMediaWork(review, stats);
  if (work.length === 0) return;

  stats.candidateReviews += 1;

  if (args.dryRun) {
    for (const oldPath of work) {
      const newPath = `${getS3KeyFromPath(oldPath).replace(/\.[^.]+$/, "")}.webp`;
      await upsertAudit({
        review_id: review._id,
        old_path: oldPath,
        new_path: newPath,
        status: "dry_run",
      }, args);
      console.log(`[dry-run] review=${review._id} ${oldPath} -> ${newPath}`);
    }
    return;
  }

  const mapping = new Map();
  const conversions = [];

  for (const oldPath of work) {
    try {
      const result = await uploadWebpSet({
        s3Client,
        bucket: process.env.AWS_BUCKET_S3,
        oldPath,
        quality: args.webpQuality,
      });

      mapping.set(oldPath, result.newKey);
      conversions.push({ oldPath, result });

      if (result.status === "existing_webp") stats.existingWebpSets += 1;
      else stats.convertedImages += 1;

      await upsertAudit({
        review_id: review._id,
        old_path: oldPath,
        new_path: result.newKey,
        variant_keys: result.variantKeys,
        status: args.skipDbUpdate ? "s3_ready_db_skipped" : "s3_ready",
        width: result.width,
        height: result.height,
      }, args);
    } catch (error) {
      stats.failedConversions += 1;
      await upsertAudit({
        review_id: review._id,
        old_path: oldPath,
        status: "conversion_failed",
        error: serializeError(error),
      }, args);
      console.error(`[conversion-failed] review=${review._id} path=${oldPath} error=${error.message}`);
      return;
    }
  }

  if (args.skipDbUpdate) {
    stats.s3OnlyReviews += 1;
    console.log(`[s3-only] review=${review._id} images=${conversions.length}`);
    return;
  }

  try {
    await updateReviewReferences(review, mapping);
    stats.dbUpdatedReviews += 1;

    for (const conversion of conversions) {
      await upsertAudit({
        review_id: review._id,
        old_path: conversion.oldPath,
        new_path: conversion.result.newKey,
        variant_keys: conversion.result.variantKeys,
        status: "db_updated",
        width: conversion.result.width,
        height: conversion.result.height,
      }, args);
    }

    console.log(`[db-updated] review=${review._id} images=${conversions.length}`);
  } catch (error) {
    stats.failedDbUpdates += 1;
    for (const conversion of conversions) {
      await upsertAudit({
        review_id: review._id,
        old_path: conversion.oldPath,
        new_path: conversion.result.newKey,
        variant_keys: conversion.result.variantKeys,
        status: "db_update_failed",
        width: conversion.result.width,
        height: conversion.result.height,
        error: serializeError(error),
      }, args);
    }
    console.error(`[db-update-failed] review=${review._id} error=${error.message}`);
  }
}

async function processWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex]);
      }
    }),
  );
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  ({ MigrationAudit, Review, ReviewMedia, collectionNames } = createModels({
    review: args.reviewCollectionName,
    reviewMedia: args.reviewMediaCollectionName,
    audit: args.auditCollectionName,
  }));
  validateEnv();

  console.log(
    `Starting review media WebP migrator mode=${args.dryRun ? "dry-run" : "migrate"} reviewCollection=${collectionNames.review} reviewMediaCollection=${collectionNames.reviewMedia} auditCollection=${collectionNames.audit} limit=${args.limit ?? "none"} batchSize=${args.batchSize} concurrency=${args.concurrency} skipDbUpdate=${args.skipDbUpdate}`,
  );

  await connectMongo();
  if (!args.dryRun) {
    await MigrationAudit.init();
  }

  const s3Client = createS3ClientFromEnv();
  const stats = createStats();
  const query = buildReviewQuery(args);
  const cursor = Review.find(query).lean().batchSize(args.batchSize).cursor();

  let batch = [];
  let remaining = args.limit;

  for await (const review of cursor) {
    if (remaining !== null && remaining <= 0) break;
    batch.push(review);
    if (remaining !== null) remaining -= 1;

    if (batch.length >= args.batchSize) {
      await processWithConcurrency(batch, args.concurrency, (item) =>
        processReview(item, { args, s3Client, stats }),
      );
      batch = [];
    }
  }

  if (batch.length > 0) {
    await processWithConcurrency(batch, args.concurrency, (item) =>
      processReview(item, { args, s3Client, stats }),
    );
  }

  console.log("Migration summary:");
  console.table(stats);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
