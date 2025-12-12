import { Component, type ReactNode } from "react";
import { Sentry } from "../lib/sentry";
import { getCurrentTraceId } from "../lib/opentelemetry";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  traceId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      traceId: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      traceId: getCurrentTraceId(),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const traceId = getCurrentTraceId();

    // Capture error with Sentry including trace context
    Sentry.withScope((scope) => {
      scope.setTag("component", "ErrorBoundary");
      scope.setExtra("componentStack", errorInfo.componentStack);
      if (traceId) {
        scope.setTag("traceId", traceId);
      }
      Sentry.captureException(error);
    });

    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, traceId: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-fallback__content">
            <div className="error-boundary-fallback__icon">💥</div>
            <h1 className="error-boundary-fallback__title">
              Something went wrong
            </h1>
            <p className="error-boundary-fallback__message">
              An unexpected error occurred. The error has been reported to our
              monitoring system.
            </p>

            <div className="error-boundary-fallback__details">
              <p className="error-boundary-fallback__error">
                {this.state.error?.message || "Unknown error"}
              </p>
              {this.state.traceId && (
                <p className="error-boundary-fallback__trace">
                  Trace ID: {this.state.traceId}
                </p>
              )}
            </div>

            <div className="error-boundary-fallback__actions">
              <button
                className="error-boundary-fallback__button error-boundary-fallback__button--primary"
                onClick={this.handleReload}
              >
                Reload Page
              </button>
              <button
                className="error-boundary-fallback__button error-boundary-fallback__button--secondary"
                onClick={this.handleReset}
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
