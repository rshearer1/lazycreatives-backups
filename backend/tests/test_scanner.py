from ablebackup.scanner import scan_projects
from tests.helpers import write_als, fileref_rel


def test_finds_als_and_resolves_refs(tmp_path):
    proj = tmp_path / "Song Project"
    (proj / "Samples").mkdir(parents=True)
    (proj / "Samples" / "loop.wav").write_bytes(b"xyz")
    write_als(proj / "Song.als", [fileref_rel("Samples/loop.wav", "loop.wav")])

    results = scan_projects([tmp_path])

    assert len(results) == 1
    scan = results[0]
    assert scan.name == "Song"
    assert scan.project_dir == proj
    assert len(scan.refs) == 1
    assert scan.refs[0].exists is True


def test_skips_backup_and_output_folders(tmp_path):
    proj = tmp_path / "Song Project"
    backup = proj / "Backup"
    backup.mkdir(parents=True)
    write_als(backup / "Song [2023-01-01].als", [])
    out = tmp_path / "AbletonBackups" / "projects" / "Song" / "2026-01-01_1200"
    out.mkdir(parents=True)
    write_als(out / "Song.als", [])
    write_als(proj / "Song.als", [])

    results = scan_projects([tmp_path])

    assert len(results) == 1
    assert results[0].project_dir == proj
