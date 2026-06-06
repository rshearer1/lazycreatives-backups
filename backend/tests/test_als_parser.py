from ablebackup.als_parser import parse_als
from tests.helpers import write_als, fileref_abs


def test_parses_absolute_path_ref(tmp_path):
    als = write_als(tmp_path / "song.als", [
        fileref_abs("C:\\samples\\kick.wav", "kick.wav"),
        fileref_abs("/Users/me/snare.wav", "snare.wav"),
    ])
    refs = parse_als(als)
    assert len(refs) == 2
    assert refs[0].name == "kick.wav"
    assert refs[0].absolute_path == "C:\\samples\\kick.wav"
    assert refs[0].relative_path is None
    assert refs[1].absolute_path == "/Users/me/snare.wav"
