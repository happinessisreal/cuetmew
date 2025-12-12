import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/api";
import "./HealthStatus.css";

export function HealthStatus() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5000, // Poll every 5 seconds
  });

  const getIndicatorClass = () => {
    if (isLoading) return "health-status__indicator health-status__indicator--loading";
    if (isError || data?.status !== "healthy")
      return "health-status__indicator health-status__indicator--unhealthy";
    return "health-status__indicator health-status__indicator--healthy";
  };

  return (
    <div className="health-status">
      <h2>
        <span className={getIndicatorClass()} />
        API Health Status
      </h2>

      {isError ? (
        <div className="health-status__error">
          Error: {error instanceof Error ? error.message : "Connection failed"}
        </div>
      ) : (
        <div className="health-status__details">
          <div className="health-status__detail">
            <div className="health-status__detail-label">Status</div>
            <div className="health-status__detail-value">
              {isLoading ? "Checking..." : data?.status?.toUpperCase() || "UNKNOWN"}
            </div>
          </div>
          <div className="health-status__detail">
            <div className="health-status__detail-label">Storage</div>
            <div className="health-status__detail-value">
              {isLoading ? "..." : data?.checks?.storage?.toUpperCase() || "N/A"}
            </div>
          </div>
          <div className="health-status__detail">
            <div className="health-status__detail-label">Last Check</div>
            <div className="health-status__detail-value">
              {isLoading
                ? "..."
                : dataUpdatedAt
                ? new Date(dataUpdatedAt).toLocaleTimeString()
                : "N/A"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
