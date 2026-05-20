const { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const sharp = require("sharp");
const {
  getImageVariantKeys,
  getS3KeyFromPath,
  replaceFileExtension,
} = require("./utils");

const WEBP_CONTENT_TYPE = "image/webp";
const BASE_WIDTH = 2048;
const VARIANT_SIZES = [300, 800, 1200];

function createS3ClientFromEnv(env = process.env) {
  return new S3Client({
    region: env.AWS_DEFAULT_REGION_S3,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID_S3,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY_S3,
    },
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function getObjectBuffer(s3Client, bucket, key) {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      buffer: await streamToBuffer(response.Body),
      contentType: response.ContentType,
    };
  } catch (error) {
    error.s3Key = key;
    throw error;
  }
}

async function headObjectExists(s3Client, bucket, key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    error.s3Key = key;
    throw error;
  }
}

async function getImageMetadataFromS3(s3Client, bucket, key) {
  const { buffer } = await getObjectBuffer(s3Client, bucket, key);
  return sharp(buffer).metadata();
}

async function existingWebpSetIsUsable(s3Client, bucket, baseKey, variantKeys) {
  const baseExists = await headObjectExists(s3Client, bucket, baseKey);
  if (!baseExists) return false;

  const metadata = await getImageMetadataFromS3(s3Client, bucket, baseKey);
  if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)) {
    return false;
  }

  for (const variantKey of variantKeys) {
    const exists = await headObjectExists(s3Client, bucket, variantKey);
    if (!exists) return false;
  }

  return {
    width: metadata.width,
    height: metadata.height,
  };
}

async function uploadWebpSet({ s3Client, bucket, oldPath, quality }) {
  const oldKey = getS3KeyFromPath(oldPath);
  const newKey = replaceFileExtension(oldKey, ".webp");
  const variantKeys = getImageVariantKeys(newKey);

  const existing = await existingWebpSetIsUsable(s3Client, bucket, newKey, variantKeys);
  if (existing) {
    return {
      oldKey,
      newKey,
      variantKeys,
      width: existing.width,
      height: existing.height,
      status: "existing_webp",
    };
  }

  const { buffer } = await getObjectBuffer(s3Client, bucket, oldKey);
  const originalMetadata = await sharp(buffer).metadata();

  const baseBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: BASE_WIDTH, withoutEnlargement: true })
    .withMetadata()
    .webp({ quality })
    .toBuffer();

  const uploads = [
    s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: newKey,
        Body: baseBuffer,
        ContentType: WEBP_CONTENT_TYPE,
      }),
    ),
  ];

  for (let i = 0; i < VARIANT_SIZES.length; i += 1) {
    const resizedBuffer = await sharp(buffer)
      .rotate()
      .resize({ width: VARIANT_SIZES[i], withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();

    uploads.push(
      s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: variantKeys[i],
          Body: resizedBuffer,
          ContentType: WEBP_CONTENT_TYPE,
        }),
      ),
    );
  }

  await Promise.all(uploads);

  return {
    oldKey,
    newKey,
    variantKeys,
    width: originalMetadata.width,
    height: originalMetadata.height,
    status: "converted",
  };
}

async function verifyWebpSet({ s3Client, bucket, baseKey }) {
  const variantKeys = getImageVariantKeys(baseKey);
  const existing = await existingWebpSetIsUsable(s3Client, bucket, baseKey, variantKeys);
  return {
    ok: !!existing,
    baseKey,
    variantKeys,
    width: existing?.width,
    height: existing?.height,
  };
}

module.exports = {
  createS3ClientFromEnv,
  getImageVariantKeys,
  uploadWebpSet,
  verifyWebpSet,
};
