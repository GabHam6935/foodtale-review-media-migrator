const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"]);

function parsePositiveInt(value, fallback, label = "value") {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function getS3KeyFromPath(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return safeDecodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch (_) {
    const withoutQuery = raw.split("?")[0].split("#")[0];
    return safeDecodeURIComponent(withoutQuery.replace(/^\/+/, ""));
  }
}

function getExtension(pathOrUrl) {
  const key = getS3KeyFromPath(pathOrUrl).toLowerCase();
  const fileName = key.split("/").pop() || "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.substring(dotIndex) : "";
}

function isVideoPath(pathOrUrl) {
  return VIDEO_EXTENSIONS.has(getExtension(pathOrUrl));
}

function isWebpPath(pathOrUrl) {
  return getExtension(pathOrUrl) === ".webp";
}

function isConvertibleImagePath(pathOrUrl) {
  return IMAGE_EXTENSIONS.has(getExtension(pathOrUrl));
}

function replaceFileExtension(pathOrUrl, extension) {
  const key = getS3KeyFromPath(pathOrUrl);
  const lastSlashIndex = key.lastIndexOf("/");
  const directory = lastSlashIndex >= 0 ? `${key.substring(0, lastSlashIndex + 1)}` : "";
  const fileName = lastSlashIndex >= 0 ? key.substring(lastSlashIndex + 1) : key;
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex >= 0 ? fileName.substring(0, dotIndex) : fileName;
  return `${directory}${baseName}${extension}`;
}

function getImageVariantKeys(baseKey) {
  const lastSlashIndex = baseKey.lastIndexOf("/");
  const directory = lastSlashIndex >= 0 ? `${baseKey.substring(0, lastSlashIndex + 1)}` : "";
  const fileName = lastSlashIndex >= 0 ? baseKey.substring(lastSlashIndex + 1) : baseKey;
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex >= 0 ? fileName.substring(0, dotIndex) : fileName;
  const ext = dotIndex >= 0 ? fileName.substring(dotIndex) : "";
  return ["small", "medium", "large"].map((suffix) => `${directory}${baseName}_${suffix}${ext}`);
}

function buildReviewQuery(args) {
  const query = {
    media_paths: { $exists: true, $type: "array", $ne: [] },
  };

  if (args.reviewId) query._id = args.reviewId;
  if (args.since) query.created_at = { $gte: args.since };
  return query;
}

function serializeError(error) {
  return {
    name: error.name,
    code: error.Code || error.code,
    message: error.message,
    s3_key: error.s3Key,
    stack: error.stack,
  };
}

module.exports = {
  buildReviewQuery,
  getImageVariantKeys,
  getS3KeyFromPath,
  isConvertibleImagePath,
  isVideoPath,
  isWebpPath,
  parseBoolean,
  parseDate,
  parsePositiveInt,
  replaceFileExtension,
  serializeError,
};
