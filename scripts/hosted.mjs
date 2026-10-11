// Copyright (c) 2026 BRAIN TRUST PRIVATE LIMITED
// One total deadline covers licence validation and every hosted request.
// This helper returns data only: it cannot change the local geometry verdict.
export async function hostedExtras({ token, repository, runId, report,
  baseUrl = 'https://burr.sh', timeoutMs = 5000, fetchImpl = fetch }) {
  if (!token) return { status: 'skipped (no token)' };
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
  });
  const work = async () => {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) throw new Error('HTTPS required');
    const request = async (route, method = 'GET', body) => {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(new URL(route, url), {
        method, signal: controller.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      controller.signal.throwIfAborted();
      return data;
    };
    const licence = await request('/api/v1/licence');
    const [owner, repo, extra] = (repository || '').split('/');
    if (!owner || !repo || extra || licence.valid !== true || !['pro', 'team'].includes(licence.plan) ||
        typeof licence.org !== 'string' || licence.org.toLowerCase() !== owner.toLowerCase() ||
        (licence.plan === 'pro' ? licence.privateRepoLimit !== 5 : licence.privateRepoLimit !== null)) throw new Error('invalid licence');
    const prefix = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const baseline = await request(`${prefix}/baseline`);
    if (!Object.hasOwn(baseline, 'baseline')) throw new Error('invalid baseline');
    const stored = await request(`${prefix}/history`, 'POST', { ...report, runId: String(runId) });
    if (stored.stored !== true) throw new Error('invalid history');
    return { status: 'history stored', baseline: baseline.baseline };
  };
  try { return await Promise.race([work(), deadline]); }
  catch { return { status: 'skipped (unavailable or invalid licence)' }; }
  finally { clearTimeout(timer); controller.abort(); }
}
