# Long-Running Download Architecture Design

## Overview

This document describes the architecture for handling long-running file downloads (10-200+ seconds) in a way that avoids proxy timeouts and provides excellent user experience.

### The Problem

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Without Async Architecture                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Client ──POST /download──▶ API ──waits 120s──▶ Response                │
│                               │                                          │
│                               ▼                                          │
│                        ❌ TIMEOUT!                                       │
│                     (Cloudflare: 100s)                                   │
│                     (nginx default: 60s)                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Issues:**

- Cloudflare has a 100-second timeout
- nginx default proxy_read_timeout is 60 seconds
- AWS ALB idle timeout is 60 seconds
- Users see 504 Gateway Timeout errors
- No progress feedback during long waits

---

## 1. Architecture Diagram

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ARCHITECTURE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐         ┌──────────────────┐         ┌──────────────┐        │
│   │          │  HTTPS  │                  │         │              │        │
│   │  Client  │◀───────▶│  Reverse Proxy   │────────▶│   Hono API   │        │
│   │ (Browser)│         │ (Cloudflare/nginx)│         │  (Node.js)   │        │
│   │          │         │                  │         │              │        │
│   └──────────┘         └──────────────────┘         └──────┬───────┘        │
│                                                             │                │
│                                                    ┌────────┴────────┐      │
│                                                    │                 │      │
│                                                    ▼                 ▼      │
│                                            ┌─────────────┐   ┌───────────┐  │
│                                            │             │   │           │  │
│                                            │    Redis    │   │   MinIO   │  │
│                                            │  (BullMQ)   │   │    (S3)   │  │
│                                            │             │   │           │  │
│                                            └──────┬──────┘   └───────────┘  │
│                                                   │                 ▲       │
│                                                   │                 │       │
│                                                   ▼                 │       │
│                                            ┌─────────────┐          │       │
│                                            │             │          │       │
│                                            │   Worker    │──────────┘       │
│                                            │  (BullMQ)   │                  │
│                                            │             │                  │
│                                            └─────────────┘                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagram

**Fast Download Flow (< 30s):**
```
┌────────┐     POST /initiate     ┌─────────┐     Queue Job     ┌─────────┐
│ Client │ ──────────────────────▶│   API   │ ─────────────────▶│  Redis  │
└────────┘   ◀── {jobId} ────────└─────────┘                    └────┬────┘
     │                                                                │
     │         GET /status/:jobId                                     ▼
     │ ───────────────────────────────────────────────────────▶ ┌─────────┐
     │ ◀───────── {progress: 100%, downloadUrl} ─────────────── │ Worker  │
     │                                                          └─────────┘
     │                                                                │
     │         GET downloadUrl (presigned S3)                         │
     │ ──────────────────────────────────────────────────────────────▶│
     │ ◀───────────────────── File Content ──────────────────────────│
     ▼                                                           ┌─────────┐
┌────────┐                                                       │  MinIO  │
│  File  │                                                       └─────────┘
└────────┘
```

**Slow Download Flow (30-120s) - Handles Timeout Gracefully:**
```
┌────────┐     POST /initiate     ┌─────────┐     Queue Job     ┌─────────┐
│ Client │ ──────────────────────▶│   API   │ ─────────────────▶│  Redis  │
└────────┘   ◀── {jobId} ────────└─────────┘                    └────┬────┘
     │                                                                │
     │   ┌──────────────────────────────────────────────────────────┐ │
     │   │  POLLING LOOP (with exponential backoff + jitter)        │ │
     │   │                                                          │ ▼
     │   │  GET /status/:jobId ──▶ {progress: 10%}  ◀── Worker     │ ┌─────────┐
     │   │  (wait 2s + jitter)                      processing...   │ │ Worker  │
     │   │  GET /status/:jobId ──▶ {progress: 30%}                  │ └─────────┘
     │   │  (wait 4s + jitter)                                      │
     │   │  GET /status/:jobId ──▶ {progress: 60%}                  │
     │   │  (wait 8s + jitter)                                      │
     │   │  GET /status/:jobId ──▶ {progress: 100%, downloadUrl}    │
     │   └──────────────────────────────────────────────────────────┘
     │                                                                
     │         GET downloadUrl (presigned S3 URL)                     
     │ ──────────────────────────────────────────────────────────────▶
     │ ◀───────────────────── File Content ──────────────────────────
     ▼                                                           ┌─────────┐
┌────────┐                                                       │  MinIO  │
│  File  │                                                       └─────────┘
└────────┘
```

