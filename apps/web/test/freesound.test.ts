/**
 * The library client, pinned against the API it was written for.
 *
 * Two kinds of thing are asserted here and they fail differently. The **request
 * shape** is a contract with a service nobody in this repository controls: it is
 * pinned so that the day Freesound renames a parameter, a test says so instead of a
 * user seeing an empty result list. The **failure mapping** is what the panel draws —
 * a rejected key and a throttled key look identical as a red box and need completely
 * different sentences under them.
 *
 * Written against Freesound APIv2 as documented on 2026-08-08. The `fetch` is
 * injected, so nothing here touches a network.
 */

import { describe, expect, it } from 'vitest';
import {
  FreesoundError,
  attributionFor,
  fetchOriginal,
  fetchPreview,
  licenceOf,
  needsAttribution,
  safeName,
  searchFreesound,
  type FreesoundSound,
} from '../src/lib/freesound.js';

/** One row as the API sends it, with the API's own field names. */
const ROW = {
  id: 12345,
  name: 'door_slam_heavy.wav',
  url: 'https://freesound.org/people/someone/sounds/12345/',
  duration: 1.234,
  type: 'wav',
  license: 'http://creativecommons.org/publicdomain/zero/1.0/',
  username: 'someone',
  tags: ['door', 'slam', 'wood'],
  channels: 2,
  samplerate: 48000,
  filesize: 231044,
  avg_rating: 4.5,
  num_downloads: 812,
  previews: {
    'preview-hq-mp3': 'https://cdn.freesound.org/previews/12/12345_1-hq.mp3',
    'preview-lq-mp3': 'https://cdn.freesound.org/previews/12/12345_1-lq.mp3',
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Record the one call and answer with `response`. */
function stub(response: Response | (() => Promise<Response>)): {
  fetchImpl: typeof fetch;
  calls: { url: URL; init: RequestInit | undefined }[];
} {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: new URL(url), init });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('searchFreesound', () => {
  it('asks for the fields it reads, filtered and sorted by the library’s own relevance', async () => {
    const { fetchImpl, calls } = stub(json(200, { count: 1, results: [ROW] }));
    await searchFreesound({ token: 'T', query: 'door slam wood', licence: 'cc0', maxSeconds: 4, fetchImpl });

    const url = calls[0]?.url;
    expect(`${url?.origin ?? ''}${url?.pathname ?? ''}`).toBe('https://freesound.org/apiv2/search/text/');
    expect(url?.searchParams.get('query')).toBe('door slam wood');
    expect(url?.searchParams.get('filter')).toBe('license:"Creative Commons 0" duration:[* TO 4]');
    expect(url?.searchParams.get('sort')).toBe('score');
    expect(url?.searchParams.get('page_size')).toBe('30');
    for (const field of ['id', 'name', 'url', 'duration', 'license', 'previews', 'type']) {
      expect(url?.searchParams.get('fields')).toContain(field);
    }
  });

  /* The token is the user's own credential: in a header it stays out of history,
     referrers and access logs. The preflight this costs is allowed and cached for a
     day — measured, see the module note. */
  it('sends the token as a bearer header and never in the URL', async () => {
    const { fetchImpl, calls } = stub(json(200, { count: 0, results: [] }));
    await searchFreesound({ token: 'secret-token', query: 'x', licence: 'any', maxSeconds: null, fetchImpl });

    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
    expect(calls[0]?.url.toString()).not.toContain('secret-token');
  });

  it('sends no filter when nothing is filtered', async () => {
    const { fetchImpl, calls } = stub(json(200, { count: 0, results: [] }));
    await searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl });
    expect(calls[0]?.url.searchParams.get('filter')).toBeNull();
  });

  it('maps the API’s names onto ours', async () => {
    const { fetchImpl } = stub(json(200, { count: 7, results: [ROW] }));
    const page = await searchFreesound({ token: 'T', query: 'door', licence: 'cc0', maxSeconds: null, fetchImpl });

    expect(page.count).toBe(7);
    expect(page.sounds[0]).toEqual({
      id: 12345,
      name: 'door_slam_heavy.wav',
      format: 'wav',
      url: 'https://freesound.org/people/someone/sounds/12345/',
      seconds: 1.234,
      license: 'http://creativecommons.org/publicdomain/zero/1.0/',
      username: 'someone',
      tags: ['door', 'slam', 'wood'],
      channels: 2,
      sampleRate: 48000,
      bytes: 231044,
      rating: 4.5,
      downloads: 812,
      preview: 'https://cdn.freesound.org/previews/12/12345_1-hq.mp3',
    });
  });

  it('takes the low-quality preview when there is no high-quality one', async () => {
    const row = { ...ROW, previews: { 'preview-lq-mp3': 'https://cdn.freesound.org/x-lq.mp3' } };
    const { fetchImpl } = stub(json(200, { count: 1, results: [row] }));
    const page = await searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl });
    expect(page.sounds[0]?.preview).toBe('https://cdn.freesound.org/x-lq.mp3');
  });

  /* A row whose every button would be dead is worse than one row fewer. */
  it('drops a row with no preview, and keeps the rest', async () => {
    const { fetchImpl } = stub(json(200, { count: 2, results: [{ ...ROW, id: 1, previews: {} }, ROW] }));
    const page = await searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl });
    expect(page.sounds.map((s) => s.id)).toEqual([12345]);
  });

  /* Everything this app does not depend on may go missing without emptying a search. */
  it('survives a row missing everything optional', async () => {
    const bare = { id: 9, previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/9.mp3' } };
    const { fetchImpl } = stub(json(200, { count: 1, results: [bare] }));
    const page = await searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl });
    expect(page.sounds[0]?.name).toBe('sound 9');
    expect(page.sounds[0]?.url).toBe('https://freesound.org/s/9/');
    expect(page.sounds[0]?.tags).toEqual([]);
  });

  it('tells a refused token apart from a throttled account', async () => {
    const rejected = stub(json(401, { detail: 'Invalid token' }));
    await expect(
      searchFreesound({ token: 'bad', query: 'x', licence: 'any', maxSeconds: null, fetchImpl: rejected.fetchImpl }),
    ).rejects.toMatchObject({ code: 'token', status: 401 });

    const throttled = stub(json(429, { detail: 'Request was throttled.' }));
    await expect(
      searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl: throttled.fetchImpl }),
    ).rejects.toMatchObject({ code: 'throttled' });
  });

  it('reports the library’s own words on a refusal it has never seen', async () => {
    const { fetchImpl } = stub(json(400, { detail: 'Invalid filter' }));
    await expect(
      searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl }),
    ).rejects.toThrow(/Invalid filter/);
  });

  it('calls an unreachable library a network failure, not a refused token', async () => {
    const { fetchImpl } = stub(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(
      searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  /* Pressing Stop is not a failure and must not paint a red box. */
  it('lets an abort through as itself', async () => {
    const { fetchImpl } = stub(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(
      searchFreesound({ token: 'T', query: 'x', licence: 'any', maxSeconds: null, fetchImpl }),
    ).rejects.not.toBeInstanceOf(FreesoundError);
  });
});

describe('licences', () => {
  it('names the ones a person has to decide about', () => {
    expect(licenceOf('http://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0');
    expect(licenceOf('https://creativecommons.org/licenses/by/4.0/')).toBe('by');
    expect(licenceOf('http://creativecommons.org/licenses/by-nc/3.0/')).toBe('by-nc');
    expect(licenceOf('http://creativecommons.org/licenses/sampling+/1.0/')).toBe('sampling+');
    expect(licenceOf('')).toBe('other');
  });

  /* `by-nc` starts with `by`; ordering the checks wrong would label a non-commercial
     sound as plain attribution, which is the one mistake here with a legal cost. */
  it('does not read by-nc as by', () => {
    expect(licenceOf('https://creativecommons.org/licenses/by-nc/4.0/')).not.toBe('by');
  });

  it('knows which sounds put an obligation on whoever ships them', () => {
    const cc0 = { ...ROW, license: 'http://creativecommons.org/publicdomain/zero/1.0/' } as unknown as FreesoundSound;
    const by = { ...ROW, license: 'https://creativecommons.org/licenses/by/4.0/' } as unknown as FreesoundSound;
    expect(needsAttribution(cc0)).toBe(false);
    expect(needsAttribution(by)).toBe(true);
  });

  it('writes a credit line with all four things a notice needs', () => {
    const line = attributionFor({
      name: 'door_slam_heavy.wav',
      username: 'someone',
      url: 'https://freesound.org/people/someone/sounds/12345/',
      license: 'https://creativecommons.org/licenses/by/4.0/',
    } as FreesoundSound);
    expect(line).toBe(
      '"door_slam_heavy.wav" by someone — https://freesound.org/people/someone/sounds/12345/ — https://creativecommons.org/licenses/by/4.0/',
    );
  });
});

describe('fetchPreview', () => {
  it('names the file after the sound and calls it what it is', async () => {
    const { fetchImpl, calls } = stub(new Response(new Uint8Array([1, 2, 3])));
    const file = await fetchPreview({ ...ROW, preview: ROW.previews['preview-hq-mp3'] } as unknown as FreesoundSound, {
      fetchImpl,
    });

    expect(calls[0]?.url.toString()).toBe('https://cdn.freesound.org/previews/12/12345_1-hq.mp3');
    expect(file.name).toBe('door_slam_heavy.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(file.size).toBe(3);
  });

  it('reports a missing preview instead of decoding an error page', async () => {
    const { fetchImpl } = stub(new Response('not found', { status: 404 }));
    await expect(
      fetchPreview({ ...ROW, preview: 'https://cdn.freesound.org/gone.mp3' } as unknown as FreesoundSound, { fetchImpl }),
    ).rejects.toBeInstanceOf(FreesoundError);
  });
});

describe('fetchOriginal', () => {
  /* The whole payoff of connecting an account: this endpoint is OAuth2-only, and a
     pasted key could never reach it. */
  it('asks the OAuth2-only endpoint with the user’s bearer token', async () => {
    const { fetchImpl, calls } = stub(new Response(new Uint8Array([1, 2, 3, 4])));
    const file = await fetchOriginal({ ...ROW, format: 'wav' } as unknown as FreesoundSound, 'access-1', { fetchImpl });

    expect(calls[0]?.url.toString()).toBe('https://freesound.org/apiv2/sounds/12345/download/');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer access-1');
    /* Named after the original's own format — a FLAC saved as `.wav` is the same class
       of lie as a renamed WAV. */
    expect(file.name).toBe('door_slam_heavy.wav');
    expect(file.size).toBe(4);
  });

  it('leaves the name extensionless rather than guessing a format', async () => {
    const { fetchImpl } = stub(new Response(new Uint8Array([1])));
    const file = await fetchOriginal({ ...ROW, format: '' } as unknown as FreesoundSound, 'a', { fetchImpl });
    expect(file.name).toBe('door_slam_heavy');
  });

  /* A 24-hour token that ran out is the expected end of a long session; the caller
     refreshes on this code rather than telling anyone the connection is broken. */
  it('reports a spent token as such, and anything else as http', async () => {
    const expired = stub(new Response('', { status: 401 }));
    await expect(
      fetchOriginal(ROW as unknown as FreesoundSound, 'old', { fetchImpl: expired.fetchImpl }),
    ).rejects.toMatchObject({ code: 'token' });

    const gone = stub(new Response('', { status: 404 }));
    await expect(
      fetchOriginal(ROW as unknown as FreesoundSound, 'fine', { fetchImpl: gone.fetchImpl }),
    ).rejects.toMatchObject({ code: 'http' });
  });
});

describe('safeName', () => {
  it('drops the original extension so `.wav.mp3` cannot happen', () => {
    expect(safeName('door_slam_heavy.wav')).toBe('door_slam_heavy');
    expect(safeName('bell.flac')).toBe('bell');
  });

  it('keeps letters of any script and replaces the rest', () => {
    expect(safeName('дверь / скрип (2).wav')).toBe('дверь_скрип_2');
  });

  it('always returns something a file can be called', () => {
    expect(safeName('///')).toBe('sound');
    expect(safeName('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
