"""Leader stage view: lyrics and chords by section (CONTRACT_V3 9.1), setlist rail, mixer hidden."""

from src.ui.chordpro_layout import (
    MUSICIAN,
    SINGER,
    layout_chord_line,
    lyric_lines,
    preview_text,
    section_html,
    section_index_at,
)

SECTIONS = [
    {"id": "a", "kind": "intro", "label": "Intro", "bars": 2, "start_bar": 1,
     "chordpro": "[Am]  [F]", "cue_text": "Intro"},
    {"id": "b", "kind": "verse", "label": "Estrofa 1", "bars": 4, "start_bar": 3,
     "chordpro": "[Am]Hoy vuelvo a [F]casa\n{c: Todos}", "cue_text": None},
    {"id": "c", "kind": "chorus", "label": "Coro", "bars": 4, "start_bar": 7,
     "chordpro": "[F]Canta <conmigo> & [G]ya", "cue_text": None},
]
ENTRY = {"song_id": "s1", "title": "Hoy vuelvo a casa", "artist": "B&O's", "key": "Am", "show_key": "",
         "bpm": 92, "sections": SECTIONS}


def test_layout_chord_line_puts_chords_over_syllables():
    chords, lyrics = layout_chord_line("[Am]Hoy vuelvo a [F]casa")
    assert lyrics == "Hoy vuelvo a casa"
    assert chords.index("F") == lyrics.index("casa")
    # A chord longer than its syllable keeps a space before the next one.
    chords, lyrics = layout_chord_line("[Am7sus4]a[G]b")
    assert chords == "Am7sus4 G"
    assert lyrics.rstrip() == "a       b"


def test_lyrics_only_and_preview():
    assert lyric_lines("[Am]  [F]\n[C]con la noche en [G]calma") == ["con la noche en calma"]
    assert preview_text(SECTIONS[1]["chordpro"], MUSICIAN) == "Am F // Hoy vuelvo a casa"
    assert preview_text(SECTIONS[1]["chordpro"], SINGER) == "Hoy vuelvo a casa"
    assert preview_text("", SINGER, "Final") == "Final"


def test_section_html_escapes_and_placeholders():
    out = section_html(SECTIONS[2]["chordpro"], MUSICIAN)
    assert "&lt;conmigo&gt; &amp;" in out and "<conmigo>" not in out
    assert "INSTRUMENTAL" in section_html("[Am]  [F]", SINGER)
    assert "INTRO" in section_html("", MUSICIAN, "Intro")


def test_section_index_at_follows_bars():
    assert [section_index_at(SECTIONS, b) for b in (None, -1, 1, 2, 3, 6, 7, 99)] == [0, 0, 0, 0, 1, 1, 2, 2]
    assert section_index_at([], 5) == -1


def test_stage_view_follows_sections(qtbot):
    from src.ui.views.stage_view import StageView

    sv = StageView()
    qtbot.addWidget(sv)
    sv.set_setlist([ENTRY, {"song_id": "s2", "title": "Otra", "bpm": 120}], "s1")
    assert sv.rail_song_ids() == ["s1", "s2"]

    sv.set_song(title="Hoy vuelvo a casa")  # legacy path first, as MainWindow does
    assert sv.mode_btn.isHidden()
    sv.set_song_content(ENTRY)
    assert not sv.mode_btn.isHidden()
    assert sv.current_section_index() == 0
    assert sv.section_head.text().startswith("INTRO")
    assert sv.section_label.text() == "B&O's // Am"
    assert "SIGUE: ESTROFA 1" in sv.next_lyric.text()

    for bar, idx in ((2, 0), (3, 1), (6, 1), (7, 2), (40, 2)):
        sv.set_bar(bar)
        assert sv.current_section_index() == idx, bar
    assert sv.next_lyric.text() == "FIN DE LA CANCION"

    sv.set_prompter_mode(SINGER)
    assert sv.mode_btn.text() == "LETRA"
    assert "Canta &lt;conmigo&gt; &amp; ya" in sv.current_lyric.text()
    sv.toggle_prompter_mode()
    assert sv.prompter_mode() == MUSICIAN

    # A song without sections keeps the legacy plain lyrics and stops following bars.
    sv.set_song("Sin hub", "Primera linea <b>")
    sv.set_song_content({"song_id": "s2", "sections": []})
    sv.set_bar(9)
    assert sv.current_section_index() == -1
    assert sv.current_lyric.text() == "Primera linea &lt;b&gt;"
