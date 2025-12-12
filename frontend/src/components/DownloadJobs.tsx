import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { initiateDownload, fetchJobStatus, type DownloadJob } from "../lib/api";
import { createSpan, getCurrentTraceId } from "../lib/opentelemetry";
import { Sentry } from "../lib/sentry";
import "./DownloadJobs.css";

export function DownloadJobs() {
  const [fileId, setFileId] = useState("");
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const initiateMutation = useMutation({
    mutationFn: async (fileId: number) => {
      return createSpan("initiateDownload", async () => {
        const traceId = getCurrentTraceId();
        console.log(
          `[Download] Initiating download for file ${fileId}, trace: ${traceId}`,
        );
        return initiateDownload(fileId);
      });
    },
    onSuccess: (data, variables) => {
      const newJob: DownloadJob = {
        jobId: data.jobId,
        fileId: variables,
        status: data.status as DownloadJob["status"],
        createdAt: new Date().toISOString(),
      };
      setJobs((prev) => [newJob, ...prev]);
      setFileId("");
      setError(null);
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Failed to initiate download";
      setError(message);
      Sentry.captureException(err, {
        tags: { component: "DownloadJobs", action: "initiateDownload" },
        extra: { fileId },
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(fileId);
    if (isNaN(id) || id < 10000 || id > 100000000) {
      setError("File ID must be between 10,000 and 100,000,000");
      return;
    }
    setError(null);
    initiateMutation.mutate(id);
  };

  // Poll job status for active jobs
  const activeJobIds = jobs
    .filter((j) => j.status === "queued" || j.status === "processing")
    .map((j) => j.jobId);

  useQuery({
    queryKey: ["jobStatuses", activeJobIds],
    queryFn: async () => {
      const updates = await Promise.all(
        activeJobIds.map(async (jobId) => {
          try {
            const status = await fetchJobStatus(jobId);
            return { ...status, polledJobId: jobId };
          } catch (err) {
            console.error(`Failed to fetch status for job ${jobId}:`, err);
            return null;
          }
        }),
      );

      // Update jobs with new status
      setJobs((prev) =>
        prev.map((job) => {
          const update = updates.find(
            (u) => u?.polledJobId === job.jobId || u?.jobId === job.jobId,
          );
          if (update) {
            return {
              ...job,
              status: update.status as DownloadJob["status"],
              progress: update.progress,
              downloadUrl: update.downloadUrl ?? undefined,
              message: update.message,
              updatedAt: update.updatedAt,
            };
          }
          return job;
        }),
      );

      return updates;
    },
    enabled: activeJobIds.length > 0,
    refetchInterval: 2000,
  });

  return (
    <div className="download-jobs">
      <h2>📥 Download Jobs</h2>

      <form className="download-jobs__form" onSubmit={handleSubmit}>
        <input
          type="number"
          className="download-jobs__input"
          placeholder="Enter File ID (10000 - 100000000)"
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
          min="10000"
          max="100000000"
        />
        <button
          type="submit"
          className="download-jobs__button"
          disabled={initiateMutation.isPending}
        >
          {initiateMutation.isPending ? "Starting..." : "Start Download"}
        </button>
      </form>

      {error && <div className="download-jobs__error">{error}</div>}

      <div className="download-jobs__list">
        {jobs.length === 0 ? (
          <div className="download-jobs__empty">
            No download jobs yet. Enter a file ID (10000-100000000) to start.
          </div>
        ) : (
          jobs.map((job) => (
            <div key={job.jobId} className="download-job">
              <div className="download-job__info">
                <div className="download-job__id">
                  Job: {job.jobId.slice(0, 8)}...
                </div>
                <div className="download-job__file-id">
                  File ID: {job.fileId}
                </div>
                {job.message && (
                  <div className="download-job__message">{job.message}</div>
                )}
                {job.error && (
                  <div className="download-job__error">{job.error}</div>
                )}
              </div>

              {(job.status === "processing" || job.status === "queued") && (
                <div className="download-job__progress">
                  <div
                    className="download-job__progress-bar"
                    style={{ width: `${job.progress || 0}%` }}
                  />
                </div>
              )}

              <span
                className={`download-job__status download-job__status--${job.status}`}
              >
                {job.status}{" "}
                {job.progress !== undefined ? `(${job.progress}%)` : ""}
              </span>

              {job.status === "completed" && job.downloadUrl && (
                <div className="download-job__actions">
                  <a
                    href={job.downloadUrl}
                    className="download-job__download-link"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download
                  </a>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
