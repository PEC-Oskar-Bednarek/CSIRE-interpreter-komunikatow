import { EDITIONS, searchText, STATUS } from './analysis.mjs';
import { downloadBlob, h, pager, table } from './ui.mjs?v=strony-slownika';
import { loadLocalDictionary, localName } from './local-dictionary.mjs';

export const usesLocalArchive = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
export const archiveHash = name => '#analiza/archiwum/' + encodeURIComponent(name);

export async function archiveFetch(path = '', options) {
  let response;
  try {
    response = await fetch('/api/archive' + path, { ...options, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'Archiwum nie odpowiedziało w porę.' : 'Nie udało się połączyć z archiwum.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'Nie udało się otworzyć archiwum.');
    error.archiveFolder = payload.folder;
    throw error;
  }
  return response;
}

export async function readArchivedFile(name) {
  const response = await archiveFetch('/' + encodeURIComponent(name));
  return new File([await response.blob()], name, { type: 'application/xml' });
}

export async function listArchive() {
  return (await archiveFetch()).json();
}

const date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

function validations(item) {
  return (item.checks ?? []).filter(check => Object.hasOwn(EDITIONS, check.edition)).map(check =>
    EDITIONS[check.edition].name + ' · ' + (check.state === 'valid' ? 'zgodny z XSD' : 'błędy XSD')).join(' / ');
}

function columns(item) {
  return [
    item.timestamp || item.modified, item.type, item.unk, item.title, item.points?.join(', '), item.objects?.join(', '),
    item.status, item.codes?.join(', '), item.messageId, item.processIds?.join(', '), item.transactions?.join(', '),
    item.respondsTo, item.correctedTransactions?.join(', '), validations(item), usesLocalArchive ? item.name : '',
  ].map(value => value ?? '');
}

const headings = ['Czas', 'Typ', 'UNK', 'Nazwa', 'Punkty pomiarowe', 'Obiekty', 'Wynik', 'Kody', 'ID komunikatu',
  'Instancje procesu', 'Transakcje', 'Odpowiedź na ID komunikatu', 'Korygowane transakcje', 'TSKB i wynik walidacji', 'Plik XML'];
const csvCell = value => '"' + (/^\s*[=+\-@]|^[\t\r\n]/.test(value) ? "'" : '') + value.replaceAll('"','""') + '"';

export function mountArchive({ examples, exampleHash }) {
  const $ = id => document.getElementById(id);
  const target = $('archive-results');
  const status = $('archive-status');
  const details = $('archive-skipped-details');
  const skipped = $('archive-skipped-files');
  const search = $('archive-query');
  const csv = $('archive-export');
  const excel = $('archive-excel');
  const refresh = $('archive-refresh');
  const locationLabel = $('archive-location');
  const locationPath = locationLabel.querySelector('code');
  let items = [];
  let visible = [];
  let page = 1;
  let revision = 0;
  let dictionary = {};
  $('archive-context').textContent = usesLocalArchive ? 'Komunikaty XML ze wspólnego folderu.' : 'Komunikaty z przykładowego archiwum.';
  excel.hidden = refresh.hidden = !usesLocalArchive;

  function showFolder(folder) {
    locationPath.textContent = folder || '';
    locationLabel.hidden = !folder;
  }

  function pointNames(item) {
    return [...(item.points ?? []), ...(item.objects ?? [])].map(value => {
      const label = localName(dictionary.ppe, value);
      return label ? `${value} · ${label}` : value;
    }).join(', ');
  }

  function render() {
    const words = searchText(search.value).split(/\s+/).filter(Boolean);
    visible = items.filter(item => {
      const text = searchText(columns(item).join(' ') + ' ' + pointNames(item));
      return words.every(word => text.includes(word));
    });
    csv.disabled = !visible.length;
    const size = 10;
    const rows = visible.slice((page - 1) * size, page * size).map(item => {
      const time = item.timestamp || item.modified || '';
      const result = STATUS[item.status]?.title || item.status;
      const action = h('a', 'archive-open', 'Otwórz komunikat →');
      action.href = usesLocalArchive ? archiveHash(item.name) : exampleHash(item.sample);
      const message = h('td');
      message.append(h('strong', '', item.title || item.type || 'Komunikat CSIRE'),
        h('small', 'glossary-context', [item.type && item.title && item.type, item.unk].filter(Boolean).join(' · ')));
      const operations = h('td');
      operations.append(action);
      return [h('td', '', Number.isFinite(Date.parse(time)) ? date.format(new Date(time)) : time || '—'), message,
        h('td', '', pointNames(item) || '—'),
        h('td', '', [result, ...(item.codes ?? [])].filter(Boolean).join(' · ') || '—'), operations];
    });
    const content = rows.length
      ? table(['Data i godzina', 'Komunikat', 'Punkt / obiekt', 'Wynik i kody', ''], rows)
      : h('p', 'no-records', 'Brak komunikatów do wyświetlenia.');
    target.replaceChildren(content, pager(page, visible.length, size,
      next => { page = next; render(); }, 'komunikatów', {alwaysShowControls: true}));
  }

  async function load() {
    const job = ++revision;
    details.hidden = true;
    details.open = false;
    skipped.replaceChildren();
    status.textContent = 'Odczytuję archiwum…';
    target.replaceChildren();
    items = [];
    visible = [];
    csv.disabled = excel.disabled = true;
    try {
      const [result, names] = await Promise.all([
        usesLocalArchive ? listArchive() : examples().then(items => ({ items })),
        loadLocalDictionary(),
      ]);
      if (job !== revision) return;
      items = result.items;
      dictionary = names;
      showFolder(result.folder);
      page = 1;
      excel.disabled = !items.length;
      status.textContent = result.skipped ? 'Pominięte pliki XML · ' + result.skipped : '';
      for (const file of result.skippedFiles ?? []) skipped.append(h('li', '', file.name + ' · ' + file.reason));
      details.hidden = !skipped.childElementCount;
      render();
    } catch (error) {
      if (job === revision) {
        if (error.archiveFolder) showFolder(error.archiveFolder);
        status.textContent = error.message;
      }
    }
  }

  search.addEventListener('input', () => { page = 1; render(); });
  refresh.addEventListener('click', () => void load());
  csv.addEventListener('click', () => {
    const rows = [headings, ...visible.map(columns)];
    const body = '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
    downloadBlob('csire-archiwum.csv', new Blob([body], { type: 'text/csv;charset=utf-8' }));
  });
  excel.addEventListener('click', async () => {
    excel.disabled = true;
    try {
      downloadBlob('rejestr-csire.xlsx', await (await archiveFetch('.xlsx')).blob());
    } catch (error) {
      status.textContent = error.message;
    } finally {
      excel.disabled = !items.length;
    }
  });
  return load;
}
