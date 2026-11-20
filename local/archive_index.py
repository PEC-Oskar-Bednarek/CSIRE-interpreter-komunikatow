"""Local, disposable cache for shared XML metadata."""

import hashlib
import json
import os
import stat
from contextlib import suppress
from pathlib import Path
from threading import Lock
from uuid import uuid4

INDEX_VERSION = 4


def write_atomic(path, data):
    temporary = path.parent / f".csire-{uuid4().hex}.tmp"
    try:
        with temporary.open("xb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        with suppress(FileNotFoundError):
            temporary.unlink()


def local_cache_dir():
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "CSIRE-Interpreter" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "csire-interpreter"


def signature(info):
    return [info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]


class ArchiveFileChanged(OSError):
    pass


def read_error_reason(error):
    if isinstance(error, ArchiveFileChanged):
        return "Plik zmienił się w trakcie skanowania. Odśwież archiwum."
    if getattr(error, "winerror", None) in {32, 33}:
        return "Plik jest zablokowany przez inny program. Odśwież archiwum po zwolnieniu blokady."
    if isinstance(error, PermissionError):
        return "Aplikacja nie ma uprawnień do odczytu tego pliku."
    if isinstance(error, FileNotFoundError):
        return "Plik stał się niedostępny w trakcie skanowania. Odśwież archiwum."
    code = getattr(error, "winerror", None) or error.errno
    reason = "Nie udało się odczytać pliku z folderu"
    return (f"{reason} (kod systemowy {code})." if code else reason + ".") + " Odśwież archiwum."


class ArchiveIndex:
    def __init__(self, cache_directory=None):
        self.cache_directory = cache_directory
        self._folder = None
        self._entries = {}
        self._lock = Lock()

    def _cache_file(self, folder):
        if self.cache_directory is None:
            return None
        key = hashlib.sha256(os.fsencode(os.path.normcase(folder))).hexdigest()
        return self.cache_directory / f"archive-{key}.json"

    def _open(self, folder, path):
        if self._folder == folder:
            return
        self._folder = folder
        self._entries = {}
        if path is None:
            return
        try:
            saved = json.loads(path.read_bytes())
            if saved["version"] == INDEX_VERSION and isinstance(saved["entries"], dict):
                self._entries = saved["entries"]
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def scan(self, folder, read_entry):
        with self._lock:
            cache_file = self._cache_file(folder)
            self._open(folder, cache_file)
            next_entries = {}
            items, skipped_files = [], []
            with os.scandir(folder) as paths:
                for path in paths:
                    if not path.name.lower().endswith(".xml"):
                        continue
                    try:
                        file = Path(path.path)
                        # DirEntry.stat may omit the inode on Windows, unlike fstat.
                        info = file.stat(follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            continue
                        stamp = signature(info)
                        previous = self._entries.get(path.name)
                        if isinstance(previous, dict) and previous.get("signature") == stamp and (
                            "item" in previous and (
                                (previous["item"] is None and isinstance(previous.get("error"), str))
                                or (
                                    isinstance(previous["item"], dict) and previous["item"].get("name") == path.name
                                    and isinstance(previous["item"].get("digest"), str)
                                )
                            )
                        ):
                            entry = previous
                        else:
                            item, error = read_entry(file, stamp)
                            entry = {"signature": stamp, "item": item, "error": error}
                        next_entries[path.name] = entry
                        if entry["item"] is not None:
                            items.append(entry["item"])
                        else:
                            skipped_files.append({"name": path.name, "reason": entry["error"]})
                    except OSError as error:
                        # A failed read is retried on the next refresh.
                        skipped_files.append({
                            "name": path.name, "reason": read_error_reason(error),
                        })
            if next_entries != self._entries:
                self._entries = next_entries
                if cache_file is not None:
                    with suppress(OSError):
                        cache_file.parent.mkdir(parents=True, exist_ok=True)
                        write_atomic(cache_file, json.dumps({
                            "version": INDEX_VERSION, "entries": next_entries,
                        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            skipped_files.sort(key=lambda file: file["name"].casefold())
            return items, skipped_files
