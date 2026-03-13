import { ROOT_CONTEXT, SpanContext, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Generates a random W3C Traceparent.
 * Format: 00-<trace-id>-<span-id>-01
 * trace-id: 16 random bytes (32 hex chars)
 * span-id: 8 random bytes (16 hex chars)
 */
function generateTraceparent(): string {
    const traceId = crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');
    return `00-${traceId}-${spanId}-01`;
}

async function submitSpan(traceparent: string, startTime: number): Promise<void> {
    const parts = traceparent.split('-');
    if (parts.length !== 4) return;

    const traceId = parts[1];
    const spanId = parts[2];

    const exporter = process.env.OTEL_EXPORTER_OTLP_CONSOLE === 'true'
        ? new ConsoleSpanExporter()
        : new OTLPTraceExporter();

    const provider = new BasicTracerProvider({
        resource: new Resource({
            [ATTR_SERVICE_NAME]: process.env.GITHUB_ACTION ?? 'github-action',
        }),
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const tracer = provider.getTracer('action-otel');

    const spanContext: SpanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED, };

    const span = tracer.startSpan(process.env.GITHUB_ACTION ?? 'action', {
        startTime,
        kind: SpanKind.INTERNAL,
    }, trace.setSpanContext(ROOT_CONTEXT, spanContext));

    span.end(Date.now());
    await provider.forceFlush();
    await provider.shutdown();
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Detect if we are in the "post" phase of a GitHub Action
    const isGhaStatusPost = process.env['STATE_isPost'] === 'true';
    const isStart = args.includes('--start') || (process.env.GITHUB_ACTIONS && !isGhaStatusPost);
    const isEnd = args.includes('--end') || isGhaStatusPost;

    if (isStart && !isGhaStatusPost) {
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

        // Output the export command as requested
        process.stdout.write(`export TRACEPARENT=${traceparent}\n`);
        process.stdout.write(`export TRACEPARENT_START=${startTime}\n`);
    }

    if (isEnd) {
        const traceparent = process.env['TRACEPARENT'] || process.env['STATE_traceparent'];
        const startTimeStr = process.env['TRACEPARENT_START'] || process.env['STATE_startTime'];

        if (traceparent && startTimeStr) {
            const startTime = parseInt(startTimeStr);
            process.stdout.write(`Submitting span for TRACEPARENT=${traceparent} (started at ${startTime})\n`);
            try {
                await submitSpan(traceparent, startTime);
            } catch (err: any) {
                process.stderr.write(`Failed to submit span: ${err.message}\n`);
            }
        } else {
            process.stderr.write('Missing TRACEPARENT or TRACEPARENT_START for end handler\n');
        }
    }
}

main().catch(err => {
    process.stderr.write(err.stack + '\n');
    process.exit(1);
});
