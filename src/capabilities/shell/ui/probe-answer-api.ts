// YUK-567 slice-2 — client wire types + callers for the 备课台「待你试做」probe 作答区.
//
// Two calls: list the active probes (GET, mirrors the server ActiveProbe contract),
// and submit an answer (POST → the conjecture probe-answer route, which grades via
// the real judge chokepoint and writes one probe_result event). Answers support text
// AND image refs (uploaded via uploadAsset → /api/assets); a photo-only answer is
// allowed (the route photo-only-gates to an image-consuming judge route).

import { apiJson } from '@/ui/lib/api';

export interface PrepDeskProbeWire {
  /** target of the answer POST. */
  probe_question_id: string;
  /** the question the team is about to ask. */
  prompt_md: string;
  knowledge_id: string | null;
}

export interface ActiveProbesResponse {
  probes: PrepDeskProbeWire[];
}

export const getActiveProbes = () => apiJson<ActiveProbesResponse>('/api/prep-desk/probes');

export interface ProbeAnswerVerdict {
  /** 'confirmed' = the conjecture's predicted misconception was observed (answered wrong);
   *  'retired'   = the conjecture was falsified (answered right). */
  status: 'confirmed' | 'retired';
  resolution: 'confirmed' | 'retired';
  outcome: 0 | 1;
  idempotent?: boolean;
}

export const submitProbeAnswer = (id: string, answerMd: string, answerImageRefs: string[]) =>
  apiJson<ProbeAnswerVerdict>(`/api/conjecture/probe/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer_md: answerMd, answer_image_refs: answerImageRefs }),
  });
