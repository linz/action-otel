import crypto from 'node:crypto';
import fs from 'node:fs';

import type { SpanContext } from '@opentelemetry/api';
import { ROOT_CONTEXT, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export function generateTraceId(): string {
  const epoch = Math.floor(Date.now() / 1000).toString(16);
  const rand = crypto.randomBytes(12).toString('hex');
  return epoch + rand;
}

/**
 * Generates a random W3C Traceparent.
 * Format: 00-<trace-id>-<span-id>-01
 * trace-id: 16 random bytes (32 hex chars)
 * span-id: 8 random bytes (16 hex chars)
 */
export function generateTraceparent(): string {
  const spanId = crypto.randomBytes(8).toString('hex');
  return `00-${generateTraceId()}-${spanId}-01`;
}

async function submitSpan(traceparent: string, startTime: number): Promise<void> {
  const parts = traceparent.split('-');
  if (parts.length !== 4) return;

  const traceId = parts[1];
  const spanId = parts[2];

  const exporter =
    process.env.OTEL_EXPORTER_OTLP_CONSOLE === 'true' ? new ConsoleSpanExporter() : new OTLPTraceExporter();

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.GITHUB_ACTION ?? 'github-action',
    }),
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('action-otel');

  const spanContext: SpanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED };

  const span = tracer.startSpan(
    process.env.GITHUB_ACTION ?? 'action',
    {
      startTime,
      kind: SpanKind.INTERNAL,
    },
    trace.setSpanContext(ROOT_CONTEXT, spanContext),
  );

  span.end(Date.now());
  await provider.forceFlush();
  await provider.shutdown();
}

export function runStart() {
  const traceparent = generateTraceparent();
  const startTime = Date.now().toString();

  const githubEnv = process.env.GITHUB_ENV;
  if (githubEnv) {
    try {
      fs.appendFileSync(githubEnv, `TRACEPARENT=${traceparent}\n`);
      fs.appendFileSync(githubEnv, `TRACEPARENT_START=${startTime}\n`);
    } catch (err: any) {
      process.stderr.write(`Failed to write to $GITHUB_ENV: ${err.message}\n`);
    }
  }

  const githubState = process.env.GITHUB_STATE;
  if (githubState) {
    try {
      fs.appendFileSync(githubState, `isPost=true\n`);
      fs.appendFileSync(githubState, `traceparent=${traceparent}\n`);
      fs.appendFileSync(githubState, `startTime=${startTime}\n`);
    } catch (err: any) {
      process.stderr.write(`Failed to write to $GITHUB_STATE: ${err.message}\n`);
    }
  }

  // Output the export command as requested
  process.stdout.write(`export TRACEPARENT=${traceparent}\n`);
  process.stdout.write(`export TRACEPARENT_START=${startTime}\n`);
}

export async function runEnd() {
  const traceparent = process.env['TRACEPARENT'] ?? process.env['STATE_traceparent'] ?? '';
  const startTimeStr = process.env['TRACEPARENT_START'] ?? process.env['STATE_startTime'] ?? '';

  if (traceparent.trim() && startTimeStr) {
    const startTime = parseInt(startTimeStr);
    process.stdout.write(`Submitting span for TRACEPARENT=${traceparent} (started at ${startTime})\n`);
    try {
      await submitSpan(traceparent, startTime);
    } catch (err: any) {
      process.stderr.write(`Failed to submit span: ${err.message}\n`);
    }
  } else {
    process.stderr.write('Missing $TRACEPARENT or $TRACEPARENT_START\n');
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Detect if we are in the "post" phase of a GitHub Action
  const isGhaStatusPost = process.env['STATE_isPost'] === 'true';
  const isStart = argv.includes('--start') || (process.env.GITHUB_ACTIONS && !isGhaStatusPost);
  const isEnd = argv.includes('--end') || isGhaStatusPost;

  if (isStart && !isGhaStatusPost) runStart();
  if (isEnd) await runEnd();
}

main().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
