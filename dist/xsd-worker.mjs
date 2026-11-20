import { validateAgainstXsd } from './xsd.mjs';

self.addEventListener('message', async ({ data: { id, xml, edition, schema } }) => {
  try {
    const result = await validateAgainstXsd(xml, edition, async path => {
      const response = await fetch(new URL('./data/' + path, import.meta.url));
      if (!response.ok) throw new Error('Nie udało się wczytać schematu XSD.');
      return new Uint8Array(await response.arrayBuffer());
    }, schema);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, result: { state: 'unavailable', errors: [] } });
  }
});
