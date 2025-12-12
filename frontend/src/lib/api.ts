const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

export interface HealthResponse {
  status: string;
  checks: {
    storage: string;
  };
}

export interface DownloadJob {
  jobId: string;
  fileId: number;
  status: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  downloadUrl?: string;
  error?: string;
  message?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface DownloadInitiateResponse {
  jobId: string;
  status: string;
  totalFileIds: number;
}

export interface JobStatusResponse {
  jobId: string;
  file_id: number;
  status: string;
  progress: number;
  downloadUrl: string | null;
  size: number | null;
  processingTimeMs: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  return response.json();
}

export async function initiateDownload(
  fileId: number,
): Promise<DownloadInitiateResponse> {
  // file_id must be between 10000 and 100000000
  if (fileId < 10000 || fileId > 100000000) {
    throw new Error("File ID must be between 10,000 and 100,000,000");
  }

  const response = await fetch(`${API_BASE_URL}/v1/download/initiate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_ids: [fileId] }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.message || `Download initiation failed: ${response.status}`,
    );
  }

  return response.json();
}

export async function fetchJobStatus(
  jobId: string,
): Promise<JobStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/v1/download/status/${jobId}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.message || `Job status fetch failed: ${response.status}`,
    );
  }

  return response.json();
}

/**
 * Trigger a test error in the backend to verify Sentry integration.
 * This calls the /v1/download/check endpoint with sentry_test=true.
 */
export async function triggerBackendSentryTest(): Promise<{
  error: string;
  message: string;
}> {
  const response = await fetch(
    `${API_BASE_URL}/v1/download/check?sentry_test=true`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: 70000 }),
    },
  );

  // This endpoint intentionally returns 500 for testing
  const data = await response.json();
  return data;
}

export { API_BASE_URL };
