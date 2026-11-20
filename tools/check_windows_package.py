"""Verify that the packaged server creates and reuses the archive."""

import argparse
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from zipfile import ZipFile


def check_server(command, environment, archive, expected_items, available=True):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with subprocess.Popen([*command, "--port", str(port)], env=environment) as server:
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(f"The packaged server exited with code {server.returncode}.")
                try:
                    with urlopen(base + "/", timeout=1) as response:
                        assert b"CSIRE interpreter" in response.read()
                    break
                except URLError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("The packaged server did not start.")
            assert archive.is_dir() == available
            try:
                with urlopen(base + "/api/archive", timeout=3) as response:
                    data = json.load(response)
                assert available and len(data["items"]) == expected_items
            except HTTPError as error:
                assert not available and error.code == 503
                with error:
                    data = json.load(error)
            assert Path(data["folder"]) == archive.resolve()
            workbook = Path(command[2]).resolve().parent.parent / "Słownik.xlsx"
            assert workbook.is_file()
            with urlopen(base + "/api/local-dictionary", timeout=3) as response:
                assert json.load(response) == {"path": str(workbook), "ppe": {}, "meters": {}}
        finally:
            server.terminate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--python", type=Path, help="Alternative interpreter for checking the server on non-Windows systems")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="CSIRE test ") as temporary:
        root = Path(temporary)
        with ZipFile(args.package) as package:
            assert package.testzip() is None
            assert all(name.startswith("Interpreter CSIRE/Aplikacja/") for name in package.namelist())
            package.extractall(root)
        application = root / "Interpreter CSIRE" / "Aplikacja"
        assert (application / "Uruchom CSIRE.cmd").is_file()
        archive = application.parent / "Archiwum"
        assert not archive.exists()
        assert not (application.parent / "Słownik.xlsx").exists()
        python = args.python or application / "python" / "python.exe"
        command = [str(python), "-B", str(application / "serve.py")]
        environment = {**os.environ, "XDG_CACHE_HOME": str(root / "cache"), "LOCALAPPDATA": str(root / "cache")}
        check_server(command, environment, archive, 0)
        sample = (application / "dist" / "data" / "przyklady" / "wynik-ce807.xml").read_bytes()
        existing = archive / "wynik.xml"
        existing.write_bytes(sample)
        check_server(command, environment, archive, 1)
        assert existing.read_bytes() == sample
        shared = root / "Shared archive parent"
        shared.mkdir()
        check_server([*command, "--archive", str(shared)], environment, shared / "Archiwum", 0)
        missing = root / "Unavailable share"
        check_server([*command, "--archive", str(missing)], environment, missing / "Archiwum", 0, available=False)
        configured = root / "Explicit archive"
        configured.mkdir()
        (configured / "wynik.xml").write_bytes(sample)
        server_file = application / "serve.py"
        source = server_file.read_text(encoding="utf-8")
        assert "ARCHIVE_FOLDER = None" in source
        server_file.write_text(source.replace("ARCHIVE_FOLDER = None", f"ARCHIVE_FOLDER = {str(configured)!r}", 1), encoding="utf-8")
        check_server(command, environment, configured, 1)
        assert not (configured / "Archiwum").exists()
        check_server([*command, "--archive", str(shared)], environment, shared / "Archiwum", 0)
    print("The packaged server, archive location, creation, reuse and unavailable-folder fallback passed.")


if __name__ == "__main__":
    main()
