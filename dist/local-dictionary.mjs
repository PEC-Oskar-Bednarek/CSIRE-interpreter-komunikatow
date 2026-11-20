export const localName = (names, value) => Object.hasOwn(names ?? {}, value) ? names[value] : '';

export async function loadLocalDictionary() {
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) return {};
  try {
    const response = await fetch('/api/local-dictionary', { signal: AbortSignal.timeout(4000) });
    if (response.ok) return await response.json();
  } catch {}
  return { error: 'Nie udało się wczytać lokalnego słownika.' };
}
