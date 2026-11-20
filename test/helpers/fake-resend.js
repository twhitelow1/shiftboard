// A stand-in for Resend's HTTP API: records every request, never sends anything.
export function fakeResend({ fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: 403, json: async () => ({ name: 'validation_error', message: fail }) };
    return { ok: true, status: 200, json: async () => ({ id: `em_${calls.length}` }) };
  };
  return { calls, fetchImpl, emails: () => calls.flatMap((c) => (Array.isArray(c.body) ? c.body : [c.body])) };
}
