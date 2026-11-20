"""Create and read the editable PPE and meter workbook."""

import os
import posixpath
import re
from contextlib import suppress
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

from archive_register import NS, PACKAGE, REL, workbook_xlsx, worksheet


SHEETS = {"PPE": ("ppe", "Numer PPE"), "Liczniki": ("meters", "Numer licznika")}
MAIN = f"{{{NS}}}"


def ensure_dictionary(path):
    if path.exists():
        return
    data = workbook_xlsx([(name, worksheet([(header, "Opis / Nazwa")], [28, 62], text_columns=2))
                          for name, (_, header) in SHEETS.items()])
    temporary = path.with_name(f".csire-{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as file:
            file.write(data)
        try:
            if os.name == "nt":
                temporary.rename(path)
            else:
                os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        with suppress(FileNotFoundError):
            temporary.unlink()


def read_part(archive, name):
    if archive.getinfo(name).file_size > 25_000_000:
        raise ValueError("Part too large")
    return ET.fromstring(archive.read(name))


def rich_text(element):
    return "".join(node.text or "" for node in element.findall(f"{MAIN}t") + element.findall(f"{MAIN}r/{MAIN}t"))


def cell_text(cell, shared):
    kind = cell.get("t", "n")
    if cell.find(f"{MAIN}f") is not None:
        return ""
    if kind == "inlineStr":
        inline = cell.find(f"{MAIN}is")
        return rich_text(inline).strip() if inline is not None else ""
    value = cell.findtext(f"{MAIN}v", "").strip()
    if kind == "s" and value.isdecimal():
        index = int(value)
        return shared[index].strip() if index < len(shared) else ""
    return value if kind == "str" or kind == "n" and re.fullmatch(r"[0-9]{1,15}", value) else ""


def workbook_entries(path):
    with ZipFile(path) as archive:
        workbook = read_part(archive, "xl/workbook.xml")
        relationships = read_part(archive, "xl/_rels/workbook.xml.rels")
        files = {link.get("Id"): posixpath.normpath(posixpath.join("xl", link.get("Target"))).lstrip("/")
                 for link in relationships.findall(f"{{{PACKAGE}}}Relationship") if link.get("Target")}
        shared_path = next((files[link.get("Id")] for link in relationships
                            if link.get("Type", "").endswith("/sharedStrings")), None)
        shared = [rich_text(node) for node in read_part(archive, shared_path)] if shared_path else []
        sheets = {sheet.get("name"): files.get(sheet.get(f"{{{REL}}}id"))
                  for sheet in workbook.findall(f"{MAIN}sheets/{MAIN}sheet")}
        entries = {}
        for sheet, (key, _) in SHEETS.items():
            if not sheets.get(sheet):
                raise ValueError(f"Missing worksheet {sheet}")
            rows = read_part(archive, sheets[sheet]).findall(f"{MAIN}sheetData/{MAIN}row")
            names = {}
            for row in rows[1:]:
                cells = {cell.get("r", "").rstrip("0123456789"): cell_text(cell, shared) for cell in row}
                if cells.get("A") and cells.get("B"):
                    names[cells["A"]] = cells["B"]
            entries[key] = names
        return entries


def load_dictionary(path):
    try:
        ensure_dictionary(path)
        return {"path": str(path), **workbook_entries(path)}
    except (OSError, BadZipFile, ET.ParseError, ValueError, KeyError, RuntimeError):
        return {"path": str(path), "error": "Nie udało się odczytać słownika. Sprawdź plik Słownik.xlsx i jego zakładki PPE oraz Liczniki."}