---

## 2. Technical Approach

### Chosen Pattern: **Option A - Polling Pattern** (with enhancements)

```
Client → POST /download/initiate → Returns jobId immediately
Client → GET /download/status/:jobId (poll with exponential backoff)
Client → Download via presigned S3 URL (when ready)
```

### Why Polling Was Chosen

| Approach    | Pros                                | Cons                             |
| ----------- | ----------------------------------- | -------------------------------- |
| **Polling** | Simple, works everywhere, stateless | More requests, slight delay      |
| WebSocket   | Real-time updates                   | Complex, connection management   |
| SSE         | Server-push, simpler than WS        | One-way, browser support varies  |
| Webhooks    | Server-to-server, no polling        | Requires client to have endpoint |

**Justification for Polling:**

1. **Works through all proxies and firewalls** - No special proxy configuration needed
2. **No persistent connections to manage** - Simpler server architecture
3. **Client can resume from any state** - Browser refresh doesn't break the flow
4. **Simple frontend implementation** - Just `fetch()` in a loop
5. **Stateless server** - Horizontal scaling friendly (any server can answer status queries)
6. **Cost-effective** - No WebSocket connection overhead

### Enhancements to Basic Polling

To make polling efficient, we add:

1. **Exponential Backoff + Jitter** - Reduces server load, prevents thundering herd
2. **ETag Caching** - Server returns `304 Not Modified` when status unchanged (~90% bandwidth savings)
3. **Optional SSE** - Real-time updates with automatic polling fallback

---

## 3. Implementation Details

### 3.1 API Contract Changes

**Existing Endpoint Enhanced: `POST /v1/download/initiate`**

```typescript
// Request
{
  "file_ids": [70000, 70001, 70002]
}

// Response (returns immediately, < 100ms)
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "totalFileIds": 3
}
```

**New Endpoint: `GET /v1/download/status/:jobId`**

```typescript
// Response during processing
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "file_id": 70000,
  "status": "processing",
  "progress": 45,
  "downloadUrl": null,
  "size": null,
  "processingTimeMs": null,
  "message": "Processing download...",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:45.000Z"
}

// Response when completed
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "file_id": 70000,
  "status": "completed",
  "progress": 100,
  "downloadUrl": "http://minio:9000/downloads/70000.zip?X-Amz-...",
  "size": 1048576,
  "processingTimeMs": 95432,
  "message": "Download ready after 95.4 seconds",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:01:35.000Z"
}

// Response when failed
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "file_id": 70000,
  "status": "failed",
  "progress": 100,
  "downloadUrl": null,
  "size": null,
  "processingTimeMs": null,
  "message": "File 70000.zip does not exist in storage",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:01:35.000Z"
}
```

### 3.2 Database/Cache Schema

**Redis Schema for Job Status**

```
Key:    job:{jobId}
TTL:    86400 seconds (24 hours)
Value:  JSON string

{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "file_id": 70000,
  "status": "queued" | "processing" | "completed" | "failed",
  "progress": 0-100,
  "downloadUrl": string | null,
  "size": number | null,
  "processingTimeMs": number | null,
  "message": string,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

**Why Redis?**

| Feature | Benefit |
|---------|---------|
| In-memory | < 1ms read/write latency |
| TTL support | Automatic job cleanup after 24h |
| BullMQ compatible | Native integration with job queue |
| Horizontal scaling | Redis Cluster for high availability |
| Cost | Low - single Redis instance handles millions of jobs |

### 3.3 Background Job Processing

**Queue System: BullMQ + Redis**

```typescript
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

// Redis connection
const redisConnection = new Redis(process.env.REDIS_URL);

