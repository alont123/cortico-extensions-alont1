/** Fake fetch plus temporary cookie files; never signs in to a service. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CookieJar, QrLogin } from '../src/login.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const json = (body: unknown) => new Response(JSON.stringify(body));
const generated = (key: string) => json({ code: 0, data: { url: `https://passport.bilibili.com/fixture/${key}`, qrcode_key: key } });
const authorized = () => ({ code: 0, data: { code: 0, url: 'https://passport.bilibili.com/fixture?SESSDATA=unit-cookie' } });
function fixture() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'bili-qr-unit-'));
  const jar = new CookieJar(join(root, 'cookies.json'));
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected fixture request'));
  const onChange = vi.fn();
  const login = new QrLogin({ jar, fetchImpl: fetcher, onChange });
  cleanups.push(() => { login.stop(); rmSync(root, { recursive: true, force: true }); });
  return { jar, fetcher, onChange, login };
}

it('stop cancels a generating request without changing state or restarting a timer when it returns', async () => {
  const f = fixture(), response = deferred<Response>(); f.fetcher.mockReturnValueOnce(response.promise);
  const pending = f.login.start(); const signal = f.fetcher.mock.calls[0][1]!.signal!;
  f.login.stop(); expect(signal.aborted).toBe(true);
  response.resolve(generated('old')); await pending;
  expect(f.login.current.status).toBe('none'); expect(f.onChange).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('a newer start wins when old generation JSON resolves late', async () => {
  const f = fixture(), body = deferred<unknown>();
  f.fetcher.mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response).mockResolvedValueOnce(generated('new'));
  const old = f.login.start(); await Promise.resolve(); await f.login.start();
  body.resolve({ code: 0, data: { url: 'old-url', qrcode_key: 'old' } }); await old;
  expect(f.login.current.qrText).toContain('/new'); expect(f.onChange).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
});

it('stop during a poll rejects late authorization without saving cookies', async () => {
  const f = fixture(), response = deferred<Response>();
  f.fetcher.mockResolvedValueOnce(generated('first')).mockReturnValueOnce(response.promise);
  await f.login.start(); await vi.advanceTimersByTimeAsync(2000); f.login.stop();
  expect(f.fetcher.mock.calls[1][1]!.signal!.aborted).toBe(true);
  response.resolve(json(authorized())); await vi.advanceTimersByTimeAsync(0);
  expect(f.jar.load()).toEqual([]); expect(f.login.current.status).toBe('pending');
  expect(f.onChange).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('logout and a fresh start survive an older poll JSON completing', async () => {
  const f = fixture(), body = deferred<unknown>();
  f.fetcher.mockResolvedValueOnce(generated('first')).mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response).mockResolvedValueOnce(generated('second'));
  await f.login.start(); await vi.advanceTimersByTimeAsync(2000); f.login.logout(); await f.login.start();
  body.resolve(authorized()); await vi.advanceTimersByTimeAsync(0);
  expect(f.jar.load()).toEqual([]); expect(f.login.current.qrText).toContain('/second'); expect(vi.getTimerCount()).toBe(1);
});

it('a synchronous stop from onChange cannot be followed by scheduling another poll', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(generated('first'));
  f.onChange.mockImplementation(() => f.login.stop()); await f.login.start();
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10_000); expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it('an active attempt progresses from pending through scanned to a persisted authorization', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(generated('first'))
    .mockResolvedValueOnce(json({ code: 0, data: { code: 86090 } }))
    .mockResolvedValueOnce(json(authorized()));
  await f.login.start(); await vi.advanceTimersByTimeAsync(2000); expect(f.login.current.status).toBe('scanned');
  await vi.advanceTimersByTimeAsync(2000); expect(f.login.current.status).toBe('authorized');
  expect(f.jar.load()).toEqual([expect.objectContaining({ name: 'SESSDATA', value: 'unit-cookie' })]); expect(vi.getTimerCount()).toBe(0);
});
