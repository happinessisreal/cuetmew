import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { sentry } from "@hono/sentry";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { Scalar } from "@scalar/hono-api-reference";
import { Queue, Worker } from "bullmq";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { rateLimiter } from "hono-rate-limiter";
import { Redis } from "ioredis";

// Extend Hono's context variable map to include requestId
interface AppVariables {
  requestId: string;
}

// Helper for optional URL that treats empty string as undefined
const optionalUrl = z
  .string()
  .optional()
  .transform((val) => (val === "" ? undefined : val))
  .pipe(z.url().optional());

// Environment schema
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET_NAME: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  SENTRY_DSN: optionalUrl,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  CORS_ORIGINS: z
    .string()
    .default("*")
    .transform((val) => (val === "*" ? "*" : val.split(","))),
  // Download delay simulation (in milliseconds)
  DOWNLOAD_DELAY_MIN_MS: z.coerce.number().int().min(0).default(10000), // 10 seconds
  DOWNLOAD_DELAY_MAX_MS: z.coerce.number().int().min(0).default(200000), // 200 seconds
  DOWNLOAD_DELAY_ENABLED: z.coerce.boolean().default(true),
  // Redis configuration
  REDIS_URL: z.url().optional(),
  // Presigned URL expiry
  PRESIGNED_URL_EXPIRY_SECONDS: z.coerce.number().int().min(60).default(3600),
});

// Parse and validate environment
const env = EnvSchema.parse(process.env);

// S3 Client
const s3Client = new S3Client({
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
  ...(env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

// Redis connection for BullMQ (optional - falls back to in-memory if not configured)
let redisConnection: Redis | null = null;
if (env.REDIS_URL) {
  redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

// Job status types
type JobStatus = "queued" | "processing" | "completed" | "failed";

interface JobResult {
  file_id: number;
  status: JobStatus;
  progress: number;
  downloadUrl: string | null;
  size: number | null;
  processingTimeMs: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}

// In-memory job store (fallback when Redis is not available)
const inMemoryJobs = new Map<string, JobResult>();

// Download queue and worker (only if Redis is configured)
const QUEUE_NAME = "download-jobs";

let downloadQueue: Queue | null = null;
if (redisConnection) {
  downloadQueue = new Queue(QUEUE_NAME, { connection: redisConnection });
}

// Helper to get job status from Redis or in-memory store
const getJobStatus = async (jobId: string): Promise<JobResult | null> => {
  if (redisConnection) {
    const data = await redisConnection.get(`job:${jobId}`);
    if (data) {
      return JSON.parse(data) as JobResult;
    }
    return null;
  }
  return inMemoryJobs.get(jobId) ?? null;
};

// Helper to set job status
const setJobStatus = async (
  jobId: string,
  status: JobResult,
): Promise<void> => {
  if (redisConnection) {
    // Store for 24 hours
    await redisConnection.set(
      `job:${jobId}`,
      JSON.stringify(status),
      "EX",
      86400,
    );
  } else {
    inMemoryJobs.set(jobId, status);
  }
};

// Initialize OpenTelemetry SDK
const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "delineate-hackathon-challenge",
  }),
  traceExporter: new OTLPTraceExporter(),
});
otelSDK.start();

const app = new OpenAPIHono<{ Variables: AppVariables }>();

// Request ID middleware - adds unique ID to each request
app.use(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

// Security headers middleware (helmet-like)
app.use(secureHeaders());

// CORS middleware
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    exposeHeaders: [
      "X-Request-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
    ],
    maxAge: 86400,
  }),
);

// Request timeout middleware
app.use(timeout(env.REQUEST_TIMEOUT_MS));

// Rate limiting middleware
app.use(
  rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "anonymous",
  }),
);

// OpenTelemetry middleware
app.use(
  httpInstrumentationMiddleware({
    serviceName: "delineate-hackathon-challenge",
  }),
);

// Sentry middleware
app.use(
  sentry({
    dsn: env.SENTRY_DSN,
  }),
);

// Error response schema for OpenAPI
const ErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  })
  .openapi("ErrorResponse");

// Error handler with Sentry
app.onError((err, c) => {
  c.get("sentry").captureException(err);
  const requestId = c.get("requestId") as string | undefined;
  return c.json(
    {
      error: "Internal Server Error",
      message:
        env.NODE_ENV === "development"
          ? err.message
          : "An unexpected error occurred",
      requestId,
    },
    500,
  );
});

