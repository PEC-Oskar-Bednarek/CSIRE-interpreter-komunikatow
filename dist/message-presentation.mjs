const tech = 'urn:pl:oire:technical:v1';

export function directValue(node, name, ns = node?.namespaceURI) {
  return Array.from(node?.children ?? []).find(child =>
    child.localName === name && child.namespaceURI === ns)?.textContent.trim() || '';
}

export function matchingNodes(node, names) {
  return Array.from(node.getElementsByTagName('*')).filter(child =>
    names.includes(child.localName) && child.namespaceURI?.startsWith('urn:pl:oire:'));
}

const warsaw = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Warsaw',
});

export function displayedDate(value) {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d\d:\d\d(?::\d\d(?:\.\d+)?)?))?$/.exec(value);
  if (match) return [match[3] + '.' + match[2] + '.' + match[1], match[4]].filter(Boolean).join(', ');
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) {
    return warsaw.format(new Date(value)) + ' (czas polski)';
  }
  return value;
}

export function displayedPeriod({ start, end }) {
  return [start && 'od ' + displayedDate(start), end && 'do ' + displayedDate(end)].filter(Boolean).join(' ');
}

export function profileRecords(root) {
  return matchingNodes(root, ['DailyMeteringPointMeasurements']).flatMap(record => {
    const transaction = directValue(record, 'ReferenceTransactionId');
    const identity = matchingNodes(record, ['MeteringPointCode', 'FacilityIdentifier'])[0]?.textContent.trim() || '';
    return matchingNodes(record, ['BasicData']).map(data => ({
      transaction, identity,
      start: directValue(data, 'PeriodStart'), end: directValue(data, 'PeriodEnd'),
      version: directValue(data, 'DataVersionNumber'),
      products: [...new Set(matchingNodes(data, ['ProductType']).map(node => node.textContent.trim()).filter(Boolean))],
    }));
  });
}

export function messageOverview(root, metadata) {
  const header = Array.from(root.children).find(child => child.localName === 'Header' && child.namespaceURI === root.namespaceURI);
  const distinct = names => [...new Set(matchingNodes(root, names).map(node => node.textContent.trim()).filter(Boolean))];
  const periods = [];
  for (const start of matchingNodes(root, ['PeriodStart', 'PeriodStartDate'])) {
    const period = displayedPeriod({
      start: start.textContent.trim(),
      end: directValue(start.parentElement, start.localName === 'PeriodStart' ? 'PeriodEnd' : 'PeriodEndDate', start.namespaceURI),
    });
    if (period && !periods.includes(period)) periods.push(period);
  }
  const profiles = metadata.number === '6.1.1.1' ? profileRecords(root) : [];
  return {
    profiles, periods,
    points: distinct(['MeteringPointCode']),
    objects: distinct(['FacilityIdentifier']),
    sender: directValue(header, 'JuridicalSenderId', tech) || directValue(header, 'PhysicalSenderId', tech),
    recipient: directValue(header, 'JuridicalRecipientId', tech) || directValue(header, 'PhysicalRecipientId', tech),
    codes: distinct(['ErrorCode', 'ResultCode', 'AnomalyCode']),
  };
}

export function matchingProfiles(record, current, items) {
  const id = value => value?.toLowerCase();
  return items.flatMap(item => {
    if (item.unk !== '6.1.1.1') return [];
    const profiles = item.profiles ?? [];
    const identity = record.point || record.facility;
    const exact = profiles.filter(profile => record.transactionId && id(profile.transaction) === id(record.transactionId)
      && (!identity || !profile.identity || profile.identity === identity));
    if (exact.length) return exact.map(profile => ({ item, profile }));
    if (!current.respondsTo || id(current.respondsTo) !== id(item.messageId) || !identity) return [];
    const scoped = profiles.filter(profile => profile.identity === identity && (!record.transactionId || !profile.transaction));
    return scoped.map(profile => ({ item, profile }));
  });
}
