let sessionToken;
export async function api(path, input, options = {}, retry = true) {
  if (input !== undefined && !sessionToken) sessionToken = (await api('/api/session', undefined, options)).token;
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : options.method || 'POST',
    headers: input === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', 'X-Perpetual-Token': sessionToken },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: options.signal,
  });
  if (response.status === 403 && input !== undefined && retry) { sessionToken = undefined; return api(path, input, options, false); }
  let data;
  try { data = await response.json(); } catch (error) { if (error.name === 'AbortError') throw error; throw new Error('The local server is unavailable. Try reconnecting.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { statusCode: response.status });
  return data;
}
