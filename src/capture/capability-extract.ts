// Correlates sanitized endpoints with the discovery phase that caused them, scored
// against the plan's per-surface / per-control `signal` patterns. A phase is useful
// only when the route is not ambient across unrelated surfaces; it never turns generic
// search/favourites/analytics traffic into a capability by itself.

import type { DiscoveryPlan } from '../discovery/plan.js';
import type { CapturedRoute, JsonShape } from './playwright-capture.js';
import { distinctEndpoints } from './playwright-capture.js';

export interface CapabilityRouteCandidate {
  /** A surface or control id from the plan. */
  capability: string;
  method: string;
  url: string;
  status: number;
  score: number;
  reason: string;
  observedDuring: string[];
  requestShape?: JsonShape;
  responseShape?: JsonShape;
}

const NOISE = /analytics|tracking|telemetry|metrics?|events?\/collect|pixel|sentry|datadog|amplitude|segment\.io|commanders-act|cdn-cgi|conversion|pinterest/i;

interface CapabilitySignal {
  capability: string;
  signal: RegExp;
}

/** Every surface and control that declares a `signal` becomes a scoreable capability. */
export function planCapabilities(plan: DiscoveryPlan): CapabilitySignal[] {
  const result: CapabilitySignal[] = [];
  for (const surface of plan.surfaces) {
    if (surface.signal) result.push({ capability: surface.id, signal: new RegExp(surface.signal, 'i') });
    for (const control of surface.controls ?? []) {
      if (control.signal) result.push({ capability: control.id, signal: new RegExp(control.signal, 'i') });
    }
  }
  return result;
}

export function extractCapabilityRoutes(routes: CapturedRoute[], plan: DiscoveryPlan): CapabilityRouteCandidate[] {
  const endpoints = distinctEndpoints(routes);
  const capabilities = planCapabilities(plan);
  const ignore = plan.ignoreEndpointPattern ? new RegExp(plan.ignoreEndpointPattern, 'i') : undefined;
  const candidates: CapabilityRouteCandidate[] = [];

  for (const endpoint of endpoints) {
    if (NOISE.test(endpoint.url) || ignore?.test(endpoint.url)) continue;
    const observedDuring = endpoint.observedDuring ?? (endpoint.phase ? [endpoint.phase] : []);
    const shapeText = JSON.stringify({ request: endpoint.requestShape, response: endpoint.responseShape });
    for (const { capability, signal } of capabilities) {
      const reasons: string[] = [];
      let score = 0;
      const urlMatch = signal.test(endpoint.url);
      if (urlMatch) {
        score += 3;
        reasons.push('URL signal');
      }
      const structuralMatch = signal.test(shapeText);
      if (structuralMatch) {
        score += 2;
        reasons.push('JSON shape signal');
      }
      const correlatedPhase = observedDuring.includes(capability) && observedDuring.length <= 2;
      if (correlatedPhase) {
        score += 5;
        reasons.push(`observed during ${capability}`);
      }
      if (endpoint.status >= 200 && endpoint.status < 300) {
        score += 1;
        reasons.push('2xx');
      }
      if (/json|graphql/i.test(endpoint.contentType ?? endpoint.url)) {
        score += 1;
        reasons.push('structured response');
      }
      if (!urlMatch && !structuralMatch) continue;
      if (!urlMatch && !correlatedPhase) continue;
      if (score < 4) continue;
      candidates.push({
        capability,
        method: endpoint.method,
        url: endpoint.url,
        status: endpoint.status,
        score,
        reason: reasons.join(', '),
        observedDuring,
        ...(endpoint.requestShape ? { requestShape: endpoint.requestShape } : {}),
        ...(endpoint.responseShape ? { responseShape: endpoint.responseShape } : {}),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score || a.capability.localeCompare(b.capability));
}