// Queue configuration
const downloadQueue = new Queue("download-jobs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Worker configuration
const downloadWorker = new Worker(
  "download-jobs",
  async (job) => {
    const { jobId, fileId } = job.data;
    await processDownloadJob(jobId, fileId);
  },
  {
    connection: redisConnection,
    concurrency: 5, // Process 5 jobs in parallel
  },
);
```

**Job Processing Flow:**

```
1. POST /v1/download/initiate
   ├── Create job in Redis (status: queued)
   └── Add job to BullMQ queue

2. Worker picks up job
   ├── Update Redis (status: processing, progress: 0%)
   ├── Simulate/perform download (10-120s)
   ├── Update Redis every 10% progress
   └── Check if file exists in S3

3. If file exists:
   ├── Generate presigned URL
   └── Update Redis (status: completed, downloadUrl: ...)

4. If file doesn't exist:
   └── Update Redis (status: failed, message: "File not found")
```

### 3.4 Error Handling & Retry Logic

```typescript
// BullMQ automatic retry configuration
const downloadQueue = new Queue("download-jobs", {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // Retry delays: 5s, 10s, 20s
    },
  },
});

// Worker error handling
downloadWorker.on("failed", async (job, err) => {
  console.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err);
  
  // Update job status in Redis
  if (job?.data?.jobId) {
    await redisConnection.set(
      `job:${job.data.jobId}`,
      JSON.stringify({
        ...existingJob,
        status: "failed",
        message: `Failed: ${err.message}`,
        updatedAt: new Date().toISOString(),
      }),
      "EX",
      86400
    );
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await downloadWorker.close();
  await downloadQueue.close();
  await redisConnection.quit();
});
```

**Error Scenarios Handled:**

| Error Type | Handling Strategy |
|------------|-------------------|
| S3 connection failure | Retry 3 times with exponential backoff |
| File not found | Fail immediately, no retry |
| Redis connection failure | Worker crashes, Docker restarts |
| Worker process crash | BullMQ requeues incomplete jobs |

### 3.5 Timeout Configuration at Each Layer

| Layer | Setting | Value | Justification |
|-------|---------|-------|---------------|
| **Cloudflare** | Proxy timeout | 100s (default) | N/A - polling requests complete in < 100ms |
| **nginx** | proxy_read_timeout | 30s | Status polling is fast, no long connections |
| **Hono API** | REQUEST_TIMEOUT_MS | 30000 (30s) | Safety limit for request handlers |
| **BullMQ Worker** | Job timeout | None | Jobs run until completion (10-120s) |
| **Presigned URL** | PRESIGNED_URL_EXPIRY_SECONDS | 3600 (1 hour) | User has 1 hour to download |
| **Redis job TTL** | Expiry | 86400 (24 hours) | Jobs cleaned up after 24h |
| **Client polling** | Backoff max | 15000ms | Cap polling at 15s intervals |

---

## 4. Proxy Configuration

### 4.1 Cloudflare

```yaml
# Cloudflare doesn't need special configuration for polling pattern
# All API requests complete in < 100ms, well under the 100s timeout

# Dashboard Settings (optional):
# Speed → Optimization → Auto Minify: Off (for API responses)
# Network → WebSockets: On (if implementing SSE fallback)

# Page Rules (if needed):
# api.example.com/v1/* → Cache Level: Bypass
```

**Why no special config needed:**

- Polling requests are fast (< 100ms)
- No long-running HTTP connections
- File downloads use presigned S3 URLs (bypass Cloudflare)

### 4.2 nginx

```nginx
upstream api_backend {
    server app:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name api.example.com;

    # API endpoints
    location /v1/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Connection reuse
        proxy_set_header Connection "";
        
        # Short timeouts (polling is fast)
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
        
        # Disable buffering for real-time status updates
        proxy_buffering off;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://api_backend;
        proxy_connect_timeout 5s;
        proxy_read_timeout 5s;
    }

    # SSE endpoint (optional)
    location /v1/download/events/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        
        # SSE-specific settings
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;  # Keep SSE connection open
        chunked_transfer_encoding off;
    }
}
```

### 4.3 AWS Application Load Balancer

```yaml
# Target Group Configuration
TargetGroup:
  Type: AWS::ElasticLoadBalancingV2::TargetGroup
  Properties:
    HealthCheckPath: /health
    HealthCheckIntervalSeconds: 30
    HealthCheckTimeoutSeconds: 5
    HealthyThresholdCount: 2
    UnhealthyThresholdCount: 3
    Port: 3000
    Protocol: HTTP
    TargetType: ip

