export const MESSAGE_NS = 'urn:pl:oire:message_R_9:v1';
const TECH_NS = 'urn:pl:oire:technical:v1';
const SOAP_NAMESPACES = ['http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'];

export const EDITIONS = {
  '04': {
    name: 'TSKB/04/2025',
    effectiveFrom: '01.09.2026',
    common: 'https://www.pse.pl/documents/20182/6979466808/Zalacznik_nr_6_Komunikaty_wspolne.pdf',
    codes: 'https://www.pse.pl/documents/20182/6979466808/Zalacznik_nr_8_Kody_bledow_i_akceptacji.xlsx?download=true',
  },
  '05': {
    name: 'TSKB/05/2026',
    effectiveFrom: '01.02.2027',
    common: 'https://www.pse.pl/documents/20182/976314471/Zalacznik_nr_6-Komunikaty_wspolne.pdf',
    codes: 'https://www.pse.pl/documents/20182/976314471/Zalacznik_nr_8-Kody_bledow_i_akceptacji.xlsx?download=true',
  },
};
export const MAX_BYTES = 25_000_000;

export const STATUS = {
  OK: { title: 'Operacja zakończona pomyślnie', detail: 'CSIRE zgłosił pełny sukces operacji masowej.', tone: 'ok', icon: '✓' },
  PARTIAL_OK: { title: 'Częściowy sukces', detail: 'CSIRE zgłosił częściowy sukces. Sprawdź zwrócone rekordy z błędami.', tone: 'warn', icon: '!' },
  ERROR: { title: 'Operacja zakończona błędem', detail: 'CSIRE zgłosił błąd operacji masowej. Sprawdź wynik żądania i zwrócone rekordy.', tone: 'error', icon: '×' },
};
export const PROCESS_NAMES = {
  '6.1': 'Dobowe profile zużycia',
  '6.2': 'Wskazania pomiarowe',
  '6.3': 'Informacje rozliczeniowe GUD-k',
  '6.8': 'Informacje o saldzie przedpłaty',
  '6.9': 'Informacje o jakości energii',
  '6.10': 'Rozliczenia dodatkowe',
  '11.1': 'Historyczne dobowe profile zużycia',
  '11.2': 'Historyczne wskazania pomiarowe',
  '11.3': 'Historyczne informacje rozliczeniowe GUD-k',
  '11.4': 'Historyczne informacje o jakości energii',
};

function element(parent, name, ns = MESSAGE_NS) {
  return Array.from(parent?.children ?? []).find(child => child.localName === name && child.namespaceURI === ns);
}

function field(parent, name, ns = MESSAGE_NS) {
  return element(parent, name, ns)?.textContent.trim() ?? '';
}

function isMessage(node) {
  return /^urn:pl:oire:(?:unk_|message_)[^:]+:v[^:]+$/i.test(node?.namespaceURI ?? '')
    || (node?.namespaceURI?.startsWith('urn:pl:oire:') && Boolean(element(node, 'Header', node.namespaceURI)));
}

export function readMessage(input) {
  const xml = input.trim();
  if (!xml) throw new Error('Wklej treść XML lub wybierz plik, aby rozpocząć analizę.');
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error('Wybierz XML bez deklaracji DOCTYPE.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Nie udało się odczytać XML. Sprawdź składnię i kompletność komunikatu.');
  let root = doc.documentElement;
  if (root.localName === 'Envelope' && SOAP_NAMESPACES.includes(root.namespaceURI)) {
    const body = element(root, 'Body', root.namespaceURI);
    const candidates = Array.from(body?.getElementsByTagName('*') ?? []).filter(isMessage);
    const messages = candidates.filter(node => {
      for (let parent = node.parentElement; parent !== body; parent = parent.parentElement) {
        if (isMessage(parent)) return false;
      }
      return true;
    });
    if (messages.length > 1) throw new Error('Koperta SOAP zawiera kilka komunikatów CSIRE. Wczytaj jeden komunikat naraz.');
    root = messages[0] ?? root;
  }
  if (!isMessage(root)) throw new Error('Wczytaj XML komunikatu CSIRE lub kopertę SOAP zawierającą taki komunikat.');
  return root;
}

export function messageMetadata(root) {
  const ns = root.namespaceURI;
  const header = element(root, 'Header', ns);
  const context = element(root, 'ProcessEnergyContext', ns);
  const type = field(header, 'MessageType', TECH_NS);
  return {
    type: type.replace(/^(\d+\.\d+)-(\d+)$/, '$1_$2'),
    number: field(context, 'BusinessProcessMessageType', TECH_NS).replace(/\.$/, ''),
    process: field(context, 'BusinessProcess', TECH_NS).replace(/\.$/, ''),
    id: field(header, 'MessageId', TECH_NS),
    timestamp: field(header, 'MessageTimestamp', TECH_NS),
    schemaKey: ns + '|' + root.localName,
    batch: ns === MESSAGE_NS && root.localName === 'BatchResult',
  };
}

function resultFields(node) {
  return {
    code: field(node, 'ErrorCode'),
    description: field(node, 'ErrorDescription'),
    scenario: field(node, 'PriorityMatrixScenario'),
  };
}

