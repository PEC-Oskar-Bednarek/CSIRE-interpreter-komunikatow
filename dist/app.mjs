import { EDITIONS, searchText } from './analysis.mjs';
import { mountWarm, sampleHash } from './warm.mjs?v=slownik-wewnetrzny';
import { mountArchive, usesLocalArchive } from './archive-client.mjs?v=slownik-wewnetrzny';
import { h, pager, table } from './ui.mjs?v=strony-slownika';
import { loadLocalDictionary, localName } from './local-dictionary.mjs';

const $ = id => document.getElementById(id);
const dictEdition = $('dictionary-edition');
const glossaryButtons = $('glossary-groups').querySelectorAll('button[data-category]');
let activeGlossaryButton = $('glossary-groups').querySelector('[aria-pressed="true"]');
const glossaryCache = new Map();
let dictionaryPage = 1;

const catalogs = new Map();
const fieldCatalogs = new Map();
const codeDescriptions = new Map();
const eicCatalog = new Map();

function loadJson(version, filename, cache) {
  if (!cache.has(version)) {
    cache.set(version, fetch(new URL('./data/' + version + '/' + filename, import.meta.url))
      .then(response => {
        if (!response.ok) throw new Error('Katalog jest niedostępny.');
        return response.json();
      }).catch(() => {
        cache.delete(version);
        return null;
      }));
  }
  return cache.get(version);
}

const loadCatalog = version => loadJson(version, 'schemas.json', catalogs);
const loadFields = version => loadJson(version, 'fields.json', fieldCatalogs);
const loadCodeDescriptions = version => loadJson(version, 'opisy-kodow.json', codeDescriptions);
const loadEicNames = () => loadJson('eic', 'podmioty.json', eicCatalog);

function xmlFields(node, parentType, definitions) {
  const branch = h('details');
  const name = node.localName;
  const group = Object.hasOwn(definitions.groups, parentType) ? definitions.groups[parentType] : {};
  const [type, label, code] = Object.hasOwn(group, name) ? group[name] : [];
  const title = label ? label + ' · ' + name : name;
  branch.append(h('summary', '', title + (node.children.length ? ' · ' + node.children.length : '')));
  branch.addEventListener('toggle', () => {
    if (!branch.open || branch.childElementCount > 1) return;
    const body = h('div', 'xml-branch');
    if (code) body.append(h('p', 'xml-value', code));
    for (const attribute of node.attributes) {
      if (attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/') {
        body.append(h('p', 'xml-value', '@' + attribute.name + ' = ' + attribute.value));
      }
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) body.append(xmlFields(child, type, definitions));
      if ([3, 4].includes(child.nodeType) && child.nodeValue.trim()) {
        const value = child.nodeValue.trim();
        const values = Object.hasOwn(definitions.enums, type) ? definitions.enums[type] : {};
        const csire = node.namespaceURI?.startsWith('urn:pl:oire:');
        const names = csire && (name === 'MeterNumber' ? definitions.localDictionary.meters
          : ['MeteringPointCode', 'FacilityIdentifier'].includes(name) ? definitions.localDictionary.ppe : null);
        const explanation = ['ErrorCode', 'ResultCode'].includes(name) && Object.hasOwn(definitions.codes, value)
          ? definitions.codes[value]
          : type === 'EicIdentifierType' ? definitions.parties[value.toUpperCase()]
            : localName(names, value) || (Object.hasOwn(values, value) ? values[value] : '');
        const text = h('p', 'xml-value', value);
        if (explanation) text.append(h('span', 'xml-explanation', ' · ' + explanation));
        body.append(text);
      }
    }
    if (!body.childElementCount) body.append(h('p', 'xml-value', 'Puste pole'));
    branch.append(body);
  });
  return branch;
}

const codeCatalogs = new Map();
async function loadDictionary(version) {
  const result = await loadJson(version, 'kody.json', codeCatalogs);
  if (!result) throw new Error('Nie udało się wczytać słownika PSE.');
  return result;
}

const glossaryGroups = {
  types: 'Typ komunikatu', unk: 'Numer UNK', processes: 'Proces biznesowy',
  fields: 'Pole / sekcja XML', data: 'Typ danych XSD', values: 'Wartość słownikowa',
  CE: 'Błąd', CA: 'Akceptacja', CL: 'Przyczyna', anomalies: 'Anomalia',
};
const resultGroups = new Set(['CE', 'CA', 'CL', 'anomalies']);
const dictionarySort = new Intl.Collator('pl', {numeric: true});

function getGlossary(version) {
  if (!glossaryCache.has(version)) {
    const pending = Promise.all([
      fetch(new URL('./data/' + version + '/glossary.json', import.meta.url)).then(response => {
        if (!response.ok) throw new Error('Słownik TSKB jest niedostępny.');
        return response.json();
      }),
      loadDictionary(version), loadCodeDescriptions(version),
    ]).then(([glossary, codes, descriptions]) => {
      const codeRows = Object.entries(codes).map(([code, title]) => [code.slice(0, 2), code, title, '', descriptions?.[code] ?? '']);
      return [...glossary, ...codeRows].sort((a, b) => dictionarySort.compare(a[1], b[1]))
        .map(row => [row, searchText([...row, glossaryGroups[row[0]]].join(' '))]);
    }).catch(error => {
      glossaryCache.delete(version);
      throw error;
    });
    glossaryCache.set(version, pending);
  }
  return glossaryCache.get(version);
}

