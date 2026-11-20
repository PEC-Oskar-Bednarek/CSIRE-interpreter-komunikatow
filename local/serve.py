"""Run the interpreter on one workstation with a shared XML archive."""

import argparse
import codecs
import hashlib
import json
import os
import re
import shutil
import webbrowser
import xml.etree.ElementTree as ET
from contextlib import suppress
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from archive_index import ArchiveFileChanged, ArchiveIndex, local_cache_dir, signature, write_atomic
from archive_register import MIME, archive_xlsx
from local_dictionary import ensure_dictionary, load_dictionary

# Podaj dokładną ścieżkę do archiwum, np. r"Z:\Interpreter CSIRE\Archiwum".
# None oznacza folder Archiwum obok folderu aplikacji.
ARCHIVE_FOLDER = None

PROJECT = Path(__file__).resolve().parent
ASSETS = PROJECT / "dist"
if not ASSETS.is_dir():
    ASSETS = PROJECT.parent / "dist"
MAX_BYTES = 25_000_000
CHECKS_FOLDER = ".csire-tskb"
CHECK_FILENAME = re.compile(r"([0-9a-f]{64})\.(04|05)\.(valid|invalid)\.json")
NS = "urn:pl:oire:"
TECH = "{urn:pl:oire:technical:v1}"
SOAP_NAMESPACES = {
    "http://schemas.xmlsoap.org/soap/envelope/",
    "http://www.w3.org/2003/05/soap-envelope",
    "http://www.w3.org/2003/05/soap-envelope/",  # Previously accepted by the archive.
}


def split_tag(node):
    if node.tag.startswith("{"):
        return node.tag[1:].split("}", 1)
    return "", node.tag


class ArchiveMessageError(ValueError):
    pass


XML_ENCODING = re.compile(rb"""^\s*<\?xml\s[^>]*?\bencoding\s*=\s*(['"])([a-z0-9._-]+)\1""", re.I)
MESSAGE_NAMESPACE = re.compile(r"urn:pl:oire:(?:unk_|message_)[^:]+:v[^:]+", re.I)
ENCODING_ALIASES = {
    "unicode-1-1-utf-8": "utf-8", "unicode11utf8": "utf-8", "unicode20utf8": "utf-8",
    "x-unicode20utf8": "utf-8", "utf-16": "utf-16-le", "utf-16le": "utf-16-le",
    "utf-16be": "utf-16-be", "x-cp1250": "cp1250", "x-cp1252": "cp1252",
}
BROWSER_CODECS = {
    "utf-8", "utf-16-le", "utf-16-be", "cp866", "koi8-r", "koi8-u", "mac-roman",
    "mac-cyrillic", "cp874", "gbk", "gb18030", "big5", "euc_jp", "iso2022_jp", "shift_jis", "euc_kr",
    *(f"cp125{number}" for number in range(9)),
    *(f"iso8859-{number}" for number in (2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 15, 16)),
}


def archive_xml_text(data):
    if data.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif data.startswith(b"<\x00"):
        encoding = "utf-16-le"
    elif data.startswith(b"\x00<"):
        encoding = "utf-16-be"
    else:
        declared = XML_ENCODING.match(data[:300])
        label = declared[2].decode("ascii").lower() if declared else "utf-8"
        try:
            encoding = codecs.lookup(ENCODING_ALIASES.get(label, label)).name
        except LookupError:
            raise ArchiveMessageError(f"Archiwum nie rozpoznaje kodowania XML ({label}).") from None
        if encoding in {"ascii", "iso8859-1"}:
            encoding = "cp1252"
        if encoding not in BROWSER_CODECS:
            raise ArchiveMessageError(f"Archiwum nie obsługuje kodowania XML ({label}).")
    try:
        return data.decode(encoding).strip()
    except UnicodeError:
        raise ArchiveMessageError("Znaki w pliku nie odpowiadają zadeklarowanemu kodowaniu XML.") from None


