"""Refresh the offline lookup from the public PSE registers."""

import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen


EIC_SOURCE = "https://www.pse.pl/web/pse-eng/eic-code-list"
CSIRE_SOURCE = "https://www.pse.pl/lista-podmiotow-csire"
PARTY_CODE = re.compile(r"\d{2}X[A-Z0-9-]{13}")
TARGET = Path(__file__).resolve().parents[1] / "dist" / "data" / "eic" / "podmioty.json"


class Rows(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in {"th", "td"} and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in {"th", "td"} and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
            self.cell = None


def load_register(url, saved_html, code_header, name_header):
    if saved_html:
        html = saved_html.read_text(encoding="utf-8")
    else:
        with urlopen(url, timeout=30) as response:
            html = response.read().decode("utf-8")
    parser = Rows()
    parser.feed(html)
    code_column = name_column = None
    parties = {}
    for row in parser.rows:
        if code_header in row and name_header in row:
            code_column, name_column = row.index(code_header), row.index(name_header)
        elif code_column is not None and len(row) > max(code_column, name_column):
            code, name = row[code_column].upper(), row[name_column]
            if PARTY_CODE.fullmatch(code) and name:
                parties.setdefault(code, name)
    if not parties:
        raise RuntimeError(f"Nie znaleziono kodów podmiotów w {url}.")
    return parties


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eic-html", type=Path)
    parser.add_argument("--csire-html", type=Path)
    args = parser.parse_args()
    eic = load_register(EIC_SOURCE, args.eic_html, "EIC Code", "EIC Name")
    csire = load_register(CSIRE_SOURCE, args.csire_html, "Kod EIC", "Nazwa")
    parties = {**eic, **csire}
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(dict(sorted(parties.items())), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Zapisano {len(parties)} podmiotów, w tym {len(csire)} z listy CSIRE.")


if __name__ == "__main__":
    main()