async function renderDictionary() {
  const version = dictEdition.value;
  const query = searchText($('code-query').value).split(/\s+/).filter(Boolean);
  const filter = activeGlossaryButton.dataset.category;
  const target = $('dictionary-results');
  const size = 10;
  const showResults = (content, count = 0) => {
    const navigation = pager(dictionaryPage, count, size, next => {
      dictionaryPage = next;
      void renderDictionary();
    }, 'wpisów', {alwaysShowControls: true});
    target.replaceChildren(content, navigation);
  };
  const scope = `${version}:${filter}`;
  if (target.dataset.scope !== scope) {
    target.dataset.scope = scope;
    showResults(h('p', 'no-records', 'Wczytywanie wpisów…'));
  }
  const key = [version, ...query, filter, dictionaryPage].join('|');
  target.dataset.query = key;
  $('dictionary-source').href = resultGroups.has(filter)
    ? EDITIONS[version].codes : 'https://www.pse.pl/oire/standardy-biznesowe';
  try {
    const glossary = await getGlossary(version);
    if (target.dataset.query !== key) return;
    const entries = glossary.filter(([[group], text]) => group === filter && query.every(word => text.includes(word)));
    const page = dictionaryPage;
    const rows = entries.slice((page - 1) * size, page * size).map(([[group, code, title, context, explanation]]) => {
      const cell = h('td');
      const tone = group === 'CE' ? 'error' : group === 'CA' ? 'ok' : 'neutral';
      cell.append(h('code', 'code-pill tone-' + tone, code));
      const description = h('td', '', title || '—');
      if (context) description.append(h('small', 'glossary-context', context));
      if (resultGroups.has(group) && explanation) {
        const details = h('details', 'glossary-description');
        details.append(h('summary', '', 'Objaśnienie PSE'), h('p', '', explanation));
        description.append(details);
      }
      return [cell, description];
    });
    if (!rows.length) {
      const empty = h('td', '', 'Brak wpisów pasujących do wyszukiwania.');
      empty.colSpan = 2;
      rows.push([empty]);
    }
    showResults(table(['Kod / identyfikator', 'Nazwa i opis'], rows), entries.length);
  } catch (error) {
    if (target.dataset.query === key) showResults(h('p', 'no-records', error.message));
  }
}

const report = mountWarm({ loadCatalog, loadFields, loadDictionary, loadCodeDescriptions, loadEicNames, xmlFields });
$('analysis-view').append(report.panel);
const loadArchive = mountArchive({ examples: report.sampleArchive, exampleHash: sampleHash });

async function showLocalDictionary() {
  if (!usesLocalArchive) return;
  const result = await loadLocalDictionary();
  $('local-dictionary').hidden = false;
  $('local-dictionary-path').textContent = result.path || 'Słownik.xlsx';
  $('local-dictionary-status').textContent = result.error ||
    'Uzupełnij arkusze PPE i Liczniki, zapisz plik, a potem odśwież Archiwum lub Historię sprawy.';
}

const themeSwitch = $('theme-switch');
const themeKey = 'csire-interpreter-theme';
function theme(value) {
  const dark = value === 'finansowy';
  document.body.dataset.design = dark ? 'finansowy' : 'cieply';
  themeSwitch.setAttribute('aria-checked', String(dark));
  themeSwitch.title = dark ? 'Przełącz na motyw ciepły' : 'Przełącz na motyw finansowy';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0b1114' : '#fcf8f0';
}
try { theme(window.localStorage.getItem(themeKey)); } catch { theme('cieply'); }
themeSwitch.addEventListener('click', () => {
  const next = document.body.dataset.design === 'finansowy' ? 'cieply' : 'finansowy';
  theme(next);
  try { window.localStorage.setItem(themeKey, next); } catch {}
});

function openView() {
  const route = location.hash.slice(1);
  const active = route === 'slownik' ? 'slownik' : ['archiwum', 'historia'].includes(route) ? 'archiwum' : 'analiza';
  const inAnalysis = !$('analysis-view').hidden;
  $('analysis-view').hidden = active !== 'analiza';
  $('archive-view').hidden = active !== 'archiwum';
  $('dictionary-view').hidden = active !== 'slownik';
  for (const link of document.querySelectorAll('.main-nav a')) {
    if (link.hash === '#' + active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (active === 'archiwum') { void loadArchive(); return; }
  if (active === 'slownik') { void renderDictionary(); void showLocalDictionary(); return; }
  if (route.startsWith('analiza/archiwum/') && usesLocalArchive) {
    try {
      const name = decodeURIComponent(route.slice('analiza/archiwum/'.length));
      if (name && !/[\/\\\x00]/.test(name) && name.toLowerCase().endsWith('.xml')) {
        void report.openArchive(name, true);
        return;
      }
    } catch {}
  }
  const sample = route.startsWith('analiza/przyklad/') ? route.slice('analiza/przyklad/'.length)
    : route.startsWith('cieply/') ? route.slice('cieply/'.length) : '';
  report.openSample(sample, !!sample && inAnalysis);
}

function refreshDictionary() {
  dictionaryPage = 1;
  void renderDictionary();
}
for (const button of glossaryButtons) {
  button.addEventListener('click', () => {
    if (activeGlossaryButton === button) return;
    activeGlossaryButton.setAttribute('aria-pressed', 'false');
    activeGlossaryButton = button;
    button.setAttribute('aria-pressed', 'true');
    $('glossary-category-title').textContent = button.textContent;
    refreshDictionary();
  });
}
$('code-query').addEventListener('input', refreshDictionary);
dictEdition.addEventListener('change', refreshDictionary);
document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  $('main').focus();
});
window.addEventListener('hashchange', openView);
openView();
