// YUK-567 slice-2 — client wire types + callers for the 备课台「待你试做」probe 作答区.
//
// Two calls: list the active probes (GET, mirrors the server ActiveProbe contract),
// and submit an answer (POST → the conjecture probe-answer route, which grades via
// the real judge chokepoint and writes one probe_result event). Answers support text
// AND image refs (uploaded via uploadAsset → /api/assets); a photo-only answer is
// allowed (the route photo-only-gates to an image-consuming judge route).

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type ActiveProbesResponse = ApiOperationJsonResponse<'listPrepDeskProbes'>;
export type PrepDeskProbeWire = ActiveProbesResponse['probes'][number];

export const getActiveProbes = () =>
  apiOperationJson('listPrepDeskProbes', {
    url: '/api/prep-desk/probes',
    method: 'GET',
  });

export type ProbeAnswerVerdict = ApiOperationJsonResponse<'answerConjectureProbe'>;

export const submitProbeAnswer = (id: string, answerMd: string, answerImageRefs: string[]) =>
  apiOperationJson('answerConjectureProbe', {
    url: `/api/conjecture/probe/${encodeURIComponent(id)}/answer`,
    method: 'POST',
    body: { answer_md: answerMd, answer_image_refs: answerImageRefs },
  });
