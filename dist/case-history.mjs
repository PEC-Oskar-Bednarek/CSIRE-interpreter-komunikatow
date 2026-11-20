import { profileRecords } from './message-presentation.mjs';
// Exact identifiers establish links. A metering point alone is a search hint.
function values(node, names) {
  const found = new Set();
  for (const child of node.getElementsByTagName('*')) {
    if (names.includes(child.localName) && child.namespaceURI?.startsWith('urn:pl:oire:')) {
      const value = child.textContent.trim();
      if (value) found.add(value);
    }
  }
  return [...found];
}

export function historyMetadata(root, metadata) {
  const header = Array.from(root.children).find(node => node.localName === 'Header' && node.namespaceURI === root.namespaceURI);
  const correctionLinks = [];
  for (const transaction of root.getElementsByTagNameNS(root.namespaceURI, 'ReferenceTransactionId')) {
    const reference = transaction.textContent.trim();
    if (!reference) continue;
    for (const corrected of values(transaction.parentElement, ['CorrectedReferenceTransactionId'])) {
      correctionLinks.push([reference, corrected]);
    }
  }
  return {
    correctionLinks,
    profiles: metadata.number === '6.1.1.1' ? profileRecords(root) : [],
    type: metadata.type || root.localName,
    unk: metadata.number,
    messageId: metadata.id,
    timestamp: metadata.timestamp,
    respondsTo: header?.getElementsByTagNameNS('urn:pl:oire:technical:v1', 'SenderMessageId')[0]?.textContent.trim() || '',
    processIds: values(root, ['ProcessInstanceId']),
    transactions: values(root, ['ReferenceTransactionId']),
    correctedTransactions: values(root, ['CorrectedReferenceTransactionId']),
    points: values(root, ['MeteringPointCode']),
    objects: values(root, ['FacilityIdentifier']),
    codes: values(root, ['ErrorCode', 'ResultCode']),
    status: values(root, ['BatchOperationResult'])[0] || '',
  };
}

const id = value => (value || '').toLowerCase();
const intersects = (a = [], b = []) => {
  const keys = new Set(a.map(id));
  return b.some(value => keys.has(id(value)));
};
const same = (a, b) => Boolean(a && b && id(a) === id(b));

function directReasons(current, item) {
  const reasons = [];
  if (same(current.respondsTo, item.messageId) || same(item.respondsTo, current.messageId)) reasons.push('Odpowiedź wskazuje ID komunikatu');
  if (intersects(current.processIds, item.processIds)) reasons.push('Wspólna instancja procesu');
  if (intersects(current.transactions, item.transactions)) reasons.push('Wspólny identyfikator transakcji');
  if (intersects(current.transactions, item.correctedTransactions) || intersects(current.correctedTransactions, item.transactions)) reasons.push('Wskazanie korygowanej transakcji');
  return reasons;
}

export function caseHistory(current, items, digest) {
  const seenFiles = new Set(digest ? [digest] : []);
  const rows = [];
  const context = [];
  const distinct = items.filter(item => {
    if (item.digest && seenFiles.has(item.digest)) return false;
    if (item.digest) seenFiles.add(item.digest);
    return true;
  });

  // Follow explicit answer chains without expanding a batch through unrelated
  // transaction IDs found on the way.
  const answerLinks = new Map();
  for (const item of distinct) {
    for (const key of new Set([id(item.messageId), id(item.respondsTo)])) {
      if (!key) continue;
      if (!answerLinks.has(key)) answerLinks.set(key, []);
      answerLinks.get(key).push(item);
    }
  }
  const reached = new Set();
  const seenIds = new Set();
  const queue = [current.messageId, current.respondsTo];
  for (let index = 0; index < queue.length; index++) {
    const key = id(queue[index]);
    if (!key || seenIds.has(key)) continue;
    seenIds.add(key);
    for (const item of answerLinks.get(key) ?? []) {
      if (reached.has(item)) continue;
      reached.add(item);
      queue.push(item.messageId, item.respondsTo);
    }
  }

  const corrections = new Map();
  for (const item of [current, ...distinct]) {
    for (const [transaction, corrected] of item.correctionLinks ?? []) {
      if (!transaction || !corrected) continue;
      for (const [from, to] of [[id(transaction), id(corrected)], [id(corrected), id(transaction)]]) {
        if (!corrections.has(from)) corrections.set(from, new Set());
        corrections.get(from).add(to);
      }
    }
  }
  const transactions = new Set([...(current.transactions ?? []), ...(current.correctedTransactions ?? [])].map(id));
  for (const transaction of transactions) {
    for (const related of corrections.get(transaction) ?? []) transactions.add(related);
  }

  for (const item of distinct) {
    const reasons = directReasons(current, item);
    if (same(current.messageId, item.messageId)) {
      context.push({ item, reason: 'Ten sam identyfikator komunikatu. Inny plik w archiwum.' });
    } else if (reasons.length) {
      rows.push({ item, reason: reasons.join(' · ') });
    } else if (reached.has(item)) {
      rows.push({ item, reason: 'Łańcuch odpowiedzi po ID komunikatu' });
    } else if ((item.transactions ?? []).some(value => transactions.has(id(value)))) {
      rows.push({ item, reason: 'Łańcuch korekt po identyfikatorze transakcji' });
    } else if (intersects(current.points, item.points) || intersects(current.objects, item.objects)) {
      context.push({ item, reason: 'Wspólny punkt lub obiekt' });
    }
  }

  const gaps = [];
  const expected = current.unk === '6.1.1.2' ? '6.1.1.1'
    : current.unk === '6.1.1.1' ? '6.1.1.2' : '';
  const onlyCorrections = current.profiles?.length && current.profiles.every(profile => Number(profile.version) > 1);
  if (expected && !onlyCorrections && !rows.some(row => row.item.unk === expected)) {
    gaps.push(expected === '6.1.1.1'
      ? 'Brak potwierdzonego zgłoszenia dobowego profilu (6.1.1.1) w archiwum.'
      : 'Brak potwierdzonej odpowiedzi R_9 na ten profil (6.1.1.2) w archiwum.');
  }

  const timeline = [...rows, { item: current, reason: 'Analizowany komunikat', current: true }];
  for (const { item } of timeline) {
    if (item.unk !== '6.1.1.1') continue;
    for (const correction of (item.profiles ?? []).filter(profile => Number(profile.version) > 1)) {
      const answered = timeline.some(({ item: result }) => result.unk === '6.1.1.2'
        && (same(result.respondsTo, item.messageId)
          || intersects([correction.transaction].filter(Boolean), result.transactions)));
      if (!answered) {
        const details = [correction.identity, 'wersja ' + correction.version, correction.start].filter(Boolean);
        gaps.push('Brak odpowiedzi na korektę w archiwum · ' + details.join(' · '));
      }
    }
  }
  timeline.sort((a, b) => {
    const dateA = Date.parse(a.item.timestamp || a.item.modified);
    const dateB = Date.parse(b.item.timestamp || b.item.modified);
    return (Number.isNaN(dateA) ? Infinity : dateA) - (Number.isNaN(dateB) ? Infinity : dateB);
  });
  return { timeline, context, gaps: [...new Set(gaps)], linked: rows.length };
}
