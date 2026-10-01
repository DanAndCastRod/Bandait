# Avisos de terceros (NOTICE)

Bandait es software libre: puede redistribuirlo y modificarlo bajo los términos de la
GNU General Public License, versión 3 o (a su elección) cualquier versión posterior
(GPL-3.0-or-later). El texto completo está en [`LICENSE`](LICENSE).

El instalador de Windows del líder (`BandaitLeader-Setup-X.Y.Z.exe`) y la carpeta portátil
(`BandaitLeader-X.Y.Z-win64-portable.zip`) son un empaquetado PyInstaller *onedir*: además
del código de Bandait incluyen los componentes de terceros de esta lista, cada uno bajo su
propia licencia.

## Código fuente correspondiente

- **Bandait:** el repositorio <https://github.com/DanAndCastRod/Bandait> y, para cada
  versión publicada, los archivos *Source code (zip)* y *Source code (tar.gz)* que GitHub
  adjunta al Release de su etiqueta `vX.Y.Z`.
- **Componentes de terceros:** los enlaces de cada sección. Las versiones exactas de cada
  paquete Python del build están en `build-environment.txt`, junto a `BandaitLeader.exe`
  en la carpeta de instalación (por defecto `C:\Program Files\Bandait Leader`).
- Los textos de licencia que publica cada paquete Python del build (archivos `LICENSE`,
  `COPYING`, `NOTICE` de su `*.dist-info`) se copian a `third_party_licenses\`, junto a
  `BandaitLeader.exe`. Los de PortAudio y libsndfile están en
  `_internal\_sounddevice_data\portaudio-binaries\README.md` y
  `_internal\_soundfile_data\COPYING`.

## Componentes nativos con condiciones de copyleft

### Qt 6, Qt for Python (PySide6) y Shiboken6

- Licencia: LGPL-3.0-only (Qt for Python también se ofrece bajo GPL-2.0 y GPL-3.0).
  Bandait usa estos componentes bajo LGPL-3.0.
- Archivos: `_internal\PySide6\` (`Qt6Core.dll`, `Qt6Gui.dll`, `Qt6Widgets.dll`,
  `Qt6Network.dll`, `Qt6Svg.dll`, `Qt6OpenGL.dll`, plugins y módulos `.pyd`) y
  `_internal\shiboken6\`.
- Las bibliotecas de Qt son archivos DLL separados y no modificados: puede reemplazarlas por
  una compilación compatible de la misma versión de Qt (LGPL-3.0, sección 4).
- Fuentes: Qt <https://download.qt.io/official_releases/qt/> y
  <https://code.qt.io/cgit/qt/>; Qt for Python <https://code.qt.io/cgit/pyside/pyside-setup.git/>
  (etiqueta de la versión de `build-environment.txt`) y <https://pypi.org/project/PySide6/#files>.

### PortAudio y Steinberg ASIO SDK

- Archivos: `_internal\_sounddevice_data\portaudio-binaries\libportaudio64bit.dll` (sin ASIO)
  y `libportaudio64bit-asio.dll` (con ASIO). Bandait carga la segunda solo si se activa ASIO.
- **PortAudio** v19.7.0, de Ross Bencina y Phil Burk: licencia MIT (licencia de PortAudio).
  Fuente: <https://github.com/PortAudio/portaudio/tree/v19.7.0>.
- **Steinberg ASIO SDK** (Audio Stream Input/Output), de Steinberg Media Technologies GmbH,
  compilado dentro de `libportaudio64bit-asio.dll`. Desde el 2025-10-15 Steinberg ofrece el
  SDK con licencia dual: su licencia propietaria o GPL-3.0. Bandait lo usa bajo GPL-3.0.
  Fuente: <https://www.steinberg.net/asiosdk> (descarga del SDK) y
  <https://www.steinberg.net/developers/>. ASIO es una marca de Steinberg Media Technologies GmbH.
- Ambas DLL vienen precompiladas en el paquete `sounddevice`. Las compila el proyecto
  spatialaudio/portaudio-binaries con esta receta pública:
  <https://github.com/spatialaudio/portaudio-binaries/blob/master/.github/workflows/build-libs.yml>
  (repositorio: <https://github.com/spatialaudio/portaudio-binaries>).

### libsndfile y códecs

- Archivo: `_internal\_soundfile_data\libsndfile_x64.dll` (con su `COPYING`), del paquete
  `soundfile`. Lo usa la grabación multipista (FLAC).
- libsndfile, de Erik de Castro Lopo: LGPL-2.1-or-later. Incluye, enlazados de forma
  estática: FLAC, Ogg, Vorbis y Opus (BSD-3-Clause), mpg123 (LGPL-2.1) y LAME (LGPL-2.0-or-later).
- Fuentes: <https://github.com/libsndfile/libsndfile> y la receta de compilación
  <https://github.com/bastibe/libsndfile-binaries>.

## Intérprete y bibliotecas del sistema

- **CPython 3.11** (`python311.dll`, `base_library.zip`, módulos `.pyd`): PSF License 2.0.
  Fuente: <https://www.python.org/downloads/source/>. Incluye OpenSSL (Apache-2.0),
  SQLite (dominio público), libffi (MIT), zlib (zlib), bzip2 (bzip2), liblzma (dominio
  público) y expat (MIT).
- **Microsoft Visual C++ Runtime** (`VCRUNTIME140*.dll`, `MSVCP140*.dll`): redistribuible de
  Microsoft, biblioteca del sistema en el sentido de la GPL-3.0 (sección 1).

## Paquetes Python incluidos

| Paquete | Licencia | Fuente |
|---|---|---|
| PySide6, PySide6-Essentials, PySide6-Addons, shiboken6 | LGPL-3.0-only (o GPL) | <https://code.qt.io/cgit/pyside/pyside-setup.git/> |
| sounddevice | MIT | <https://github.com/spatialaudio/python-sounddevice> |
| cffi | MIT-0 (2.x) / MIT (1.x) | <https://github.com/python-cffi/cffi> |
| pycparser | BSD-3-Clause | <https://github.com/eliben/pycparser> |
| numpy (incluye OpenBLAS, BSD-3-Clause, y el runtime de gfortran, GPL-3.0 con GCC Runtime Library Exception) | BSD-3-Clause | <https://github.com/numpy/numpy> |
| soundfile | BSD-3-Clause | <https://github.com/bastibe/python-soundfile> |
| python-socketio | MIT | <https://github.com/miguelgrinberg/python-socketio> |
| python-engineio | MIT | <https://github.com/miguelgrinberg/python-engineio> |
| bidict | MPL-2.0 | <https://github.com/jab/bidict> |
| uvicorn | BSD-3-Clause | <https://github.com/encode/uvicorn> |
| h11 | MIT | <https://github.com/python-hyper/h11> |
| httptools (incluye llhttp, MIT) | MIT | <https://github.com/MagicStack/httptools> |
| websockets | BSD-3-Clause | <https://github.com/python-websockets/websockets> |
| wsproto | MIT | <https://github.com/python-hyper/wsproto> |
| click | BSD-3-Clause | <https://github.com/pallets/click> |
| colorama | BSD-3-Clause | <https://github.com/tartley/colorama> |
| python-dotenv | BSD-3-Clause | <https://github.com/theskumar/python-dotenv> |
| PyYAML | MIT | <https://github.com/yaml/pyyaml> |
| SQLAlchemy | MIT | <https://github.com/sqlalchemy/sqlalchemy> |
| greenlet | MIT AND PSF-2.0 | <https://github.com/python-greenlet/greenlet> |
| typing_extensions | PSF-2.0 | <https://github.com/python/typing_extensions> |
| keyring | MIT | <https://github.com/jaraco/keyring> |
| jaraco.classes, jaraco.functools, jaraco.context | MIT | <https://github.com/jaraco> |
| backports.tarfile | MIT | <https://github.com/jaraco/backports.tarfile> |
| more-itertools | MIT | <https://github.com/more-itertools/more-itertools> |
| importlib_metadata | Apache-2.0 | <https://github.com/python/importlib_metadata> |
| zipp | MIT | <https://github.com/jaraco/zipp> |
| pywin32-ctypes | BSD-3-Clause | <https://github.com/enthought/pywin32-ctypes> |
| qrcode | BSD-3-Clause | <https://github.com/lincolnloop/python-qrcode> |
| Pillow (incluye libjpeg-turbo, libpng, zlib, libtiff, libwebp, FreeType, Little CMS, OpenJPEG y otras, todas permisivas) | MIT-CMU (HPND) | <https://github.com/python-pillow/Pillow> |
| psutil | BSD-3-Clause | <https://github.com/giampaolo/psutil> |
| mutagen | GPL-2.0-or-later | <https://github.com/quodlibet/mutagen> |
| charset-normalizer | MIT | <https://github.com/jawah/charset_normalizer> |
| PyInstaller (cargador `BandaitLeader.exe` y *runtime hooks*) | GPL-2.0-or-later con la excepción del cargador de PyInstaller, que permite distribuirlo con cualquier programa | <https://github.com/pyinstaller/pyinstaller> |

`openpyxl` (MIT, <https://foss.heptapod.net/openpyxl/openpyxl>) y `et_xmlfile` (MIT) están
en `requirements.txt`; PyInstaller los incluye solo si la interfaz los importa.

## App del músico servida por el líder

El líder sirve a los teléfonos la app web compilada de `bandait-follower`
(`_internal\follower\`, parte de Bandait, GPL-3.0-or-later). Su JavaScript incluye:

| Paquete | Licencia | Fuente |
|---|---|---|
| React, React DOM | MIT | <https://github.com/facebook/react> |
| socket.io-client (y engine.io-client) | MIT | <https://github.com/socketio/socket.io> |
| @supabase/supabase-js | MIT | <https://github.com/supabase/supabase-js> |
| html5-qrcode (incluye ZXing, Apache-2.0) | Apache-2.0 | <https://github.com/mebjas/html5-qrcode> |
| NoSleep.js | MIT | <https://github.com/richtr/NoSleep.js> |
| Workbox (service worker) | MIT | <https://github.com/GoogleChrome/workbox> |

## No incluidos en el instalador

- `google-generativeai` (Apache-2.0): llegó al fin de soporte el 2025-11-30. La vista de IA
  lo importa de forma opcional y, sin él, responde "AI offline".
- `alembic`, `mido`, `python-rtmidi`, `qasync`: están en `requirements.txt` pero el líder no
  los importa.
- Herramientas de desarrollo y pruebas: `ruff`, `pytest`, `pytest-qt`, `aiohttp`, `jsonschema`.
