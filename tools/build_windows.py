"""Package the offline Windows x64 application with the official CPython runtime."""

import argparse
import hashlib
from io import BytesIO
from pathlib import Path, PurePosixPath
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
PYTHON_URL = "https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip"
PYTHON_SHA256 = "9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38"
APP = PurePosixPath("Interpreter CSIRE", "Aplikacja")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-zip", type=Path)
    parser.add_argument("--output", type=Path, default=Path("output/Interpreter-CSIRE-Windows-x64.zip"))
    args = parser.parse_args()

    if args.runtime_zip:
        runtime_bytes = args.runtime_zip.read_bytes()
    else:
        with urlopen(PYTHON_URL, timeout=60) as response:
            runtime_bytes = response.read()
    if hashlib.sha256(runtime_bytes).hexdigest() != PYTHON_SHA256:
        raise SystemExit("Suma SHA-256 pakietu Pythona jest niezgodna.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(BytesIO(runtime_bytes)) as runtime, ZipFile(args.output, "w", ZIP_DEFLATED) as package:
        for name in runtime.namelist():
            # Add the application's modules to the embeddable runtime's isolated path.
            content = b"python313.zip\r\n.\r\n..\r\n" if name == "python313._pth" else runtime.read(name)
            package.writestr(str(APP / "python" / name), content)
        launcher = (ROOT / "local" / "Uruchom CSIRE.cmd").read_text(encoding="ascii")
        package.writestr(str(APP / "Uruchom CSIRE.cmd"), launcher.replace("\n", "\r\n"))
        for name in ("serve.py", "archive_index.py", "archive_register.py", "local_dictionary.py", "README.md"):
            package.write(ROOT / "local" / name, str(APP / name))
        for path in sorted((ROOT / "dist").rglob("*")):
            relative = path.relative_to(ROOT / "dist")
            if path.is_file() and relative.parts[0] not in {"downloads", "pobierz.html"}:
                package.write(path, str(APP / "dist" / relative.as_posix()))
    print(args.output.resolve())


if __name__ == "__main__":
    main()
