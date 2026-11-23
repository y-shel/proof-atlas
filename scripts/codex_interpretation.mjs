import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resultStatus } from './interpretation.mjs';
const exec = promisify(execFile);

/** Non-inference inspection only. No prompt, exec, login action, API, or config mutation. */
export async function preflightCodex({ executable = 'codex', timeoutMs = 5000 } = {}) {
  const signal = AbortSignal.timeout(Math.min(timeoutMs, 5000));
  try {
    const version = await exec(executable, ['--version'], { signal, maxBuffer: 4096 });
    const versionMatch = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(version.stdout.trim());
    const inspection = { version: versionMatch?.[1] ?? 'unknown', authentication: 'unknown', toolBoundary: 'unverified' };
    const auth = await exec(executable, ['login', 'status'], { signal, maxBuffer: 4096 });
    if (!/Logged in using ChatGPT/.test(auth.stdout + auth.stderr))
      return { status: 'unavailable', inspection, reason: 'ChatGPT CLI authentication is unavailable; no login or API fallback attempted' };
    inspection.authentication = 'chatgpt-cli';
    return { status: 'unavailable', inspection, reason: 'Live generation unavailable. No supported protocol certifies an empty tool inventory for the inference configuration. Feature flags and debug prompt inventory alone are insufficient; no inference launched' };
  } catch {
    return { status: 'unavailable', reason: 'Codex version/auth inspection failed or exceeded its bound; no inference launched' };
  }
}
export async function runCodexInterpretation(request) {
  if (request.status !== 'ready') return resultStatus(request, request.status, 'none', 'No ready request; provider not inspected');
  const preflight = await preflightCodex({ timeoutMs: Math.max(1, Math.floor(request.limits.timeoutMs / 2)) });
  const result = resultStatus(request, preflight.status, 'none', preflight.reason);
  if (preflight.inspection) result.provenance.inspection = preflight.inspection;
  if (Buffer.byteLength(JSON.stringify(result) + '\n') > request.limits.artifactBytes) return resultStatus(request, 'over_limit', 'none', 'Preflight provenance exceeds artifactBytes');
  return result;
}
