"""Universal Multi-Tab XLSX Service for Bandait 3.0 Master Workbook.

Provides import, export, and Diff Preview calculation for:
- Tab 1: Canciones
- Tab 2: Setlists
- Tab 3: Equipo (Roles and WhatsApp/SMS phone credentials)
"""

import io
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict

from src.domain.models import (
    ExcelMasterWorkbook,
    ExcelSongRow,
    ExcelSetlistRow,
    ExcelEquipoRow,
)


@dataclass
class DiffItem:
    entity_id: str
    change_type: str  # "added" | "updated" | "deleted" | "unchanged"
    details: Dict[str, Any]
    diff_fields: Optional[Dict[str, Dict[str, Any]]] = None  # {field: {before, after}}


@dataclass
class DiffPreview:
    canciones: List[DiffItem]
    setlists: List[DiffItem]
    equipo: List[DiffItem]
    has_changes: bool
    summary: Dict[str, int]  # {added, updated, deleted, unchanged}


class XLSXService:
    """Service to handle universal multi-tab Excel import/export and diff calculation."""

    SHEET_CANCIONES = "Canciones"
    SHEET_SETLISTS = "Setlists"
    SHEET_EQUIPO = "Equipo"

    @classmethod
    def calculate_diff(
        cls,
        current_workbook: ExcelMasterWorkbook,
        incoming_workbook: ExcelMasterWorkbook,
    ) -> DiffPreview:
        """Calculate granular Diff Preview between current database and incoming XLSX."""
        canciones_diff = cls._diff_entities(
            current=[asdict(s) for s in current_workbook.canciones],
            incoming=[asdict(s) for s in incoming_workbook.canciones],
            id_key="id",
        )

        setlists_diff = cls._diff_entities(
            current=[asdict(s) for s in current_workbook.setlists],
            incoming=[asdict(s) for s in incoming_workbook.setlists],
            id_key="cancion_id",  # unique per setlist entry
        )

        equipo_diff = cls._diff_entities(
            current=[asdict(m) for m in current_workbook.equipo],
            incoming=[asdict(m) for m in incoming_workbook.equipo],
            id_key="usuario_id",
        )

        all_items = canciones_diff + setlists_diff + equipo_diff
        summary = {
            "added": sum(1 for i in all_items if i.change_type == "added"),
            "updated": sum(1 for i in all_items if i.change_type == "updated"),
            "deleted": sum(1 for i in all_items if i.change_type == "deleted"),
            "unchanged": sum(1 for i in all_items if i.change_type == "unchanged"),
        }
        has_changes = (summary["added"] + summary["updated"] + summary["deleted"]) > 0

        return DiffPreview(
            canciones=canciones_diff,
            setlists=setlists_diff,
            equipo=equipo_diff,
            has_changes=has_changes,
            summary=summary,
        )

    @classmethod
    def _diff_entities(
        cls,
        current: List[Dict[str, Any]],
        incoming: List[Dict[str, Any]],
        id_key: str,
    ) -> List[DiffItem]:
        diff_items: List[DiffItem] = []
        current_map = {str(item.get(id_key, "")): item for item in current}
        incoming_map = {str(item.get(id_key, "")): item for item in incoming}

        # Check incoming items for added or updated
        for inc_id, inc_item in incoming_map.items():
            if not inc_id:
                continue
            if inc_id not in current_map:
                diff_items.append(
                    DiffItem(
                        entity_id=inc_id,
                        change_type="added",
                        details=inc_item,
                    )
                )
            else:
                curr_item = current_map[inc_id]
                field_diffs = {}
                for key, inc_val in inc_item.items():
                    curr_val = curr_item.get(key)
                    if curr_val != inc_val:
                        field_diffs[key] = {"before": curr_val, "after": inc_val}

                if field_diffs:
                    diff_items.append(
                        DiffItem(
                            entity_id=inc_id,
                            change_type="updated",
                            details=inc_item,
                            diff_fields=field_diffs,
                        )
                    )
                else:
                    diff_items.append(
                        DiffItem(
                            entity_id=inc_id,
                            change_type="unchanged",
                            details=inc_item,
                        )
                    )

        # Check deleted items
        for curr_id, curr_item in current_map.items():
            if curr_id and curr_id not in incoming_map:
                diff_items.append(
                    DiffItem(
                        entity_id=curr_id,
                        change_type="deleted",
                        details=curr_item,
                    )
                )

        return diff_items

    @classmethod
    def export_workbook(cls, workbook_data: ExcelMasterWorkbook) -> bytes:
        """Export master data to 3-tab XLSX buffer using openpyxl."""
        import openpyxl

        wb = openpyxl.Workbook()
        # Default sheet -> Canciones
        ws_canciones = wb.active
        ws_canciones.title = cls.SHEET_CANCIONES

        # Headers Canciones
        ws_canciones.append([
            "id", "titulo", "artista", "bpm_original", "tono_original", "duracion_segundos", "letra_chordpro"
        ])
        for song in workbook_data.canciones:
            ws_canciones.append([
                song.id, song.titulo, song.artista, song.bpm_original, song.tono_original, song.duracion_segundos, song.letra_chordpro
            ])

        # Sheet 2 -> Setlists
        ws_setlists = wb.create_sheet(title=cls.SHEET_SETLISTS)
        ws_setlists.append([
            "setlist_id", "nombre_show", "cancion_id", "orden", "tono_show", "modo_transicion", "notas"
        ])
        for item in workbook_data.setlists:
            ws_setlists.append([
                item.setlist_id, item.nombre_show, item.cancion_id, item.orden, item.tono_show, item.modo_transicion, item.notas
            ])

        # Sheet 3 -> Equipo
        ws_equipo = wb.create_sheet(title=cls.SHEET_EQUIPO)
        ws_equipo.append([
            "usuario_id", "nombre", "telefono", "rol"
        ])
        for member in workbook_data.equipo:
            ws_equipo.append([
                member.usuario_id, member.nombre, member.telefono, member.rol
            ])

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    @classmethod
    def import_workbook(cls, file_bytes_or_path: Any) -> ExcelMasterWorkbook:
        """Parse 3-tab XLSX file into ExcelMasterWorkbook dataclass."""
        import openpyxl

        if isinstance(file_bytes_or_path, (bytes, bytearray)):
            file_stream = io.BytesIO(file_bytes_or_path)
            wb = openpyxl.load_workbook(file_stream, data_only=True)
        else:
            wb = openpyxl.load_workbook(file_bytes_or_path, data_only=True)

        canciones: List[ExcelSongRow] = []
        setlists: List[ExcelSetlistRow] = []
        equipo: List[ExcelEquipoRow] = []

        # Parse Canciones
        if cls.SHEET_CANCIONES in wb.sheetnames:
            ws = wb[cls.SHEET_CANCIONES]
            rows = list(ws.iter_rows(values_only=True))
            if len(rows) > 1:
                header = [str(c).strip().lower() if c else "" for c in rows[0]]
                for row in rows[1:]:
                    if not row or not any(row):
                        continue
                    row_dict = dict(zip(header, row))
                    canciones.append(
                        ExcelSongRow(
                            id=str(row_dict.get("id") or ""),
                            titulo=str(row_dict.get("titulo") or ""),
                            artista=str(row_dict.get("artista") or ""),
                            bpm_original=int(row_dict.get("bpm_original") or 120),
                            tono_original=str(row_dict.get("tono_original") or ""),
                            duracion_segundos=float(row_dict.get("duracion_segundos") or 0.0),
                            letra_chordpro=str(row_dict.get("letra_chordpro") or ""),
                        )
                    )

        # Parse Setlists
        if cls.SHEET_SETLISTS in wb.sheetnames:
            ws = wb[cls.SHEET_SETLISTS]
            rows = list(ws.iter_rows(values_only=True))
            if len(rows) > 1:
                header = [str(c).strip().lower() if c else "" for c in rows[0]]
                for row in rows[1:]:
                    if not row or not any(row):
                        continue
                    row_dict = dict(zip(header, row))
                    setlists.append(
                        ExcelSetlistRow(
                            setlist_id=str(row_dict.get("setlist_id") or ""),
                            nombre_show=str(row_dict.get("nombre_show") or ""),
                            cancion_id=str(row_dict.get("cancion_id") or ""),
                            orden=int(row_dict.get("orden") or 1),
                            tono_show=str(row_dict.get("tono_show") or ""),
                            modo_transicion=str(row_dict.get("modo_transicion") or "manual_cue"),
                            notas=str(row_dict.get("notas") or ""),
                        )
                    )

        # Parse Equipo
        if cls.SHEET_EQUIPO in wb.sheetnames:
            ws = wb[cls.SHEET_EQUIPO]
            rows = list(ws.iter_rows(values_only=True))
            if len(rows) > 1:
                header = [str(c).strip().lower() if c else "" for c in rows[0]]
                for row in rows[1:]:
                    if not row or not any(row):
                        continue
                    row_dict = dict(zip(header, row))
                    equipo.append(
                        ExcelEquipoRow(
                            usuario_id=str(row_dict.get("usuario_id") or ""),
                            nombre=str(row_dict.get("nombre") or ""),
                            telefono=str(row_dict.get("telefono") or ""),
                            rol=str(row_dict.get("rol") or "Musician"),
                        )
                    )

        return ExcelMasterWorkbook(
            canciones=canciones,
            setlists=setlists,
            equipo=equipo,
        )