def message_info(data):
    xml = archive_xml_text(data)
    if re.search(r"<!DOCTYPE\b", xml, re.I):
        raise ArchiveMessageError("Archiwum przyjmuje XML bez deklaracji DOCTYPE.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        line, column = error.position
        raise ArchiveMessageError(f"Archiwum nie może odczytać składni XML (wiersz {line}, kolumna {column + 1}).") from None

    def is_message(node):
        namespace, _ = split_tag(node)
        return bool(MESSAGE_NAMESPACE.fullmatch(namespace)) or (
            namespace.startswith(NS) and node.find(f"{{{namespace}}}Header") is not None
        )

    space, name = split_tag(root)
    if space in SOAP_NAMESPACES and name == "Envelope":
        body = root.find(f"{{{space}}}Body")
        messages = []

        pending = list(body) if body is not None else []
        while pending:
            candidate = pending.pop()
            if is_message(candidate):
                messages.append(candidate)
            else:
                pending.extend(candidate)
        if len(messages) != 1:
            raise ArchiveMessageError("Koperta SOAP powinna zawierać jeden komunikat CSIRE.")
        root = messages[0]
    if not is_message(root):
        raise ArchiveMessageError("Zawartość pliku nie jest rozpoznanym komunikatem CSIRE.")
    namespace, name = split_tag(root)
    message_ns = "{" + namespace + "}"

    def field(section, key):
        return root.findtext(f"{message_ns}{section}/{TECH}{key}", "").strip()

    indexes = {
        "points": "MeteringPointCode",
        "processIds": "ProcessInstanceId",
        "transactions": "ReferenceTransactionId",
        "correctedTransactions": "CorrectedReferenceTransactionId",
        "statuses": "BatchOperationResult",
        "codes": {"ErrorCode", "ResultCode"},
        "objects": "FacilityIdentifier",
    }
    values = {key: set() for key in indexes}
    for item in root.iter():
        _, tag = split_tag(item)
        value = (item.text or "").strip()
        if not value:
            continue
        for key, wanted in indexes.items():
            if tag == wanted or isinstance(wanted, set) and tag in wanted:
                values[key].add(value)

    correction_links = []
    for record in root.iter():
        transaction = record.findtext(message_ns + "ReferenceTransactionId", "").strip()
        if transaction:
            correction_links.extend(
                [transaction, original.text.strip()]
                for original in record.iter(message_ns + "CorrectedReferenceTransactionId")
                if original.text and original.text.strip()
            )

    unk = field("ProcessEnergyContext", "BusinessProcessMessageType").rstrip(".")
    profiles = []
    if unk == "6.1.1.1":
        for record in root.iter(message_ns + "DailyMeteringPointMeasurements"):
            transaction = record.findtext(message_ns + "ReferenceTransactionId", "").strip()
            identity = next(
                (node.text.strip() for node in record.iter()
                 if node.tag in {message_ns + "MeteringPointCode", message_ns + "FacilityIdentifier"}
                 and node.text and node.text.strip()), ""
            )
            for basic in record.iter(message_ns + "BasicData"):
                profiles.append({
                    "transaction": transaction, "identity": identity,
                    "start": basic.findtext(message_ns + "PeriodStart", "").strip(),
                    "end": basic.findtext(message_ns + "PeriodEnd", "").strip(),
                    "version": basic.findtext(message_ns + "DataVersionNumber", "").strip(),
                    "products": sorted({node.text.strip() for node in basic.iter(message_ns + "ProductType")
                                        if node.text and node.text.strip()}),
                })

    return {
        "type": field("Header", "MessageType") or name,
        "unk": unk,
        "profiles": profiles,
        "messageId": field("Header", "MessageId"),
        "respondsTo": field("Header", "SenderMessageId"),
        "correctionLinks": correction_links,
        "status": next(iter(values.pop("statuses")), ""),
        "timestamp": field("Header", "MessageTimestamp"),
        **{key: sorted(found) for key, found in values.items()},
    }


class ArchiveUnavailable(OSError):
    pass


class Archive:
    def __init__(self, folder, cache_directory=None):
        self.folder = folder
        self.index = ArchiveIndex(cache_directory)

    def available_folder(self):
        try:
            folder = self.folder.resolve()
            if folder == ASSETS or ASSETS in folder.parents:
                raise ArchiveUnavailable("Wskaż folder archiwum poza katalogiem dist.")
            if not folder.is_dir():
                self.folder.mkdir(exist_ok=True)
            if folder.is_dir():
                return folder
        except ArchiveUnavailable:
            raise
        except (OSError, RuntimeError, ValueError):
            pass
        raise ArchiveUnavailable("Folder archiwum jest niedostępny. Sprawdź ścieżkę, połączenie i uprawnienia.")

    def path(self, name):
        if not name or name in {".", ".."} or re.search(r"[/\\:\x00]", name):
            raise FileNotFoundError()
        path = self.available_folder() / name
        if path.suffix.lower() != ".xml" or path.is_symlink() or not path.is_file():
            raise FileNotFoundError()
        return path

    def read_entry(self, path, expected_signature):
        with path.open("rb") as source:
            before = os.fstat(source.fileno())
            data = source.read(MAX_BYTES + 1)
            after = os.fstat(source.fileno())
        # Windows and network shares can report different file IDs for paths
        # and open handles. Compare each signature using the same API.
        if signature(before) != signature(after) or signature(path.stat(follow_symlinks=False)) != expected_signature:
            raise ArchiveFileChanged()
        if len(data) > MAX_BYTES:
            return None, "Plik przekracza limit 25 MB."
        if len(data) != after.st_size or len(data) != expected_signature[0]:
            raise ArchiveFileChanged()
        try:
            item = {
                **message_info(data), "name": path.name,
                "digest": hashlib.sha256(data).hexdigest(),
                "modified": datetime.fromtimestamp(after.st_mtime, timezone.utc).isoformat(),
            }
        except ArchiveMessageError as error:
            return None, str(error)
        except (ValueError, ET.ParseError, LookupError, RecursionError):
            return None, "Nie udało się odczytać komunikatu XML."
        return item, ""

    def list_messages(self):
        folder = self.available_folder()
        items, skipped_files = self.index.scan(folder, self.read_entry)
        checks = self.validation_checks(folder)
        items = [{**item, "checks": checks.get(item["digest"], [])} for item in items]
        items.sort(key=lambda item: (item["timestamp"] or item["modified"], item["name"]), reverse=True)
        return {"folder": str(folder), "items": items, "skipped": len(skipped_files), "skippedFiles": skipped_files}

    def validation_checks(self, folder):
        found = {}
        directory = folder / CHECKS_FOLDER
        try:
            if directory.is_symlink():
                return {}
            with os.scandir(directory) as paths:
                for entry in paths:
                    match = CHECK_FILENAME.fullmatch(entry.name)
                    if not match or not entry.is_file(follow_symlinks=False):
                        continue
                    digest, edition, state = match.groups()
                    try:
                        modified = entry.stat(follow_symlinks=False).st_mtime
                    except OSError:
                        continue
                    entry_info = {
                        "edition": edition, "state": state,
                        "checkedAt": datetime.fromtimestamp(modified, timezone.utc).isoformat(),
                    }
                    editions = found.setdefault(digest, {})
                    if edition not in editions or entry_info["checkedAt"] > editions[edition]["checkedAt"]:
                        editions[edition] = entry_info
        except OSError:
            pass
        return {
            digest: sorted(editions.values(), key=lambda check: (check["checkedAt"], check["edition"]), reverse=True)
            for digest, editions in found.items()
        }

    def record_validation(self, name, edition, state):
        folder = self.available_folder() / CHECKS_FOLDER
        folder.mkdir(exist_ok=True)
        if folder.is_symlink():
            raise OSError("Folder informacji TSKB jest niedostępny.")
        digest = name.removesuffix(".xml")
        path = folder / f"{digest}.{edition}.{state}.json"
        if not CHECK_FILENAME.fullmatch(path.name):
            raise ValueError("Nieprawidłowy zapis walidacji.")
        write_atomic(path, json.dumps({
            "edition": edition, "state": state, "checkedAt": datetime.now(timezone.utc).isoformat(),
        }).encode("utf-8"))

    def save(self, data):
        message_info(data)
        name = hashlib.sha256(data).hexdigest() + ".xml"
        folder = self.available_folder()
        target = folder / name
        if target.exists() and not target.is_symlink():
            with target.open("rb") as existing:
                if existing.read(MAX_BYTES + 1) == data:
                    return name, False
            raise OSError("Plik o tej nazwie ma inną treść.")
        temporary = folder / f".csire-{uuid4().hex}.tmp"
        try:
            with temporary.open("xb") as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            # Windows rename rejects an existing destination. On POSIX, writers
            # replacing this name concurrently have the same content.
            try:
                if os.name == "nt":
                    temporary.rename(target)
                else:
                    os.replace(temporary, target)
            except OSError:
                if target.is_symlink() or not target.exists():
                    raise
                with target.open("rb") as existing:
                    if existing.read(MAX_BYTES + 1) != data:
                        raise
                return name, False
            return name, True
        finally:
            with suppress(FileNotFoundError):
                temporary.unlink()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}

    def __init__(self, *args, archive, dictionary, **kwargs):
        self.archive = archive
        self.dictionary = dictionary
        super().__init__(*args, directory=str(ASSETS), **kwargs)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def correct_host(self):
        return self.headers.get("Host") in {
            f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"
        }

    def do_GET(self):
        if not self.correct_host():
            self.send_error(403)
            return
        route = urlsplit(self.path).path
        if route == "/api/local-dictionary":
            self.send_json(load_dictionary(self.dictionary))
            return
        if route == "/api/archive.xlsx":
            try:
                body = archive_xlsx(self.archive.list_messages()["items"])
            except ArchiveUnavailable as error:
                self.send_json({"error": str(error)}, 503)
                return
            except OSError:
                self.send_json({"error": "Nie udało się odczytać folderu archiwum."}, 503)
                return
            self.send_response(200)
            self.send_header("Content-Type", MIME)
            self.send_header("Content-Disposition", 'attachment; filename="rejestr-csire.xlsx"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/api/archive":
            try:
                self.send_json(self.archive.list_messages())
            except ArchiveUnavailable as error:
                self.send_json({"error": str(error), "folder": str(self.archive.folder)}, 503)
            except OSError:
                self.send_json({"error": "Folder archiwum jest niedostępny.", "folder": str(self.archive.folder)}, 503)
        elif route.startswith("/api/archive/"):
            try:
                file = self.archive.path(unquote(route.removeprefix("/api/archive/"))).open("rb")
            except ArchiveUnavailable as error:
                self.send_json({"error": str(error)}, 503)
                return
            except FileNotFoundError:
                self.send_json({"error": "Plik jest niedostępny."}, 404)
                return
            except OSError:
                self.send_json({"error": "Nie udało się otworzyć pliku w archiwum."}, 503)
                return
            with file:
                size = os.fstat(file.fileno()).st_size
                if size > MAX_BYTES:
                    self.send_json({"error": "Plik przekracza 25 MB."}, 413)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                shutil.copyfileobj(file, self.wfile)
        else:
            super().do_GET()

    def do_POST(self):
        if not self.correct_host() or self.headers.get("Origin") != "http://" + self.headers["Host"]:
            self.send_json({"error": "Zapis wymaga otwarcia aplikacji lokalnie."}, 403)
            return
        if self.path != "/api/archive":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BYTES:
            self.send_json({"error": "Wybierz plik XML do 25 MB."}, 413)
            return
        edition = self.headers.get("X-CSIRE-TSKB")
        state = self.headers.get("X-CSIRE-XSD")
        if (edition is not None or state is not None) and (edition not in {"04", "05"} or state not in {"valid", "invalid"}):
            self.send_json({"error": "Nieprawidłowa wersja TSKB lub wynik walidacji."}, 400)
            return
        try:
            data = self.rfile.read(length)
            if len(data) != length:
                raise ArchiveMessageError("Otrzymano niepełny plik.")
            name, added = self.archive.save(data)
            payload = {"name": name, "added": added}
            if edition is not None:
                try:
                    self.archive.record_validation(name, edition, state)
                    payload["editionSaved"] = True
                except OSError:
                    payload["editionSaved"] = False
            self.send_json(payload, 201 if added else 200)
        except ArchiveMessageError as error:
            self.send_json({"error": str(error)}, 400)
        except ArchiveUnavailable as error:
            self.send_json({"error": str(error)}, 503)
        except OSError:
            self.send_json({"error": "Nie udało się zapisać w folderze. Sprawdź połączenie i uprawnienia."}, 503)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, metavar="FOLDER", help="Folder nadrzędny, w którym aplikacja użyje lub utworzy Archiwum")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="Otwórz aplikację w domyślnej przeglądarce")
    args = parser.parse_args()
    if args.archive is not None:
        folder = args.archive.expanduser().absolute() / "Archiwum"
    elif ARCHIVE_FOLDER is None:
        folder = PROJECT.parent / "Archiwum"
    else:
        folder = PROJECT.parent / Path(ARCHIVE_FOLDER).expanduser()
    archive = Archive(folder, local_cache_dir())
    dictionary = PROJECT.parent / "Słownik.xlsx"
    handler = partial(Handler, archive=archive, dictionary=dictionary)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        with suppress(ArchiveUnavailable):
            archive.available_folder()
        with suppress(OSError):
            ensure_dictionary(dictionary)
        url = f"http://127.0.0.1:{server.server_port}/"
        print(f"Interpretator CSIRE · {url}", flush=True)
        print(f"Archiwum · {archive.folder}", flush=True)
        if args.open:
            with suppress(OSError, webbrowser.Error):
                webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
