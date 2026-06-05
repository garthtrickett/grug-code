import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { Data, Effect } from "effect";
import { config } from "./Config";
import { writeFile } from "node:fs/promises";
import { type Readable } from "node:stream";

export class S3UploadError extends Data.TaggedError("S3UploadError")<{
  readonly cause: unknown;
}> {}

export class S3DownloadError extends Data.TaggedError("S3DownloadError")<{
  readonly cause: unknown;
}> {}

export class PresignError extends Data.TaggedError("PresignError")<{
  readonly cause: unknown;
}> {}

export const s3Client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpointUrl,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
  forcePathStyle: config.s3.forcePathStyle,
});

export const uploadMediaFile = (
  userId: string,
  file: File,
  options?: { filename?: string }
): Effect.Effect<{ url: string; key: string }, S3UploadError> =>
  Effect.gen(function* () {
    const originalName = options?.filename || file.name || "audio.mp3";
    const parts = originalName.split(".");
    const ext = parts.length > 1 ? parts.pop()?.toLowerCase() : "mp3";
    
    const fileId = crypto.randomUUID();
    const key = `media/${userId}/${fileId}.${ext}`;
    const bodyStream = file.stream();
    const contentDisposition = `inline; filename="${originalName.replace(/"/g, '\\"')}"`;

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: config.s3.bucketName,
        Key: key,
        Body: bodyStream,
        ContentType: file.type || "application/octet-stream",
        ContentDisposition: contentDisposition,
      },
    });

    yield* Effect.tryPromise({
      try: () => upload.done(),
      catch: (cause) => new S3UploadError({ cause }),
    });

    return { 
      url: `${config.s3.publicAvatarUrl}/${key}`,
      key
    };
  });

export const getPresignedUploadUrl = (
  key: string,
  contentType: string = "application/octet-stream"
) => Effect.gen(function*() {
  const command = new PutObjectCommand({
    Bucket: config.s3.bucketName,
    Key: key,
    ContentType: contentType
  });

  const url = yield* Effect.tryPromise({
    try: () => getSignedUrl(s3Client, command, { expiresIn: 3600 }),
    catch: (cause) => new PresignError({ cause })
  });

  return url;
});

export const downloadFileToPath = (key: string, localPath: string) =>
  Effect.gen(function* () {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key
    });

    const response = yield* Effect.tryPromise({
      try: () => s3Client.send(command),
      catch: (cause) => new S3DownloadError({ cause })
    });

    if (!response.Body) {
      return yield* Effect.fail(new S3DownloadError({ cause: "Empty response body from S3" }));
    }

    yield* Effect.tryPromise({
            try: async () => {
        const stream = response.Body as Readable;
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk as Uint8Array);
        }
        const buffer = Buffer.concat(chunks);
        await writeFile(localPath, buffer);
      },
      catch: (cause) => new S3DownloadError({ cause })
    });
  });
