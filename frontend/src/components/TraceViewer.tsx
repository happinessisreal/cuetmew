import { useState, useEffect } from "react";
import { getCurrentTraceId, getTracer } from "../lib/opentelemetry";
import "./TraceViewer.css";

const JAEGER_UI_URL = import.meta.env.VITE_JAEGER_UI_URL || "http://localhost:16686";

export function TraceViewer() {
  const [currentTraceId, setCurrentTraceId] = useState<string | null>(null);

  useEffect(() => {
    // Update trace ID periodically
    const interval = setInterval(() => {
      const traceId = getCurrentTraceId();
      if (traceId) {
        setCurrentTraceId(traceId);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleCreateTestSpan = () => {
    const tracer = getTracer();
    const span = tracer.startSpan("user-interaction.test-span");
    span.setAttribute("user.action", "test-button-click");
    span.setAttribute("timestamp", new Date().toISOString());
    
    // Keep span active briefly to capture trace ID
    setTimeout(() => {
      const traceId = span.spanContext().traceId;
      setCurrentTraceId(traceId);
      span.end();
    }, 100);
  };

  const openJaegerUI = () => {
    window.open(JAEGER_UI_URL, "_blank");
  };

  const openTraceInJaeger = () => {
    if (currentTraceId) {
      window.open(`${JAEGER_UI_URL}/trace/${currentTraceId}`, "_blank");
    }
  };

  return (
    <div className="trace-viewer">
      <h2>🔍 Trace Viewer</h2>

      <div className="trace-viewer__content">
        <p className="trace-viewer__info">
          OpenTelemetry traces are collected and can be viewed in Jaeger UI.
          Traces correlate frontend user actions with backend API calls.
        </p>

        {currentTraceId && (
          <div className="trace-viewer__current">
            <div className="trace-viewer__label">Current Trace ID</div>
            <div className="trace-viewer__trace-id">{currentTraceId}</div>
          </div>
        )}

        <div className="trace-viewer__actions">
          <button
            className="trace-viewer__button trace-viewer__button--secondary"
            onClick={handleCreateTestSpan}
          >
            🧪 Create Test Span
          </button>

          <button
            className="trace-viewer__button trace-viewer__button--primary"
            onClick={openJaegerUI}
          >
            🔗 Open Jaeger UI
          </button>

          {currentTraceId && (
            <button
              className="trace-viewer__button trace-viewer__button--primary"
              onClick={openTraceInJaeger}
            >
              📊 View Current Trace
            </button>
          )}
        </div>

        <div className="trace-viewer__note">
          <strong>Note:</strong> Make sure Jaeger is running at{" "}
          <a
            href={JAEGER_UI_URL}
            className="trace-viewer__jaeger-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            {JAEGER_UI_URL}
          </a>{" "}
          to view traces. Run <code>docker compose -f docker/compose.dev.yml up</code> to start all services.
        </div>
      </div>
    </div>
  );
}
