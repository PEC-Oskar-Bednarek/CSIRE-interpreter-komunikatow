# CSIRE interpreter na Windows

Rozpakuj ZIP z zachowaniem folderu `Interpreter CSIRE`. Wejdź do `Aplikacja` i uruchom `Uruchom CSIRE.cmd`. Możesz ręcznie utworzyć skrót wskazujący ten plik. Program otworzy lokalną aplikację w domyślnej przeglądarce. Zamknięcie okna startowego zatrzymuje aplikację.

Przy pierwszym uruchomieniu aplikacja utworzy folder `Interpreter CSIRE\Archiwum`. Jeśli folder już istnieje, użyje go. Pod nagłówkiem Archiwum aplikacja pokazuje jego pełną ścieżkę. Do nowego folderu możesz skopiować istniejące pliki XML oraz katalog `.csire-tskb`, jeśli był obecny w dotychczasowym archiwum.

Przy instalacjach na kilku komputerach możesz wpisać w `serve.py` dokładną ścieżkę do wspólnego katalogu, np. `ARCHIVE_FOLDER = r"\\serwer\udział\Komunikaty CSIRE"`. Aplikacja użyje wskazanego katalogu. Wartość `None` włącza domyślny folder obok aplikacji.

Argument `--archive` w skrócie ma pierwszeństwo przed ustawieniem w `serve.py`. Podaj w nim folder nadrzędny, np. `--archive "\\serwer\udział\Interpreter CSIRE"`, aby użyć jego podfolderu `Archiwum`.

Przy pierwszym uruchomieniu obok `Aplikacja` powstaje też `Słownik.xlsx`. W arkuszach `PPE` i `Liczniki` uzupełnij numer oraz opis lub nazwę. Wklejaj identyfikatory jako tekst, żeby zachować zera wiodące i pełną długość numeru PPE. Po zapisaniu arkusza odśwież Archiwum lub Historię sprawy w otwartym wyniku. Pełna ścieżka do pliku jest w zakładce Słownik.

Aktualizując program, zamknij go i podmień folder `Aplikacja`. Dane pozostają w sąsiednim folderze `Archiwum`.
