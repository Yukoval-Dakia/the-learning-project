import {
  type Dispatcher,
  type RequestInfo,
  type RequestInit,
  type Response,
  fetch as undiciFetch,
} from 'undici';

export type PinnedFetchInit = RequestInit & { dispatcher: Dispatcher };
export type PinnedFetchResponse = Response;
export type PinnedFetch = (
  input: RequestInfo,
  init: PinnedFetchInit,
) => Promise<PinnedFetchResponse>;

// Node's global fetch embeds its own Undici version. A dispatcher created by the
// npm package is only compatible with fetch from that same package/major.
export const fetchWithPinnedDispatcher: PinnedFetch = (input, init) => undiciFetch(input, init);
