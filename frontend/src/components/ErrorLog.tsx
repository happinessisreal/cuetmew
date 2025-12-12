import { useState } from "react";
import { Sentry } from "../lib/sentry";
import { getCurrentTraceId } from "../lib/opentelemetry";
import { triggerBackendSentryTest } from "../lib/api";
import "./ErrorLog.css";

interface ErrorEntry {
  id: string;
  type: string;
  message: string;
  timestamp: Date;
  traceId?: string | null;
}

export function ErrorLog() {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  const addError = (type: string, message: string) => {
    const traceId = getCurrentTraceId();
    const entry: ErrorEntry = {
      id: crypto.randomUUID(),
      type,
      message,
      timestamp: new Date(),
      traceId,
    };
    setErrors((prev) => [entry, ...prev].slice(0, 50)); // Keep last 50 errors
  };

  const handleTestError = () => {
    try {
      throw new Error("Test error from Observability Dashboard");
    } catch (err) {
      if (err instanceof Error) {
        Sentry.captureException(err, {
          tags: { component: "ErrorLog", action: "testError" },
          extra: { traceId: getCurrentTraceId() },
        });
        addError("Frontend Test Error", err.message);
      }
    }
  };

  const handleBackendSentryTest = async () => {
    try {
      const result = await triggerBackendSentryTest();
      // This intentionally returns an error response
      addError("Backend Sentry Test", result.message || "Backend error triggered for Sentry testing");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backend Sentry test failed";
      Sentry.captureException(err, {
        tags: { component: "ErrorLog", action: "backendSentryTest" },
        extra: { traceId: getCurrentTraceId() },
      });
      addError("Backend Sentry Test", message);
    }
  };



  const clearErrors = () => {
    setErrors([]);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString();
  };

  return (
    <div className="error-log">
      <h2>🚨 Error Log</h2>

      <div className="error-log__content">
        <p className="error-log__info">
          Errors captured by Sentry are logged here. View full details in your{" "}
          <a
            href="https://sentry.io"
            className="error-log__sentry-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sentry Dashboard
          </a>
          .
        </p>

        <div className="error-log__actions">
          <button
            className="error-log__button error-log__button--test"
            onClick={handleTestError}
          >
            🧪 Frontend Error
          </button>
          <button
            className="error-log__button error-log__button--backend"
            onClick={handleBackendSentryTest}
          >
            🔥 Backend Sentry Test
          </button>
          <button
            className="error-log__button error-log__button--clear"
            onClick={clearErrors}
            disabled={errors.length === 0}
          >
            🗑️ Clear Log
          </button>
        </div>

        <div className="error-log__list">
          {errors.length === 0 ? (
            <div className="error-log__empty">
              No errors captured yet. Click "Trigger Test Error" to test Sentry integration.
            </div>
          ) : (
            errors.map((error) => (
              <div key={error.id} className="error-log__item">
                <div className="error-log__item-header">
                  <span className="error-log__item-type">{error.type}</span>
                  <span className="error-log__item-time">
                    {formatTime(error.timestamp)}
                  </span>
                </div>
                <div className="error-log__item-message">{error.message}</div>
                {error.traceId && (
                  <div className="error-log__item-trace">
                    Trace: {error.traceId}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
