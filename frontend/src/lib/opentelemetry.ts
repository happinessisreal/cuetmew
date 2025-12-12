import {
  WebTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const OTEL_ENDPOINT =
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

let provider: WebTracerProvider | null = null;

export function initOpenTelemetry() {
  const exporter = new OTLPTraceExporter({
    url: `${OTEL_ENDPOINT}/v1/traces`,
  });

  provider = new WebTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  provider.register({
    contextManager: new ZoneContextManager(),
  });

  // Register fetch instrumentation for automatic trace propagation
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: [/.*/], // Propagate to all URLs
        clearTimingResources: true,
      }),
    ],
  });

  console.log("[OpenTelemetry] Initialized with endpoint:", OTEL_ENDPOINT);
}

export function getTracer(name: string = "observability-dashboard") {
  return trace.getTracer(name);
}

export function getCurrentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (span) {
    return span.spanContext().traceId;
  }
  return null;
}

export function createSpan<T>(
  name: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export { trace, SpanStatusCode };