export function extractR9(root) {
  const header = element(root, 'Header');
  const context = element(root, 'ProcessEnergyContext');
  const payload = element(root, 'Payload');
  const basic = element(payload, 'BasicInfo');
  const general = element(payload, 'Result');
  const records = Array.from(payload?.children ?? [])
    .filter(node => node.localName === 'BatchOperationRecord' && node.namespaceURI === MESSAGE_NS)
    .map((node, index) => ({
      index: index + 1,
      transactionId: field(node, 'ReferenceTransactionId'),
      subject: field(element(node, 'DataSubject'), 'DataSubject'),
      point: field(element(node, 'MeteringPointData_Basic'), 'MeteringPointCode'),
      facility: field(element(node, 'FacilityData_Basic'), 'FacilityIdentifier'),
      hasPoint: Boolean(element(node, 'MeteringPointData_Basic')),
      hasFacility: Boolean(element(node, 'FacilityData_Basic')),
      ...resultFields(element(node, 'TransactionResult')),
    }));
  return {
    status: field(basic, 'BatchOperationResult'),
    processId: field(basic, 'ProcessInstanceId'),
    process: field(context, 'BusinessProcess', TECH_NS).replace(/\.$/, ''),
    messageNumber: field(context, 'BusinessProcessMessageType', TECH_NS).replace(/\.$/, ''),
    messageType: field(header, 'MessageType', TECH_NS),
    messageId: field(header, 'MessageId', TECH_NS),
    timestamp: field(header, 'MessageTimestamp', TECH_NS),
    sender: field(header, 'JuridicalSenderId', TECH_NS),
    recipient: field(header, 'JuridicalRecipientId', TECH_NS),
    general: general ? resultFields(general) : null,
    records,
  };
}

export function codeKind(code, dictionary) {
  if (!code || !Object.hasOwn(dictionary, code)) return 'unknown';
  if (code.startsWith('CE')) return 'error';
  if (code.startsWith('CA')) return 'ok';
  return 'reason';
}

export function codeTitle(code, dictionary) {
  return Object.hasOwn(dictionary, code) ? dictionary[code] : (code ? 'Kod spoza słownika tej wersji' : 'Brak kodu wyniku');
}

export function checkRules(data) {
  const issues = [];
  const note = (message, index = 0) => issues.push({ message, index });
  if (data.messageType && data.messageType !== 'R_9') note('Pole MessageType powinno mieć wartość R_9.');
  if (data.status === 'PARTIAL_OK' && data.records.length === 0) note('PARTIAL_OK wymaga zwrócenia rekordów, których dotyczy błąd.');
  if (data.status === 'ERROR' && !data.general && data.records.length === 0) note('Przy statusie ERROR oczekuje się wyniku całego żądania lub szczegółów błędnych rekordów.');
  function checkScenario(result, index) {
    if (result.code === 'CE199' && !result.scenario) note('Kod CE199 wymaga pola PriorityMatrixScenario.', index);
    if (result.code && result.code !== 'CE199' && result.scenario) note('Pole PriorityMatrixScenario jest przewidziane dla kodu CE199.', index);
  }
  if (data.general) checkScenario(data.general, 0);
  for (const record of data.records) {
    if (record.subject === 'CK0150' && (!record.hasPoint || record.hasFacility)) {
      note('CK0150 wymaga sekcji punktu pomiarowego i wyklucza sekcję obiektu pomiarowego.', record.index);
    }
    if (record.subject === 'CK0151' && (!record.hasFacility || record.hasPoint)) {
      note('CK0151 wymaga sekcji obiektu pomiarowego i wyklucza sekcję punktu pomiarowego.', record.index);
    }
    checkScenario(record, record.index);
  }
  return issues;
}

export function guidance(code) {
  switch (code) {
    case 'CE108': return 'Porównaj kod punktu pomiarowego z rekordem źródłowego zgłoszenia i kartą punktu w CSIRE.';
    case 'CE104': return 'Sprawdź rolę nadawcy prawnego w nagłówku i rolę biznesową wymaganą w tym procesie.';
    case 'CE199': return 'Odczytaj scenariusz macierzy, a następnie sprawdź inne procesy powiązane z tym punktem lub obiektem.';
    case 'CE999': return 'Sprawdź opis przekazany przez CSIRE i porównaj go z danymi w zgłoszeniu źródłowym.';
    default: return '';
  }
}

export function decodeXmlFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  }
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  }
  const header = new TextDecoder().decode(bytes.subarray(0, 300));
  const encoding = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*(['"])([a-z0-9._-]+)\1/i.exec(header)?.[2] ?? 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export function searchText(value) {
  return String(value).toLocaleLowerCase('pl').normalize('NFD').replace(/\p{Diacritic}/gu, '').replaceAll('ł', 'l').trim();
}

export function makeCsv(records, dictionary) {
  const cell = value => {
    const string = String(value ?? '');
    const safe = /^\s*[=+\-@]|^[\t\r\n]/.test(string) ? "'" + string : string;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const rows = [['Rekord', 'Identyfikator transakcji', 'Kod PP', 'Identyfikator obiektu', 'Kod wyniku', 'Znaczenie kodu', 'Opis z komunikatu', 'Scenariusz macierzy']];
  for (const r of records) rows.push([r.index, r.transactionId, r.point, r.facility, r.code, codeTitle(r.code, dictionary), r.description, r.scenario]);
  return '\ufeff' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
