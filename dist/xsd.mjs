import { XmlDocument, XsdValidator, XmlValidateError, xmlRegisterInputProvider } from './vendor/index.mjs';

const virtualRoot = 'file:///csire/';
const files = new Map();
const readers = new Map();
let readerId = 0;
const validators = new Map();

function key(filename) {
  return filename.startsWith(virtualRoot) ? filename.slice(virtualRoot.length)
    : filename.startsWith('/csire/') ? filename.slice(7) : filename;
}

xmlRegisterInputProvider({
  match: filename => files.has(key(filename)),
  open(filename) {
    const data = files.get(key(filename));
    if (!data) return undefined;
    const id = ++readerId;
    readers.set(id, { data, offset: 0 });
    return id;
  },
  read(id, buffer) {
    const reader = readers.get(id);
    if (!reader) return -1;
    const bytes = reader.data.subarray(reader.offset, reader.offset + buffer.length);
    buffer.set(bytes);
    reader.offset += bytes.length;
    return bytes.length;
  },
  close: id => readers.delete(id),
});

function getValidator(edition, schema, load) {
  const cacheKey = edition + '/' + schema;
  if (!validators.has(cacheKey)) {
    const pending = Promise.all([schema, 'technical.xsd', 'businessDataTypes.xsd'].map(async name => {
      const path = edition + '/' + name;
      return [path, await load(path)];
    })).then(resources => {
      for (const [path, bytes] of resources) files.set(path, bytes);
      const path = cacheKey;
      const document = XmlDocument.fromBuffer(files.get(path), { url: virtualRoot + path });
      try {
        return XsdValidator.fromDoc(document);
      } finally {
        document.dispose();
      }
    }).catch(error => {
      validators.delete(cacheKey);
      throw error;
    });
    validators.set(cacheKey, pending);
  }
  return validators.get(cacheKey);
}

export async function validateAgainstXsd(xml, edition, load, schema = 'R_9.xsd') {
  if (edition !== '04' && edition !== '05') throw new Error('Wybierz obsługiwaną wersję standardu.');
  if (!/^(?:[0-9_]+|R_[139]|S)\.xsd$/.test(schema)) throw new Error('Nieznany schemat.');
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error('Wybierz XML bez deklaracji DOCTYPE.');
  const validator = await getValidator(edition, schema, load);
  const doc = XmlDocument.fromString(xml);
  try {
    validator.validate(doc);
    return { state: 'valid', errors: [] };
  } catch (error) {
    if (!(error instanceof XmlValidateError)) throw error;
    const details = error.details.filter(item => item.level >= 2);
    return {
      state: 'invalid',
      errors: details.slice(0, 12).map(item => ({
        line: item.line,
        message: item.message.trim().replace(/\{urn:pl:oire:[^}]+\}/g, ''),
      })),
      count: details.length,
    };
  } finally {
    doc.dispose();
  }
}
