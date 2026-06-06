from ablebackup.backup_engine import supports_hardlinks


def test_supports_hardlinks_true_on_tmp(tmp_path):
    # Local temp filesystems support hardlinks on all CI platforms we target.
    assert supports_hardlinks(tmp_path) is True


def test_detection_leaves_no_residue(tmp_path):
    supports_hardlinks(tmp_path)
    assert list(tmp_path.iterdir()) == []
