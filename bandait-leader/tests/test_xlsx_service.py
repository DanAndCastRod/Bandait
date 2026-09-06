"""Tests for universal multi-tab XLSX service and Diff Preview calculation."""

from src.domain.models import (
    ExcelMasterWorkbook,
    ExcelSongRow,
    ExcelSetlistRow,
    ExcelEquipoRow,
)
from src.infrastructure.xlsx_service import XLSXService


def test_diff_preview_calculation():
    """Verify calculation of added, updated, deleted, and unchanged entities."""
    current = ExcelMasterWorkbook(
        canciones=[
            ExcelSongRow(
                id="song_1",
                titulo="Medianoche en Pereira",
                artista="Bandait Band",
                bpm_original=120,
                tono_original="Am",
                duracion_segundos=210.0,
                letra_chordpro="{title: Medianoche en Pereira}\n[Am]Noche fria",
            ),
            ExcelSongRow(
                id="song_2",
                titulo="Viejo Bar",
                artista="Bandait Band",
                bpm_original=95,
                tono_original="G",
                duracion_segundos=180.0,
                letra_chordpro="[G]En aquel bar",
            ),
        ],
        setlists=[
            ExcelSetlistRow(
                setlist_id="show_1",
                nombre_show="Concierto Rock Fest",
                cancion_id="song_1",
                orden=1,
                tono_show="Am",
                modo_transicion="manual_cue",
                notas="Entrada con platillo",
            ),
        ],
        equipo=[
            ExcelEquipoRow(
                usuario_id="user_1",
                nombre="Carlos Percusión",
                telefono="+573001112233",
                rol="Musician",
            ),
        ],
    )

    incoming = ExcelMasterWorkbook(
        canciones=[
            # Updated: BPM changed from 120 to 124
            ExcelSongRow(
                id="song_1",
                titulo="Medianoche en Pereira",
                artista="Bandait Band",
                bpm_original=124,
                tono_original="Am",
                duracion_segundos=210.0,
                letra_chordpro="{title: Medianoche en Pereira}\n[Am]Noche fria",
            ),
            # Added: new song_3
            ExcelSongRow(
                id="song_3",
                titulo="Nuevo Amanecer",
                artista="Bandait Band",
                bpm_original=140,
                tono_original="C",
                duracion_segundos=240.0,
                letra_chordpro="[C]Sale el sol",
            ),
            # Deleted: song_2 is missing in incoming
        ],
        setlists=[
            # Unchanged: same show_1 song_1
            ExcelSetlistRow(
                setlist_id="show_1",
                nombre_show="Concierto Rock Fest",
                cancion_id="song_1",
                orden=1,
                tono_show="Am",
                modo_transicion="manual_cue",
                notas="Entrada con platillo",
            ),
        ],
        equipo=[
            # Added: new substitute member
            ExcelEquipoRow(
                usuario_id="user_1",
                nombre="Carlos Percusión",
                telefono="+573001112233",
                rol="Musician",
            ),
            ExcelEquipoRow(
                usuario_id="user_2",
                nombre="Andrés Reemplazo",
                telefono="+573004445566",
                rol="Substitute",
            ),
        ],
    )

    diff = XLSXService.calculate_diff(current, incoming)

    assert diff.has_changes is True
    assert diff.summary["added"] == 2      # song_3 and user_2
    assert diff.summary["updated"] == 1    # song_1 (BPM changed)
    assert diff.summary["deleted"] == 1    # song_2 deleted
    assert diff.summary["unchanged"] == 2  # show_1 song_1 and user_1

    # Check song_1 field diff
    song_1_diff = next(item for item in diff.canciones if item.entity_id == "song_1")
    assert song_1_diff.change_type == "updated"
    assert song_1_diff.diff_fields is not None
    assert song_1_diff.diff_fields["bpm_original"]["before"] == 120
    assert song_1_diff.diff_fields["bpm_original"]["after"] == 124