// Schemas
const MessageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi("MessageResponse");

const HealthResponseSchema = z
  .object({
    status: z.enum(["healthy", "unhealthy"]),
    checks: z.object({
      storage: z.enum(["ok", "error"]),
    }),
  })
  .openapi("HealthResponse");

// Download API Schemas
const DownloadInitiateRequestSchema = z
  .object({
    file_ids: z
      .array(z.number().int().min(10000).max(100000000))
      .min(1)
      .max(1000)
      .openapi({ description: "Array of file IDs (10K to 100M)" }),
  })
  .openapi("DownloadInitiateRequest");

const DownloadInitiateResponseSchema = z
  .object({
    jobId: z.string().openapi({ description: "Unique job identifier" }),
    status: z.enum(["queued", "processing"]),
    totalFileIds: z.number().int(),
  })
  .openapi("DownloadInitiateResponse");

const DownloadCheckRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "Single file ID to check (10K to 100M)" }),
  })
  .openapi("DownloadCheckRequest");

const DownloadCheckResponseSchema = z
  .object({
    file_id: z.number().int(),
    available: z.boolean(),
    s3Key: z
      .string()
      .nullable()
      .openapi({ description: "S3 object key if available" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
  })
  .openapi("DownloadCheckResponse");

const DownloadStartRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "File ID to download (10K to 100M)" }),
  })
  .openapi("DownloadStartRequest");

const DownloadStartResponseSchema = z
  .object({
    file_id: z.number().int(),
    status: z.enum(["completed", "failed"]),
    downloadUrl: z
      .string()
      .nullable()
      .openapi({ description: "Presigned download URL if successful" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
    processingTimeMs: z
      .number()
      .int()
      .openapi({ description: "Time taken to process the download in ms" }),
    message: z.string().openapi({ description: "Status message" }),
  })
  .openapi("DownloadStartResponse");

// Job status response schema (for polling)
const JobStatusResponseSchema = z
  .object({
    jobId: z.string().openapi({ description: "Unique job identifier" }),
    file_id: z.number().int(),
    status: z
      .enum(["queued", "processing", "completed", "failed"])
      .openapi({ description: "Current job status" }),
    progress: z
      .number()
      .int()
      .min(0)
      .max(100)
      .openapi({ description: "Progress percentage (0-100)" }),
    downloadUrl: z.string().nullable().openapi({
      description: "Presigned download URL (available when completed)",
    }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
    processingTimeMs: z.number().int().nullable().openapi({
      description: "Time taken to process (null if still processing)",
    }),
    message: z.string().openapi({ description: "Status message" }),
    createdAt: z.string().openapi({ description: "Job creation timestamp" }),
    updatedAt: z.string().openapi({ description: "Last update timestamp" }),
  })
  .openapi("JobStatusResponse");

// Input sanitization for S3 keys - prevent path traversal
const sanitizeS3Key = (fileId: number): string => {
  // Ensure fileId is a valid integer within bounds (already validated by Zod)
  const sanitizedId = Math.floor(Math.abs(fileId));
  // Construct safe S3 key without user-controlled path components
  return `downloads/${String(sanitizedId)}.zip`;
};

// S3 health check
const checkS3Health = async (): Promise<boolean> => {
  if (!env.S3_BUCKET_NAME) return true; // Mock mode
  try {
    // Use a lightweight HEAD request on a known path
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: "__health_check_marker__",
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    // NotFound is fine - bucket is accessible
    if (err instanceof Error && err.name === "NotFound") return true;
    // AccessDenied or other errors indicate connection issues
    return false;
  }
};

// S3 availability check
const checkS3Availability = async (
  fileId: number,
): Promise<{
  available: boolean;
  s3Key: string | null;
  size: number | null;
}> => {
  const s3Key = sanitizeS3Key(fileId);

  // If no bucket configured, use mock mode
  if (!env.S3_BUCKET_NAME) {
    const available = fileId % 7 === 0;
    return {
      available,
      s3Key: available ? s3Key : null,
      size: available ? Math.floor(Math.random() * 10000000) + 1000 : null,
    };
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: s3Key,
    });
    const response = await s3Client.send(command);
    return {
      available: true,
      s3Key,
      size: response.ContentLength ?? null,
    };
  } catch {
    return {
      available: false,
      s3Key: null,
      size: null,
    };
  }
};

// Generate presigned S3 URL for downloading
const generatePresignedUrl = async (s3Key: string): Promise<string | null> => {
  if (!env.S3_BUCKET_NAME) {
    // Mock mode - return a fake URL
    return `https://storage.example.com/${s3Key}?token=${crypto.randomUUID()}`;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: s3Key,
    });
    const url = await getSignedUrl(s3Client, command, {
      expiresIn: env.PRESIGNED_URL_EXPIRY_SECONDS,
    });
    return url;
  } catch (err) {
    console.error("[S3] Failed to generate presigned URL:", err);
    return null;
  }
};

