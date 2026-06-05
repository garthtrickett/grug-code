const getEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};


const getEnvOrDefault = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

export const config = {
  db: {
    url: getEnv("DATABASE_URL"),
  },
    s3: {
    bucketName: getEnvOrDefault("BUCKET_NAME", "life-io"),
    publicAvatarUrl: getEnvOrDefault("PUBLIC_AVATAR_URL", "http://localhost:9000/life-io"),
    endpointUrl: getEnvOrDefault("AWS_ENDPOINT_URL_S3", "http://localhost:9000"),
    accessKeyId: getEnvOrDefault("AWS_ACCESS_KEY_ID", "minioadmin"),
    secretAccessKey: getEnvOrDefault("AWS_SECRET_ACCESS_KEY", "minioadmin"),
    region: getEnvOrDefault("AWS_REGION", "us-east-1"),
    forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === "true" || process.env.AWS_FORCE_PATH_STYLE === undefined,
  },
  app: {
    nodeEnv: process.env.NODE_ENV || "development",
    isProduction: process.env.NODE_ENV === "production",
    rootDomain: process.env.ROOT_DOMAIN || "life-io.xyz",
  },
  jwt: {
    secret: getEnvOrDefault("JWT_SECRET", "Few4D1oru8s1GEZJY2mmg1hjdC2nszByiLuUba1bcbA="),
  },
};
