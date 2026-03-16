import crypto, { createHash } from 'node:crypto';
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
export function generateTraceParent(): string {
  const spanId = crypto.randomBytes(8).toString('hex');
  return `00-${generateTraceId()}-${spanId}-01`;
}

function env(obj: Record<string, string>, key: string, envKey: string): void {
  const val = (process.env[envKey] ?? '').trim();
  if (val === '') return;
  obj[key] = val;
}

function readGithubEnv(): Record<string, string | undefined> | null {
  const output = {};
  env(output, 'github.actor', 'GITHUB_ACTOR');
  env(output, 'github.event', 'GITHUB_EVENT_NAME');
  env(output, 'github.job', 'GITHUB_JOB');
  env(output, 'github.ref', 'GITHUB_REF');
  env(output, 'github.sha', 'GITHUB_SHA');
  env(output, 'github.run_id', 'GITHUB_RUN_ID');
  env(output, 'github.repository', 'GITHUB_REPOSITORY');
  env(output, 'github.workflow', 'GITHUB_WORKFLOW');
  return output;
}

function maskKey(val: string): string {
  return createHash('sha256').update(val).digest('hex').slice(0, 12);
}

function getServiceName() {
  // linz_action-otel_push_test
  if (process.env.GITHUB_ACTION) {
    return `${process.env['GITHUB_REPOSITORY']}.${process.env['GITHUB_WORKFLOW']}.${process.env['GITHUB_JOB']}`;
  }
  return 'action-otel';
}

async function submitSpan(traceParent: string, startTime: number): Promise<void> {
  const parts = traceParent.split('-');
  if (parts.length !== 4) {
    process.stderr.write('Invalid TRACEPARENT format\n');
    return;
  }

  const traceId = parts[1];
  const spanId = parts[2];

  const exporter =
    process.env.OTEL_EXPORTER_OTLP_CONSOLE === 'true' ? new ConsoleSpanExporter() : new OTLPTraceExporter();

  process.stdout.write(`Using exporter: ${exporter.constructor.name}\n`);
  const otelEnv = Object.keys(process.env).filter((f) => f.startsWith('OTEL_'));
  const otel: Record<string, unknown> = {};
  for (const key of otelEnv) otel[key] = maskKey(process.env[key] ?? '');
  process.stdout.write(`OtelEnv: ${JSON.stringify(otel)}\n`);

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: getServiceName(),
      ...readGithubEnv(),
    }),
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('action-otel');

  const spanContext: SpanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED };

  const span = tracer.startSpan(
    process.env.GITHUB_WORKFLOW ? `action.${process.env['GITHUB_WORKFLOW']}.${process.env['GITHUB_JOB']}` : 'action',
    {
      startTime,
      kind: SpanKind.SERVER,
    },
    trace.setSpanContext(ROOT_CONTEXT, spanContext),
  );

  span.end(Date.now());
  console.log('Span ended, flushing exporter...');
  await provider.forceFlush();
  console.log('Exporter flushed, shutting down provider...');
  await provider.shutdown();
  console.log('Provider shut down.');
}

export function runStart() {
  const traceparent = generateTraceParent();
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
