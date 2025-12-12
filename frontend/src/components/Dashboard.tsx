import { HealthStatus } from "./HealthStatus";
import { DownloadJobs } from "./DownloadJobs";
import { TraceViewer } from "./TraceViewer";
import { ErrorLog } from "./ErrorLog";
import { PerformanceMetrics } from "./PerformanceMetrics";
import "./Dashboard.css";

export function Dashboard() {
  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1 className="dashboard__title">📊 Observability Dashboard</h1>
        <p className="dashboard__subtitle">
          Real-time monitoring with Sentry error tracking and OpenTelemetry
          distributed tracing
        </p>
      </header>

      <div className="dashboard__content">
        <div>
          <HealthStatus />
          <DownloadJobs />
        </div>
        <div>
          <PerformanceMetrics />
          <ErrorLog />
          <TraceViewer />
        </div>
      </div>
    </div>
  );
}
