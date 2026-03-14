import assert from 'node:assert';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { generateTraceId, generateTraceparent, main } from './index.ts';

describe('OTEL Action', () => {
  describe('generateTraceId', () => {
    it('should generate a 32-character hex string', () => {
      const traceId = generateTraceId();
      assert.strictEqual(traceId.length, 32);
      assert.match(traceId, /^[0-9a-f]{32}$/);
    });

    it('should start with a valid hex timestamp (current time)', () => {
      const traceId = generateTraceId();
      const timestampHex = traceId.substring(0, 8);
      const timestamp = parseInt(timestampHex, 16);
      const now = Math.floor(Date.now() / 1000);

      // Allow for a small time drift (5 seconds)
      assert.ok(timestamp <= now);
      assert.ok(timestamp > now - 5);
    });

    it('should generate unique IDs', () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();
      assert.notStrictEqual(id1, id2);
    });
  });

  describe('generateTraceparent', () => {
    it('should generate a valid W3C traceparent', () => {
      const traceparent = generateTraceparent();
      // Format: 00-<trace-id>-<span-id>-01
      assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('should contain a valid trace ID', () => {
      const traceparent = generateTraceparent();
      const traceId = traceparent.split('-')[1];
      const timestampHex = traceId.substring(0, 8);
      const timestamp = parseInt(timestampHex, 16);
      const now = Math.floor(Date.now() / 1000);

      assert.ok(timestamp <= now);
      assert.ok(timestamp > now - 5);
    });
  });

  describe('main', () => {
    const tempEnv = 'temp_env';
    const tempState = 'temp_state';

    it('should write to GITHUB_ENV and GITHUB_STATE and stdout when run with --start', async (t) => {
      const writeMock = t.mock.method(process.stdout, 'write');
      process.env.GITHUB_ENV = tempEnv;
      process.env.GITHUB_STATE = tempState;

      try {
        // Ensure files are clean
        if (fs.existsSync(tempEnv)) fs.unlinkSync(tempEnv);
        if (fs.existsSync(tempState)) fs.unlinkSync(tempState);

        await main(['--start']);

        const envContent = fs.readFileSync(tempEnv, 'utf8');
        const stateContent = fs.readFileSync(tempState, 'utf8');

        assert.match(envContent, /^TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
        assert.match(envContent, /^TRACEPARENT_START=[0-9]+$/m);

        assert.match(stateContent, /^isPost=true$/m);
        assert.match(stateContent, /^traceparent=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
        assert.match(stateContent, /^startTime=[0-9]+$/m);

        // Verify stdout
        const calls = writeMock.mock.calls;
        const stdout = calls.map((c) => c.arguments[0]).join('');
        assert.match(stdout, /^export TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
        assert.match(stdout, /^export TRACEPARENT_START=[0-9]+$/m);
      } finally {
        if (fs.existsSync(tempEnv)) fs.unlinkSync(tempEnv);
        if (fs.existsSync(tempState)) fs.unlinkSync(tempState);
        delete process.env.GITHUB_ENV;
        delete process.env.GITHUB_STATE;
      }
    });

    it('should still write to stdout when environment variables are not set', async (t) => {
      const writeMock = t.mock.method(process.stdout, 'write');
      await main(['--start']);

      const calls = writeMock.mock.calls;
      const stdout = calls.map((c) => c.arguments[0]).join('');
      assert.match(stdout, /^export TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
      assert.match(stdout, /^export TRACEPARENT_START=[0-9]+$/m);
    });
  });
});
