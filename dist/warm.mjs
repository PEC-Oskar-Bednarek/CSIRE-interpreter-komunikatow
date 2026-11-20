import { decodeXmlFile, EDITIONS, extractR9, MAX_BYTES, messageMetadata, PROCESS_NAMES, readMessage, searchText, STATUS } from './analysis.mjs?v=daty-tskb';
import { archiveFetch, archiveHash, listArchive, readArchivedFile, usesLocalArchive } from './archive-client.mjs';
import { caseHistory, historyMetadata } from './case-history.mjs';
import { downloadBlob } from './ui.mjs';
import { attentionCards } from './attention.mjs';
import { answerDeadline, displayDeadlineDay, documentedDeadline } from './deadlines.mjs';
import { loadLocalDictionary, localName } from './local-dictionary.mjs';

const samples = new Set([
  'wynik-ce807', 'profil-dobowy', 'korekta-profilu', 'potrzeba-pomiarow', 'zmiana-charakterystyki',
  'saldo-przedplaty', 'zadanie-odpowiedzi', 'status-zadania', 'wynik-zadania', 'nowy-typ',
]);
const demoLinks = {
  'wynik-ce807': [['profil-dobowy', 'Zgłoszenie źródłowe', 'Wspólny identyfikator transakcji']],
  'profil-dobowy': [['wynik-ce807', 'Odpowiedź na to zgłoszenie', 'Wspólny identyfikator transakcji']],
  'korekta-profilu': [['profil-dobowy', 'Możliwe powiązanie', 'Ten sam punkt i okres']],
  'status-zadania': [['wynik-zadania', 'Wynik rozpatrzenia żądania', 'Wspólny identyfikator instancji procesu']],
  'wynik-zadania': [['status-zadania', 'Wcześniejszy status sprawy', 'Wspólny identyfikator instancji procesu']],
};
const markup = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const e = value => String(value ?? '').replace(/[&<>"']/g, char => markup[char]);
const code = value => `<code>${e(value || '—')}</code>`;
function xmlDescription(value) {
  if (/^not all required product types are submitted\.?$/i.test(value?.trim().replace(/\s+/g, ' '))) {
    return 'Nie przekazano wszystkich wymaganych typów produktów energetycznych. <small class="xml-explanation">(tłumaczenie)</small>';
  }
  return e(value);
}
function namedCode(value, names) {
  const label = localName(names, value);
  return code(value) + (label ? ` <span class="xml-explanation">· ${e(label)}</span>` : '');
}
function partyField(value, parties) {
  if (!value) return '';
  const name = parties[value.toUpperCase()];
  return code(value) + (name ? ` <span class="xml-explanation">· ${e(name)}</span>` : '');
}
export const sampleHash = id => '#analiza/przyklad/' + encodeURIComponent(id);
const sampleUrl = id => new URL('./data/przyklady/' + id + '.xml', import.meta.url);
const dateTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' });
const localDateTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const calendarDate = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', dateStyle: 'medium' });
async function digestOf(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function date(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return value;
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return calendarDate.format(new Date(value));
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return dateTime.format(new Date(value)) + ' (czas polski)';
  return localDateTime.format(new Date(value + 'Z'));
}

function fields(pairs) {
  const entries = pairs.filter(([, value]) => value);
  return entries.length
    ? `<dl class="d-fields">${entries.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`
    : '';
}

function table(headings, rows) {
  return `<div class="d-table-scroll" role="region" aria-label="${e(headings.join(', '))}" tabindex="0">
    <table class="d-table"><thead><tr>${headings.map(label => `<th scope="col">${e(label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function paginate(host, items, render, size, emptyMessage = 'Brak wyników.') {
  host.innerHTML = `<div class="w-page-body"></div>
    <div class="w-page-control">
      <p class="w-page-status" role="status"></p>
      <div class="w-page-buttons" hidden>
        <button type="button" class="button button-outline">Poprzednia</button>
        <button type="button" class="button button-outline">Następna</button>
      </div>
    </div>`;
  const body = host.querySelector('.w-page-body');
  const status = host.querySelector('.w-page-status');
  const buttons = host.querySelector('.w-page-buttons');
  const [previous, next] = buttons.querySelectorAll('button');
  let page = 0;
  let visible = items;

  function show() {
    const start = page * size;
    const end = Math.min(start + size, visible.length);
    body.innerHTML = visible.length ? render(visible.slice(start, end)) : `<p class="w-empty-result">${e(emptyMessage)}</p>`;
    status.textContent = visible.length ? `${start + 1}–${end} z ${visible.length}` : '';
    buttons.hidden = visible.length <= size;
    previous.disabled = page === 0;
    next.disabled = end === visible.length;
  }

  previous.addEventListener('click', () => { page--; show(); });
  next.addEventListener('click', () => { page++; show(); });
  show();
  return matching => { visible = matching; page = 0; show(); };
}

function batchRecords(host, records, codes, enums, ppe) {
  host.innerHTML = `<label class="w-business-search">Szukaj w rekordach
    <input type="search" placeholder="Punkt, obiekt, kod lub transakcja"></label><div class="w-record-pages"></div>`;
  const search = host.querySelector('input');
  const index = records.map(record => ({
    record,
    search: searchText([
      record.index, record.point, record.facility, record.code, codes[record.code], record.description,
      localName(ppe, record.point), localName(ppe, record.facility),
      record.transactionId, record.scenario, record.subject,
    ].filter(Boolean).join(' ')),
  }));
  const update = paginate(host.querySelector('.w-record-pages'), index, items =>
    table(['Rekord', 'Punkt / obiekt', 'Kod i znaczenie PSE', 'Szczegóły'], items.map(({ record }) => {
      const details = fields([
        ['Punkt pomiarowy', record.point && namedCode(record.point, ppe)],
        ['Identyfikator obiektu', record.facility && namedCode(record.facility, ppe)],
        ['Identyfikator transakcji', record.transactionId && code(record.transactionId)],
        ['Przedmiot danych', coded(record.subject, enums.DataSubjectType)],
        ['Kod wyniku', coded(record.code, codes)],
        ['Opis z XML', xmlDescription(record.description)],
        ['Scenariusz macierzy', coded(record.scenario, enums.PriorityMatrixScenarioType)],
      ]);
      return [record.index, namedCode(record.point || record.facility, ppe), coded(record.code, codes) || '—',
        details ? `<details class="w-record-details"><summary aria-label="Szczegóły rekordu ${record.index}">Rozwiń</summary>${details}</details>` : '—'];
    })), 20, 'Brak rekordów pasujących do wyszukiwania.');
  search.addEventListener('input', () => {
    const words = searchText(search.value).trim().split(/\s+/).filter(Boolean);
    update(index.filter(entry => words.every(word => entry.search.includes(word))));
  });
}

function profileGroups(host, groups, number, enums, ppe) {
  const expandSingleProduct = groups.length === 1 && groups[0].products.length === 1;
  host.addEventListener('toggle', event => {
    const product = event.target;
    if (!product.matches('.w-profile-product') || !product.open || product.childElementCount > 1) return;
    const [groupIndex, productIndex] = product.dataset.product.split(':').map(Number);
    const { type, measures } = groups[groupIndex].products[productIndex];
    const content = document.createElement('div');
    product.append(content);
    paginate(content, measures, items => table(['Pozycja', 'Wolumen', 'Kod jakości'], items.map(item => {
      const volume = xmlValue(item, 'Volume');
      const unit = volume && ['6.1.1.1', '6.1.1.5'].includes(number) && /^CK(?:112[5-9]|1130)$/.test(type)
        ? ' <span class="w-coded-label" title="Jednostka według TSKB, pole PL-192">kWh</span>' : '';
      return [e(xmlValue(item, 'SEQ')), e(volume.replace('.', ',')) + unit,
        coded(xmlValue(item, 'QQ'), enums.DataQualityAssessmentType) || '—'];
    })), 25);
  }, true);
  paginate(host, groups, items => items.map(group => `<article class="w-profile-group">
    <h3>${e(group.point ? 'Punkt pomiarowy' : group.facility ? 'Obiekt' : 'Profil')}${group.point || group.facility ? ' ' + namedCode(group.point || group.facility, ppe) : ''}</h3>
    ${fields([
      ['Początek okresu', e(date(group.start))], ['Koniec okresu', e(date(group.end))],
      ['Wersja danych', e(group.version)], ['Identyfikator transakcji', group.transaction && code(group.transaction)],
      ['Typy produktów', [...new Set(group.products.map(product => product.type).filter(Boolean))]
        .map(type => coded(type, enums.ProductType_Type)).join(', ')],
    ])}
    ${group.products.map(({ type, measures }, index) => measures.length
      ? `<details class="w-profile-product" data-product="${group.index}:${index}"${expandSingleProduct ? ' open' : ''}>
        <summary>${coded(type, enums.ProductType_Type) || 'Pomiary'} <span class="w-coded-label">· ${measures.length} pozycji</span></summary></details>`
      : '').join('')}
  </article>`).join(''), 5);
}

const xmlNodes = (parent, name) => Array.from(parent?.getElementsByTagNameNS(parent.namespaceURI, name) ?? []);
const xmlValue = (parent, name) => xmlNodes(parent, name)[0]?.textContent.trim() || '';
const coded = (value, labels) => value && (code(value) + (labels && Object.hasOwn(labels, value)
  ? ` <span class="w-coded-label" title="Znaczenie według TSKB">${e(labels[value])}</span>` : ''));
const moreFields = (title, visibleFields) => visibleFields
  ? `<details class="w-business-details"><summary>${e(title)}</summary>${visibleFields}</details>` : '';

function businessView(root, data, catalog, { codes, enums, parties, localDictionary: {ppe, meters} }) {
  const payload = Array.from(root.children).find(node => node.localName === 'Payload' && node.namespaceURI === root.namespaceURI);
  const nodes = xmlNodes;
  const value = (name, parent = payload) => xmlValue(parent, name);
  const distinct = name => [...new Set(nodes(payload, name).map(node => node.textContent.trim()).filter(Boolean))];
  const optionalCode = value => value && code(value);
  const pointValues = distinct('MeteringPointCode');
  const objectValues = distinct('FacilityIdentifier');
  const focus = [
    ['Punkt pomiarowy', pointValues.map(point => namedCode(point, ppe)).join(', ')],
    ['Identyfikator obiektu', objectValues.map(point => namedCode(point, ppe)).join(', ')],
  ];
  const profile = /^(6\.1\.1\.[145]|11\.1\.)/.test(data.number) || nodes(payload, 'DailyMeteringPointMeasurements').length > 0;
  const correction = data.number === '6.1.1.4';
  const balance = value('Balance');
  const response = value('ResponseCode') || value('ResultCode');
  const responseText = value('ResponseJustification') || value('ResultDescription');
  let information = '';
  let fallback = '';
  let batch;
  let mountBusiness;
  if (data.batch) {
    batch = extractR9(root);
    if (batch.general) information = fields([
      ['Kod wyniku ogólnego', coded(batch.general.code, codes)],
      ['Opis wyniku z XML', xmlDescription(batch.general.description)],
    ]);
    if (batch.records.length) mountBusiness = host => batchRecords(host, batch.records, codes, enums, ppe);
  } else if (data.type === 'R_3') {
    information = fields([...focus, ['Data i czas zapytania pomiarowego', e(date(value('MeasurementQueryDateTime')))]]);
  } else if (profile || correction) {
    const blocks = nodes(payload, 'BasicData').filter(block =>
      value('PeriodStart', block) || value('PeriodEnd', block) || nodes(block, 'EnergyProduct').length);
    const groups = blocks.map((block, index) => ({
      index, point: value('MeteringPointCode', block.parentElement), facility: value('FacilityIdentifier', block.parentElement),
      transaction: value('ReferenceTransactionId', block.parentElement),
      start: value('PeriodStart', block), end: value('PeriodEnd', block), version: value('DataVersionNumber', block),
      products: nodes(block, 'EnergyProduct').map(product => ({
        type: value('ProductType', product), measures: nodes(product, 'EnergyProductMeasurement'),
      })),
    }));
    if (groups.length) mountBusiness = host => profileGroups(host, groups, data.number, enums, ppe);
    else information = fields(focus);
  } else if (data.type === '3.1_1' || data.type === '2.9_1' || value('MeteringPointType')) {
    const address = nodes(payload, 'MeteringPointData_Address')[0];
    const area = nodes(payload, 'MeteringPointData_Area')[0];
    const operators = nodes(payload, 'MeteringPointData_Operators')[0];
    const technical = nodes(payload, 'TechnicalData_Basic')[0];
    const meter = xmlValue(technical, 'MeterNumber');
    information = fields([...focus,
      ['Data obowiązywania', e(date(value('EffectiveDate')))],
      ['Typ punktu pomiarowego', coded(value('MeteringPointType'), enums.MeteringPointType_Type)],
      ['Status przyłączenia', coded(xmlValue(technical, 'ConnectionStatus'), enums.MeteringPointConnectionStatusType)],
      ['Status fizyczny', coded(xmlValue(technical, 'PhysicalStatus'), enums.PhysicalStatusType)],
    ]) + moreFields('Adres i obszar', fields([
      ['Kraj', e(xmlValue(address, 'Country'))], ['Miejscowość', e(xmlValue(address, 'CityName'))],
      ['Kod pocztowy', e(xmlValue(address, 'PostalCode'))], ['Ulica', e(xmlValue(address, 'StreetName'))],
      ['Numer budynku', e(xmlValue(address, 'BuildingNumber'))], ['Numer lokalu', e(xmlValue(address, 'ApartmentNumber'))],
      ['Kod obszaru sieci', optionalCode(xmlValue(area, 'MeteringGridAreaCode'))],
    ])) + moreFields('Podmioty', fields([
      ['Operator', partyField(xmlValue(operators, 'OperatorIdentifier'), parties)],
      ['Sprzedawca', optionalCode(xmlValue(operators, 'SupplierIdentifier'))],
      ['Podmiot odpowiedzialny za bilansowanie', optionalCode(xmlValue(operators, 'BalanceResponsiblePartyIdentifier'))],
    ])) + moreFields('Dane techniczne', fields([
      ['Moc przyłączeniowa', e(xmlValue(technical, 'ConnectionPower').replace('.', ','))],
      ['Numer licznika', meter && namedCode(meter, meters)],
      ['Metoda pomiaru', coded(xmlValue(technical, 'MeasurementMethod'), enums.MeasurementMethod_Type)],
      ['Liczba faz', coded(xmlValue(technical, 'MeasuringSystemPhasesCount'), enums.MeasuringSystemPhasesCountType)],
    ]));
  } else if (balance) {
    information = fields([...focus,
      ['Stan salda', e(balance.replace('.', ',')) + ' ' + coded(value('BalanceUnit'), enums.UnitCodeType)],
      ['Data i czas salda', e(date(value('BalanceDateTime')))],
    ]);
  } else if (data.process === '9.1') {
    const messageDetails = nodes(payload, 'MessageDetails')[0];
    information = fields([...focus,
      ['Kod wyniku', coded(response, Object.hasOwn(codes, response) ? codes : enums.ComplaintResponseCode_Type)],
      ['Powód wymiany informacji', coded(value('GenericInformationExchangeReason'), enums.GenericInformationExchangeReasonType)],
      ['Typ adresata', coded(value('RecipientType'), enums.ComplaintRecipientType_Type)],
    ]) + moreFields('Treść żądania lub odpowiedzi', fields([
      ['Opis z XML', xmlDescription(responseText || xmlValue(messageDetails, 'Description'))], ['Data wskazana w żądaniu', e(date(xmlValue(messageDetails, 'Date')))],
      ['Planowana data początku obowiązywania umowy', e(date(xmlValue(messageDetails, 'PlannedAgreementValidFrom')))],
    ])) + moreFields('Inicjator i powiązane identyfikatory', fields([
      ['Nazwa inicjatora', e(value('ProcessInitiatorName'))], ['Identyfikator inicjatora', optionalCode(value('ProcessInitiatorId'))],
      ['Identyfikator procesu wskazanego w żądaniu', optionalCode(xmlValue(messageDetails, 'ComplaintSubjectProcessId'))],
      ['Identyfikator komunikatu wskazanego w żądaniu', optionalCode(xmlValue(messageDetails, 'ComplaintSubjectMessageId'))],
    ]));
  } else if (data.type === 'R_1') {
    information = fields([...focus, ['Kod wyniku', coded(response, codes)], ['Opis z XML', xmlDescription(responseText)]]);
  } else {
    fallback = catalog?.schemas?.[data.schemaKey]
      ? 'Dostępny jest przegląd pól źródłowych z opisami ze schematu.'
      : 'Dostępny jest ogólny podgląd pól XML. Katalog może zawierać nazwę typu bez osobnego schematu dla tej struktury.';
    information = fields(focus);
  }
  return {
    information, fallback, batch, mountBusiness,
    processId: value('ProcessInstanceId'),
    responseLabel: response && coded(response, Object.hasOwn(codes, response) ? codes : enums.ComplaintResponseCode_Type),
    sender: root.getElementsByTagNameNS('urn:pl:oire:technical:v1', 'JuridicalSenderId')[0]?.textContent.trim(),
    recipient: root.getElementsByTagNameNS('urn:pl:oire:technical:v1', 'JuridicalRecipientId')[0]?.textContent.trim(),
  };
}

function timelineEntry(root, metadata, catalog, codesByName, ppe) {
  const payload = Array.from(root.children).find(node => node.localName === 'Payload' && node.namespaceURI === root.namespaceURI);
  const values = name => [...new Set(Array.from(payload?.getElementsByTagNameNS(root.namespaceURI, name) ?? [],
    node => node.textContent.trim()).filter(Boolean))];
  const batch = metadata.batch ? extractR9(root) : null;
  const status = STATUS[batch?.status]?.title || batch?.status;
  const codes = [...new Set([...values('ErrorCode'), ...values('ResultCode'), ...values('AnomalyCode')])];
  const rejected = batch?.records.filter(record => record.code.startsWith('CE')).length ?? 0;
  const response = values('ResponseCode')[0];
  const profileDays = values('PeriodStart').map(start => start.slice(0, 10)).filter(day => /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(Date.parse(day)));
  const distinctDays = [...new Set(profileDays)];
  const profileLabel = /^6\.1\.1\.[14]$/.test(metadata.number) && distinctDays.length
    ? distinctDays.length === 1 ? 'Profil za ' + calendarDate.format(new Date(distinctDays[0])) : 'Doby profilu: ' + distinctDays.length
    : '';
  const pointCodes = values('MeteringPointCode');
  const objectCodes = values('FacilityIdentifier');
  const identity = [
    pointCodes.length === 1 && [pointCodes[0], localName(ppe, pointCodes[0])].filter(Boolean).join(' · '),
    pointCodes.length > 1 && 'Punkty pomiarowe: ' + pointCodes.length,
    objectCodes.length === 1 && [objectCodes[0], localName(ppe, objectCodes[0])].filter(Boolean).join(' · '),
    objectCodes.length > 1 && 'Obiekty: ' + objectCodes.length,
  ].filter(Boolean).join(' · ');
  const errorCount = rejected === 1 ? '1 rekord z błędem' : rejected > 0 ? 'Rekordy z błędem: ' + rejected : '';
  const summary = [status || response,
    codes.slice(0, 4).join(', ') + (codes.length > 4 ? ' +' + (codes.length - 4) : ''), errorCount, profileLabel]
    .filter(Boolean).join(' · ') || identity;
  const name = batch
    ? metadata.number === '6.1.1.2' ? 'Wynik przekazania profilu dobowego'
      : ['Wynik operacji masowej', PROCESS_NAMES[metadata.process]].filter(Boolean).join(' · ')
    : catalog?.schemas?.[metadata.schemaKey]?.[1]?.replace(/^\d+(?:\.\d+)+\.?\s+/, '')
      || catalog?.labels?.[metadata.type] || 'Komunikat CSIRE';
  return {
    ...metadata, name, summary,
    details: [
      ['Identyfikator komunikatu', metadata.id && `${code(metadata.id)} <button type="button" class="w-copy">Kopiuj</button>`],
      ['Punkty pomiarowe', pointCodes.slice(0, 5).map(point => namedCode(point, ppe)).join(', ') + (pointCodes.length > 5 ? ' +' + (pointCodes.length - 5) : '')],
      ['Obiekty', objectCodes.slice(0, 5).map(point => namedCode(point, ppe)).join(', ') + (objectCodes.length > 5 ? ' +' + (objectCodes.length - 5) : '')],
      ['Kody', codes.map(code).join(', ')],
      ['Znaczenie według PSE', codes.filter(value => Object.hasOwn(codesByName, value))
        .map(value => `${code(value)} · ${e(codesByName[value])}`).join('<br>')],
      ['Opis z XML', [...new Set([...values('ErrorDescription'), ...values('ResultDescription'), ...values('ResponseJustification')])]
        .slice(0, 5).map(xmlDescription).join('<br>')],
    ],
  };
}

function timeline(rows) {
  return `<ol class="w-history">${rows.map(row => {
    const types = [row.type, row.number].filter(Boolean).join(' · ');
    const when = date(row.timestamp).replace(/ \(czas polski\)$/, '');
    const timestamp = when
      ? `<time datetime="${e(row.timestamp)}">${e(when)}</time>`
      : '<span class="w-history-no-date">Brak daty</span>';
    const details = fields(row.details);
    return `<li class="w-history-row"${row.current ? ' aria-current="true"' : ''}>
      <div class="w-history-date">${timestamp}</div>
      <div class="w-history-event"><h3>${e(row.name)}</h3>
        ${types ? `<p class="w-history-type">${code(types)}</p>` : ''}
        ${row.summary ? `<p class="w-history-summary">${e(row.summary)}</p>` : ''}
      </div>
      <div class="w-history-relation"><span>${e(row.relation)}</span>
        ${row.reason ? `<p>${e(row.reason)}</p>` : ''}
        ${row.href ? `<a class="w-jump" href="${e(row.href)}" aria-label="Otwórz komunikat: ${e(row.name)}">Otwórz komunikat <span aria-hidden="true">→</span></a>` : ''}</div>
      ${details ? `<details class="w-history-details"><summary>Szczegóły</summary>
        ${details}</details>` : ''}
    </li>`;
  }).join('')}</ol>`;
}

function renderAttention(cards, { codes, descriptions, enums, localDictionary }, version) {
  return `<div class="w-issues">${cards.map(card => {
    const { items = [] } = card;
    const title = Object.hasOwn(codes, card.code) ? codes[card.code] : '';
    const choices = enums.ComplaintResponseCode_Type ?? {};
    const enumTitle = Object.hasOwn(choices, card.code) ? choices[card.code] : '';
    const description = Object.hasOwn(descriptions, card.code) ? descriptions[card.code] : '';
    const describe = item => `<div class="w-issue-item">${item.index || item.identity
      ? `<strong>${item.index ? 'Rekord ' + item.index : ''}${item.identity ? (item.index ? ' · ' : '') + namedCode(item.identity, localDictionary.ppe) : ''}</strong>` : ''}
      ${item.description ? `<p>Opis z XML · ${xmlDescription(item.description)}</p>` : ''}
      ${item.scenario ? `<p>Scenariusz macierzy · ${code(item.scenario)}</p>` : ''}</div>`;
    return `<article class="w-issue">
      <div class="w-issue-heading">${card.code ? `<span class="d-code">${e(card.code)}</span>` : ''}<h3>${e(title || enumTitle || card.title)}</h3></div>
      ${title || description ? `<p class="w-evidence-label">Słownik PSE · ${e(EDITIONS[version].name)}</p>
        ${description ? `<details class="w-official-description"><summary>Objaśnienie PSE</summary><p>${e(description)}</p></details>` : ''}` : ''}
      ${enumTitle && !title && !description ? '<p class="w-evidence-label">Znaczenie według schematu TSKB</p>' : ''}
      ${fields([['Punkt / obiekt', card.points?.map(point => namedCode(point, localDictionary.ppe)).join(', ')],
        ...(card.dates ?? []).map(([label, value]) => [label, /^\d{4}-/.test(value) ? e(date(value)) : e(value)])])}
      ${card.description ? `<p>Opis z XML · ${xmlDescription(card.description)}</p>` : ''}
      ${items.length === 1 ? describe(items[0]) : items.length > 1
        ? `<details class="w-issue-records"><summary>Pozycje z tym kodem (${items.length})</summary>
          ${items.slice(0, 100).map(describe).join('')}
          ${items.length > 100 ? '<p>Pierwsze 100 pozycji. Pełna lista jest w sekcji „Wszystkie pola XML”.</p>' : ''}</details>` : ''}
    </article>`;
  }).join('')}</div>`;
}

function renderDeadline(deadline) {
  if (!deadline) return '';
  return `<article class="w-issue w-deadline">
    <div class="w-issue-heading"><h3>${e(deadline.label)}</h3></div>
    <p class="w-evidence-label">Reguła źródłowa</p>
    <p>${e(deadline.rule)}</p>
    ${deadline.kind === 'answer'
      ? `<div class="w-deadline-control">
        <label for="oire-delivery">Data przekazania żądania przez OIRE</label>
        <input type="date" id="oire-delivery" aria-describedby="oire-delivery-note">
        <p id="oire-delivery-note">Data podana przez użytkownika na podstawie informacji o przekazaniu.</p>
        <output for="oire-delivery" id="oire-deadline" aria-live="polite">Do wyliczenia potrzebna jest data przekazania.</output>
      </div>`
      : `${deadline.periods.length ? `<ul class="w-deadline-dates">${deadline.periods.slice(0, 30).map(([day, due]) =>
        `<li>Doba z XML ${e(displayDeadlineDay(day))} · <strong>Wyliczony termin ${e(displayDeadlineDay(due))}, 07:00 (czas polski)</strong></li>`).join('')}</ul>` : ''}
        ${deadline.periods.length > 30 ? '<p>Pokazano pierwsze 30 dób.</p>' : ''}
        ${deadline.missing ? '<p>Dla części danych brakuje jednoznacznego okresu dobowego w XML.</p>' : ''}`}
  </article>`;
}

function drawReport(output, data, src, catalog, schema, definitions, validation, version, xmlFields) {
  const { root, metadata, xml, sample, archived, history, historyIncomplete, archiveContext, gaps, archiveState } = src;
  const stored = archived || archiveState.archive?.items.some(item => item.digest === archiveState.digest);
  const canSave = usesLocalArchive && !sample && !stored;
  const archiveStatus = sample ? 'Komunikat przykładowy.'
    : !usesLocalArchive ? 'Zapis we wspólnym archiwum jest dostępny w wersji lokalnej.'
    : stored ? 'Komunikat zapisany w archiwum.'
    : archiveState.error ? 'Nie udało się sprawdzić statusu zapisu.'
    : 'Komunikat nie jest zapisany w archiwum.';
  const schemaTitle = schema?.[1]?.replace(/^\d+(?:\.\d+)+\.?\s+/, '');
  const name = metadata.batch ? PROCESS_NAMES[metadata.process] || 'Wynik operacji masowej'
    : schemaTitle || catalog?.labels?.[metadata.type] || 'Komunikat CSIRE';
  const outcome = STATUS[data.batch?.status];
  const { format, cards } = attentionCards(root, metadata, schema, data.batch);
  const deadline = documentedDeadline(root, metadata, schema, version);
  const validity = { valid: 'Zgodny z XSD', invalid: 'Wykryto błędy XSD', unknown: 'Brak dopasowanego XSD', unavailable: 'Nie udało się sprawdzić XSD' }[validation.state];

  output.innerHTML = `<div class="w-result-actions">
    <button type="button" class="button button-primary" data-next-message>Zinterpretuj kolejny komunikat</button>
  </div><header class="w-head">
    <div class="w-intro">
      <div class="d-label">${metadata.type ? `<span>${e(metadata.type)}</span>` : ''}
        ${metadata.number ? `<span>${e(metadata.number)}</span>` : ''}<span>${sample || archived ? 'Wczytane z archiwum' : 'Nowy komunikat'}</span></div>
      <h1 id="design-title" tabindex="-1">${e(name)}</h1>
    </div>
    <section class="w-status" aria-label="${outcome ? 'Wynik w CSIRE' : 'Charakter komunikatu'}">
      <div class="d-panel-heading">${outcome ? 'Wynik w CSIRE' : 'Rodzaj informacji'}
        ${data.batch?.status ? `<span class="d-status">${e(data.batch.status)}</span>` : ''}</div>
      ${outcome ? `<h2>${e(outcome.title)}</h2>` : ''}
      ${data.batch && !outcome ? '<h2>Brak rozpoznanego statusu</h2>' : ''}
      ${!data.batch ? (data.responseLabel ? `<h2>${data.responseLabel}</h2>`
        : `<h2>${e(format.label)}</h2>`) : ''}
      ${data.batch?.records.length ? `<p>Zwrócone rekordy: ${data.batch.records.length}</p>` : ''}
    </section>
  </header>
  <div class="w-report-grid">
    <div class="w-report-main">
      ${cards.length || deadline ? `<section class="w-report-section"><h2>Co wymaga uwagi</h2>
        ${cards.length ? renderAttention(cards, definitions, version) : ''}${renderDeadline(deadline)}</section>` : ''}
      <section class="w-report-section"><h2>Dane biznesowe</h2>
        ${data.information}${data.fallback ? `<p>${e(data.fallback)}</p>` : ''}
        ${data.mountBusiness ? '<div class="w-business-interactive"></div>' : ''}
        ${!data.information && !data.fallback && !data.mountBusiness ? '<p>Szczegóły są dostępne w sekcji „Wszystkie pola XML”.</p>' : ''}
      </section>
      <section class="w-report-section w-case-history"><h2>Historia sprawy</h2>
        ${timeline(history)}
        ${historyIncomplete ? '<p>Nie udało się wczytać wszystkich powiązanych przykładów.</p>'
          : archiveState.error ? `<p>${e(archiveState.error)}</p>`
          : !sample && !usesLocalArchive ? '<p>Historia ze wspólnego folderu jest dostępna w wersji lokalnej.</p>'
          : history.length === 1 && !gaps.length ? '<p>Brak potwierdzonych powiązań w archiwum.</p>' : ''}
        ${gaps.length ? `<ul class="w-history-gaps">${gaps.map(gap => `<li>${e(gap)}</li>`).join('')}</ul>` : ''}
        ${archiveContext.length ? `<details class="w-context-messages"><summary>Możliwe powiązania (${archiveContext.length})</summary>${timeline(archiveContext)}</details>` : ''}
        ${usesLocalArchive && !sample ? '<button type="button" class="button button-outline" data-refresh-case>Odśwież historię</button>' : ''}
        <p class="w-copy-status" role="status"></p>
      </section>
    </div>
    <aside class="w-report-aside" aria-label="Dane i archiwum komunikatu">
      <section class="w-message"><header class="d-card-title"><h2>Dane komunikatu</h2></header>
        ${fields([['Czas utworzenia', e(date(metadata.timestamp))], ['Nadawca', partyField(data.sender, definitions.parties)], ['Odbiorca', partyField(data.recipient, definitions.parties)],
          ['Identyfikator komunikatu', metadata.id && code(metadata.id)], ['Identyfikator instancji procesu', data.processId && code(data.processId)]])}
      </section>
      <section class="w-report-section w-save"><h2>Archiwum</h2>
        <p role="status">${e(archiveStatus)}</p>
        ${canSave ? '<button type="button" class="button button-outline" data-save-message>Zapisz w archiwum</button>' : ''}
      </section>
    </aside>
  </div>
  <section class="w-report-section w-verification"><h2>Weryfikacja i źródło</h2>
    <div class="d-validation"><span class="d-check" aria-hidden="true">${validation.state === 'valid' ? '✓' : 'i'}</span>
      <div><strong>${validity}</strong><span>${e(EDITIONS[version].name)}</span></div></div>
    ${validation.errors?.length ? `<details class="d-source"><summary>Uwagi walidacji XSD</summary><ul>${validation.errors.map(issue => `<li>${e(issue.message)}</li>`).join('')}</ul></details>` : ''}
    <details class="d-source w-all-fields"><summary>Wszystkie pola XML</summary></details>
    <details class="d-source w-source-xml"><summary>XML źródłowy</summary></details>
    ${sample ? `<a href="${e(sampleUrl(sample).href)}" download>Pobierz przykładowy XML ↓</a>`
      : '<button type="button" class="button button-outline" data-download-xml>Pobierz XML ↓</button>'}
  </section>`;

  if (data.mountBusiness) data.mountBusiness(output.querySelector('.w-business-interactive'));
  const delivery = output.querySelector('#oire-delivery');
  delivery?.addEventListener('input', () => {
    const due = answerDeadline(delivery.value);
    output.querySelector('#oire-deadline').textContent = due
      ? 'Wyliczony termin: ' + displayDeadlineDay(due)
      : 'Do wyliczenia potrzebna jest data przekazania.';
  });
  const fieldsPanel = output.querySelector('.w-all-fields');
  fieldsPanel.addEventListener('toggle', () => {
    if (fieldsPanel.open && fieldsPanel.childElementCount === 1) {
      fieldsPanel.append(...Array.from(root.children, child => xmlFields(child, definitions.rootType, definitions)));
    }
  });
  const raw = output.querySelector('.w-source-xml');
  raw.addEventListener('toggle', () => {
    if (!raw.open || raw.childElementCount > 1) return;
    const text = document.createElement('pre');
    text.textContent = xml;
    raw.append(text);
  });
}

export function mountWarm(options) {
  const panel = document.createElement('div');
  panel.className = 'd-frame warm warm-report';
  panel.innerHTML = `<section class="w-intake" aria-labelledby="w-intake-title" hidden>
    <header class="w-intake-heading">
      <h1 id="w-intake-title">Analiza komunikatu</h1>
      <p>Wklej pełną treść komunikatu XML lub wczytaj ją z pliku.</p>
    </header>
    <div class="w-intake-grid">
      <div class="w-intake-card w-intake-editor">
        <form id="warm-paste-form"><label for="warm-xml">Treść komunikatu</label>
          <textarea id="warm-xml" spellcheck="false" placeholder="Wklej tutaj pełny XML…"></textarea>
          <button class="button button-primary" type="submit">Analizuj komunikat</button>
        </form>
        <div class="w-controls">
          <label for="warm-edition">Wersja TSKB
            <select id="warm-edition">${Object.entries(EDITIONS).map(([id, edition]) =>
              `<option value="${id}">${e(edition.name)} · od ${e(edition.effectiveFrom)}</option>`).join('')}</select>
          </label>
          <button type="button" class="button button-outline" id="warm-open-file">Wczytaj XML</button>
          <input type="file" id="warm-file" accept=".xml,.soap,application/xml,text/xml" hidden>
        </div>
      </div>
      <div class="w-intake-aside">
        <section class="w-intake-card" aria-labelledby="w-example-title">
          <h2 id="w-example-title">Przykładowy XML</h2>
          <pre class="w-intake-example"><code>${e(`<?xml version="1.0" encoding="UTF-8"?>
<BatchResult xmlns="urn:pl:oire:message_R_9:v1"
             xmlns:tech="urn:pl:oire:technical:v1">
  <Header>
    <tech:MessageId>080cd234-5fd2-4eaf-b5a7-b10a923f1832</tech:MessageId>
    <tech:MessageType>R_9</tech:MessageType>
    …`)}</code></pre>
          <a class="w-intake-link" href="${sampleHash('wynik-ce807')}">Otwórz analizę przykładu <span aria-hidden="true">→</span></a>
        </section>
        <section class="w-intake-card" aria-labelledby="w-archive-title">
          <h2 id="w-archive-title">Komunikat jest już w archiwum?</h2>
          <p>Otwórz go bezpośrednio z archiwum, bez ponownego wklejania XML.</p>
          <a class="w-intake-link" href="#archiwum">Przejdź do archiwum <span aria-hidden="true">→</span></a>
        </section>
      </div>
    </div>
  </section>
  <div class="w-report-tools"><p class="w-state" role="status"></p></div><div class="w-output"></div>`;
  const edition = panel.querySelector('#warm-edition');
  const input = panel.querySelector('#warm-file');
  const editor = panel.querySelector('#warm-xml');
  const paste = panel.querySelector('#warm-paste-form');
  const feedback = panel.querySelector('.w-state');
  const output = panel.querySelector('.w-output');
  const intake = panel.querySelector('.w-intake');
  const intakeEditor = intake.querySelector('.w-intake-editor');
  const reportTools = panel.querySelector('.w-report-tools');
  function showIntake(visible) {
    if (intake.hidden === !visible) return;
    intake.hidden = !visible;
    reportTools.hidden = visible;
    (visible ? intakeEditor : reportTools).append(feedback);
  }
  showIntake(true);
  const sampleCache = new Map();
  function loadSample(id) {
    if (!sampleCache.has(id)) {
      const pending = fetch(sampleUrl(id)).then(response => {
        if (!response.ok) throw new Error('Nie udało się wczytać przykładu.');
        return response.text();
      }).catch(error => {
        sampleCache.delete(id);
        throw error;
      });
      sampleCache.set(id, pending);
    }
    return sampleCache.get(id);
  }

  let revision = 0;
  let selection;
  let activeInput;
  let saveData;
  let savedHeaders;
  let configRequest = 0;
  const read = async ({ sample, file, text, focus, archived, historyData, archiveFileHash }) => {
    const job = ++revision;
    feedback.textContent = 'Odczytuję komunikat…';
    output.replaceChildren();
    activeInput = { sample, file, text, archived };
    try {
      const version = sample ? '04' : edition.value;
      if (file?.size > MAX_BYTES) throw new Error('Wybierz pojedynczy XML do 25 MB.');
      const bytes = file ? await file.arrayBuffer() : undefined;
      const xml = sample ? await loadSample(sample) : bytes ? decodeXmlFile(bytes) : text;
      const original = file || new Blob([xml.replace(/^(\s*<\?xml\s[^>]*?\bencoding\s*=\s*)(['"])[^'"]+\2/i, '$1"UTF-8"')], { type: 'application/xml' });
      if (original.size > MAX_BYTES) throw new Error('Wybierz pojedynczy XML do 25 MB.');
      const root = readMessage(xml);
      if (job !== revision) return;
      const metadata = messageMetadata(root);
      const [catalog, fields, codes, descriptions, parties, localDictionary] = await Promise.all([
        options.loadCatalog(version), options.loadFields(version),
        options.loadDictionary(version).catch(() => ({})), options.loadCodeDescriptions(version), options.loadEicNames(), loadLocalDictionary(),
      ]);
      if (job !== revision) return;
      const schema = catalog?.schemas?.[metadata.schemaKey];
      const [rootType, schemaFields] = fields?.schemas?.[schema?.[0]] ?? [];
      const definitions = { rootType, groups: { ...fields?.technical, ...schemaFields }, enums: fields?.enums ?? {},
        codes, descriptions: descriptions ?? {}, parties: parties ?? {}, localDictionary };
      const data = businessView(root, metadata, catalog, definitions);
      const relatedJob = Promise.allSettled((demoLinks[sample] ?? []).map(async ([id, relation, reason]) => {
        const linked = readMessage(await loadSample(id));
        return { ...timelineEntry(linked, messageMetadata(linked), catalog, definitions.codes, localDictionary.ppe),
          href: sampleHash(id), relation, reason };
      }));
      const archiveJob = usesLocalArchive && !sample ? Promise.all([
        historyData ? Promise.resolve(historyData) : listArchive(),
        archiveFileHash || digestOf(bytes || await original.arrayBuffer()),
      ]).then(([archive, digest]) => ({ archive, digest })).catch(error => ({ error: 'Historia archiwum niedostępna. ' + error.message })) : Promise.resolve({});
      let validation = { state: catalog ? 'unknown' : 'unavailable' };
      if (schema) {
        const schemaXml = new XMLSerializer().serializeToString(root);
        validation = await import('./xsd.mjs').then(({ validateAgainstXsd }) =>
          validateAgainstXsd(schemaXml, version, async path => {
            const response = await fetch(new URL('./data/' + path, import.meta.url));
            if (!response.ok) throw new Error('Nie udało się pobrać schematu.');
            return new Uint8Array(await response.arrayBuffer());
          }, schema[0])).catch(() => ({ state: 'unavailable' }));
      }
      const [related, archiveState] = await Promise.all([relatedJob, archiveJob]);
      if (job !== revision) return;
      const history = [{ ...timelineEntry(root, metadata, catalog, definitions.codes, localDictionary.ppe),
        current: true, relation: 'Otwarty komunikat' }];
      for (const result of related) {
        if (result.status === 'fulfilled') history.push(result.value);
      }
      let archiveContext = [];
      let gaps = [];
      if (archiveState.archive) {
        const current = historyMetadata(root, metadata);
        const connected = caseHistory(current, archiveState.archive.items, archiveState.digest);
        const byId = new Map(Object.entries(catalog?.schemas ?? {}).map(([, [file, name]]) =>
          [file.replace(/\.xsd$/, '').replaceAll('_', '.'), name.replace(/^\d+(?:\.\d+)+\.?\s+/, '')]));
        const archivedRow = ({ item, reason }, uncertain = false) => ({
          timestamp: item.timestamp || item.modified, type: item.type, number: item.unk,
          name: item.type === 'R_9' ? item.unk === '6.1.1.2' ? 'Wynik przekazania profilu dobowego'
            : 'Wynik operacji masowej' : byId.get(item.unk) || catalog?.labels?.[item.type] || item.type || 'Komunikat CSIRE',
          summary: [STATUS[item.status]?.title || item.status, item.codes?.join(', ')].filter(Boolean).join(' · '),
          relation: uncertain ? 'Możliwe powiązanie'
            : /identyfikator transakcji|wskazuje ID komunikatu/.test(reason) && current.unk === '6.1.1.2' && item.unk === '6.1.1.1' ? 'Zgłoszenie źródłowe'
            : /identyfikator transakcji|wskazuje ID komunikatu/.test(reason) && current.unk === '6.1.1.1' && item.unk === '6.1.1.2' ? 'Odpowiedź na to zgłoszenie'
            : 'Powiązany komunikat',
          reason, href: archiveHash(item.name),
          details: [['Identyfikator komunikatu', item.messageId && `${code(item.messageId)} <button type="button" class="w-copy">Kopiuj</button>`],
            ['Punkty pomiarowe', item.points?.map(point => namedCode(point, localDictionary.ppe)).join(', ')],
            ['Obiekty', item.objects?.map(point => namedCode(point, localDictionary.ppe)).join(', ')],
            ['Kody', item.codes?.map(value => coded(value, definitions.codes)).join(', ')]],
        });
        history.push(...connected.timeline.filter(row => !row.current).map(row => archivedRow(row)));
        archiveContext = connected.context.map(row => archivedRow(row, true));
        gaps = connected.gaps;
        if (archiveState.archive.skipped) gaps.push('Pominięte pliki XML · ' + archiveState.archive.skipped);
      }
      const chronological = ({ timestamp }) => Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : Infinity;
      history.sort((a, b) => chronological(a) - chronological(b));
      const historyIncomplete = related.some(result => result.status === 'rejected');
      drawReport(output, data, { root, metadata, xml, sample, archived, history, historyIncomplete,
        archiveContext, gaps, archiveState },
        catalog, schema, definitions, validation, version, options.xmlFields);
      showIntake(false);
      feedback.textContent = file ? 'Wczytano ' + file.name : '';
      saveData = original;
      savedHeaders = ['valid', 'invalid'].includes(validation.state)
        ? { 'X-CSIRE-TSKB': version, 'X-CSIRE-XSD': validation.state } : {};
      if (focus && panel.isConnected && !panel.closest('[hidden]') && (!sample || location.hash === sampleHash(sample))) {
        output.querySelector('#design-title').focus();
      }
    } catch (error) {
      if (job === revision) {
        showIntake(true);
        feedback.textContent = error.message;
      }
    }
  };
  function openSample(id, focus) {
    const sample = samples.has(id) ? id : selection?.sample;
    const hash = sample ? sampleHash(sample) : selection?.archive ? archiveHash(selection.archive) : '#analiza';
    if (location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
    if (!sample || sample === selection?.sample) return;
    configRequest++;
    selection = { sample };
    void read({ sample, focus });
  }

  function openInput(data) {
    ++configRequest;
    selection = {};
    window.history.replaceState(window.history.state, '', '#analiza');
    if (data.file) editor.value = '';
    void read(data);
  }

  async function openArchive(name, focus) {
    if (selection?.archive === name && (activeInput?.archived || feedback.textContent === 'Odczytuję komunikat z archiwum…')) return;
    const job = ++configRequest;
    ++revision;
    selection = { archive: name };
    feedback.textContent = 'Odczytuję komunikat z archiwum…';
    output.replaceChildren();
    try {
      const [file, index] = await Promise.all([readArchivedFile(name), listArchive().catch(() => null)]);
      if (job !== configRequest || location.hash !== archiveHash(name)) return;
      const entry = index?.items.find(item => item.name === name);
      const archiveFileHash = await digestOf(await file.arrayBuffer());
      if (job !== configRequest || location.hash !== archiveHash(name)) return;
      const saved = entry?.digest === archiveFileHash ? entry.checks?.[0]?.edition : '';
      if (Object.hasOwn(EDITIONS, saved)) edition.value = saved;
      await read({ file, archived: true, focus, historyData: index, archiveFileHash });
    } catch (error) {
      if (job === configRequest) {
        selection = {};
        showIntake(true);
        feedback.textContent = error.message;
      }
    }
  }

  async function sampleArchive() {
    const catalog = await options.loadCatalog('04');
    const entries = await Promise.all(Array.from(samples, async sample => {
      const root = readMessage(await loadSample(sample));
      const metadata = messageMetadata(root);
      return { ...historyMetadata(root, metadata), title: timelineEntry(root, metadata, catalog, {}).name, sample };
    }));
    return entries.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }

  panel.querySelector('#warm-open-file').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (file) openInput({ file, focus: !intake.hidden });
  });
  panel.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  panel.addEventListener('drop', event => {
    const files = event.dataTransfer.files;
    if (!files.length) return;
    event.preventDefault();
    if (files.length === 1) openInput({ file: files[0], focus: !intake.hidden });
    else feedback.textContent = 'Upuść jeden plik XML.';
  });
  paste.addEventListener('submit', event => {
    event.preventDefault();
    if (!editor.value.trim()) {
      feedback.textContent = 'Wklej treść komunikatu XML.';
      editor.focus();
      return;
    }
    openInput({ text: editor.value, focus: !intake.hidden });
  });
  async function saveMessage(button) {
    if (button.disabled || !saveData) return;
    const pending = revision;
    const saveStatus = button.closest('.w-save').querySelector('[role="status"]');
    button.disabled = true;
    saveStatus.textContent = 'Zapisuję komunikat…';
    try {
      const response = await archiveFetch('', { method: 'POST', body: saveData, headers: savedHeaders });
      const result = await response.json();
      if (pending === revision) {
        saveStatus.textContent = result.added ? 'Komunikat zapisany w archiwum.' : 'Ten plik jest już w archiwum.';
        if (result.editionSaved === false) saveStatus.textContent += ' Zapis informacji o TSKB się nie powiódł.';
        button.hidden = true;
      }
    } catch (error) {
      if (pending === revision) saveStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  output.addEventListener('click', async event => {
    if (event.target.closest('[data-next-message]')) {
      ++revision;
      ++configRequest;
      selection = activeInput = saveData = savedHeaders = undefined;
      editor.value = input.value = '';
      feedback.textContent = '';
      output.replaceChildren();
      window.history.replaceState(window.history.state, '', '#analiza');
      showIntake(true);
      editor.focus();
      return;
    }
    const saveButton = event.target.closest('[data-save-message]');
    if (saveButton) {
      await saveMessage(saveButton);
      return;
    }
    if (event.target.closest('[data-refresh-case]')) {
      await read(activeInput);
      return;
    }
    if (event.target.closest('[data-download-xml]')) {
      downloadBlob(activeInput.file?.name || 'komunikat-csire.xml', saveData);
      return;
    }
    const copy = event.target.closest('.w-copy');
    if (copy) {
      const status = output.querySelector('.w-copy-status');
      try {
        await navigator.clipboard.writeText(copy.previousElementSibling.textContent);
        status.textContent = 'Skopiowano identyfikator komunikatu.';
      } catch {
        status.textContent = 'Skopiuj identyfikator ręcznie.';
      }
      return;
    }
  });
  return { panel, openSample, openArchive, sampleArchive };
}
