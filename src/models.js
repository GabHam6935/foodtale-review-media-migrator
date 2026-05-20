const mongoose = require("mongoose");

const DEFAULT_COLLECTIONS = Object.freeze({
  review: "reviews",
  reviewMedia: "review_medias",
  audit: "review_media_webp_migrations",
});

function normalizeCollectionName(value, fallback, label) {
  const collectionName = String(value || fallback || "").trim();
  if (!collectionName) {
    throw new Error(`${label} collection name cannot be empty`);
  }
  if (collectionName.includes("$") || collectionName.includes("\0")) {
    throw new Error(`${label} collection name cannot contain '$' or null bytes`);
  }
  return collectionName;
}

function modelName(baseName, collectionName) {
  return `${baseName}_${collectionName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function createReviewSchema(collectionName) {
  return new mongoose.Schema(
    {
      media_paths: [String],
      media_ids: [mongoose.Schema.Types.ObjectId],
      created_at: Date,
      updated_at: Date,
    },
    {
      collection: collectionName,
      strict: false,
      versionKey: false,
    },
  );
}

function createReviewMediaSchema(collectionName) {
  return new mongoose.Schema(
    {
      review_id: mongoose.Schema.Types.ObjectId,
      source_path: String,
      type: String,
      updated_at: Date,
    },
    {
      collection: collectionName,
      strict: false,
      versionKey: false,
    },
  );
}

function createAuditSchema(collectionName) {
  const auditSchema = new mongoose.Schema(
    {
      review_id: { type: mongoose.Schema.Types.ObjectId, required: true },
      old_path: { type: String, required: true },
      new_path: String,
      variant_keys: [String],
      status: String,
      width: Number,
      height: Number,
      error: Object,
      dry_run: Boolean,
      skip_db_update: Boolean,
      review_collection: String,
      review_media_collection: String,
      created_at: { type: Date, default: () => new Date() },
      updated_at: { type: Date, default: () => new Date() },
    },
    {
      collection: collectionName,
      versionKey: false,
    },
  );

  auditSchema.index({ review_id: 1, old_path: 1 }, { unique: true });
  auditSchema.index({ status: 1, updated_at: -1 });

  return auditSchema;
}

function createModel(baseName, schema) {
  const name = modelName(baseName, schema.options.collection);
  return mongoose.models[name] || mongoose.model(name, schema);
}

function createModels(collections = {}) {
  const reviewCollectionName = normalizeCollectionName(
    collections.review,
    DEFAULT_COLLECTIONS.review,
    "Review",
  );
  const reviewMediaCollectionName = normalizeCollectionName(
    collections.reviewMedia,
    DEFAULT_COLLECTIONS.reviewMedia,
    "Review media",
  );
  const auditCollectionName = normalizeCollectionName(
    collections.audit,
    DEFAULT_COLLECTIONS.audit,
    "Audit",
  );

  return {
    Review: createModel("Review", createReviewSchema(reviewCollectionName)),
    ReviewMedia: createModel(
      "ReviewMedia",
      createReviewMediaSchema(reviewMediaCollectionName),
    ),
    MigrationAudit: createModel(
      "MigrationAudit",
      createAuditSchema(auditCollectionName),
    ),
    collectionNames: {
      review: reviewCollectionName,
      reviewMedia: reviewMediaCollectionName,
      audit: auditCollectionName,
    },
  };
}

module.exports = {
  DEFAULT_COLLECTIONS,
  createModels,
  normalizeCollectionName,
};
