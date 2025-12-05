/**
 * STORAGE LAYER (FINAL VERSION)
 * ------------------------------
 * Supports:
 *  - Backblaze B2 (primary)
 *  - AWS S3/Glacier (optional)
 *  - Streaming upload/download
 */

const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const B2 = require("backblaze-b2");
const config = require("./config");
const { withRetry } = require("../resilience/retry");

// ------------------------------
// B2 CLIENT
// ------------------------------
let b2Client = null;

function getB2() {
  if (!b2Client) {
    b2Client = new B2({
      applicationKeyId: config.b2.applicationKeyId,
      applicationKey: config.b2.applicationKey,
    });
  }
  return b2Client;
}

// Authorize once & refresh token when needed
async function b2Auth() {
  const b2 = getB2();
  const res = await b2.authorize();
  return res;
}

// ------------------------------
// AWS S3 CLIENT (optional)
// Used for Glacier or S3 archival
// ------------------------------
let s3Client = null;

function getS3() {
  if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
    return null; // Glacier optional
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: config.aws.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      },
    });
  }
  return s3Client;
}

// ------------------------------
// HELPERS
// ------------------------------
function detectMimeType(filePath, override) {
  if (override) return override;
  return "application/octet-stream";
}

function normalizeKey(key) {
  return String(key || "").replace(/\\/g, "/");
}

// ------------------------------
// B2 UPLOAD
// ------------------------------
async function uploadToB2(bucketId, remotePath, localPath, mimeOverride) {
  await b2Auth();
  const b2 = getB2();

  const stat = fs.statSync(localPath);
  const stream = fs.createReadStream(localPath);
  const contentType = detectMimeType(localPath, mimeOverride);
  const fileName = normalizeKey(remotePath);

  const { data: uploadUrlData } = await b2.getUploadUrl({ bucketId });

  // backblaze-b2 supports streaming via data: ReadStream and explicit contentLength
  return b2.uploadFile({
    uploadUrl: uploadUrlData.uploadUrl,
    uploadAuthToken: uploadUrlData.authorizationToken,
    fileName,
    data: stream,
    contentType,
    contentLength: stat.size,
  });
}

// ------------------------------
// B2 DOWNLOAD
// ------------------------------
async function resolveB2FileId(bucketId, remotePath) {
  const b2 = getB2();
  const { data } = await b2.listFileNames({ bucketId, startFileName: normalizeKey(remotePath), maxFileCount: 1 });
  const file = (data && data.files && data.files[0]) || null;
  if (file && file.fileName === normalizeKey(remotePath)) return file.fileId;
  return null;
}

async function downloadFromB2(bucketId, remotePath, localPath) {
  await b2Auth();
  const b2 = getB2();

  const fileId = await resolveB2FileId(bucketId, remotePath);
  if (!fileId) throw new Error('B2_NOT_FOUND');
  const { data } = await b2.downloadFileById({ fileId, responseType: 'stream' });

  await new Promise((resolve, reject) => {
    const write = fs.createWriteStream(localPath);
    data.pipe(write);
    data.on('end', resolve);
    data.on('error', reject);
  });
  return true;
}

// ------------------------------
// B2 EXISTS
// ------------------------------
async function b2FileExists(bucketId, remotePath) {
  try {
    await b2Auth();
    const id = await resolveB2FileId(bucketId, remotePath);
    return !!id;
  } catch (err) {
    const code = err && (err.name || err.code || err.status || err.message);
    if (code && String(code).toLowerCase().includes('not') && String(code).toLowerCase().includes('found')) return false;
    if (String(err?.message || '').includes('file_not_present')) return false;
    return false;
  }
}

// ------------------------------
// AWS S3 UPLOAD (GLACIER / ARCHIVE)
// ------------------------------
async function uploadToS3(bucket, remotePath, localPath) {
  const s3 = getS3();
  if (!s3) throw new Error("S3_NOT_CONFIGURED");

  const stream = fs.createReadStream(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(remotePath),
      Body: stream,
      ContentType: detectMimeType(localPath),
      StorageClass: "DEEP_ARCHIVE",
    })
  );

  return true;
}

// ------------------------------
// EXPORTING FINAL API
// ------------------------------

async function uploadFile(bucketId, remotePath, localPath, mimeOverride = null) {
  return withRetry(async () => {
    if (config.aws.archiveBucket && bucketId === config.aws.archiveBucket) {
      // Archive to AWS Glacier/S3
      return uploadToS3(bucketId, remotePath, localPath);
    }
    return uploadToB2(bucketId, remotePath, localPath, mimeOverride);
  }, { maxRetries: 3, baseDelay: 300 });
}

async function downloadFile(bucketId, remotePath, localPath) {
  return withRetry(async () => {
    if (config.aws.archiveBucket && bucketId === config.aws.archiveBucket) {
      const s3 = getS3();
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucketId, Key: normalizeKey(remotePath) })
      );
      const stream = obj.Body;
      const write = fs.createWriteStream(localPath);
      await new Promise((res, rej) => {
        stream.pipe(write);
        stream.on("end", res);
        stream.on("error", rej);
      });
      return true;
    }
    return downloadFromB2(bucketId, remotePath, localPath);
  }, { maxRetries: 3, baseDelay: 300 });
}

async function fileExists(bucketId, remotePath) {
  return withRetry(async () => {
    if (config.aws.archiveBucket && bucketId === config.aws.archiveBucket) {
      const s3 = getS3();
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucketId, Key: normalizeKey(remotePath) }));
        return true;
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404) return false;
        return false;
      }
    }
    return b2FileExists(bucketId, remotePath);
  }, { maxRetries: 2, baseDelay: 200 });
}

async function archiveToGlacier(remotePath, localPath) {
  return withRetry(async () => {
    return uploadToS3(config.aws.archiveBucket, remotePath, localPath);
  }, { maxRetries: 3, baseDelay: 300 });
}

module.exports = {
  uploadFile,
  downloadFile,
  fileExists,
  archiveToGlacier,
};
