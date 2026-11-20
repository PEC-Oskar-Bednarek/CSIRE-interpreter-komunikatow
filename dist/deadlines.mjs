const polishDate = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone: 'UTC' });
const warsaw = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Warsaw', hourCycle: 'h23' });

function addDays(day, count) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const value = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(+value) || !value.toISOString().startsWith(day)) return '';
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function displayDeadlineDay(day) {
  return day ? polishDate.format(new Date(day + 'T00:00:00Z')) : '';
}

export function answerDeadline(deliveryDay) {
  return addDays(deliveryDay, 60);
}

function startOfWarsawDay(value = '') {
  // PL-179 and PL-180 also use midnight timestamps without a zone in the ZIK examples.
  const local = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?$/.exec(value)?.[1];
  if (local) return addDays(local, 0);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return '';
  const [day, time] = warsaw.format(new Date(value)).split(' ');
  return time === '00:00:00' ? day : '';
}

export function documentedDeadline(root, metadata, schema, edition) {
  if (schema?.[0] === '9_1_1_5.xsd' && metadata.number === '9.1.1.5' && ['04', '05'].includes(edition)) {
    // TSKB, załącznik 1.9a (str. 11) and PSE Q&A of 12 November 2026, item 5.
    return {
      kind: 'answer',
      label: 'Termin udzielenia odpowiedzi',
      rule: '60 dni kalendarzowych od dnia przekazania żądania przez OIRE.',
    };
  }
  if (schema?.[0] !== '6_1_1_1.xsd' || metadata.number !== '6.1.1.1') return null;
  const namespace = root.namespaceURI;
  const records = root.getElementsByTagNameNS(namespace, 'DailyMeteringPointMeasurements');
  const periods = new Map();
  let missing = false;
  for (const record of records) {
    for (const block of record.getElementsByTagNameNS(namespace, 'BasicData')) {
      const start = startOfWarsawDay(block.getElementsByTagNameNS(namespace, 'PeriodStart')[0]?.textContent.trim());
      const end = startOfWarsawDay(block.getElementsByTagNameNS(namespace, 'PeriodEnd')[0]?.textContent.trim());
      if (start && addDays(start, 1) === end) periods.set(start, end);
      else missing = true;
    }
  }
  // IRiESP-OIRE, section 5.4.4.1.
  return {
    kind: 'profile',
    label: 'Termin przekazania profilu',
    rule: 'Do 07:00 następnego dnia po dobie, której dotyczy profil.',
    periods: [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)),
    missing: missing || !periods.size,
  };
}
