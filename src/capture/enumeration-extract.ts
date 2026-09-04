// First-pass extraction of "enumerated reference data" endpoints from a capture: the
// category tree, attribute options, plan tiers, regions — whatever the plan's
// `enumerate: true` controls walked through. Deterministic heuristics flag which
// captured endpoints look like the option source; identifying the exact endpoint and
// its JSON shape is the judgment step a model or human finishes.

import type { DiscoveryPlan } from '../discovery/plan.js';
import type { CapturedRoute, JsonShape } from './playwright-capture.js';
import { distinctEndpoints } from './playwright-capture.js';

const NOISE = /analytics|tracking|telemetry|metrics?|events?\/collect|pixel|sentry|datadog|amplitude|segment\.io|commanders-act|cdn-cgi|conversion|pinterest/i;
const ENUMERATION_SHAPE = /children|options|values|items|nodes|tree|levels?/i;

export interface EnumerationCandidate {
  /** The enumerating control id from the plan. */
  control: string;
  method: string;
  url: string;
  status: number;
  score: number;
  reason: string;
  responseShape?: JsonShape;
}

export function extractEnumerationCandidates(routes: CapturedRoute[], plan: DiscoveryPlan): EnumerationCandidate[] {
  const endpoints = distinctEndpoints(routes);
  const controls = plan.surfaces
    .flatMap((surface) => surface.controls ?? [])
    .filter((control) => control.enumerate)
    .map((control) => ({ id: control.id, signal: control.signal ? new RegExp(control.signal, 'i') : undefined }));
  const candidates: EnumerationCandidate[] = [];

  for (const endpoint of endpoints) {
    if (NOISE.test(endpoint.url)) continue;
    const observedDuring = endpoint.observedDuring ?? (endpoint.phase ? [endpoint.phase] : []);
    const shapeText = JSON.stringify(endpoint.responseShape ?? {});
    for (const control of controls) {
      const urlHint = !!control.signal && control.signal.test(endpoint.url);
      const phaseMatch = observedDuring.includes(control.id);
      const shapeMatch = ENUMERATION_SHAPE.test(shapeText) || (!!control.signal && control.signal.test(shapeText));
      if (!urlHint && !(phaseMatch && shapeMatch)) continue;
      let score = 1;
      const reasons: string[] = [];
      if (urlHint) reasons.push('url matches control signal');
      if (phaseMatch) { score += 4; reasons.push(`observed while exercising ${control.id}`); }
      if (shapeMatch) { score += 2; reasons.push('response shape looks enumerable'); }
      if (endpoint.method === 'GET') { score += 1; reasons.push('GET (read)'); }
      if (endpoint.status >= 200 && endpoint.status < 300) { score += 1; reasons.push('2xx'); }
      candidates.push({
        control: control.id,
        method: endpoint.method,
        url: endpoint.url,
        status: endpoint.status,
        score,
        reason: reasons.join(', '),
        ...(endpoint.responseShape ? { responseShape: endpoint.responseShape } : {}),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.control.localeCompare(b.control));
}