# ALB Attributes
LoadBalancer:
  Type: AWS::ElasticLoadBalancingV2::LoadBalancer
  Properties:
    LoadBalancerAttributes:
      - Key: idle_timeout.timeout_seconds
        Value: "60"  # Default is fine for polling
```

---

## 5. Frontend Integration

### 5.1 Initiating Downloads

```tsx
// API client
async function initiateDownload(fileIds: number[]): Promise<{ jobId: string }> {
  const response = await fetch("/v1/download/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids: fileIds }),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to initiate download: ${response.status}`);
  }
  
  return response.json();
}
```

### 5.2 Showing Progress to Users

```tsx
import { useState, useEffect, useRef } from "react";

interface JobStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  downloadUrl: string | null;
  message: string;
}

function useDownloadWithBackoff() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const etagRef = useRef<string | null>(null);

  // Exponential backoff + jitter calculation
  const getDelay = (attempt: number): number => {
    const baseDelay = Math.min(2000 * Math.pow(2, attempt), 15000);
    const jitter = baseDelay * 0.25 * (Math.random() - 0.5);
    return Math.round(baseDelay + jitter);
  };

  // Initiate download
  const startDownload = async (fileIds: number[]) => {
    try {
      setError(null);
      const response = await fetch("/v1/download/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds }),
      });
      const data = await response.json();
      setJobId(data.jobId);
      setStatus({ ...data, progress: 0, downloadUrl: null, message: "Queued" });
      etagRef.current = null;
    } catch (err) {
      setError("Failed to start download");
    }
  };

  // Poll for status with backoff + ETag
  useEffect(() => {
    if (!jobId) return;

    let timeoutId: NodeJS.Timeout;
    let attempt = 0;

    const pollStatus = async () => {
      try {
        const headers: HeadersInit = {};
        if (etagRef.current) {
          headers["If-None-Match"] = etagRef.current;
        }

        const response = await fetch(`/v1/download/status/${jobId}`, { headers });
        
        const newEtag = response.headers.get("ETag");
        if (newEtag) etagRef.current = newEtag;

        // 304 Not Modified - status unchanged
        if (response.status === 304) {
          attempt = Math.min(attempt + 1, 4);
          timeoutId = setTimeout(pollStatus, getDelay(attempt));
          return;
        }

        const data: JobStatus = await response.json();
        setStatus(data);

        if (data.status === "completed" || data.status === "failed") {
          return; // Stop polling
        }

        // Reset backoff if progress changed
        if (data.progress !== status?.progress) {
          attempt = 0;
        } else {
          attempt = Math.min(attempt + 1, 4);
        }

        timeoutId = setTimeout(pollStatus, getDelay(attempt));
      } catch (err) {
        attempt = Math.min(attempt + 1, 4);
        timeoutId = setTimeout(pollStatus, getDelay(attempt));
      }
    };

    pollStatus();
    return () => clearTimeout(timeoutId);
  }, [jobId]);

  return { startDownload, status, error };
}
```

### 5.3 Handling Completion/Failure States

```tsx
function DownloadButton({ fileId }: { fileId: number }) {
  const { startDownload, status, error } = useDownloadWithBackoff();

  // Handle completion - auto-download
  useEffect(() => {
    if (status?.status === "completed" && status.downloadUrl) {
      // Create hidden link and click to download
      const link = document.createElement("a");
      link.href = status.downloadUrl;
      link.download = `${fileId}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }, [status?.status, status?.downloadUrl, fileId]);

  if (error) {
    return (
      <div className="error">
        <p>{error}</p>
        <button onClick={() => startDownload([fileId])}>Try Again</button>
      </div>
    );
  }

  if (status?.status === "failed") {
    return (
      <div className="error">
        <p>Download failed: {status.message}</p>
        <button onClick={() => startDownload([fileId])}>Retry</button>
      </div>
    );
  }

  if (status?.status === "processing" || status?.status === "queued") {
    return (
      <div className="progress">
        <div className="progress-bar" style={{ width: `${status.progress}%` }} />
        <span>{status.progress}% - {status.message}</span>
      </div>
    );
  }

  if (status?.status === "completed") {
    return (
      <a href={status.downloadUrl!} download className="success">
        ✅ Download Ready - Click to Save
      </a>
    );
  }

  return (
    <button onClick={() => startDownload([fileId])}>
      Download File
    </button>
  );
}
```

### 5.4 Implementing Retry Logic

```tsx
// Handle browser close/refresh - persist job ID
useEffect(() => {
  if (jobId) {
    localStorage.setItem("pendingDownloadJob", jobId);
  }
}, [jobId]);

// Resume polling on page load
useEffect(() => {
  const savedJobId = localStorage.getItem("pendingDownloadJob");
  if (savedJobId) {
    setJobId(savedJobId);
  }
}, []);

// Clear job ID when complete
useEffect(() => {
  if (status?.status === "completed" || status?.status === "failed") {
    localStorage.removeItem("pendingDownloadJob");
  }
}, [status?.status]);
```

### 5.5 Multiple Concurrent Downloads

```tsx
function useMultipleDownloads() {
  const [downloads, setDownloads] = useState<Map<string, JobStatus>>(new Map());

  const startDownload = async (fileId: number) => {
    const response = await fetch("/v1/download/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: [fileId] }),
    });
    const { jobId } = await response.json();
    
    setDownloads(prev => new Map(prev).set(jobId, {
      jobId,
      status: "queued",
      progress: 0,
      downloadUrl: null,
      message: "Queued",
    }));

    // Start polling for this specific job
    pollJob(jobId);
  };

  const pollJob = async (jobId: string) => {
    // ... polling logic for individual job
  };

  return { downloads: Array.from(downloads.values()), startDownload };
}

// Usage
function DownloadQueue() {
  const { downloads, startDownload } = useMultipleDownloads();

  return (
    <div>
      <button onClick={() => startDownload(70001)}>Download File 1</button>
      <button onClick={() => startDownload(70002)}>Download File 2</button>
      
      {downloads.map(d => (
        <div key={d.jobId}>
          Job {d.jobId}: {d.status} ({d.progress}%)
        </div>
      ))}
    </div>
  );
}
```

---

## Additional Considerations

### Cost Implications

| Component | Cost Model | Estimated Cost |
|-----------|------------|----------------|
| Redis | Memory-based | ~$15/month (1GB) |
| BullMQ | Open source | Free |
| MinIO | Self-hosted | Infrastructure cost only |
| S3 (if using AWS) | Per request + storage | ~$0.023/GB + $0.005/1K requests |

### Scalability

- **Horizontal scaling**: Add more API instances, BullMQ workers
- **Redis**: Use Redis Cluster for high availability
- **S3**: Infinitely scalable object storage

### Security

- Presigned URLs expire after 1 hour
- Job IDs are UUIDs (hard to guess)
- Redis should be internal-only (not exposed to internet)

---

## Summary

| Component       | Technology            | Purpose                          |
| --------------- | --------------------- | -------------------------------- |
| API Framework   | Hono (Node.js)        | HTTP endpoints, request handling |
| Job Queue       | BullMQ                | Async job processing             |
| State Storage   | Redis                 | Job status, progress tracking    |
| Object Storage  | MinIO (S3-compatible) | File storage                     |
| URL Generation  | AWS SDK presigner     | Secure, expiring download URLs   |
| Client Polling  | Backoff + Jitter      | Efficient status updates         |
| Response Cache  | ETags + 304           | Bandwidth optimization           |

**Key Benefits:**

- ✅ No proxy timeouts (instant response)
- ✅ Real-time progress feedback
- ✅ Efficient polling with exponential backoff + jitter
- ✅ ETag caching reduces bandwidth by ~90%
- ✅ Resilient to browser refresh/close
- ✅ Horizontally scalable
- ✅ Works behind any reverse proxy
- ✅ Handles multiple concurrent downloads
