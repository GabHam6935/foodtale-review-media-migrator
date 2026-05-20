require("dotenv").config();

const mongoose = require("mongoose");
const { DEFAULT_COLLECTIONS, createModels } = require("./models");
const { createS3ClientFromEnv, verifyWebpSet } = require("./s3Webp");
const { getS3KeyFromPath, parsePositiveInt } = require("./utils");

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
    limit: 20,
    reviewCollectionName:
      process.env.REVIEW_COLLECTION_NAME || DEFAULT_COLLECTIONS.review,
    reviewMediaCollectionName:
      process.env.REVIEW_MEDIA_COLLECTION_NAME || DEFAULT_COLLECTIONS.reviewMedia,
    auditCollectionName:
      process.env.AUDIT_COLLECTION_NAME || DEFAULT_COLLECTIONS.audit,
    reviewId: null,
  };

  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument format: ${arg}`);

    const [, key, value] = match;
    switch (key) {
      case "limit":
        args.limit = parsePositiveInt(value, null, "--limit");
        break;
      case "review-id":
        args.reviewId = value;
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
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
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

async function verifyAuditRecord(record, s3Client) {
  const review = await Review.findById(record.review_id).lean();
  const reviewHasNewPath = !!review?.media_paths?.includes(record.new_path);
  const mediaDoc = await ReviewMedia.findOne({
    review_id: record.review_id,
    source_path: record.new_path,
    type: "image",
  }).lean();
  const s3Result = await verifyWebpSet({
    s3Client,
    bucket: process.env.AWS_BUCKET_S3,
    baseKey: getS3KeyFromPath(record.new_path),
  });

  return {
    review_id: String(record.review_id),
    old_path: record.old_path,
    new_path: record.new_path,
    reviewHasNewPath,
    reviewMediaUpdated: !!mediaDoc,
    s3Ok: s3Result.ok,
    width: s3Result.width,
    height: s3Result.height,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  ({ MigrationAudit, Review, ReviewMedia, collectionNames } = createModels({
    review: args.reviewCollectionName,
    reviewMedia: args.reviewMediaCollectionName,
    audit: args.auditCollectionName,
  }));
  validateEnv();
  await connectMongo();

  console.log(
    `Verifying review media WebP migration reviewCollection=${collectionNames.review} reviewMediaCollection=${collectionNames.reviewMedia} auditCollection=${collectionNames.audit} limit=${args.limit}`,
  );

  const s3Client = createS3ClientFromEnv();
  const query = { status: "db_updated" };
  if (args.reviewId) query.review_id = args.reviewId;

  const records = await MigrationAudit.find(query)
    .sort({ updated_at: -1 })
    .limit(args.limit)
    .lean();

  if (records.length === 0) {
    console.log("No db_updated audit records found to verify.");
    return;
  }

  const results = [];
  for (const record of records) {
    results.push(await verifyAuditRecord(record, s3Client));
  }

  console.table(results);

  const failed = results.filter(
    (result) => !result.reviewHasNewPath || !result.reviewMediaUpdated || !result.s3Ok,
  );

  if (failed.length > 0) {
    throw new Error(`Verification failed for ${failed.length} record(s)`);
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
