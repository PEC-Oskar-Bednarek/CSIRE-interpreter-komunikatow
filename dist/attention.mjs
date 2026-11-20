const addressedSteps = new Set([
  '2.2.1.4', '2.2.1.5', '2.2.1.11', '2.5.1.1', '7.5.1.4',
  '8.1.1.5', '8.2.1.6', '8.5.1.4', '9.1.1.5', '9.1.1.11',
]);

const roleLabels = {
  batch: 'Wynik operacji masowej',
  result: 'Wynik operacji',
  request: 'Żądanie',
  action: 'Żądanie do realizacji',
  correction: 'Korekta lub nowa wersja',
  notice: 'Powiadomienie',
  reminder: 'Możliwa potrzeba działania',
  exception: 'Wynik wymagający sprawdzenia',
  special: 'Komunikat specjalny',
  data: 'Przekazanie lub udostępnienie danych',
  unknown: 'Komunikat do odczytu',
};

export function attentionFormat(metadata, schema) {
  const filename = schema?.[0];
  const number = filename && /^\d/.test(filename) ? filename.slice(0, -4).replaceAll('_', '.') : '';
  const exactStep = number && number === metadata.number ? number : '';
  const title = schema?.[1]?.replace(/^\d+(?:\.\d+)+\.?\s+/, '') || '';
  let kind = 'unknown';
  if (metadata.batch || filename === 'R_9.xsd') kind = 'batch';
  else if (filename === 'R_1.xsd') kind = 'result';
  else if (filename === 'R_3.xsd') kind = 'reminder';
  else if (filename === 'S.xsd') kind = 'special';
  else if (addressedSteps.has(exactStep)) kind = 'action';
  else if (/(?:o odmowie|o braku możliwości|o odrzuceniu)/i.test(title)) kind = 'exception';
  else if (/o korekcie/i.test(title)) kind = 'correction';
  else if (/^(?:Żądanie|Zapytanie) /i.test(title)) kind = 'request';
  else if (/^Powiadomienie /i.test(title)) kind = 'notice';
  else if (/^(?:Wysłanie|Udostępnienie|Przekazanie) /i.test(title)) kind = 'data';
  return { kind, label: roleLabels[kind], title };
}

const dateFields = [
  ['MeasurementQueryDateTime', 'Oczekiwana data odczytu'],
  ['RequestedMpCharacteristicsChangeDate', 'Wnioskowana data zmiany charakterystyki'],
  ['EffectiveDate', 'Data obowiązywania'],
  ['EffectiveDateTime', 'Data i czas obowiązywania'],
  ['PeriodStart', 'Początek okresu'],
  ['PeriodEnd', 'Koniec okresu'],
  ['DataVersionNumber', 'Wersja danych'],
];

const first = (root, name) => root?.getElementsByTagNameNS(root.namespaceURI, name)[0]?.textContent.trim() || '';

export function attentionCards(root, metadata, schema, batch) {
  const format = attentionFormat(metadata, schema);
  const payload = Array.from(root.children).find(node => node.localName === 'Payload' && node.namespaceURI === root.namespaceURI);
  const points = new Set();
  for (const name of ['MeteringPointCode', 'FacilityIdentifier']) {
    const values = payload?.getElementsByTagNameNS(root.namespaceURI, name) ?? [];
    for (const node of values) if (node.textContent.trim()) points.add(node.textContent.trim());
  }
  const entries = new Map();
  const cards = [];
  const add = (code, item) => {
    const list = entries.get(code) ?? [];
    list.push(item);
    entries.set(code, list);
  };
  if (batch) {
    for (const record of [batch.general, ...batch.records]) {
      if (record?.code.startsWith('CE')) add(record.code, { ...record, identity: record.point || record.facility });
    }
    if (['ERROR', 'PARTIAL_OK'].includes(batch.status) && !entries.size) {
      cards.push({ title: 'Wynik operacji masowej', code: batch.status });
    }
  } else if (payload) {
    const tags = new Set(['ErrorCode', 'ResultCode', 'AnomalyCode']);
    for (const node of payload.getElementsByTagNameNS(root.namespaceURI, '*')) {
      if (!tags.has(node.localName)) continue;
      const code = node.textContent.trim();
      if (!code || (node.localName === 'ResultCode' && !/^CE\d+$/.test(code))) continue;
      add(code, {
        anomaly: node.localName === 'AnomalyCode',
        description: first(node.parentElement, 'ErrorDescription') || first(node.parentElement, 'ResultDescription'),
        scenario: first(node.parentElement, 'PriorityMatrixScenario'),
      });
    }
  }
  for (const [code, items] of entries) {
    cards.push({ title: items.some(item => item.anomaly) ? 'Anomalia' : 'Błąd', code, items });
  }

  const response = first(payload, 'ResponseCode');
  const negative = ['CK0486', 'CK0487'].includes(response);
  if (['action', 'reminder', 'correction', 'exception'].includes(format.kind) || negative ||
      (format.kind === 'special' && !entries.size)) {
    cards.push({
      title: format.title || format.label,
      code: response || first(payload, 'SpecialMessageType'),
      points: [...points],
      dates: dateFields.map(([name, label]) => [label, first(payload, name)]).filter(([, value]) => value),
      description: ['ResponseJustification', 'ErrorDescription', 'ReasonDescription', 'Description']
        .map(name => first(payload, name)).find(Boolean),
    });
  }
  return { format, cards };
}
