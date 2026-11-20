"""Export a filterable Excel register without converting identifiers into numbers."""

from io import BytesIO
import re
from itertools import chain
from xml.etree.ElementTree import Element, SubElement, tostring
from zipfile import ZipFile, ZIP_DEFLATED

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
INVALID_XML_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")

EDITION_NAMES = {"04": "TSKB/04/2025", "05": "TSKB/05/2026"}
VALIDATION_NAMES = {"valid": "zgodny z XSD", "invalid": "błędy XSD"}
HEADERS = [
    "Czas nadania", "Data pliku", "Typ", "UNK", "Status CSIRE", "Kody wyniku",
    "Punkt pomiarowy", "Obiekt", "ID komunikatu", "Odpowiedź na ID komunikatu",
    "Instancja procesu", "ID transakcji", "Korygowane transakcje", "TSKB i wynik walidacji", "Plik XML",
]


def editions_label(item):
    return " / ".join(
        f'{EDITION_NAMES[check["edition"]]} · {VALIDATION_NAMES[check["state"]]}'
        for check in item.get("checks", [])
    )


def register_row(item):
    return [
        item["timestamp"], item["modified"], item["type"], item["unk"], item["status"], ", ".join(item["codes"]),
        ", ".join(item["points"]), ", ".join(item["objects"]), item["messageId"], item["respondsTo"],
        ", ".join(item["processIds"]), ", ".join(item["transactions"]), ", ".join(item["correctedTransactions"]),
        editions_label(item), item["name"],
    ]


def archive_xlsx(items):
    return workbook_xlsx([("Rejestr CSIRE", worksheet(
        chain([HEADERS], map(register_row, items)),
        [29, 29, 13, 13, 18, 21, 26, 24, 39, 39, 39, 39, 39, 39, 67],
        filter_range=f"A1:O{len(items) + 1}",
    ))])


def worksheet(rows, widths, *, text_columns=0, filter_range=None):
    sheet = Element("worksheet", xmlns=NS)
    view = SubElement(SubElement(sheet, "sheetViews"), "sheetView", workbookViewId="0")
    SubElement(view, "pane", ySplit="1", topLeftCell="A2", activePane="bottomLeft", state="frozen")
    columns = SubElement(sheet, "cols")
    for index, width in enumerate(widths, 1):
        column = SubElement(columns, "col", min=str(index), max=str(index), width=str(width), customWidth="1")
        if index <= text_columns:
            column.set("style", "2")
    sheet_data = SubElement(sheet, "sheetData")
    for index, values in enumerate(rows, 1):
        row = SubElement(sheet_data, "row", r=str(index))
        for col, value in enumerate(values):
            cell = SubElement(row, "c", r=chr(65 + col) + str(index), t="inlineStr")
            if index == 1:
                cell.set("s", "1")
            text = SubElement(SubElement(cell, "is"), "t", {"xml:space": "preserve"})
            value = INVALID_XML_CHARACTERS.sub("�", value)
            text.text = value if len(value) <= 32767 else value[:32766] + "…"
    if filter_range:
        SubElement(sheet, "autoFilter", ref=filter_range)
    return sheet


def workbook_xlsx(worksheets):
    workbook = Element("workbook", {"xmlns": NS, "xmlns:r": REL})
    sheets = SubElement(workbook, "sheets")
    workbook_links = Element("Relationships", xmlns=PACKAGE)
    sheet_types = []
    for index, (name, sheet) in enumerate(worksheets, 1):
        relationship = f"rId{index}"
        filename = f"worksheets/sheet{index}.xml"
        SubElement(sheets, "sheet", {"name": name, "sheetId": str(index), "r:id": relationship})
        SubElement(workbook_links, "Relationship", Id=relationship, Type=f"{REL}/worksheet", Target=filename)
        sheet_types.append(f'<Override PartName="/xl/{filename}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    SubElement(workbook_links, "Relationship", Id=f"rId{len(worksheets) + 1}", Type=f"{REL}/styles", Target="styles.xml")
    types = f'''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
{"".join(sheet_types)}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''
    styles = f'''<styleSheet xmlns="{NS}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>'''
    package_links = f'<Relationships xmlns="{PACKAGE}"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr("_rels/.rels", package_links)
        archive.writestr("xl/_rels/workbook.xml.rels", tostring(workbook_links, encoding="utf-8"))
        archive.writestr("xl/workbook.xml", tostring(workbook, encoding="utf-8"))
        for index, (_, sheet) in enumerate(worksheets, 1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", tostring(sheet, encoding="utf-8"))
        archive.writestr("xl/styles.xml", styles)
    return output.getvalue()