// Process a download job (used by worker)
const processDownloadJob = async (
  jobId: string,
  fileId: number,
): Promise<void> => {
  const startTime = Date.now();

  // Update status to processing
  await setJobStatus(jobId, {
    file_id: fileId,
    status: "processing",
    progress: 0,
    downloadUrl: null,
    size: null,
    processingTimeMs: null,
    message: "Processing download...",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Get random delay and log it
  const delayMs = getRandomDelay();
  const delaySec = (delayMs / 1000).toFixed(1);
  const minDelaySec = (env.DOWNLOAD_DELAY_MIN_MS / 1000).toFixed(0);
  const maxDelaySec = (env.DOWNLOAD_DELAY_MAX_MS / 1000).toFixed(0);
  console.log(
    `[Download Worker] Processing job=${jobId} file_id=${String(fileId)} | delay=${delaySec}s (range: ${minDelaySec}s-${maxDelaySec}s)`,
  );

  // Simulate progress updates during the delay
  const progressIntervalMs = Math.max(1000, delayMs / 10);
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + 10, 90);
    void (async () => {
      const currentStatus = await getJobStatus(jobId);
      if (currentStatus?.status === "processing") {
        await setJobStatus(jobId, {
          ...currentStatus,
          progress,
          updatedAt: new Date().toISOString(),
        });
      }
    })();
  }, progressIntervalMs);

  // Simulate long-running download process
  await sleep(delayMs);
  clearInterval(progressInterval);

  // Check if file is available in S3
  const s3Result = await checkS3Availability(fileId);
  const processingTimeMs = Date.now() - startTime;

  if (s3Result.available && s3Result.s3Key) {
    // Generate presigned URL
    const downloadUrl = await generatePresignedUrl(s3Result.s3Key);

    await setJobStatus(jobId, {
      file_id: fileId,
      status: "completed",
      progress: 100,
      downloadUrl,
      size: s3Result.size,
      processingTimeMs,
      message: `Download ready after ${(processingTimeMs / 1000).toFixed(1)} seconds`,
      createdAt:
        (await getJobStatus(jobId))?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    console.log(
      `[Download Worker] Completed job=${jobId} file_id=${String(fileId)}, time=${String(processingTimeMs)}ms`,
    );
  } else {
    await setJobStatus(jobId, {
      file_id: fileId,
      status: "failed",
      progress: 100,
      downloadUrl: null,
      size: null,
      processingTimeMs,
      message: `File not found after ${(processingTimeMs / 1000).toFixed(1)} seconds`,
      createdAt:
        (await getJobStatus(jobId))?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    console.log(
      `[Download Worker] Failed job=${jobId} file_id=${String(fileId)}, file not found`,
    );
  }
};

// Create BullMQ worker (only if Redis is configured)
let downloadWorker: Worker | null = null;
if (redisConnection) {
  downloadWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { jobId, fileId } = job.data as { jobId: string; fileId: number };
      await processDownloadJob(jobId, fileId);
    },
    {
      connection: redisConnection,
      concurrency: 5, // Process up to 5 jobs concurrently
    },
  );

  // Worker event handlers
  downloadWorker.on("completed", (job) => {
    console.log(`[BullMQ] Job ${String(job.id)} completed`);
  });

  downloadWorker.on("failed", (job, err) => {
    console.error(`[BullMQ] Job ${String(job?.id)} failed:`, err);
  });
}

// Random delay helper for simulating long-running downloads
const getRandomDelay = (): number => {
  if (!env.DOWNLOAD_DELAY_ENABLED) return 0;
  const min = env.DOWNLOAD_DELAY_MIN_MS;
  const max = env.DOWNLOAD_DELAY_MAX_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Routes
const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["General"],
  summary: "Root endpoint",
  description: "Returns a welcome message",
  responses: {
    200: {
      description: "Successful response",
      content: {
        "application/json": {
          schema: MessageResponseSchema,
        },
      },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check endpoint",
  description: "Returns the health status of the service and its dependencies",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
    503: {
      description: "Service is unhealthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

app.openapi(rootRoute, (c) => {
  return c.json({ message: "Hello Hono!" }, 200);
});

app.openapi(healthRoute, async (c) => {
  const storageHealthy = await checkS3Health();
  const status = storageHealthy ? "healthy" : "unhealthy";
  const httpStatus = storageHealthy ? 200 : 503;
  return c.json(
    {
      status,
      checks: {
        storage: storageHealthy ? "ok" : "error",
      },
    },
    httpStatus,
  );
});

// Download API Routes
const downloadInitiateRoute = createRoute({
  method: "post",
  path: "/v1/download/initiate",
  tags: ["Download"],
  summary: "Initiate download job",
  description: "Initiates a download job for multiple IDs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadInitiateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Download job initiated",
      content: {
        "application/json": {
          schema: DownloadInitiateResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

const downloadCheckRoute = createRoute({
  method: "post",
  path: "/v1/download/check",
  tags: ["Download"],
  summary: "Check download availability",
  description:
    "Checks if a single ID is available for download in S3. Add ?sentry_test=true to trigger an error for Sentry testing.",
  request: {
    query: z.object({
      sentry_test: z.string().optional().openapi({
        description:
          "Set to 'true' to trigger an intentional error for Sentry testing",
      }),
    }),
    body: {
      content: {
        "application/json": {
          schema: DownloadCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Availability check result",
      content: {
        "application/json": {
          schema: DownloadCheckResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadInitiateRoute, async (c) => {
  const { file_ids } = c.req.valid("json");
  const jobId = crypto.randomUUID();

  // For now, we only support single file downloads via the async queue
  // The first file_id will be processed
  const fileId = file_ids[0];

  // Create initial job status
  const now = new Date().toISOString();
  await setJobStatus(jobId, {
    file_id: fileId,
    status: "queued",
    progress: 0,
    downloadUrl: null,
    size: null,
    processingTimeMs: null,
    message: "Job queued for processing",
    createdAt: now,
    updatedAt: now,
  });

  // Queue the job (if Redis is available) or process in background
  if (downloadQueue) {
    await downloadQueue.add("download", { jobId, fileId });
    console.log(
      `[Download] Queued job=${jobId} file_id=${String(fileId)} to BullMQ`,
    );
  } else {
    // Fallback: process in background without blocking
    console.log(
      `[Download] Processing job=${jobId} file_id=${String(fileId)} in-memory (no Redis)`,
    );
    // Don't await - let it run in background
    processDownloadJob(jobId, fileId).catch((err: unknown) => {
      console.error(`[Download] Background job failed:`, err);
    });
  }

  return c.json(
    {
      jobId,
      status: "queued" as const,
      totalFileIds: file_ids.length,
    },
    200,
  );
});

app.openapi(downloadCheckRoute, async (c) => {
  const { sentry_test } = c.req.valid("query");
  const { file_id } = c.req.valid("json");

  // Intentional error for Sentry testing (hackathon challenge)
  if (sentry_test === "true") {
    throw new Error(
      `Sentry test error triggered for file_id=${String(file_id)} - This should appear in Sentry!`,
    );
  }

  const s3Result = await checkS3Availability(file_id);
  return c.json(
    {
      file_id,
      ...s3Result,
    },
    200,
  );
});

// Job Status Route - for polling job progress
const jobStatusRoute = createRoute({
  method: "get",
  path: "/v1/download/status/:jobId",
  tags: ["Download"],
  summary: "Get download job status (polling)",
  description: `Poll this endpoint to check the status of a download job.
    Returns progress percentage, and when complete, provides a presigned S3 URL.
    Recommended polling interval: 2-5 seconds.`,
  request: {
    params: z.object({
      jobId: z
        .uuid()
        .openapi({ description: "Job ID returned from /v1/download/initiate" }),
    }),
  },
  responses: {
    200: {
      description: "Job status",
      content: {
        "application/json": {
          schema: JobStatusResponseSchema,
        },
      },
    },
    404: {
      description: "Job not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(jobStatusRoute, async (c) => {
  const { jobId } = c.req.valid("param");

  const jobStatus = await getJobStatus(jobId);

  if (!jobStatus) {
    return c.json(
      {
        error: "Not Found",
        message: `Job ${jobId} not found`,
        requestId: c.get("requestId") as string | undefined,
      },
      404,
    );
  }

  return c.json(
    {
      jobId,
      ...jobStatus,
    },
    200,
  );
});

// Download Start Route - simulates long-running download with random delay
const downloadStartRoute = createRoute({
  method: "post",
  path: "/v1/download/start",
  tags: ["Download"],
  summary: "Start file download (long-running)",
  description: `Starts a file download with simulated processing delay.
    Processing time varies randomly between ${String(env.DOWNLOAD_DELAY_MIN_MS / 1000)}s and ${String(env.DOWNLOAD_DELAY_MAX_MS / 1000)}s.
    This endpoint demonstrates long-running operations that may timeout behind proxies.`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadStartRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Download completed successfully",
      content: {
        "application/json": {
          schema: DownloadStartResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadStartRoute, async (c) => {
  const { file_id } = c.req.valid("json");
  const startTime = Date.now();

  // Get random delay and log it
  const delayMs = getRandomDelay();
  const delaySec = (delayMs / 1000).toFixed(1);
  const minDelaySec = (env.DOWNLOAD_DELAY_MIN_MS / 1000).toFixed(0);
  const maxDelaySec = (env.DOWNLOAD_DELAY_MAX_MS / 1000).toFixed(0);
  console.log(
    `[Download] Starting file_id=${String(file_id)} | delay=${delaySec}s (range: ${minDelaySec}s-${maxDelaySec}s) | enabled=${String(env.DOWNLOAD_DELAY_ENABLED)}`,
  );

  // Simulate long-running download process
  await sleep(delayMs);

  // Check if file is available in S3
  const s3Result = await checkS3Availability(file_id);
  const processingTimeMs = Date.now() - startTime;

  console.log(
    `[Download] Completed file_id=${String(file_id)}, actual_time=${String(processingTimeMs)}ms, available=${String(s3Result.available)}`,
  );

  if (s3Result.available) {
    return c.json(
      {
        file_id,
        status: "completed" as const,
        downloadUrl: `https://storage.example.com/${s3Result.s3Key ?? ""}?token=${crypto.randomUUID()}`,
        size: s3Result.size,
        processingTimeMs,
        message: `Download ready after ${(processingTimeMs / 1000).toFixed(1)} seconds`,
      },
      200,
    );
  } else {
    return c.json(
      {
        file_id,
        status: "failed" as const,
        downloadUrl: null,
        size: null,
        processingTimeMs,
        message: `File not found after ${(processingTimeMs / 1000).toFixed(1)} seconds of processing`,
      },
      200,
    );
  }
});

// OpenAPI spec endpoint (disabled in production)
if (env.NODE_ENV !== "production") {
  app.doc("/openapi", {
    openapi: "3.0.0",
    info: {
      title: "Delineate Hackathon Challenge API",
      version: "1.0.0",
      description: "API for Delineate Hackathon Challenge",
    },
    servers: [{ url: "http://localhost:3000", description: "Local server" }],
  });

  // Scalar API docs
  app.get("/docs", Scalar({ url: "/openapi" }));
}

// Graceful shutdown handler
const gracefulShutdown = (server: ServerType) => (signal: string) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("HTTP server closed");

    // Close BullMQ worker and queue
    const closeQueue = async () => {
      if (downloadWorker) {
        await downloadWorker.close();
        console.log("BullMQ worker closed");
      }
      if (downloadQueue) {
        await downloadQueue.close();
        console.log("BullMQ queue closed");
      }
      if (redisConnection) {
        await redisConnection.quit();
        console.log("Redis connection closed");
      }
    };

    closeQueue()
      .catch((err: unknown) => {
        console.error("Error closing queue:", err);
      })
      .finally(() => {
        // Shutdown OpenTelemetry to flush traces
        otelSDK
          .shutdown()
          .then(() => {
            console.log("OpenTelemetry SDK shut down");
          })
          .catch((err: unknown) => {
            console.error("Error shutting down OpenTelemetry:", err);
          })
          .finally(() => {
            // Destroy S3 client
            s3Client.destroy();
            console.log("S3 client destroyed");
            console.log("Graceful shutdown completed");
          });
      });
  });
};

// Start server
const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${String(info.port)}`);
    console.log(`Environment: ${env.NODE_ENV}`);
    if (env.NODE_ENV !== "production") {
      console.log(`API docs: http://localhost:${String(info.port)}/docs`);
    }
  },
);

// Register shutdown handlers
const shutdown = gracefulShutdown(server);
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
